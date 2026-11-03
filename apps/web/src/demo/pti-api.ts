import { LEGACY_CATEGORY_MAP, describeDescriptionProblem } from '@neway/shared';
import { demoCurrentUser, demoData } from './data';
import { withKey } from './pti-condition';
import { today as companyToday } from '@/lib/clock';
import { createRepairOrder } from './fleet-writes';
import { saveSoon } from './state-persist';
import type { Driver, IsoDate, MaintenanceType, Truck, User } from './types';
import {
  PTI_DUE_DAY_OFFSET,
  PTI_WEEK_STARTS_ON,
  isUnresolved,
  truckStateFor,
  type PtiIssueCategory,
  type PtiNoRepairDecision,
  type PtiRecord,
  type PtiResult,
  type PtiStatus,
} from './pti-types';

/**
 * The PTI week, and the reviewer's workflow over it.
 *
 * Two rules decide everything here. A row exists for every eligible truck from the moment the week
 * opens, so a missing video is visible as an empty row rather than as an absence nobody can see.
 * And the truck's state is never stored on the row — it is read from the truck each time the board
 * renders, so a unit that Maintenance puts in the shop moves group on its own and cannot drift out
 * of step with the fleet record.
 */

const today = (): IsoDate => companyToday();
const stamp = () => new Date().toISOString();
export function addDays(date: IsoDate, days: number): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Sunday of the week a date falls in (Sunday-start since 2026-10-18). */
export function weekStartOf(date: IsoDate = today()): IsoDate {
  const d = new Date(`${date}T00:00:00Z`);
  const offset = (d.getUTCDay() - PTI_WEEK_STARTS_ON + 7) % 7;
  return addDays(date, -offset);
}

/** The day a video stops being on time. */
export function dueDateOf(weekStart: IsoDate): IsoDate {
  return addDays(weekStart, PTI_DUE_DAY_OFFSET);
}

/** Trucks that owe an inspection this week: everything except what has left the fleet. */
function eligible(trucks: Truck[]): Truck[] {
  return trucks.filter((truck) => truckStateFor(truck.status) !== 'inactive');
}

/**
 * Opens the week.
 *
 * Idempotent: a truck that already has a row for the week keeps it, and a truck that has since
 * come out of the shop is marked as owing a fresh inspection rather than being given a second row.
 */
export function openPtiWeek(weekStart: IsoDate = weekStartOf()): PtiRecord[] {
  const driversById = new Map(demoData.drivers.map((d) => [d.id, d]));
  const existing = new Map(
    demoData.ptiRecords.filter((r) => r.weekStart === weekStart).map((r) => [r.truckId, r]),
  );

  for (const truck of eligible(demoData.trucks)) {
    const row = existing.get(truck.id);
    const driver = truck.currentDriverId ? (driversById.get(truck.currentDriverId) ?? null) : null;
    if (row) {
      // The driver on a unit changes mid-week; the row follows the truck and re-reads the driver.
      row.driverId = driver?.id ?? null;
      row.driverName = driver?.name ?? null;
      row.driverTag = driver ? payTag(driver) : null;
      row.dispatcherId = driver?.dispatcherId ?? null;
      row.dispatcherName = driver?.dispatcherName ?? null;
      continue;
    }
    demoData.ptiRecords.push(blankRow(weekStart, truck, driver));
  }
  saveSoon();
  return ptiWeek(weekStart);
}

function blankRow(weekStart: IsoDate, truck: Truck, driver: Driver | null): PtiRecord {
  return {
    id: `pti_${weekStart.replace(/-/g, '')}_${truck.id}`,
    weekStart,
    truckId: truck.id,
    unitNumber: truck.unitNumber,
    driverId: driver?.id ?? null,
    driverName: driver?.name ?? null,
    driverTag: driver ? payTag(driver) : null,
    dispatcherId: driver?.dispatcherId ?? null,
    dispatcherName: driver?.dispatcherName ?? null,
    status: 'no',
    sentDate: null,
    checkedById: null,
    checkedByName: null,
    checkedDate: null,
    result: 'pending',
    issueCategory: null,
    issueNote: null,
    actionTaken: null,
    workOrderId: null,
    workOrderNumber: null,
    needsPti: false,
    createdAt: stamp(),
    updatedAt: stamp(),
  };
}

/** Every row for one week, with the truck's state read live. */
export function ptiWeek(weekStart: IsoDate = weekStartOf()): PtiRecord[] {
  const trucksById = new Map(demoData.trucks.map((t) => [t.id, t]));
  return demoData.ptiRecords
    .filter((row) => row.weekStart === weekStart)
    .map((row) => {
      const truck = trucksById.get(row.truckId);
      // A truck that has left the shop owes a fresh inspection whatever it sent before.
      const state = truck ? truckStateFor(truck.status) : 'inactive';
      return state === 'road' && row.needsPti && row.status === 'sent'
        ? { ...row, status: 'no' as PtiStatus, sentDate: null }
        : row;
    });
}

export function stateOf(record: PtiRecord): ReturnType<typeof truckStateFor> {
  const truck = demoData.trucks.find((t) => t.id === record.truckId);
  return truck ? truckStateFor(truck.status) : 'inactive';
}

export interface PtiPatch {
  status?: PtiStatus;
  sentDate?: IsoDate | null;
  /**
   * The teammate a seeded or scripted review is attributed to, resolved against the demo users.
   *
   * People do not choose this on screen any more: the field below carries the account that
   * actually made the change.
   */
  checkedById?: string | null;
  /**
   * The account that made this change, as the session knows it.
   *
   * A PTI row records who last moved its status or result — not who volunteered a name — so the
   * caller states the signed-in account rather than offering a list of colleagues. The id is kept
   * beside the name so a later rename does not rewrite history.
   */
  checkedBy?: { id: string; name: string } | null;
  checkedDate?: IsoDate | null;
  result?: PtiResult;
  issueCategory?: PtiIssueCategory | null;
  issueNote?: string | null;
  actionTaken?: string | null;
  /** Closing a finding without a repair. A decision with a name on it, not a line of free text. */
  noRepairNeeded?: PtiNoRepairDecision | null;
}

export async function updatePti(recordId: string, patch: PtiPatch): Promise<PtiRecord> {
  const row = demoData.ptiRecords.find((r) => r.id === recordId);
  if (!row) throw new Error('That inspection row no longer exists');

  /*
   * The description rule holds here too (brief WP7). This is the pre-fleet_v2 path, and it was
   * how "65", ".+6." and "111111111111" got onto the board: an issue found with a note that is
   * not one is refused, whatever path sends it. A no_issues review carries no note to check.
   */
  const result = patch.result ?? row.result;
  const issueNote = patch.issueNote !== undefined ? patch.issueNote : row.issueNote;
  if (result === 'issue_found') {
    const problem = describeDescriptionProblem(issueNote ?? '');
    if (problem) throw new Error(`Issue: ${problem}`);
  }

  if (patch.checkedBy !== undefined) {
    row.checkedById = patch.checkedBy?.id ?? null;
    row.checkedByName = patch.checkedBy?.name ?? null;
  } else if (patch.checkedById !== undefined) {
    const user = demoData.users.find((u) => u.id === patch.checkedById) ?? null;
    row.checkedById = user?.id ?? null;
    row.checkedByName = user?.name ?? null;
  }
  for (const key of [
    'status',
    'sentDate',
    'checkedDate',
    'result',
    'issueCategory',
    'issueNote',
    'actionTaken',
  ] as const) {
    if (patch[key] !== undefined) {
      (row as unknown as Record<string, unknown>)[key] = patch[key] as unknown;
    }
  }
  if (patch.noRepairNeeded !== undefined) row.noRepairNeeded = patch.noRepairNeeded;

  // A finding on a component the walk-around catalog knows about is a rating of that component.
  // Recording "Brakes" in the review and leaving the Brakes rating untouched is how a unit could
  // carry a brake defect and a clean condition column at the same time (acceptance test A22).
  if (row.result === 'issue_found' && row.issueCategory) {
    noteConditionFromFinding(row);
  }

  // A row that has been reviewed no longer owes a fresh inspection.
  if (row.result !== 'pending' && row.status === 'sent') row.needsPti = false;
  row.updatedAt = stamp();
  saveSoon();
  return row;
}

/** Marks the walk-around as received, deciding on time or late from the cycle's due day. */
export async function receivePti(recordId: string, onDate: IsoDate = today()): Promise<PtiRecord> {
  const row = demoData.ptiRecords.find((r) => r.id === recordId);
  if (!row) throw new Error('That inspection row no longer exists');
  return updatePti(recordId, {
    status: onDate > dueDateOf(row.weekStart) ? 'late' : 'sent',
    sentDate: onDate,
  });
}

/**
 * Turns an issue into a work order in the Maintenance module.
 *
 * The row keeps the order's number so the board can show its live status, and the order carries
 * where it came from, so neither side has to be retyped or kept in step by hand.
 */
export async function raiseWorkOrder(recordId: string): Promise<PtiRecord> {
  const row = demoData.ptiRecords.find((r) => r.id === recordId);
  if (!row) throw new Error('That inspection row no longer exists');
  if (row.result !== 'issue_found') throw new Error('Only a row with an issue opens a work order');
  if (row.workOrderId) throw new Error(`Already on work order ${row.workOrderNumber}`);

  const order = await createRepairOrder({
    truckId: row.truckId,
    status: 'open',
    priority:
      row.issueCategory === 'Brakes' || row.issueCategory === 'Tires / Wheels' ? 'high' : 'normal',
    type: maintenanceTypeFor(row.issueCategory),
    summary: `PTI ${row.weekStart}: ${row.issueCategory ?? 'Issue'} — ${row.issueNote ?? 'see inspection video'}`,
    vendorName: 'In-house shop',
    technician: demoCurrentUser.name,
    promisedAt: null,
    warranty: false,
    notes: `Raised from the weekly inspection of unit ${row.unitNumber}.`,
  });

  row.workOrderId = order.id;
  row.workOrderNumber = order.roNumber;
  row.actionTaken = row.actionTaken?.trim()
    ? row.actionTaken
    : `Work order ${order.roNumber} opened`;
  row.updatedAt = stamp();
  saveSoon();
  return row;
}

/** The live status of the work order a row opened, or null. */
export function workOrderStatus(record: PtiRecord): string | null {
  if (!record.workOrderId) return null;
  return demoData.repairOrders.find((o) => o.id === record.workOrderId)?.status ?? null;
}

/** The board's counts, over the rows the board is showing. */
export function summarisePti(rows: PtiRecord[]) {
  const onRoad = rows.filter((row) => stateOf(row) === 'road');
  return {
    sent: rows.filter((row) => row.status === 'sent').length,
    // A truck in the shop is exempt from "missing" while it is in there.
    missing: onRoad.filter((row) => row.status === 'no').length,
    late: rows.filter((row) => row.status === 'late').length,
    issues: rows.filter((row) => row.result === 'issue_found').length,
    unresolved: rows.filter(isUnresolved).length,
    inShop: rows.filter((row) => stateOf(row) === 'shop').length,
  };
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

/** The fleet people who review videos. */
export function reviewers(users: User[] = demoData.users): User[] {
  const preferred = users.filter(
    (u) => u.status === 'active' && (u.department === 'maintenance' || u.department === 'safety'),
  );
  return preferred.length > 0 ? preferred : users.filter((u) => u.status === 'active');
}

/** The inspection category in the maintenance module's own vocabulary. */
function maintenanceTypeFor(category: PtiIssueCategory | null): MaintenanceType {
  switch (category) {
    case 'Brakes':
      return 'brake_repair';
    case 'Tires / Wheels':
      return 'tire_replacement';
    case 'Lights':
    case 'Mounting':
      return 'electrical';
    case 'Leaks':
      return 'engine';
    default:
      return 'other';
  }
}

/**
 * The component a walk-around category is about, where the two vocabularies agree.
 *
 * Only the unambiguous ones are mapped. "Tires / Wheels" is deliberately absent: the catalog keeps
 * steer, drive and trailer tyres apart and the category does not say which, so mapping it would be
 * a guess written into a unit's record. It stays a finding without a rating until somebody rates
 * the component they actually meant.
 */
const CATEGORY_COMPONENT_KEY: Partial<Record<PtiIssueCategory, string>> = Object.fromEntries(
  Object.entries(LEGACY_CATEGORY_MAP).flatMap(([category, target]) =>
    target ? [[category, target.key]] : [],
  ),
) as Partial<Record<PtiIssueCategory, string>>;

/**
 * Writes the finding into the unit's condition for the week.
 *
 * `monitor` and not `replace_now`: the review saw something, which is not the same as having
 * assessed how much life is left. It puts the component on the board where a person decides.
 * A rating already recorded for that component this week is left alone - a human judgement beats
 * one derived from a category.
 */
function noteConditionFromFinding(row: PtiRecord): void {
  const key = CATEGORY_COMPONENT_KEY[row.issueCategory as PtiIssueCategory];
  if (!key) return;
  const component = (demoData.ptiComponents ?? []).map(withKey).find((c) => c.key === key);
  if (!component) return;
  const already = (demoData.ptiRatings ?? []).some(
    (rating) =>
      rating.truckId === row.truckId &&
      rating.weekStart === row.weekStart &&
      rating.componentId === component.id,
  );
  if (already) return;
  demoData.ptiRatings = demoData.ptiRatings ?? [];
  demoData.ptiRatings.push({
    id: `ptr_finding_${row.id}_${component.id}`,
    recordId: row.id,
    weekStart: row.weekStart,
    truckId: row.truckId,
    componentId: component.id,
    rating: 'monitor',
    windowValue: null,
    windowUnit: null,
    odometerAtRating: demoData.trucks.find((t) => t.id === row.truckId)?.odometer ?? null,
    ratedAt: stamp(),
    ratedById: row.checkedById,
    ratedByName: row.checkedByName,
    note: row.issueNote,
    workOrderId: row.workOrderId,
    workOrderNumber: row.workOrderNumber,
  });
}
