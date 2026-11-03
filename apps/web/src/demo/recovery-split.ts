/**
 * Splitting a load between the driver who started it and the driver who finished it.
 *
 * A recovery is not a correction. The first driver really did turn the miles they turned, and
 * those miles are owed to them whether or not they ever reach the receiver. So the load stops
 * being "one driver's load" and becomes two segments, each with its own miles and its own share
 * of the linehaul, and the settlement engine pays each driver for the segment they ran.
 *
 * The share is by mile rather than by half, because that is the only division the drivers can
 * check for themselves: a driver who broke down 90 miles into a 1,340-mile run is not owed the
 * same as the one who covered the other 1,250.
 */

export interface LoadSegment {
  /** Stable within the load: `seg1`, `seg2`, … in the order the drivers ran it. */
  id: string;
  driverId: string | null;
  driverName: string | null;
  truckId: string | null;
  unitNumber: string | null;
  /** Loaded miles this driver turned under the freight. */
  loadedMiles: number;
  /** Deadhead charged to this driver's segment. All of it sits on the first one. */
  emptyMiles: number;
  /** This segment's share of the linehaul, apportioned by loaded miles. */
  linehaulRevenue: number;
  /** Why the freight left this driver. Null on the segment that finishes the run. */
  handoffReason: string | null;
  handoffAt: string | null;
}

export interface RecoverySplitInput {
  /** Loaded miles on the whole run. */
  loadedMiles: number;
  /** Deadhead on the whole run; it belongs to whoever repositioned, i.e. the first driver. */
  emptyMiles: number;
  /** The linehaul being divided. */
  linehaul: number;
  /** Miles the outgoing driver actually turned before the freight was handed over. */
  milesCompleted: number;
  outgoing: { driverId: string | null; driverName: string | null; truckId: string | null; unitNumber: string | null };
  incoming: { driverId: string | null; driverName: string | null; truckId: string | null; unitNumber: string | null };
  reason: string;
  at: string;
  /** Segments already on the load, when a load is recovered a second time. */
  existing?: LoadSegment[];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Miles cannot be negative, and nobody can have run more of the load than the load is long. */
export function clampMiles(milesCompleted: number, loadedMiles: number): number {
  if (!Number.isFinite(milesCompleted) || milesCompleted < 0) return 0;
  return Math.min(Math.round(milesCompleted), Math.max(0, Math.round(loadedMiles)));
}

/**
 * Builds the segment list for a load being recovered.
 *
 * On a second recovery the earlier segments are kept as they are — they are settled facts — and
 * only the segment of the driver currently holding the freight is divided.
 */
export function splitLoadForRecovery(input: RecoverySplitInput): LoadSegment[] {
  const totalLoaded = Math.max(0, Math.round(input.loadedMiles));
  const settled = (input.existing ?? []).slice(0, -1);
  const settledMiles = settled.reduce((sum, seg) => sum + seg.loadedMiles, 0);

  /*
   * `milesCompleted` is what the desk is told over the phone: "he got to mile 620". That is
   * measured from the start of the run, not from the start of the current driver's segment, so
   * the miles already paid to earlier drivers come off before this segment is measured.
   */
  const fromStart = clampMiles(input.milesCompleted, totalLoaded);
  const outgoingMiles = Math.max(0, fromStart - settledMiles);
  const remainingMiles = Math.max(0, totalLoaded - settledMiles - outgoingMiles);

  const linehaulLeft = round(
    input.linehaul - settled.reduce((sum, seg) => sum + seg.linehaulRevenue, 0),
  );
  const divisor = outgoingMiles + remainingMiles;
  /*
   * A handover at mile zero leaves nothing to apportion. The outgoing driver earned no linehaul,
   * so all of it follows the freight — rather than a division by zero, or a silent 50/50 that
   * would pay a driver who never moved.
   */
  const outgoingShare = divisor === 0 ? 0 : round((linehaulLeft * outgoingMiles) / divisor);
  const incomingShare = round(linehaulLeft - outgoingShare);

  const base = settled.length;
  return [
    ...settled,
    {
      id: `seg${base + 1}`,
      driverId: input.outgoing.driverId,
      driverName: input.outgoing.driverName,
      truckId: input.outgoing.truckId,
      unitNumber: input.outgoing.unitNumber,
      loadedMiles: outgoingMiles,
      // Deadhead sits on the first segment: the repositioning happened before the freight moved.
      emptyMiles: base === 0 ? Math.max(0, Math.round(input.emptyMiles)) : 0,
      linehaulRevenue: outgoingShare,
      handoffReason: input.reason,
      handoffAt: input.at,
    },
    {
      id: `seg${base + 2}`,
      driverId: input.incoming.driverId,
      driverName: input.incoming.driverName,
      truckId: input.incoming.truckId,
      unitNumber: input.incoming.unitNumber,
      loadedMiles: remainingMiles,
      emptyMiles: 0,
      linehaulRevenue: incomingShare,
      handoffReason: null,
      handoffAt: null,
    },
  ];
}
