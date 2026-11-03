/**
 * Motive (formerly KeepTruckin), read-only.
 *
 * Three requests, all GET: the company behind the key (`/v1/companies`), the vehicle list
 * (`/v1/vehicles`) and the latest location of every vehicle, which carries its odometer and
 * engine hours (`/v2/vehicle_locations`). Nothing here writes to Motive and nothing here can:
 * there is no method that would.
 *
 * The key arrives as a constructor argument, is held in a private field and is sent only in the
 * `X-Api-Key` header. It is never logged, never part of a URL, never inside an error message.
 *
 * Motive's answers are parsed tolerantly: a list item may be `{ vehicle: {...} }` or the vehicle
 * itself, numbers may arrive as strings, and a field that is missing, null, zero or not a number
 * is unknown (null) rather than a value — the sync never writes an unknown over a known.
 */

const BASE_URL = 'https://api.gomotive.com';
/** Motive's documented maximum page size. */
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES_ON_429 = 4;
/** A hard ceiling on pages, so a provider that always says "there is more" cannot spin forever. */
const MAX_PAGES = 200;

export interface MotiveVehicle {
  id: string;
  /** The unit number as Motive spells it (`number`). */
  name: string;
  vin: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  licensePlate: string | null;
  licensePlateState: string | null;
  /** `active` or `deactivated`; null when Motive did not say. */
  status: string | null;
  updatedAt: string | null;
}

export interface MotiveVehicleLocation {
  id: string;
  name: string;
  /** Miles, whole. The adjusted (`true_odometer`) reading when Motive has one, else `odometer`. */
  odometerMiles: number | null;
  /** Hours, one decimal. `true_engine_hours` first, then `engine_hours`. */
  engineHours: number | null;
  /** When the location (and the odometer read with it) was recorded. */
  at: string | null;
  latitude: number | null;
  longitude: number | null;
  /** Motive's own words for the place, usually "City, ST". */
  place: string | null;
  speedMph: number | null;
  headingDegrees: number | null;
  /** Read from the location's `type` (vehicle_moving, vehicle_stopped, engine_off …). */
  engineState: 'on' | 'off' | 'idle' | null;
}

export interface MotiveCompany {
  id: string;
  name: string;
}

export class MotiveError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'MotiveError';
  }
}

export interface MotiveClientOptions {
  fetchImpl?: typeof fetch;
  /** How a wait is spent; tests pass one that returns at once. */
  sleep?: (ms: number) => Promise<void>;
}

export class MotiveClient {
  readonly #key: string;
  readonly #fetch: typeof fetch;
  readonly #sleep: (ms: number) => Promise<void>;

  constructor(apiKey: string, options: MotiveClientOptions = {}) {
    this.#key = apiKey;
    this.#fetch = options.fetchImpl ?? fetch;
    this.#sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /** The company the key belongs to. The cheapest request there is, so it doubles as the test. */
  async company(): Promise<MotiveCompany> {
    const body = record(await this.get('/v1/companies'));
    const list = Array.isArray(body.companies) ? body.companies : [];
    const first = record(list[0]);
    const company = record(first.company ?? body.company ?? first);
    return { id: idOf(company.id), name: text(company.name) ?? '' };
  }

  /** Every vehicle in the company, across every page. */
  async vehicles(): Promise<MotiveVehicle[]> {
    const rows = await this.paginate('/v1/vehicles', 'vehicles');
    return rows
      .map((row) => {
        const v = record(row.vehicle ?? row);
        return {
          id: idOf(v.id),
          name: (text(v.number) ?? '').trim(),
          vin: text(v.vin),
          make: text(v.make),
          model: text(v.model),
          year: year(v.year),
          licensePlate: text(v.license_plate_number),
          licensePlateState: text(v.license_plate_state),
          status: text(v.status)?.toLowerCase() ?? null,
          updatedAt: text(v.updated_at),
        };
      })
      .filter((v) => v.id !== '');
  }

  /** The latest location of every vehicle, with the odometer and engine hours read with it. */
  async vehicleLocations(): Promise<MotiveVehicleLocation[]> {
    const rows = await this.paginate('/v2/vehicle_locations', 'vehicles');
    const out: MotiveVehicleLocation[] = [];
    for (const row of rows) {
      const v = record(row.vehicle ?? row);
      const id = idOf(v.id);
      if (id === '') continue;
      const loc = record(v.current_location);
      const lat = num(loc.lat ?? loc.latitude);
      const lon = num(loc.lon ?? loc.lng ?? loc.longitude);
      const odometer = positive(loc.true_odometer) ?? positive(loc.odometer);
      const hours = positive(loc.true_engine_hours) ?? positive(loc.engine_hours);
      const heading = num(loc.bearing);
      out.push({
        id,
        name: (text(v.number) ?? '').trim(),
        odometerMiles: odometer === null ? null : Math.round(odometer),
        engineHours: hours === null ? null : Math.round(hours * 10) / 10,
        at: isoTime(loc.located_at),
        // 0,0 is the Gulf of Guinea, not a truck: a missing fix, not a position.
        latitude: lat !== null && lon !== null && !(lat === 0 && lon === 0) ? lat : null,
        longitude: lat !== null && lon !== null && !(lat === 0 && lon === 0) ? lon : null,
        place: text(loc.description),
        speedMph: num(loc.speed),
        headingDegrees: heading !== null && heading >= 0 && heading <= 360 ? heading : null,
        engineState: engineState(text(loc.type), num(loc.speed)),
      });
    }
    return out;
  }

  private async paginate(path: string, listKey: string): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    for (let page = 1; page <= MAX_PAGES; page += 1) {
      const query = new URLSearchParams({ per_page: String(PAGE_SIZE), page_no: String(page) });
      const body = record(await this.get(`${path}?${query.toString()}`));
      const items = Array.isArray(body[listKey]) ? (body[listKey] as unknown[]) : [];
      rows.push(...items.map(record));
      const pagination = record(body.pagination);
      const total = num(pagination.total);
      const perPage = num(pagination.per_page) ?? PAGE_SIZE;
      if (items.length === 0) break;
      if (total !== null ? page * perPage >= total : items.length < perPage) break;
    }
    return rows;
  }

  private async get(path: string, attempt = 0): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${BASE_URL}${path}`, {
        method: 'GET',
        headers: { 'X-Api-Key': this.#key, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new MotiveError(
        `Motive could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        null,
        true,
      );
    }

    if (response.status === 429) {
      if (attempt >= MAX_RETRIES_ON_429) {
        throw new MotiveError('Motive kept answering "too many requests" (HTTP 429). Try again in a few minutes.', 429, true);
      }
      // Retry-After when Motive sends one, else 2, 4, 8, 16 seconds; never more than 30.
      const raw = response.headers.get('retry-after');
      const header = raw === null || raw.trim() === '' ? Number.NaN : Number(raw);
      const seconds = Number.isFinite(header) && header >= 0 ? header : 2 ** (attempt + 1);
      await this.#sleep(Math.min(seconds, 30) * 1000);
      return this.get(path, attempt + 1);
    }
    if (response.status === 401 || response.status === 403) {
      throw new MotiveError(
        `Motive rejected the API key (HTTP ${response.status}). Replace the credential.`,
        response.status,
        false,
      );
    }
    if (!response.ok) {
      throw new MotiveError(
        `Motive answered HTTP ${response.status} for ${path.split('?')[0]}`,
        response.status,
        response.status >= 500,
      );
    }
    try {
      return await response.json();
    } catch {
      throw new MotiveError(`Motive sent an answer that is not JSON for ${path.split('?')[0]}`, response.status, true);
    }
  }
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

function year(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n >= 1980 && n <= 2100 ? n : null;
}

function isoTime(value: unknown): string | null {
  const t = text(value);
  if (!t) return null;
  const ms = Date.parse(t);
  return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
}

function engineState(type: string | null, speed: number | null): 'on' | 'off' | 'idle' | null {
  const t = (type ?? '').toLowerCase();
  if (t.includes('idl')) return 'idle';
  if (t.includes('moving') || t.includes('engine_on') || t === 'on') return 'on';
  if (t.includes('off') || t.includes('stopped') || t.includes('parked')) return 'off';
  if (speed !== null) return speed > 0 ? 'on' : null;
  return null;
}
