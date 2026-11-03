/**
 * One availability vocabulary for every powered and towed unit.
 *
 * A truck's stored `status` mixes two different questions — what the unit is *doing* right now
 * (driving, idle) and whether it *can be dispatched* (in shop, out of service). Trailers use a
 * third, narrower vocabulary again. The Fleet workspace has to summarise both in one strip and
 * offer the right actions for each, so this engine collapses both into a single answer to the only
 * question the yard actually asks: **can I put freight on this unit today, and if not, why not.**
 *
 * Honesty rules:
 *  - A unit whose status is unknown is `unknown`, never quietly `available`.
 *  - `assigned` means the unit has work or a driver: a load attached but not moving, or an open
 *    driver assignment on an otherwise free unit (owner, 2026-10-22). It is distinct from
 *    `in_transit`, which means the unit is attached to a load *and* moving, because a dispatcher
 *    plans against those differently. `available` then means free with nobody in it.
 *  - The driver comes from the open assignment, never from a stored status: nobody writes
 *    `assigned` into the record, so the two cannot disagree.
 */

export const UNIT_AVAILABILITY_STATES = [
  'available',
  'assigned',
  'in_transit',
  'in_maintenance',
  'out_of_service',
  // Off the fleet for good (stolen, totaled, returned…) but still on the books; not the same as
  // out of service, which is expected back (owner, 2026-10-08).
  'inactive',
  'retired',
  'unknown',
] as const;

export type UnitAvailability = (typeof UNIT_AVAILABILITY_STATES)[number];

export interface UnitStatusInput {
  /** The stored status code, as the record holds it. */
  status: string;
  /** Id of the load currently attached, if any. */
  currentLoadId?: string | null;
  /** Ground speed in mph from the last telematics fix, when the unit reports one. */
  speedMph?: number | null;
  /** True when an open work order has the unit in a shop. */
  inOpenWorkOrder?: boolean;
  /**
   * Why an expired document holds the unit, when one does ("Registration expired …"). Null or
   * absent when the paperwork is in date or the expired type only warns.
   */
  documentHold?: string | null;
  /**
   * True when the unit has an open driver assignment (`truck_driver_assignments.ended_on` null,
   * mirrored on the truck as `currentDriverId`). Turns an otherwise free unit into `assigned`;
   * every hold — shop, out of service, inactive, a load, expired paperwork — still outranks it.
   */
  driverAssigned?: boolean;
}

export interface UnitStatusResult {
  availability: UnitAvailability;
  /** True when freight can be assigned to this unit right now. */
  dispatchable: boolean;
  /** Why this answer, in the operator's language. */
  reasons: string[];
}

/** Statuses that mean the unit is in a shop, whatever the module calls it. */
const MAINTENANCE_STATUSES = new Set(['in_shop', 'maintenance']);
/** Statuses that mean the unit must not be dispatched at all. */
const OUT_STATUSES = new Set(['out_of_service', 'accident']);
const INACTIVE_STATUSES = new Set(['inactive']);
const RETIRED_STATUSES = new Set(['sold', 'retired', 'archived']);
/** Statuses that mean the unit is free. */
const FREE_STATUSES = new Set(['available', 'idle', 'active']);
/** Statuses that mean the unit is attached to work. */
const WORKING_STATUSES = new Set(['driving', 'dispatched', 'assigned', 'in_transit']);

/** Speed above which a moving unit is treated as under way rather than stopped at a dock. */
const MOVING_MPH = 5;

export function unitAvailability(input: UnitStatusInput): UnitStatusResult {
  const reasons: string[] = [];
  const status = input.status?.trim().toLowerCase() ?? '';

  if (RETIRED_STATUSES.has(status)) {
    return {
      availability: 'retired',
      dispatchable: false,
      reasons: [`Unit is ${status.replace(/_/g, ' ')} and no longer part of the operating fleet`],
    };
  }

  if (INACTIVE_STATUSES.has(status)) {
    return { availability: 'inactive', dispatchable: false, reasons: ['Unit is marked inactive'] };
  }

  if (OUT_STATUSES.has(status)) {
    return {
      availability: 'out_of_service',
      dispatchable: false,
      reasons: [`Unit is marked ${status.replace(/_/g, ' ')}`],
    };
  }

  // A shop hold outranks whatever the unit was doing before it went in.
  if (MAINTENANCE_STATUSES.has(status) || input.inOpenWorkOrder) {
    reasons.push(
      MAINTENANCE_STATUSES.has(status)
        ? 'Unit status is in shop'
        : 'An open work order has the unit in a shop',
    );
    return { availability: 'in_maintenance', dispatchable: false, reasons };
  }

  if (input.currentLoadId) {
    const moving = typeof input.speedMph === 'number' && input.speedMph > MOVING_MPH;
    reasons.push(moving ? 'Attached to a load and moving' : 'Attached to a load');
    if (input.documentHold) reasons.push(input.documentHold);
    return {
      availability: moving ? 'in_transit' : 'assigned',
      dispatchable: false,
      reasons,
    };
  }

  if (WORKING_STATUSES.has(status)) {
    // Status says the unit is working but no load is attached — report what is recorded rather
    // than guessing which of the two is stale.
    reasons.push(`Status is ${status.replace(/_/g, ' ')} but no load is attached to the unit`);
    return { availability: 'assigned', dispatchable: false, reasons };
  }

  // Expired paperwork that the company's rule says blocks dispatch takes the unit off the board
  // whatever its own status claims.
  if (input.documentHold) {
    return { availability: 'out_of_service', dispatchable: false, reasons: [input.documentHold] };
  }

  if (FREE_STATUSES.has(status)) {
    // A driver in the truck is still free to take freight, so it stays dispatchable; it is no
    // longer an empty truck, which is what Available counts.
    if (input.driverAssigned) {
      reasons.push('Driver assigned; no load attached and no shop hold');
      return { availability: 'assigned', dispatchable: true, reasons };
    }
    reasons.push('No load attached and no shop hold');
    return { availability: 'available', dispatchable: true, reasons };
  }

  return {
    availability: 'unknown',
    dispatchable: false,
    reasons: [`Status "${input.status}" is not a status this fleet recognises`],
  };
}
