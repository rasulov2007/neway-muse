/**
 * Relay Payments: the fuel transactions this carrier's drivers paid for with Relay.
 *
 * Read-only. One endpoint matters - `GET /api/fuel/transactions/` over a date window - and it is
 * slow: answers of thirty seconds and more are normal, so the timeout is generous. Relay also asks
 * integrators to leave ten seconds between calls, which the client enforces itself rather than
 * trusting every caller to remember.
 *
 * The key is sent bare in `Authorization` - no "Bearer" prefix. With one, Relay answers 401.
 *
 * Relay has no receipt image anywhere in its API and no odometer prompt: the only thing a driver
 * types at the pump is the truck number, which arrives as a prompt labelled "Truck #". That prompt
 * is the only place a transaction names the unit.
 */

const BASE_URL = 'https://app.relaypayments.com';
const TRANSACTIONS_PATH = '/api/fuel/transactions/';
const REQUEST_TIMEOUT_MS = 120_000;
const MIN_SPACING_MS = 10_000;

/** One fuel line on a transaction, already reduced to what the workspace needs. */
export interface RelayFuelItem {
  /** Relay's fuel_type, lower-cased: diesel, diesel_1, diesel_dyed, def, … */
  fuelType: string;
  gallons: number;
  /** What the carrier paid for this line: the discounted total when Relay gives one. */
  amount: number;
}

export interface RelayTransaction {
  /** Relay's `transaction_id`. Stable, and the key that makes a re-read exactly-once. */
  id: string;
  /** The moment at the pump, RFC3339 UTC. */
  at: string | null;
  driver: { firstName: string; lastName: string; card: string | null };
  /** What the driver typed for "Truck #", as typed. */
  truckPrompt: string | null;
  station: { brand: string; name: string; city: string; state: string };
  items: RelayFuelItem[];
}

export class RelayError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'RelayError';
  }
}

export class RelayClient {
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #base: string;
  #lastCallAt = 0;

  constructor(key: string, fetchImpl: typeof fetch = fetch, base: string = BASE_URL) {
    this.#key = key;
    this.#fetch = fetchImpl;
    this.#base = base.replace(/\/+$/, '');
  }

  /** Every fuel transaction whose pump time falls in [start, end). */
  async transactions(start: Date, end: Date): Promise<RelayTransaction[]> {
    const body = await this.get(TRANSACTIONS_PATH, { dtstart: rfc3339(start), dtend: rfc3339(end) });
    const rows = Array.isArray(body)
      ? body
      : Array.isArray((body as { results?: unknown }).results)
        ? (body as { results: unknown[] }).results
        : [];
    return rows.map((row) => parseTransaction(row as Record<string, unknown>)).filter((t) => t.id !== '');
  }

  private async get(path: string, params: Record<string, string>): Promise<unknown> {
    const wait = this.#lastCallAt + MIN_SPACING_MS - Date.now();
    if (this.#lastCallAt > 0 && wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    this.#lastCallAt = Date.now();

    const url = `${this.#base}${path}?${new URLSearchParams(params).toString()}`;
    let response: Response;
    try {
      response = await this.#fetch(url, {
        headers: { Authorization: this.#key, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new RelayError(
        timedOut ? 'Relay did not answer in time. Try again in a minute.' : 'Relay could not be reached.',
        null,
        true,
      );
    }
    if (response.status === 401 || response.status === 403) {
      // A key for the other environment answers 403, so say which one this server talks to.
      throw new RelayError(`Relay refused the API key (${response.status}). Check it is the ${this.#base} key.`, response.status, false);
    }
    if (response.status === 429) {
      throw new RelayError('Relay is rate-limiting this key. Try again later.', 429, true);
    }
    if (!response.ok) {
      throw new RelayError(`Relay answered ${response.status}.`, response.status, response.status >= 500);
    }
    try {
      return await response.json();
    } catch {
      throw new RelayError('Relay answered with something that is not JSON.', response.status, true);
    }
  }
}

export function rfc3339(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function parseTransaction(row: Record<string, unknown>): RelayTransaction {
  const driver = record(row.driver);
  const location = record(row.location);
  const merchant = record(row.merchant);
  const prompts = Array.isArray(row.prompts) ? (row.prompts as unknown[]).map(record) : [];
  const truck = prompts.find((p) => String(p.label ?? '').toLowerCase().includes('truck'));
  const items = Array.isArray(row.fuel_items) ? (row.fuel_items as unknown[]).map(record) : [];
  return {
    id: String(row.transaction_id ?? '').trim(),
    at: text(row.created_at),
    driver: {
      firstName: String(driver.first_name ?? '').trim(),
      lastName: String(driver.last_name ?? '').trim(),
      card: text(driver.integration_id),
    },
    truckPrompt: truck ? text(truck.value) : null,
    station: {
      brand: String(merchant.name ?? location.name ?? '').trim(),
      name: String(location.name ?? merchant.name ?? '').trim(),
      city: String(location.city ?? '').trim(),
      state: String(location.state ?? '').trim().toUpperCase(),
    },
    items: items.map((item) => ({
      fuelType: String(item.fuel_type ?? '').trim().toLowerCase(),
      gallons: num(item.volume),
      amount: num(item.total_discounted_price) || num(item.total_retail_price),
    })),
  };
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  const s = typeof value === 'string' ? value.trim() : value == null ? '' : String(value).trim();
  return s === '' ? null : s;
}

function num(value: unknown): number {
  const n = typeof value === 'number' ? value : Number.parseFloat(String(value ?? ''));
  return Number.isFinite(n) ? n : 0;
}
