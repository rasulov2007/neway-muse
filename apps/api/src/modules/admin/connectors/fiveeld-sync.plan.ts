import type { FiveEldTrackPoint, FiveEldUnit, FiveEldUnitPosition } from './fiveeld.client';
import type { SamsaraVehicle, SamsaraVehicleStats } from './samsara.client';
import { planSamsaraSync, type PlanOptions, type SyncPlan, type TruckSnapshot } from './samsara-sync.plan';

/**
 * What a Five ELD sync would do.
 *
 * The rules are the Samsara sync's rules, run by the same planner, so a unit is matched, kept
 * from duplicating and protected from a lowered odometer the same way whichever ELD reports it:
 * inactive vehicles skipped, the same unit number twice resolved to the newest reading, matching
 * by the remembered Five ELD id, then VIN, then unit number, an odometer that only moves forward,
 * and a truck another provider's account has linked left to that account (see rule 3b in
 * samsara-sync.plan.ts). This file only translates Five ELD's records into the planner's shape.
 *
 * What Five ELD gives per vehicle is its newest tracking point: a GPS fix, a speed, a heading,
 * an address and — on most points — an odometer. It gives no engine hours and no engine state,
 * so those stay unknown (null) and are never written; the engine state the map shows is derived
 * from the speed alone (moving = on, otherwise off).
 */

export const FIVEELD_PROVIDER = 'fiveeld';
export const FIVEELD_LABEL = 'Five ELD';

/** Five ELD does not say which unit its odometer is in; miles unless the account says `km`. */
export type FiveEldOdometerUnit = 'mi' | 'km';
const MILES_PER_KM = 0.621371;

export interface FiveEldReading {
  unit: FiveEldUnit;
  /**
   * The point that places the vehicle: the newest one with a GPS fix, else the newest point at
   * all; null when the vehicle sent nothing in the inactive window.
   */
  latest: FiveEldTrackPoint | null;
  /**
   * The newest point carrying a real odometer (> 0), which may be older than `latest`: a parked
   * truck's ELD sends position-only or `odometer: 0` points. Undefined means "take the odometer
   * from `latest`" (the position refresh); null means none was found.
   */
  odometerPoint?: FiveEldTrackPoint | null;
}

/** Hours of the first, recent window a sync reads per vehicle. */
export const FIVEELD_RECENT_WINDOW_HOURS = 24;
/** Five ELD's longest accepted tracking window; older history is read in slices of this size. */
export const FIVEELD_SLICE_HOURS = 72;

export interface FiveEldWalkOptions {
  now: Date;
  /** How far back a vehicle is looked for at all; older than this it is inactive. */
  inactiveAfterDays: number;
  /**
   * When the roster already holds an odometer read at this time or later for the vehicle, a slice
   * that ends before it cannot improve on it, and the walk stops there.
   */
  knownOdometerAt?: Date | null;
}

/**
 * One vehicle's reading, as few requests as the answer allows: the last 24 hours first; when they
 * hold no point, or no point with an odometer above zero, older history in 72-hour slices, newest
 * first, back to the inactive window, stopping at the first slice with a real odometer.
 * `fetch(from, to)` is one Five ELD trackings request; pacing and the 429 backoff are its business.
 *
 * Position = the newest point with a fix (else the newest point); odometer = the newest point with
 * an odometer above zero, at its own time. An `odometer: 0` point never hides an older real one,
 * and a vehicle with no point in the whole window has neither (the planner calls it inactive).
 */
export async function readFiveEldVehicle(
  unit: FiveEldUnit,
  fetch: (from: Date, to: Date) => Promise<FiveEldTrackPoint[]>,
  options: FiveEldWalkOptions,
): Promise<FiveEldReading & { requests: number }> {
  const now = options.now.getTime();
  const oldest = now - options.inactiveAfterDays * 86_400_000;
  const windows: Array<[number, number]> = [];
  const recentFrom = Math.max(oldest, now - FIVEELD_RECENT_WINDOW_HOURS * 3_600_000);
  windows.push([recentFrom, now]);
  for (let end = recentFrom; end > oldest; ) {
    const start = Math.max(oldest, end - FIVEELD_SLICE_HOURS * 3_600_000);
    windows.push([start, end]);
    end = start;
  }

  let position: FiveEldTrackPoint | null = null;
  let newest: FiveEldTrackPoint | null = null;
  let odometer: FiveEldTrackPoint | null = null;
  let requests = 0;
  const known = options.knownOdometerAt ? options.knownOdometerAt.getTime() : null;
  for (const [index, [from, to]] of windows.entries()) {
    if (index > 0 && known !== null && to <= known) break;
    const points = await fetch(new Date(from), new Date(to));
    requests += 1;
    // Newest first inside the slice; slices themselves arrive newest first.
    const sorted = [...points].sort((a, b) => Date.parse(b.at) - Date.parse(a.at));
    for (const p of sorted) {
      if (!newest) newest = p;
      if (!position && p.latitude !== null && p.longitude !== null) position = p;
      if (!odometer && p.odometer !== null && p.odometer > 0) odometer = p;
    }
    if (odometer) break;
  }
  return { unit, latest: position ?? newest, odometerPoint: odometer, requests };
}

export function toPlannerVehicle(u: FiveEldUnit): SamsaraVehicle {
  return {
    id: u.id,
    name: u.name,
    vin: u.vin,
    make: null,
    model: null,
    year: null,
    licensePlate: null,
    updatedAt: null,
  };
}

/**
 * One tracking point as the planner's "latest readings", all read at `at` — or, when
 * `odometerPoint` is given, the odometer from that point at its own time and the rest from `point`.
 */
export function toPlannerStats(
  id: string,
  name: string,
  point: FiveEldTrackPoint | null,
  odometerUnit: FiveEldOdometerUnit = 'mi',
  odometerPoint?: FiveEldTrackPoint | null,
): SamsaraVehicleStats {
  const at = point?.at ?? null;
  const source = odometerPoint === undefined ? point : odometerPoint;
  const odometerAt = source?.at ?? null;
  const miles =
    source && source.odometer !== null && source.odometer > 0
      ? Math.round(odometerUnit === 'km' ? source.odometer * MILES_PER_KM : source.odometer)
      : null;
  const speed = point?.speed ?? null;
  return {
    id,
    name,
    // Five ELD's odometer comes from the ELD on the engine bus; it is the planner's preferred kind.
    obdOdometerMiles: odometerAt && miles !== null ? miles : null,
    obdOdometerAt: odometerAt && miles !== null ? odometerAt : null,
    gpsOdometerMiles: null,
    gpsOdometerAt: null,
    // Five ELD's read API carries no engine hours. Unknown, never 0.
    engineHours: null,
    engineHoursAt: null,
    gps:
      at && point && point.latitude !== null && point.longitude !== null
        ? {
            at,
            latitude: point.latitude,
            longitude: point.longitude,
            place: point.address,
            speedMph: speed,
            headingDegrees: point.headingDegrees,
          }
        : null,
    engineState: at && speed !== null ? (speed > 0 ? 'on' : 'off') : null,
    engineStateAt: at && speed !== null ? at : null,
  };
}

/**
 * Which linked trucks a position refresh should read, given `units-by-usdot`'s last-report times.
 * A truck is matched to a v2 unit by VIN, else by unit number; it is read when that unit reported
 * after the position we hold (or we hold none). A truck v2 does not name — or every truck, when v2
 * gave no answer (`positions` null) — is read, as before v2 was asked.
 */
export function trucksWithNewerReport(
  linked: Array<{ id: string; unitNumber: string; vin: string | null; locationAt: Date | null }>,
  positions: FiveEldUnitPosition[] | null,
): Set<string> {
  if (positions === null) return new Set(linked.map((t) => t.id));
  const byVin = new Map<string, FiveEldUnitPosition>();
  const byNumber = new Map<string, FiveEldUnitPosition>();
  for (const p of positions) {
    const vin = (p.vin ?? '').trim().toUpperCase();
    if (vin) byVin.set(vin, p);
    const number = p.truckNumber.trim().toUpperCase();
    if (number) byNumber.set(number, p);
  }
  const out = new Set<string>();
  for (const t of linked) {
    const p = byVin.get((t.vin ?? '').trim().toUpperCase()) ?? byNumber.get(t.unitNumber.trim().toUpperCase());
    const reported = p?.at ? Date.parse(p.at) : null;
    if (!p || reported === null || t.locationAt === null || reported > t.locationAt.getTime()) out.add(t.id);
  }
  return out;
}

export interface FiveEldPlanOptions extends Omit<PlanOptions, 'provider' | 'providerLabel'> {
  odometerUnit?: FiveEldOdometerUnit;
}

export function planFiveEldSync(
  readings: FiveEldReading[],
  trucks: TruckSnapshot[],
  options: FiveEldPlanOptions,
): SyncPlan {
  const { odometerUnit, ...rest } = options;
  return planSamsaraSync(
    readings.map((r) => toPlannerVehicle(r.unit)),
    readings.map((r) => toPlannerStats(r.unit.id, r.unit.name, r.latest, odometerUnit, r.odometerPoint)),
    trucks,
    { ...rest, provider: FIVEELD_PROVIDER, providerLabel: FIVEELD_LABEL },
  );
}
