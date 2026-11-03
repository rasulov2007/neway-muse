import type { DriverLastDrop } from '@neway/shared';
import { demoData } from './data';
import type { Load } from './types';

/**
 * Miles, computed from the stops rather than typed.
 *
 * Two figures, two different questions:
 *
 *  - **Loaded miles** are the route this load runs: first pickup, every stop in order, final
 *    delivery. Typing them by hand is how a load ends up priced per mile on a number nobody
 *    measured.
 *  - **Deadhead** is what it cost to get to the freight: the driver's *last delivery* to this
 *    load's first pickup. With no previous load there is no deadhead to compute, and this returns
 *    null with the reason rather than a confident zero.
 *
 * There is no routing service in this build, so distance is great-circle between the two places
 * plus a road factor. It is stated as an estimate wherever it is shown, and any figure a person
 * types over the top is kept — a computed number that silently overwrites a dispatcher is worse
 * than no computation at all.
 */

const ROAD_FACTOR = 1.18;

export interface Place {
  city: string;
  state: string;
  /** When known, the ZIP places the stop more exactly than its city. */
  zip?: string | null;
}

/**
 * Every US ZIP and city with its coordinates (owner, 2026-10-13: empty miles have to work on
 * real addresses, not only the demo's cities). Fetched once, the first time a form needs it,
 * from /geo/us-places.json (built from the BSD-licensed `zipcodes` 8.0.0 data).
 */
interface UsPlaces {
  zip: Record<string, [number, number]>;
  city: Record<string, [number, number]>;
}
let usPlaces: UsPlaces | null = null;
let usPlacesLoading: Promise<boolean> | null = null;

/** Loads the US places once; resolves true when they are available. */
export function ensureUsPlaces(): Promise<boolean> {
  if (usPlaces) return Promise.resolve(true);
  usPlacesLoading ??= fetch('/geo/us-places.json')
    .then((r) => (r.ok ? (r.json() as Promise<UsPlaces>) : null))
    .then((data) => {
      usPlaces = data && data.zip && data.city ? data : null;
      return usPlaces !== null;
    })
    .catch(() => {
      usPlacesLoading = null;
      return false;
    });
  return usPlacesLoading;
}

function fromUsPlaces(place: Place): { lat: number; lng: number } | null {
  if (!usPlaces) return null;
  const zip = (place.zip ?? '').trim().slice(0, 5);
  const byZip = zip ? usPlaces.zip[zip] : undefined;
  if (byZip) return { lat: byZip[0], lng: byZip[1] };
  const key = `${place.city.trim().toUpperCase()}|${place.state.trim().toUpperCase()}`;
  const byCity = usPlaces.city[key];
  return byCity ? { lat: byCity[0], lng: byCity[1] } : null;
}

export interface MileageEstimate {
  miles: number | null;
  /** Plain English for the screen: why there is a number, or why there is not. */
  note: string;
}

/** The known cities the demo dataset is built from, with their coordinates. */
function coordinatesFor(place: Place): { lat: number; lng: number } | null {
  const real = fromUsPlaces(place);
  if (real) return real;
  const city = place.city.trim().toLowerCase();
  const state = place.state.trim().toUpperCase();
  if (!city || !state) return null;

  // Facilities carry real coordinates and are the best source when the stop names one.
  const facility = demoData.facilities.find(
    (f) => f.address.state.toUpperCase() === state && f.address.city.toLowerCase() === city,
  );
  if (facility) return { lat: facility.lat, lng: facility.lng };

  // Otherwise any load that has run through that city carries the same coordinates via its
  // facilities; fall back to a stop on a known load.
  for (const load of demoData.loads) {
    for (const stop of load.stops) {
      if (stop.city.toLowerCase() === city && stop.state.toUpperCase() === state) {
        const stopFacility = demoData.facilities.find((f) => f.id === stop.facilityId);
        if (stopFacility) return { lat: stopFacility.lat, lng: stopFacility.lng };
      }
    }
  }
  return null;
}

function haversineMiles(a: { lat: number; lng: number }, b: { lat: number; lng: number }): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 3958.8 * 2 * Math.atan2(Math.sqrt(h), Math.sqrt(1 - h));
}

/** Road miles between two places, rounded to five. Null when either place is unknown. */
export function milesBetween(from: Place, to: Place): number | null {
  const a = coordinatesFor(from);
  const b = coordinatesFor(to);
  if (!a || !b) return null;
  return Math.round((haversineMiles(a, b) * ROAD_FACTOR) / 5) * 5;
}

/**
 * The loaded route: pickup, every stop in order, delivery.
 *
 * A leg whose city is not recognised makes the whole figure unavailable rather than a shorter
 * route that looks plausible.
 */
export function loadedMilesFor(stops: Place[]): MileageEstimate {
  const known = stops.filter((stop) => (stop.city.trim() && stop.state.trim()) || (stop.zip ?? '').trim().length >= 5);
  if (known.length < 2) {
    return { miles: null, note: 'Add a pickup and a delivery and the miles fill in.' };
  }

  let total = 0;
  for (let i = 0; i < known.length - 1; i += 1) {
    const leg = milesBetween(known[i] as Place, known[i + 1] as Place);
    if (leg === null) {
      const unknown = coordinatesFor(known[i] as Place) ? known[i + 1] : known[i];
      return {
        miles: null,
        note: `${unknown?.city}, ${unknown?.state} is not a place this build can measure from. Type the miles.`,
      };
    }
    total += leg;
  }

  return {
    miles: total,
    note:
      known.length > 2
        ? `Estimated over ${known.length} stops, in order.`
        : 'Estimated from the pickup and the delivery.',
  };
}

/**
 * Deadhead to the freight.
 *
 * The driver's last delivered load decides it: where they ended is where they start from. A driver
 * with no history has no deadhead to compute, and neither does a load with no driver yet.
 */
export function deadheadMilesFor(
  driverId: string | null,
  pickup: Place,
  excludeLoadId?: string | null,
  /**
   * The driver's last drop as the server answered it (GET /loads/driver-last-drop): null when
   * they have no earlier load. Absent, the browser's own copy of the loads is searched instead.
   */
  lastDrop?: DriverLastDrop | null,
): MileageEstimate {
  if (!driverId) {
    return { miles: null, note: 'Put a driver on the load and the deadhead fills in.' };
  }
  if ((!pickup.city.trim() || !pickup.state.trim()) && !(pickup.zip ?? '').trim()) {
    return { miles: null, note: 'Add the pickup and the deadhead fills in.' };
  }

  // The driver's last delivery address (owner, 2026-10-13): their latest load's final drop,
  // delivered or still running - where the truck will be when this one starts.
  const previous =
    lastDrop !== undefined
      ? lastDrop && { loadNumber: lastDrop.loadNumber, from: { city: lastDrop.city, state: lastDrop.state, zip: lastDrop.zip } }
      : (() => {
          const load = lastLoadFor(driverId, excludeLoadId ?? null);
          if (!load) return null;
          const drop = [...load.stops].reverse().find((s) => s.kind === 'delivery');
          return { loadNumber: load.loadNumber, from: drop ? { city: drop.city, state: drop.state, zip: drop.zip ?? null } : load.destination };
        })();
  if (!previous) {
    return {
      miles: null,
      note: 'No earlier load for this driver yet, so there is nothing to measure from.',
    };
  }
  const from: Place = previous.from;

  const miles = milesBetween(from, pickup);
  if (miles === null) {
    return {
      miles: null,
      note: `Their last drop was ${from.city}, ${from.state}, which could not be placed on the map.`,
    };
  }
  return {
    miles,
    note: `From their last drop at ${from.city}, ${from.state} (${previous.loadNumber}) · estimate.`,
  };
}

/** The driver's latest load by delivery date, cancelled ones and the load being edited left out. */
export function lastLoadFor(driverId: string, excludeLoadId: string | null): Load | null {
  const loads = demoData.loads
    .filter((load) => load.driverId === driverId && load.id !== excludeLoadId && load.status !== 'cancelled' && load.status !== 'tonu')
    .sort((a, b) => ((a.deliveredAt ?? a.deliveryAt) < (b.deliveredAt ?? b.deliveryAt) ? 1 : -1));
  return loads[0] ?? null;
}

/** The most recent load this driver actually delivered. */
export function lastDeliveredLoad(driverId: string): Load | null {
  const delivered = demoData.loads
    .filter(
      (load) =>
        load.driverId === driverId && (load.status === 'delivered' || load.status === 'closed'),
    )
    .sort((a, b) => ((a.deliveredAt ?? a.deliveryAt) < (b.deliveredAt ?? b.deliveryAt) ? 1 : -1));
  return delivered[0] ?? null;
}

/**
 * Miles from where the truck is to where it is going next.
 *
 * The position is Samsara's, stored by the server; the stop's coordinates are the same lookup the
 * loaded-miles estimate uses. Null when the stop's place is unknown - an ETA built on a guessed
 * distance is a guess wearing a clock.
 */
export function remainingMilesTo(
  position: { lat: number; lng: number } | null | undefined,
  place: Place | null | undefined,
): number | null {
  if (!position || !place) return null;
  const to = coordinatesFor(place);
  if (!to) return null;
  return Math.round((haversineMiles(position, to) * ROAD_FACTOR) / 5) * 5;
}
