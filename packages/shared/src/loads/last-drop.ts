/**
 * Where a driver will start their next load from: the last delivery of their latest load
 * (owner, 2026-10-13). The Add load form measures empty miles from here to the new first pickup.
 *
 * One rule for the server and the browser: the driver's loads (as driver or co-driver - a team
 * runs one truck), cancelled and TONU ones and the load being edited left out, the latest by its
 * delivery - delivered or still running, because that is where the truck will be.
 */
export interface LastDropLoad {
  id: string;
  loadNumber: string;
  status: string;
  driverId?: string | null;
  coDriverId?: string | null;
  deliveryAt?: string | null;
  deliveredAt?: string | null;
  destination?: { city: string; state: string; zip?: string | null } | null;
  stops?: readonly { kind: string; city: string; state: string; zip?: string | null; appointmentStartAt?: string | null }[] | null;
}

export interface DriverLastDrop {
  loadId: string;
  loadNumber: string;
  city: string;
  state: string;
  zip: string | null;
}

const SKIPPED = new Set(['cancelled', 'tonu']);

function lastDelivery(load: LastDropLoad) {
  return [...(load.stops ?? [])].reverse().find((s) => s.kind === 'delivery') ?? null;
}

/** When the load ends: delivered, else the delivery appointment, else the last stop's. */
function endsAt(load: LastDropLoad): number {
  const at = load.deliveredAt ?? load.deliveryAt ?? lastDelivery(load)?.appointmentStartAt ?? null;
  const ms = at ? Date.parse(at) : Number.NaN;
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

export function driverLastDrop(
  loads: readonly LastDropLoad[],
  driverId: string,
  excludeLoadId: string | null = null,
): DriverLastDrop | null {
  if (!driverId) return null;
  const latest = loads
    .filter(
      (l) =>
        (l.driverId === driverId || l.coDriverId === driverId) &&
        l.id !== excludeLoadId &&
        !SKIPPED.has(l.status),
    )
    .sort((a, b) => endsAt(b) - endsAt(a))[0];
  if (!latest) return null;
  const drop = lastDelivery(latest);
  const place = drop ?? latest.destination ?? null;
  if (!place || (!place.city?.trim() && !(place.zip ?? '').trim())) return null;
  return {
    loadId: latest.id,
    loadNumber: latest.loadNumber,
    city: place.city ?? '',
    state: place.state ?? '',
    zip: place.zip ?? null,
  };
}
