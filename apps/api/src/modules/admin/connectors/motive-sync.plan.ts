import type { SyncVehicleLine } from '@neway/shared';
import type { MotiveVehicle, MotiveVehicleLocation } from './motive.client';
import type { SamsaraVehicle, SamsaraVehicleStats } from './samsara.client';
import { planSamsaraSync, type PlanOptions, type SyncPlan, type TruckSnapshot } from './samsara-sync.plan';

/**
 * What a Motive sync would do.
 *
 * The rules are the Samsara sync's rules, run by the same planner, so a unit is matched, kept
 * from duplicating and protected from a lowered odometer the same way whichever ELD reports it:
 * inactive vehicles skipped, the same unit number twice resolved to the newest reading, matching
 * by the remembered Motive id, then VIN, then unit number, an odometer that only moves forward,
 * and a truck another provider's account has linked left to that account (see rule 3b in
 * samsara-sync.plan.ts). This file only translates Motive's records into the planner's shape.
 *
 * One rule is Motive's own: a vehicle Motive marks `deactivated` is reported as inactive and
 * never matched, whatever its last location says.
 */

/** "3.2 mi NE of Seattle, WA" → "Seattle, WA": the distance prefix is not a city. */
export function motivePlace(place: string | null): string | null {
  if (!place) return null;
  const stripped = place.replace(/^\s*[\d.]+\s*(mi|km|miles?)\s+[NSEW]{1,3}\s+of\s+/i, '').trim();
  return stripped === '' ? null : stripped;
}

export function toPlannerVehicle(v: MotiveVehicle): SamsaraVehicle {
  return {
    id: v.id,
    name: v.name,
    vin: v.vin,
    make: v.make,
    model: v.model,
    year: v.year,
    licensePlate: v.licensePlate,
    updatedAt: v.updatedAt,
  };
}

/** One location record as the planner's "latest readings". All of it is read at `at`. */
export function toPlannerStats(loc: MotiveVehicleLocation): SamsaraVehicleStats {
  const at = loc.at;
  return {
    id: loc.id,
    name: loc.name,
    // Motive reads the odometer from the engine computer; it is the planner's preferred kind.
    obdOdometerMiles: at && loc.odometerMiles !== null ? loc.odometerMiles : null,
    obdOdometerAt: at && loc.odometerMiles !== null ? at : null,
    gpsOdometerMiles: null,
    gpsOdometerAt: null,
    engineHours: at ? loc.engineHours : null,
    engineHoursAt: at && loc.engineHours !== null ? at : null,
    gps:
      at && loc.latitude !== null && loc.longitude !== null
        ? {
            at,
            latitude: loc.latitude,
            longitude: loc.longitude,
            place: motivePlace(loc.place),
            speedMph: loc.speedMph,
            headingDegrees: loc.headingDegrees,
          }
        : null,
    engineState: loc.engineState,
    engineStateAt: loc.engineState ? at : null,
  };
}

export function planMotiveSync(
  vehicles: MotiveVehicle[],
  locations: MotiveVehicleLocation[],
  trucks: TruckSnapshot[],
  options: Omit<PlanOptions, 'provider' | 'providerLabel'>,
): SyncPlan {
  const deactivated = vehicles.filter((v) => v.status === 'deactivated');
  const live = vehicles.filter((v) => v.status !== 'deactivated');

  // A vehicle the location feed knows but the vehicle list does not still counts: the feed
  // carries its unit number (not its VIN), so the planner can match it by number.
  const listed = new Set(vehicles.map((v) => v.id));
  const extra: SamsaraVehicle[] = locations
    .filter((l) => !listed.has(l.id) && l.name !== '')
    .map((l) => ({ id: l.id, name: l.name, vin: null, make: null, model: null, year: null, licensePlate: null, updatedAt: null }));

  const plan = planSamsaraSync(
    [...live.map(toPlannerVehicle), ...extra],
    locations.map(toPlannerStats),
    trucks,
    { ...options, provider: 'motive', providerLabel: 'Motive' },
  );

  const retired: SyncVehicleLine[] = deactivated.map((v) => ({
    externalId: v.id,
    name: v.name,
    vin: v.vin,
    truckId: null,
    unitNumber: null,
    odometerBefore: null,
    odometerAfter: null,
    lastSeenAt: locations.find((l) => l.id === v.id)?.at ?? null,
    note: 'Deactivated in Motive',
  }));
  plan.inactive.push(...retired);
  plan.summary.fetched += deactivated.length;
  plan.summary.inactive = plan.inactive.length;
  return plan;
}
