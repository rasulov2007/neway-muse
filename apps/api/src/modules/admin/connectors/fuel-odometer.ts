/**
 * The odometer at the moment of a fuel fill, from the unit's odometer history (owner, 2026-10-05).
 *
 * Relay never asks the driver for an odometer, so every Relay fill arrived with 0 and the Fuel page
 * showed none - and no MPG. The history (`odometer_readings`, about one Samsara reading per unit a
 * day) brackets each fill: the value is interpolated in time between the reading before and the
 * reading after. Nothing is guessed across a gap: when the bracketing readings are more than
 * MAX_GAP_MS apart, or one side is missing and the nearest reading is more than NEAR_MS away, the
 * fill keeps 0 ("no reading").
 */
export interface OdometerPoint {
  atMs: number;
  miles: number;
}

const MAX_GAP_MS = 4 * 86_400_000;
const NEAR_MS = 6 * 3_600_000;

/** `points` must be sorted by time. Returns whole miles, or null when there is nothing sound. */
export function odometerAt(points: readonly OdometerPoint[], atMs: number): number | null {
  if (points.length === 0 || !Number.isFinite(atMs)) return null;
  let before: OdometerPoint | null = null;
  let after: OdometerPoint | null = null;
  for (const p of points) {
    if (p.atMs <= atMs) before = p;
    else {
      after = p;
      break;
    }
  }
  if (before && after) {
    if (after.atMs - before.atMs > MAX_GAP_MS) {
      const near = atMs - before.atMs <= after.atMs - atMs ? before : after;
      return Math.abs(near.atMs - atMs) <= NEAR_MS ? Math.round(near.miles) : null;
    }
    // A reading that went backwards (a swapped gateway) cannot be interpolated across.
    if (after.miles < before.miles) return Math.abs(before.atMs - atMs) <= NEAR_MS ? Math.round(before.miles) : null;
    const share = after.atMs === before.atMs ? 0 : (atMs - before.atMs) / (after.atMs - before.atMs);
    return Math.round(before.miles + share * (after.miles - before.miles));
  }
  const only = before ?? after;
  return only && Math.abs(only.atMs - atMs) <= NEAR_MS ? Math.round(only.miles) : null;
}
