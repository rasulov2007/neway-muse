/**
 * One definition per Fleet number.
 *
 * The owner's report was that the same quantity had different values depending on which screen he
 * read it from: a banner said four work orders were late and the list under it held three; the
 * needs-attention panel counted trucks due for service that the Trucks list then refused to show.
 * Every one of those was the same mistake — the predicate had been written out a second time, a
 * little differently, next to the screen that needed it.
 *
 * So the predicates live here, once, and the screens call them. A number that is wrong is then
 * wrong in one place and fixable in one place, and two screens cannot drift apart without someone
 * deliberately editing this file.
 *
 * Fleet specification §2.3 ("Phase 0 definitions") is what these encode.
 */

import { maintenanceDue, type MaintenanceDue, type MaintenancePolicy } from './maintenance.js';

/** Work-order statuses that mean the job is not finished. */
export const OPEN_WORK_ORDER_STATUSES: ReadonlySet<string> = new Set(['open', 'scheduled', 'in_shop']);

/** Roster statuses that mean the unit is not available to dispatch today. */
export const OUT_OF_SERVICE_STATUSES: ReadonlySet<string> = new Set(['out_of_service', 'in_shop']);

/**
 * Roster statuses that are not part of the fleet's size.
 *
 * Fleet size is **active units**. A sold truck and a retired one are history, and counting them is
 * how one page said 63 while the page beside it said 45.
 */
export const INACTIVE_LIFECYCLE_STATUSES: ReadonlySet<string> = new Set([
  'inactive',
  'sold',
  'archived',
  'retired',
]);

/** The shape a late-work-order check needs. Anything with these fields can be asked. */
export interface LateWorkOrderInput {
  status: string;
  promisedAt: string | null;
  completedAt?: string | null;
}

/**
 * Is this work order late?
 *
 * Late means: not finished, and the date the shop promised has already gone by. The comparison is
 * against the start of the company's today, so a job promised "today" is not late until tomorrow —
 * a shop still has the day it promised.
 */
export function isLateWorkOrder(order: LateWorkOrderInput, today: string): boolean {
  if (!OPEN_WORK_ORDER_STATUSES.has(order.status)) return false;
  if (order.completedAt) return false;
  if (!order.promisedAt) return false;
  const promised = Date.parse(order.promisedAt);
  const startOfToday = Date.parse(`${today}T00:00:00Z`);
  return Number.isFinite(promised) && promised < startOfToday;
}

/** The fields a unit must offer before its service position can be judged. */
export interface PmInput {
  status?: string;
  odometer: number | null;
  nextServiceOdometer: number | null;
  nextServiceDate: string | null;
  /** The date the unit is already booked into a shop, when it is. */
  scheduledFor?: string | null;
}

/**
 * Where a unit stands against its service interval.
 *
 * The booking matters and must always be passed: a unit booked into a shop next Tuesday is
 * "scheduled", not "due soon". The needs-attention panel used to omit it while the Trucks list
 * passed it, so the panel counted trucks the list would not show — click the finding and land on
 * an empty table.
 */
export function pmPosition(
  unit: PmInput,
  today: string,
  policy?: MaintenancePolicy,
): MaintenanceDue {
  return maintenanceDue(
    {
      nextDueOdometer: unit.nextServiceOdometer,
      nextDueAt: unit.nextServiceDate,
      currentOdometer: unit.odometer,
      scheduledFor: unit.scheduledFor ?? null,
    },
    today,
    policy,
  );
}

/**
 * Is this unit past its service limit?
 *
 * Only active units are asked: a retired truck cannot be overdue for a service it will never have,
 * and counting it was why one unit appeared under "PM due soon" while its own page said Retired.
 */
export function isOverduePm(unit: PmInput, today: string, policy?: MaintenancePolicy): boolean {
  if (!isActiveUnit(unit.status)) return false;
  return pmPosition(unit, today, policy).urgency === 'overdue';
}

/** Is this unit part of the fleet's size, i.e. neither sold, retired nor archived? */
export function isActiveUnit(status: string | null | undefined): boolean {
  if (!status) return true;
  return !INACTIVE_LIFECYCLE_STATUSES.has(status);
}

/** Is this unit out of service right now, by its roster status alone? */
export function isOutOfService(status: string | null | undefined): boolean {
  return status ? OUT_OF_SERVICE_STATUSES.has(status) : false;
}

/** The fleet's size: active units only. */
export function fleetSize(units: { status?: string | null }[]): number {
  return units.filter((unit) => isActiveUnit(unit.status)).length;
}
