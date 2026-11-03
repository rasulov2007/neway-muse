/**
 * Five ELD (fiveeld.com), read-only.
 *
 * Four requests, all GET: the vehicles on the account (`current-units/:usdot`, paged; moving or
 * parked), the vehicles that were active in a date range (`active-units/:usdot/`, the fallback),
 * the tracking history of one vehicle in a date range (`trackings/:usdot/:vehicleId/`), and the
 * last known position of every unit (`/api/v2/units-by-usdot/:usdot`). Nothing here writes to
 * Five ELD and nothing here can: there is no method that would.
 *
 * Every request carries two headers — `x-api-key` and `provider-token` — and the company's USDOT
 * number in the path. The key and the token arrive as constructor arguments, are held in private
 * fields and are sent only in those headers: never logged, never part of a URL or a query string,
 * never inside an error message. The USDOT is not a secret and is the only credential in a URL.
 *
 * What Five ELD documents (developer.fiveeld.com, read 2026-10-21):
 *   - current-units → `{ data: [{ id, vin, truck_number, driver, codriver }], meta: { page, perPage, total, totalPages } }`;
 *     its `id` is read as the same vehicle id `trackings` takes (active-units' ids are UUIDs too)
 *   - active-units → `[{ id, truck_number, vin }]`
 *   - units-by-usdot (v2) → `{ units: [{ truck_number, vin, coordinates: { lat, lng }, timestamp }] }`
 *   - trackings    → `[{ address, coordinates: { lat, lng }, rotation, speed, driverId, odometer, date }]`
 *     in chronological order. There are **no engine hours** anywhere in the read API.
 * Neither page documents pagination, rate limits or error codes; the API itself answers a
 * missing or unknown provider token with HTTP 404 `{"message":"Provider token not found."}`,
 * which this client reads as a refused credential, not as a missing page.
 *
 * Answers are parsed tolerantly: a list may be bare or wrapped (`data`, `units`, `items`,
 * `trackings`), numbers may arrive as strings, coordinates may be nested or flat, and a field
 * that is missing, null, zero or not a number is unknown (null) rather than a value — the sync
 * never writes an unknown over a known.
 */

/** Five ELD's read API. `read.fiveeld.com` is the host that knows provider tokens (api.fiveeld.com answers "Provider token not found" to a valid one, seen 2026-10-21); `FIVEELD_BASE_URL` overrides it. */
export const FIVEELD_DEFAULT_BASE_URL = 'https://read.fiveeld.com';
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES_ON_429 = 4;
/** A hard ceiling on pages, should Five ELD ever page a list, so "there is more" cannot spin forever. */
const MAX_PAGES = 200;
/** Page size asked of `current-units`; Five ELD's documented example uses 10, a fleet fits in one or two pages of 100. */
const CURRENT_UNITS_PER_PAGE = 100;

export interface FiveEldCredentials {
  apiKey: string;
  providerToken: string;
  /** The company's USDOT number, as Five ELD knows it. A path parameter, not a secret. */
  usdot: string;
}

export interface FiveEldUnit {
  id: string;
  /** The unit number as Five ELD spells it (`truck_number`). */
  name: string;
  vin: string | null;
}

export interface FiveEldTrackPoint {
  /** When the point was recorded (`date`), ISO. */
  at: string;
  latitude: number | null;
  longitude: number | null;
  /** Five ELD's own words for the place; usually a full street address. */
  address: string | null;
  /** Whole, as Five ELD reports it; null when missing, zero or not a number. See `odometerUnit`. */
  odometer: number | null;
  speed: number | null;
  /** `rotation`, degrees clockwise from north. */
  headingDegrees: number | null;
  driverId: string | null;
}

/** Which Five ELD list the vehicles came from: the fleet as it stands, or the ones that moved lately. */
export type FiveEldUnitSource = 'current-units' | 'active-units';

/** One unit's last known position from the v2 tracking API: no vehicle id, so it is matched by VIN or unit number. */
export interface FiveEldUnitPosition {
  truckNumber: string;
  vin: string | null;
  latitude: number | null;
  longitude: number | null;
  /** The last tracking update, ISO; null when Five ELD gave none. */
  at: string | null;
}

export class FiveEldError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
    /** True when Five ELD refused the key or the token — never a reason to try another endpoint. */
    readonly refusedCredential = false,
  ) {
    super(message);
    this.name = 'FiveEldError';
  }
}

export interface FiveEldClientOptions {
  fetchImpl?: typeof fetch;
  /** How a wait is spent; tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
  baseUrl?: string;
}

export class FiveEldClient {
  readonly #apiKey: string;
  readonly #providerToken: string;
  readonly #usdot: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;
  readonly #baseUrl: string;

  constructor(credentials: FiveEldCredentials, options: FiveEldClientOptions = {}) {
    this.#apiKey = credentials.apiKey;
    this.#providerToken = credentials.providerToken;
    this.#usdot = encodeURIComponent(credentials.usdot.trim());
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.#baseUrl = (options.baseUrl ?? FIVEELD_DEFAULT_BASE_URL).replace(/\/+$/, '');
  }

  /**
   * Every vehicle Five ELD has on the account as active, moving or parked
   * (`current-units/:usdot?page&perPage&is_active=true`, paged by `meta.totalPages`). A truck
   * parked for a week is listed here; `active-units` only lists the ones that moved in its window.
   */
  async currentUnits(): Promise<FiveEldUnit[]> {
    const params = new URLSearchParams({ page: '1', perPage: String(CURRENT_UNITS_PER_PAGE), is_active: 'true' });
    const rows = await this.list(`/api/externalservice/current-units/${this.#usdot}`, params);
    const out = new Map<string, FiveEldUnit>();
    for (const row of rows) addUnit(out, row);
    return [...out.values()];
  }

  /**
   * The vehicles to sync: `current-units` first; when Five ELD does not know that endpoint (a 404
   * or 400 that is not about the credential) the vehicles active inside the window instead.
   * `source` says which list answered, so the caller can log it.
   */
  async listUnits(from: Date, to: Date): Promise<{ units: FiveEldUnit[]; source: FiveEldUnitSource; fallbackReason: string | null }> {
    try {
      return { units: await this.currentUnits(), source: 'current-units', fallbackReason: null };
    } catch (error) {
      if (!(error instanceof FiveEldError) || error.refusedCredential || (error.status !== 404 && error.status !== 400)) throw error;
      return { units: await this.activeUnits(from, to), source: 'active-units', fallbackReason: error.message };
    }
  }

  /**
   * Last known position of every unit on the USDOT, in one request (`/api/v2/units-by-usdot/:usdot`).
   * No vehicle id, speed, heading or address: good for "has this truck moved since we last looked",
   * not for the position itself.
   */
  async unitPositions(): Promise<FiveEldUnitPosition[]> {
    const body = await this.get(`/api/v2/units-by-usdot/${this.#usdot}`);
    const items = Array.isArray(body) ? body : listIn(record(body));
    const out: FiveEldUnitPosition[] = [];
    for (const item of items) {
      const row = record(item);
      const coords = record(row.coordinates);
      const lat = num(coords.lat ?? coords.latitude);
      const lon = num(coords.lng ?? coords.lon ?? coords.longitude);
      const fix = lat !== null && lon !== null && !(lat === 0 && lon === 0);
      out.push({
        truckNumber: (text(row.truck_number ?? row.truckNumber) ?? '').trim(),
        vin: text(row.vin),
        latitude: fix ? lat : null,
        longitude: fix ? lon : null,
        at: isoTime(row.timestamp ?? row.date),
      });
    }
    return out;
  }

  /** The vehicles that reported inside the window. With a one-day window it is the cheapest test. */
  async activeUnits(from: Date, to: Date): Promise<FiveEldUnit[]> {
    // Five ELD refuses a window over 72 hours ("Date range cannot exceed 72 hours", seen on
    // production 2026-10-21), so a longer one is read slice by slice, newest first, and a vehicle
    // seen in two slices is listed once.
    const out = new Map<string, FiveEldUnit>();
    for (const [sliceFrom, sliceTo] of slices(from, to)) {
      const rows = await this.list(`/api/externalservice/active-units/${this.#usdot}/`, window(sliceFrom, sliceTo));
      for (const row of rows) addUnit(out, row);
    }
    return [...out.values()];
  }

  /** One vehicle's tracking history inside the window, oldest first. */
  async trackings(vehicleId: string, from: Date, to: Date): Promise<FiveEldTrackPoint[]> {
    const rows = await this.list(
      `/api/externalservice/trackings/${this.#usdot}/${encodeURIComponent(vehicleId)}/`,
      window(from, to),
    );
    const out: FiveEldTrackPoint[] = [];
    for (const row of rows) {
      const at = isoTime(row.date ?? row.timestamp ?? row.time ?? row.at);
      if (!at) continue;
      const coords = record(row.coordinates ?? row.location ?? row.position);
      const lat = num(coords.lat ?? coords.latitude ?? row.lat ?? row.latitude);
      const lon = num(coords.lng ?? coords.lon ?? coords.longitude ?? row.lng ?? row.lon ?? row.longitude);
      // 0,0 is the Gulf of Guinea, not a truck: a missing fix, not a position.
      const fix = lat !== null && lon !== null && !(lat === 0 && lon === 0) && Math.abs(lat) <= 90 && Math.abs(lon) <= 180;
      const heading = num(row.rotation ?? row.heading ?? row.bearing);
      const odometer = positive(row.odometer);
      out.push({
        at,
        latitude: fix ? lat : null,
        longitude: fix ? lon : null,
        address: text(row.address),
        odometer: odometer === null ? null : Math.round(odometer),
        speed: num(row.speed),
        headingDegrees: heading !== null && heading >= 0 && heading <= 360 ? heading : null,
        driverId: text(row.driverId ?? row.driver_id),
      });
    }
    return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  }

  /**
   * The newest point of the window, or null when the vehicle sent nothing in it. One request;
   * the caller bounds the window (a day for a sync, a couple of hours for a position refresh).
   */
  async latestTracking(vehicleId: string, from: Date, to: Date): Promise<FiveEldTrackPoint | null> {
    // Same 72-hour limit as `activeUnits`: newest slice first, and the first slice with a point
    // ends the walk, so a vehicle that reported yesterday costs one request.
    for (const [sliceFrom, sliceTo] of slices(from, to)) {
      const points = await this.trackings(vehicleId, sliceFrom, sliceTo);
      if (points.length > 0) return points[points.length - 1] ?? null;
    }
    return null;
  }

  /**
   * A list, bare or wrapped, across pages when the answer carries `meta.totalPages` (the Trucks
   * and Drivers endpoints do; the two this client uses are documented without pagination, and a
   * bare array is read as the whole answer).
   */
  private async list(path: string, params: URLSearchParams): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const query = new URLSearchParams(params);
      if (page > 1) query.set('page', String(page));
      const body = await this.get(`${path}?${query.toString()}`);
      const items = Array.isArray(body) ? body : listIn(record(body));
      rows.push(...items.map(record));
      const meta = record(record(body).meta);
      const totalPages = num(meta.totalPages ?? meta.total_pages);
      const current = num(meta.page) ?? page;
      if (Array.isArray(body) || totalPages === null || current >= totalPages || items.length === 0) break;
    }
    return rows;
  }

  private async get(path: string, attempt = 0): Promise<unknown> {
    const endpoint = path.split('?')[0] ?? path;
    let response: Response;
    try {
      response = await this.#fetch(`${this.#baseUrl}${path}`, {
        method: 'GET',
        headers: { 'x-api-key': this.#apiKey, 'provider-token': this.#providerToken, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new FiveEldError(
        `Five ELD could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        null,
        true,
      );
    }

    if (response.status === 429) {
      if (attempt >= MAX_RETRIES_ON_429) {
        throw new FiveEldError('Five ELD kept answering "too many requests" (HTTP 429). Try again in a few minutes.', 429, true);
      }
      // Retry-After when Five ELD sends one, else 5, 10, 20, 40 seconds; never more than 60. Five
      // ELD sends no Retry-After and its limit is undocumented; a 2-second first wait did not clear it.
      const raw = response.headers.get('retry-after');
      const header = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
      const seconds = Number.isFinite(header) && header >= 0 ? header : 5 * 2 ** attempt;
      await this.#sleep(Math.min(seconds, 60) * 1000);
      return this.get(path, attempt + 1);
    }
    if (response.status === 401 || response.status === 403) {
      throw new FiveEldError(
        `Five ELD rejected the credentials (HTTP ${response.status}). Replace the credential.`,
        response.status,
        false,
        true,
      );
    }
    if (!response.ok) {
      // Five ELD says "Provider token not found." with a 404 and "The 'x-api-key' header is
      // required." with a 400: both are the credential, not the vehicle, and neither will pass
      // on a retry.
      const message = await messageOf(response);
      if ((response.status === 404 || response.status === 400) && /token|api[-_ ]?key|usdot/i.test(message)) {
        throw new FiveEldError(
          `Five ELD rejected the credentials (HTTP ${response.status}: ${message}). Replace the credential.`,
          response.status,
          false,
          true,
        );
      }
      throw new FiveEldError(
        `Five ELD answered HTTP ${response.status} for ${endpoint}${message ? ` (${message})` : ''}`,
        response.status,
        response.status >= 500,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new FiveEldError(`Five ELD sent an answer that is not JSON for ${endpoint}`, response.status, true);
    }
  }
}

/** Five ELD's longest accepted window. */
export const FIVEELD_MAX_WINDOW_MS = 72 * 3_600_000;

/** `[from, to]` cut into windows Five ELD accepts, newest first, so a short range is one slice. */
export function slices(from: Date, to: Date): Array<[Date, Date]> {
  const out: Array<[Date, Date]> = [];
  let end = to.getTime();
  while (end > from.getTime()) {
    const start = Math.max(from.getTime(), end - FIVEELD_MAX_WINDOW_MS);
    out.push([new Date(start), new Date(end)]);
    end = start;
  }
  return out;
}

function window(from: Date, to: Date): URLSearchParams {
  return new URLSearchParams({ from: from.toISOString(), to: to.toISOString() });
}

function listIn(body: Record<string, unknown>): unknown[] {
  for (const key of ['data', 'units', 'items', 'trackings', 'results', 'vehicles']) {
    if (Array.isArray(body[key])) return body[key] as unknown[];
  }
  return [];
}

/** The provider's `message`, short and without anything that could be a secret echoed back. */
async function messageOf(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as unknown;
    const message = text(record(body).message ?? record(body).error);
    return message ? message.slice(0, 120) : '';
  } catch {
    return '';
  }
}

/** One vehicle row of `current-units` or `active-units`, added once by its id. */
function addUnit(out: Map<string, FiveEldUnit>, row: Record<string, unknown>): void {
  const u = record(row.unit ?? row.vehicle ?? row);
  const id = idOf(u.id ?? u.vehicleId ?? u.vehicle_id ?? u.unitId);
  if (id === '' || out.has(id)) return;
  out.set(id, {
    id,
    name: (text(u.truck_number ?? u.truckNumber ?? u.number ?? u.name) ?? '').trim(),
    vin: text(u.vin),
  });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function idOf(value: unknown): string {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? value.trim() : '';
}

function text(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function num(value: unknown): number | null {
  const n = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : Number.NaN;
  return Number.isFinite(n) ? n : null;
}

/** A reading that is zero or below is a sensor that did not report, not a truck with no miles. */
function positive(value: unknown): number | null {
  const n = num(value);
  return n !== null && n > 0 ? n : null;
}

function isoTime(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    // Seconds or milliseconds since the epoch; anything before 2001 in ms is seconds.
    const ms = value < 1e12 ? value * 1000 : value;
    return new Date(ms).toISOString();
  }
  const t = text(value);
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}
