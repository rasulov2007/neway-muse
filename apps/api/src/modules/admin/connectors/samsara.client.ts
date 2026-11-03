/**
 * Samsara, read-only.
 *
 * Three requests, all GET: who the token belongs to, the vehicle list, and the latest odometer,
 * engine-hour and GPS reading per vehicle. Nothing here writes to Samsara and nothing here can —
 * there is no method that would, which is the rule the fleet specification sets ("never write to
 * Samsara without separate approval") made structural rather than remembered.
 *
 * The token arrives as a constructor argument, is held in a private field and is never logged,
 * never thrown inside an error message, and never returned. An error names the status Samsara
 * gave, not the header we sent.
 */

const BASE_URL = 'https://api.samsara.com';
const PAGE_SIZE = 512;
const REQUEST_TIMEOUT_MS = 30_000;
/** Samsara's stats endpoint accepts at most three types per request. */
const STATS_TYPES_PER_REQUEST = 3;
const MAX_RETRIES_ON_429 = 3;

export interface SamsaraVehicle {
  id: string;
  name: string;
  vin: string | null;
  make: string | null;
  model: string | null;
  year: number | null;
  licensePlate: string | null;
  /** When Samsara last changed the record; not when the vehicle last reported. */
  updatedAt: string | null;
}

export interface SamsaraVehicleStats {
  id: string;
  name: string;
  /** Odometer from the engine computer; the one to prefer. Miles, rounded. */
  obdOdometerMiles: number | null;
  obdOdometerAt: string | null;
  /** Odometer derived from GPS; a fallback when the ECU does not report one. */
  gpsOdometerMiles: number | null;
  gpsOdometerAt: string | null;
  engineHours: number | null;
  engineHoursAt: string | null;
  gps: {
    at: string;
    latitude: number;
    longitude: number;
    place: string | null;
    speedMph: number | null;
    /** Degrees clockwise from north. Null when the vehicle is not moving enough to have one. */
    headingDegrees: number | null;
  } | null;
  /** on · off · idle, as Samsara last saw the engine. */
  engineState: 'on' | 'off' | 'idle' | null;
  engineStateAt: string | null;
}

export interface SamsaraOrganisation {
  id: string;
  name: string;
}

export class SamsaraError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'SamsaraError';
  }
}

interface Page<T> {
  data: T[];
  pagination?: { endCursor?: string; hasNextPage?: boolean };
}

/** Meters to miles, whole. Samsara reports meters; the roster stores miles. */
export function metersToMiles(meters: number): number {
  return Math.round(meters / 1609.344);
}

export class SamsaraClient {
  readonly #token: string;
  readonly #fetch: typeof fetch;

  constructor(token: string, fetchImpl: typeof fetch = fetch) {
    this.#token = token;
    this.#fetch = fetchImpl;
  }

  /** Who the token belongs to. The cheapest request there is, so it doubles as the test. */
  async organisation(): Promise<SamsaraOrganisation> {
    const body = (await this.get('/me')) as { data?: { id?: string; name?: string } };
    return { id: String(body.data?.id ?? ''), name: String(body.data?.name ?? '') };
  }

  /** Every vehicle in the organisation, across every page. */
  async vehicles(): Promise<SamsaraVehicle[]> {
    const rows = await this.paginate<Record<string, unknown>>('/fleet/vehicles', {});
    return rows.map((row) => ({
      id: String(row.id ?? ''),
      name: String(row.name ?? '').trim(),
      vin: text(row.vin),
      make: text(row.make),
      model: text(row.model),
      year: year(row.year),
      licensePlate: text(row.licensePlate),
      updatedAt: text(row.updatedAtTime),
    }));
  }

  /**
   * The latest reading of each kind, per vehicle.
   *
   * Two requests because Samsara takes at most three stat types in one; the results are merged by
   * vehicle id so the caller sees one record per vehicle.
   */
  async vehicleStats(): Promise<SamsaraVehicleStats[]> {
    const wanted = ['obdOdometerMeters', 'gpsOdometerMeters', 'gps', 'obdEngineSeconds', 'engineStates'];
    const merged = new Map<string, SamsaraVehicleStats>();
    for (let i = 0; i < wanted.length; i += STATS_TYPES_PER_REQUEST) {
      const types = wanted.slice(i, i + STATS_TYPES_PER_REQUEST).join(',');
      const rows = await this.paginate<Record<string, unknown>>('/fleet/vehicles/stats', { types });
      for (const row of rows) {
        const id = String(row.id ?? '');
        const current = merged.get(id) ?? {
          id,
          name: String(row.name ?? '').trim(),
          obdOdometerMiles: null,
          obdOdometerAt: null,
          gpsOdometerMiles: null,
          gpsOdometerAt: null,
          engineHours: null,
          engineHoursAt: null,
          gps: null,
          engineState: null,
          engineStateAt: null,
        };
        const obd = reading(row.obdOdometerMeters);
        if (obd) {
          current.obdOdometerMiles = metersToMiles(obd.value);
          current.obdOdometerAt = obd.time;
        }
        const gpsOdo = reading(row.gpsOdometerMeters);
        if (gpsOdo) {
          current.gpsOdometerMiles = metersToMiles(gpsOdo.value);
          current.gpsOdometerAt = gpsOdo.time;
        }
        const engineSeconds = reading(row.obdEngineSeconds);
        if (engineSeconds) {
          current.engineHours = Math.round((engineSeconds.value / 3600) * 10) / 10;
          current.engineHoursAt = engineSeconds.time;
        }
        const gps = row.gps as
          | {
              time?: string;
              latitude?: number;
              longitude?: number;
              speedMilesPerHour?: number;
              headingDegrees?: number;
              reverseGeo?: { formattedLocation?: string };
            }
          | undefined;
        if (gps && typeof gps.latitude === 'number' && typeof gps.longitude === 'number' && gps.time) {
          current.gps = {
            at: gps.time,
            latitude: gps.latitude,
            longitude: gps.longitude,
            place: gps.reverseGeo?.formattedLocation ?? null,
            speedMph: typeof gps.speedMilesPerHour === 'number' ? gps.speedMilesPerHour : null,
            headingDegrees:
              typeof gps.headingDegrees === 'number' && Number.isFinite(gps.headingDegrees)
                ? gps.headingDegrees
                : null,
          };
        }
        const engine = row.engineStates as { time?: string; value?: string } | undefined;
        if (engine && typeof engine.time === 'string' && typeof engine.value === 'string') {
          const value = engine.value.toLowerCase();
          current.engineState = value === 'on' ? 'on' : value === 'idle' ? 'idle' : 'off';
          current.engineStateAt = engine.time;
        }
        merged.set(id, current);
      }
    }
    return [...merged.values()];
  }

  private async paginate<T>(path: string, params: Record<string, string>): Promise<T[]> {
    const rows: T[] = [];
    let after: string | undefined;
    // A hard ceiling on pages, so a provider that always says "there is more" cannot spin forever.
    for (let page = 0; page < 200; page += 1) {
      const query = new URLSearchParams({ ...params, limit: String(PAGE_SIZE) });
      if (after) query.set('after', after);
      const body = (await this.get(`${path}?${query.toString()}`)) as Page<T>;
      rows.push(...(body.data ?? []));
      if (!body.pagination?.hasNextPage || !body.pagination.endCursor) break;
      after = body.pagination.endCursor;
    }
    return rows;
  }

  private async get(path: string, attempt = 0): Promise<unknown> {
    let response: Response;
    try {
      response = await this.#fetch(`${BASE_URL}${path}`, {
        method: 'GET',
        headers: { Authorization: `Bearer ${this.#token}`, Accept: 'application/json' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (error) {
      throw new SamsaraError(
        `Samsara could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        null,
        true,
      );
    }

    if (response.status === 429 && attempt < MAX_RETRIES_ON_429) {
      const wait = Number(response.headers.get('retry-after') ?? '2');
      await new Promise((resolve) => setTimeout(resolve, Math.min(wait, 30) * 1000));
      return this.get(path, attempt + 1);
    }
    if (response.status === 401 || response.status === 403) {
      throw new SamsaraError(
        `Samsara rejected the token (HTTP ${response.status}). Replace the credential.`,
        response.status,
        false,
      );
    }
    if (!response.ok) {
      throw new SamsaraError(
        `Samsara answered HTTP ${response.status} for ${path.split('?')[0]}`,
        response.status,
        response.status >= 500,
      );
    }
    return response.json();
  }
}

function text(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return trimmed === '' ? null : trimmed;
}

function year(value: unknown): number | null {
  const n = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10);
  return Number.isInteger(n) && n >= 1980 && n <= 2100 ? n : null;
}

function reading(value: unknown): { time: string; value: number } | null {
  const v = value as { time?: unknown; value?: unknown } | undefined;
  if (!v || typeof v.value !== 'number' || typeof v.time !== 'string') return null;
  return { time: v.time, value: v.value };
}
