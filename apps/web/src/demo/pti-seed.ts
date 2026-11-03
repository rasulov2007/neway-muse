import type { Driver, IsoDate, Truck, User } from './types';
import { PTI_ISSUE_CATEGORIES, truckStateFor, type PtiRecord } from './pti-types';

/**
 * One realistic week of inspections.
 *
 * Deliberately imperfect: most videos in, a handful never sent, a few late, a few with something
 * found — one of those already on a work order and one still with nothing done about it, so the
 * flag and the escalation are visible on the screen rather than only in the code.
 */

class Rng {
  private seed: number;
  constructor(seed: number) {
    this.seed = seed >>> 0;
  }
  next(): number {
    this.seed = (this.seed * 1664525 + 1013904223) >>> 0;
    return this.seed / 0x100000000;
  }
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(0, items.length - 1)] as T;
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
}

function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const ISSUE_NOTES: Record<string, string[]> = {
  Lights: ['Passenger marker light out on the trailer', 'Left turn signal flickering'],
  'Tires / Wheels': ['Inside LR drive tire low, cords not showing yet', 'Steer tire down to 5/32'],
  Brakes: ['Air leak audible at the trailer gladhand', 'Slack adjuster out of stroke on axle 3'],
  Leaks: ['Coolant seep at the lower hose', 'Oil film building on the bell housing'],
  Body: ['Rear door seal torn', 'Step tread loose on the passenger side'],
  Mounting: ['Battery box strap missing a bolt', 'Mud flap bracket cracked'],
  Other: ['Cab heater blowing cold', 'Seat belt retracts slowly'],
};

export function buildPtiWeek(input: {
  trucks: Truck[];
  drivers: Driver[];
  users: User[];
  weekStart: IsoDate;
  seed?: number;
}): PtiRecord[] {
  const { trucks, drivers, users, weekStart } = input;
  const rng = new Rng(input.seed ?? 20260914);
  const driversById = new Map(drivers.map((d) => [d.id, d]));
  const fleetTeam = users.filter(
    (u) => u.status === 'active' && (u.department === 'maintenance' || u.department === 'safety'),
  );
  const team =
    fleetTeam.length > 0 ? fleetTeam : users.filter((u) => u.status === 'active').slice(0, 4);

  const rows: PtiRecord[] = [];
  for (const truck of trucks) {
    const state = truckStateFor(truck.status);
    if (state === 'inactive') continue;

    const driver = truck.currentDriverId ? (driversById.get(truck.currentDriverId) ?? null) : null;
    // A truck in the shop this week mostly has not sent one, which is the point of showing it.
    const sent = state === 'shop' ? rng.chance(0.25) : rng.chance(0.82);
    const late = sent && rng.chance(0.15);
    const sentDate = sent ? addDays(weekStart, late ? rng.int(3, 5) : rng.int(0, 2)) : null;

    const reviewed = sent && rng.chance(0.85);
    const reviewer = reviewed ? rng.pick(team) : null;
    const checkedDate = reviewed && sentDate ? addDays(sentDate, rng.int(0, 1)) : null;
    const issue = reviewed && rng.chance(0.14);
    const category = issue ? rng.pick(PTI_ISSUE_CATEGORIES) : null;

    // One of the issues is left with nothing done about it, so the flag shows on the board.
    const acted = issue ? rng.chance(0.6) : false;

    rows.push({
      id: `pti_${weekStart.replace(/-/g, '')}_${truck.id}`,
      weekStart,
      truckId: truck.id,
      unitNumber: truck.unitNumber,
      driverId: driver?.id ?? null,
      driverName: driver?.name ?? null,
      driverTag: driver ? payTag(driver) : null,
      dispatcherId: driver?.dispatcherId ?? null,
      dispatcherName: driver?.dispatcherName ?? null,
      status: sent ? (late ? 'late' : 'sent') : 'no',
      sentDate,
      checkedById: reviewer?.id ?? null,
      checkedByName: reviewer?.name ?? null,
      checkedDate,
      result: reviewed ? (issue ? 'issue_found' : 'no_issues') : 'pending',
      issueCategory: category,
      issueNote: category ? rng.pick(ISSUE_NOTES[category] ?? ['See the video']) : null,
      actionTaken: acted ? 'Scheduled at the yard on the next reset' : null,
      workOrderId: null,
      workOrderNumber: null,
      needsPti: state === 'shop' ? false : rng.chance(0.05),
      createdAt: `${weekStart}T06:00:00.000Z`,
      updatedAt: `${checkedDate ?? sentDate ?? weekStart}T18:30:00.000Z`,
    });
  }
  return rows;
}

/**
 * The pay-type tag shown beside a driver's name on the board.
 *
 * Company drivers get **no** tag. Nearly every driver is one, so a 'C' after almost every name
 * carried no information and was read as a typo — it was reported as "a stray C after driver
 * names". A tag now appears only when it says something the reader would not have assumed.
 */
function payTag(driver: Driver): string | null {
  switch (driver.driverType) {
    case 'company':
      return null;
    case 'lease_operator':
      return 'LO';
    case 'owner_operator':
      return 'OO';
    default:
      return null;
  }
}
