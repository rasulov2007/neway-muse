import {
  SYNC_INACTIVE_AFTER_DAYS,
  SYNC_ODOMETER_ROLLBACK_TOLERANCE_MILES,
  type SyncSummary,
  type SyncVehicleLine,
} from '@neway/shared';
import type { SamsaraVehicle, SamsaraVehicleStats } from './samsara.client';

/**
 * What a sync would do, decided before anything is done.
 *
 * Pure: vehicles and readings in, a plan out, no database and no clock of its own. That is what
 * lets the same function answer a preview and drive an apply, and what lets the rules be tested
 * with a dozen made-up vehicles instead of a Samsara account.
 *
 * The rules, in the order they run:
 *
 *  1. **Inactive.** A vehicle with no odometer, engine or GPS reading inside the window is one
 *     Samsara still lists and nobody drives. It is reported and skipped, and it never becomes a
 *     truck. The carrier's own account carries retired units for years; the roster must not.
 *  2. **Duplicates.** The same unit number two or three times in one account — a re-added
 *     vehicle, a gateway swap. The one with the newest reading is the vehicle; the rest are
 *     reported as duplicates and ignored. Two inactive copies of an active unit are still just
 *     inactive.
 *  3. **Matching.** A truck that already remembers this vehicle (by account and external id) is
 *     the same truck. Otherwise the VIN, when both sides have one. Otherwise the unit number.
 *  4. **Conflicts.** An odometer is not lowered. A provider reading below ours by more than the
 *     tolerance is reported, not applied; a small dip is a rounding difference and is ignored.
 *  5. **Unmatched.** Active in Samsara, unknown to the roster. Listed, and created only when the
 *     run asked for that and Samsara knows the VIN — a truck cannot be created without one.
 */

export interface TruckSnapshot {
  id: string;
  unitNumber: string;
  vin: string;
  status: string;
  odometer: number;
  odometerAt: Date;
  telematicsAccountId: string | null;
  telematicsExternalId: string | null;
  /** The provider of the account the truck is linked to ('samsara', 'motive', 'fiveeld'), or a hand-typed name. */
  telematicsProvider?: string | null;
  /** When the stored position was taken, so a newer GPS fix counts as a change on a parked truck. */
  locationAt?: Date | null;
}

export interface PlannedUpdate {
  truckId: string;
  externalId: string;
  odometer: number | null;
  odometerAt: string | null;
  engineHours: number | null;
  /** In the roster's own shape, ready to store. */
  location: TruckLocation | null;
  line: SyncVehicleLine;
  /**
   * Only the odometer moves: the truck stays linked to the ELD that places it, which sends no
   * odometer for it (owner, 2026-10-29: 0078's Samsara sends GPS only, Five ELD has the miles).
   */
  odometerOnly?: boolean;
}

/** The roster's location record; see `TruckLocationSchema` in the shared contract. */
export interface TruckLocation {
  lat: number;
  lng: number;
  city: string;
  state: string;
  updatedAt: string;
  speedMph: number;
  headingDegrees?: number | null;
  engineState: 'on' | 'off' | 'idle';
}

/**
 * "1850 Diehl Rd, Naperville, IL 60563" → Naperville, IL. Samsara formats its reverse geocode as
 * street, city, state-and-zip; anything shorter gives what it can and leaves the rest blank.
 */
export function placeToCityState(place: string | null): { city: string; state: string } {
  if (!place) return { city: '', state: '' };
  const parts = place
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean);
  // Production strings end with the country ("…, PA, USA"); it is not a state.
  while (
    parts.length > 1 &&
    /^(USA|US|United States|Canada|Mexico)$/i.test(parts[parts.length - 1] ?? '')
  )
    parts.pop();
  if (parts.length === 0) return { city: '', state: '' };
  // The state is the last part that reads as "ST" or "ST 60563"; the city is the part before it.
  for (let i = parts.length - 1; i >= 0; i -= 1) {
    const match = /^([A-Z]{2})(?:\s+\d{5}(?:-\d{4})?)?$/.exec(parts[i] ?? '');
    if (match) return { city: parts[i - 1] ?? '', state: match[1] ?? '' };
  }
  return { city: parts[parts.length - 1] ?? '', state: '' };
}

export function toTruckLocation(stats: SamsaraVehicleStats | null): TruckLocation | null {
  if (!stats?.gps) return null;
  const { city, state } = placeToCityState(stats.gps.place);
  return {
    lat: stats.gps.latitude,
    lng: stats.gps.longitude,
    city,
    state,
    updatedAt: stats.gps.at,
    speedMph: stats.gps.speedMph ?? 0,
    engineState: stats.engineState ?? 'off',
    headingDegrees: stats.gps.headingDegrees,
  };
}

export interface PlannedCreate {
  externalId: string;
  unitNumber: string;
  vin: string;
  make: string;
  model: string;
  year: number;
  plate: string | null;
  odometer: number;
  engineHours: number;
  line: SyncVehicleLine;
}

/**
 * A reading for the odometer history (docs/pm-module §3.4): every matched, active vehicle's
 * latest odometer, changed or not. The roster's own odometer is only moved forward; the history
 * keeps every day's reading so the PM board can say how old the number it shows is.
 */
export interface PlannedReading {
  truckId: string;
  odometer: number;
  odometerAt: string;
  engineHours: number | null;
}

export interface SyncPlan {
  summary: SyncSummary;
  updates: PlannedUpdate[];
  creates: PlannedCreate[];
  unchanged: SyncVehicleLine[];
  inactive: SyncVehicleLine[];
  duplicates: SyncVehicleLine[];
  unmatched: SyncVehicleLine[];
  conflicts: SyncVehicleLine[];
  readings: PlannedReading[];
}

export interface PlanOptions {
  accountId: string;
  now: Date;
  inactiveAfterDays?: number;
  createMissing?: boolean;
  /**
   * The provider this run reads ('samsara' by default; Motive passes 'motive', Five ELD 'fiveeld') and
   * its name in the words of the report. The planner is shared, so the rules are the same rules.
   */
  provider?: string;
  providerLabel?: string;
}

/** A vehicle with its latest readings folded in. */
interface Seen {
  vehicle: SamsaraVehicle;
  stats: SamsaraVehicleStats | null;
  odometer: number | null;
  odometerAt: string | null;
  lastSeenAt: string | null;
}

// Archived trucks (owner, 2026-10-05) are matched, so never re-created, and left alone, so never revived.
const RETIRED = new Set(['sold', 'inactive', 'archived']);
const DAY_MS = 86_400_000;
/** How a provider id reads in a note ("Taken over from Five ELD"); anything else is capitalised. */
const PROVIDER_NAMES: Record<string, string> = { samsara: 'Samsara', motive: 'Motive', fiveeld: 'Five ELD' };

function key(unit: string): string {
  return unit.trim().toLowerCase();
}

function vinOf(value: string | null): string | null {
  const vin = (value ?? '').trim().toUpperCase();
  return /^[A-HJ-NPR-Z0-9]{17}$/.test(vin) ? vin : null;
}

function latest(...times: (string | null | undefined)[]): string | null {
  let best: string | null = null;
  for (const time of times) {
    if (!time) continue;
    if (best === null || Date.parse(time) > Date.parse(best)) best = time;
  }
  return best;
}

function fold(vehicle: SamsaraVehicle, stats: SamsaraVehicleStats | null): Seen {
  // The engine's odometer over the GPS estimate, when both exist.
  const odometer = stats?.obdOdometerMiles ?? stats?.gpsOdometerMiles ?? null;
  const odometerAt =
    stats?.obdOdometerMiles !== null && stats?.obdOdometerMiles !== undefined
      ? stats.obdOdometerAt
      : (stats?.gpsOdometerAt ?? null);
  return {
    vehicle,
    stats,
    odometer,
    odometerAt,
    lastSeenAt: latest(
      stats?.obdOdometerAt,
      stats?.gpsOdometerAt,
      stats?.engineHoursAt,
      stats?.gps?.at,
    ),
  };
}

function line(
  seen: Seen,
  truck: TruckSnapshot | null,
  note: string,
  after: number | null = null,
): SyncVehicleLine {
  return {
    externalId: seen.vehicle.id,
    name: seen.vehicle.name,
    vin: seen.vehicle.vin,
    truckId: truck?.id ?? null,
    unitNumber: truck?.unitNumber ?? null,
    odometerBefore: truck?.odometer ?? null,
    odometerAfter: after,
    lastSeenAt: seen.lastSeenAt,
    note,
  };
}

export function planSamsaraSync(
  vehicles: SamsaraVehicle[],
  stats: SamsaraVehicleStats[],
  trucks: TruckSnapshot[],
  options: PlanOptions,
): SyncPlan {
  const inactiveAfterMs = (options.inactiveAfterDays ?? SYNC_INACTIVE_AFTER_DAYS) * DAY_MS;
  const provider = (options.provider ?? 'samsara').toLowerCase();
  const label = options.providerLabel ?? 'Samsara';
  const statsById = new Map(stats.map((row) => [row.id, row]));
  const seenAll = vehicles.map((vehicle) => fold(vehicle, statsById.get(vehicle.id) ?? null));

  const plan: SyncPlan = {
    summary: {
      fetched: vehicles.length,
      matched: 0,
      updated: 0,
      created: 0,
      unchanged: 0,
      inactive: 0,
      duplicates: 0,
      unmatched: 0,
      conflicts: 0,
    },
    updates: [],
    creates: [],
    unchanged: [],
    inactive: [],
    duplicates: [],
    unmatched: [],
    conflicts: [],
    readings: [],
  };

  // 1 · inactive
  const active: Seen[] = [];
  for (const seen of seenAll) {
    const age = seen.lastSeenAt ? options.now.getTime() - Date.parse(seen.lastSeenAt) : null;
    if (age === null || age > inactiveAfterMs) {
      plan.inactive.push(
        line(
          seen,
          null,
          age === null
            ? 'No reading of any kind from this vehicle'
            : `Last reading ${Math.floor(age / DAY_MS)} days ago`,
        ),
      );
    } else {
      active.push(seen);
    }
  }

  // 2 · duplicates: one vehicle per unit number, the newest reading wins.
  const byUnit = new Map<string, Seen[]>();
  for (const seen of active) {
    const k = key(seen.vehicle.name);
    if (k === '') {
      plan.unmatched.push(line(seen, null, `Vehicle has no name in ${label}`));
      continue;
    }
    byUnit.set(k, [...(byUnit.get(k) ?? []), seen]);
  }
  const winners: Seen[] = [];
  for (const group of byUnit.values()) {
    const sorted = [...group].sort(
      (a, b) => Date.parse(b.lastSeenAt ?? '0') - Date.parse(a.lastSeenAt ?? '0'),
    );
    const [winner, ...rest] = sorted;
    if (winner) winners.push(winner);
    for (const loser of rest) {
      plan.duplicates.push(
        line(
          loser,
          null,
          `Same unit number as vehicle ${winner?.vehicle.id ?? ''}, which reported more recently`,
        ),
      );
    }
  }

  // 3 · matching
  const byExternal = new Map<string, TruckSnapshot>();
  const byVin = new Map<string, TruckSnapshot>();
  const byNumber = new Map<string, TruckSnapshot>();
  for (const truck of trucks) {
    if (truck.telematicsAccountId === options.accountId && truck.telematicsExternalId) {
      byExternal.set(truck.telematicsExternalId, truck);
    }
    const vin = vinOf(truck.vin);
    if (vin) byVin.set(vin, truck);
    byNumber.set(key(truck.unitNumber), truck);
  }
  const claimed = new Set<string>();

  for (const seen of winners) {
    const vin = vinOf(seen.vehicle.vin);
    const truck =
      byExternal.get(seen.vehicle.id) ??
      (vin ? byVin.get(vin) : undefined) ??
      byNumber.get(key(seen.vehicle.name));

    if (!truck) {
      // 5 · unmatched
      if (!options.createMissing) {
        plan.unmatched.push(
          line(seen, null, 'Not in the roster; create it by running with "create missing"'),
        );
      } else if (!vin) {
        plan.unmatched.push(
          line(
            seen,
            null,
            `Not in the roster and ${label} has no VIN for it, so it cannot be created`,
          ),
        );
      } else if (seen.odometer === null) {
        plan.unmatched.push(
          line(seen, null, `Not in the roster and ${label} has no odometer for it`),
        );
      } else {
        plan.creates.push({
          externalId: seen.vehicle.id,
          unitNumber: seen.vehicle.name,
          vin,
          make: seen.vehicle.make ?? 'Unknown',
          model: seen.vehicle.model ?? 'Unknown',
          year: seen.vehicle.year ?? 1980,
          plate: seen.vehicle.licensePlate,
          odometer: seen.odometer,
          engineHours: seen.stats?.engineHours ?? 0,
          line: line(seen, null, `Created from ${label}`, seen.odometer),
        });
      }
      continue;
    }

    if (claimed.has(truck.id)) {
      plan.duplicates.push(
        line(seen, truck, `Truck ${truck.unitNumber} already matched another vehicle in this run`),
      );
      continue;
    }
    claimed.add(truck.id);
    plan.summary.matched += 1;

    if (RETIRED.has(truck.status)) {
      plan.unchanged.push(line(seen, truck, `Truck is ${truck.status} in the roster; left alone`));
      continue;
    }

    // 3b · one ELD per truck. A truck a sync of another provider has linked (Samsara and Motive in
    // one company) belongs to that account: the link is what matching trusts first, so it is what
    // decides ownership, and two providers never take turns rewriting one odometer and position.
    // The one exception is a truck whose owner has gone quiet — no position from it inside the
    // inactive window — while this provider hears it: the unit changed ELDs and is taken over.
    const notes: string[] = [];
    const ownerProvider = (truck.telematicsProvider ?? '').trim().toLowerCase();
    if (
      truck.telematicsAccountId &&
      truck.telematicsAccountId !== options.accountId &&
      ownerProvider !== '' &&
      ownerProvider !== provider
    ) {
      const ownerAge = truck.locationAt ? options.now.getTime() - truck.locationAt.getTime() : null;
      const ownerName = PROVIDER_NAMES[ownerProvider] ?? ownerProvider.charAt(0).toUpperCase() + ownerProvider.slice(1);
      if (ownerAge !== null && ownerAge <= inactiveAfterMs) {
        // The owner places the truck but has sent no odometer inside the window (its ELD gives GPS
        // only): this provider's odometer is taken, forward only, and nothing else changes hands.
        const ownerOdometerStale = truck.odometer <= 0 || options.now.getTime() - truck.odometerAt.getTime() > inactiveAfterMs;
        if (
          ownerOdometerStale &&
          seen.odometer !== null &&
          seen.odometerAt !== null &&
          seen.odometer > truck.odometer &&
          Date.parse(seen.odometerAt) > truck.odometerAt.getTime()
        ) {
          plan.readings.push({ truckId: truck.id, odometer: seen.odometer, odometerAt: seen.odometerAt, engineHours: null });
          plan.updates.push({
            truckId: truck.id,
            externalId: seen.vehicle.id,
            odometer: seen.odometer,
            odometerAt: seen.odometerAt,
            engineHours: null,
            location: null,
            odometerOnly: true,
            line: line(
              seen,
              truck,
              `Odometer ${truck.odometer.toLocaleString('en-US')} → ${seen.odometer.toLocaleString('en-US')} mi from ${label}; ${ownerName} sends no odometer for it and keeps the position`,
              seen.odometer,
            ),
          });
          continue;
        }
        plan.unchanged.push(
          line(
            seen,
            truck,
            `Reported by its ${ownerName} account (last position ${Math.floor(ownerAge / DAY_MS)} days ago); left alone`,
          ),
        );
        continue;
      }
      notes.push(
        ownerAge === null
          ? `Taken over from ${ownerName}, which has no position for it`
          : `Taken over from ${ownerName}, silent for ${Math.floor(ownerAge / DAY_MS)} days`,
      );
    }

    if (vin && vinOf(truck.vin) !== vin && byVin.get(vin) === undefined) {
      notes.push(`VIN differs (roster ${truck.vin}, ${label} ${vin})`);
    }
    if (key(truck.unitNumber) !== key(seen.vehicle.name)) {
      notes.push(`${label} calls it "${seen.vehicle.name}"`);
    }

    // The history gets today's reading whatever the roster does with it (the reading table has
    // its own validation, which is where a lowered odometer is recorded as a conflict).
    if (seen.odometer !== null && seen.odometerAt !== null) {
      plan.readings.push({
        truckId: truck.id,
        odometer: seen.odometer,
        odometerAt: seen.odometerAt,
        engineHours: seen.stats?.engineHours ?? null,
      });
    }

    // 4 · the odometer, never lowered
    let odometer: number | null = null;
    let odometerAt: string | null = null;
    if (seen.odometer !== null && seen.odometerAt !== null) {
      const newer = Date.parse(seen.odometerAt) > truck.odometerAt.getTime();
      if (seen.odometer < truck.odometer - SYNC_ODOMETER_ROLLBACK_TOLERANCE_MILES) {
        plan.conflicts.push(
          line(
            seen,
            truck,
            `${label} reads ${seen.odometer.toLocaleString('en-US')} mi, below the roster's ${truck.odometer.toLocaleString('en-US')} mi; not applied`,
            seen.odometer,
          ),
        );
        continue;
      }
      // Equal is not a change: a truck that has not moved since the last reading is up to date,
      // and listing it as "173,106 → 173,106" would bury the real changes under the parked fleet.
      if (newer && seen.odometer > truck.odometer) {
        odometer = seen.odometer;
        odometerAt = seen.odometerAt;
      }
    }

    const remembers =
      truck.telematicsAccountId === options.accountId &&
      truck.telematicsExternalId === seen.vehicle.id;
    // A parked truck's odometer does not move, but its position and engine state still do: a
    // newer GPS fix is a change too, or the map would show where the truck was last driven.
    const gpsAt = seen.stats?.gps?.at ? Date.parse(seen.stats.gps.at) : Number.NaN;
    const newerGps =
      Number.isFinite(gpsAt) && (!truck.locationAt || gpsAt > truck.locationAt.getTime());
    const changed = odometer !== null || !remembers || newerGps;
    if (!changed) {
      plan.unchanged.push(line(seen, truck, 'Up to date'));
      continue;
    }
    plan.updates.push({
      truckId: truck.id,
      externalId: seen.vehicle.id,
      odometer,
      odometerAt,
      engineHours: seen.stats?.engineHours ?? null,
      location: toTruckLocation(seen.stats),
      line: line(
        seen,
        truck,
        [
          odometer !== null
            ? `Odometer ${truck.odometer.toLocaleString('en-US')} → ${odometer.toLocaleString('en-US')} mi`
            : remembers
              ? 'Position updated'
              : `Linked to this ${label} vehicle`,
          ...notes,
        ].join(' · '),
        odometer ?? truck.odometer,
      ),
    });
  }

  plan.summary.updated = plan.updates.length;
  plan.summary.created = plan.creates.length;
  plan.summary.unchanged = plan.unchanged.length;
  plan.summary.inactive = plan.inactive.length;
  plan.summary.duplicates = plan.duplicates.length;
  plan.summary.unmatched = plan.unmatched.length;
  plan.summary.conflicts = plan.conflicts.length;
  return plan;
}
