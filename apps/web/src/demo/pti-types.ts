import type { IsoDate, IsoDateTime } from './types';

/**
 * The weekly walk-around inspection.
 *
 * Once a week a driver records a video of the whole truck and sends it in; the fleet team watches
 * it and gets developing problems fixed before one of them strands a truck mid-transit. The board
 * exists so that nobody is missed, which is why a row is created for **every eligible truck** at
 * the start of the cycle rather than when a video arrives: a truck with no row would be a truck
 * nobody noticed.
 *
 * The row is keyed on the truck, not the driver. The truck is what gets inspected, it keeps its
 * history when the driver changes, and a truck sitting in the shop is a fact about the truck.
 *
 * The video itself is **not** stored here. A weekly walk-around of every unit is tens of gigabytes
 * a month, which is a storage bill rather than a feature; the board records that one arrived, when,
 * and what the reviewer found in it. The file stays wherever the driver sent it.
 */

/** Did the video arrive, and in time. */
export type PtiStatus = 'sent' | 'no' | 'late';

/** What the reviewer concluded. `pending` means nobody has watched it yet. */
export type PtiResult = 'pending' | 'no_issues' | 'issue_found';

export const PTI_ISSUE_CATEGORIES = [
  'Lights',
  'Tires / Wheels',
  'Brakes',
  'Leaks',
  'Body',
  'Mounting',
  'Other',
] as const;

export type PtiIssueCategory = (typeof PTI_ISSUE_CATEGORIES)[number];

/**
 * Where the truck is this week, read from the truck record rather than typed here.
 *
 * `road` is the live queue. `shop` still appears — a truck leaving the shop needs a fresh
 * inspection — but below, and exempt from the missing count while it is in there. `inactive`
 * covers inactive and sold, and is hidden unless asked for.
 */
export type PtiTruckState = 'road' | 'shop' | 'inactive';

export interface PtiRecord {
  id: string;
  /** Monday of the PTI week this row belongs to. */
  weekStart: IsoDate;
  truckId: string;
  unitNumber: string;
  driverId: string | null;
  driverName: string | null;
  driverTag: string | null;
  dispatcherId: string | null;
  dispatcherName: string | null;

  status: PtiStatus;
  sentDate: IsoDate | null;

  checkedById: string | null;
  checkedByName: string | null;
  checkedDate: IsoDate | null;

  result: PtiResult;
  issueCategory: PtiIssueCategory | null;
  issueNote: string | null;
  actionTaken: string | null;

  /**
   * Who decided this finding needs no repair, and why. Absent while the finding is open.
   * Free text in `actionTaken` does not close a finding; this does (see `isUnresolved`).
   */
  noRepairNeeded?: PtiNoRepairDecision | null;

  /** The work order this inspection opened, when one was opened. */
  workOrderId: string | null;
  workOrderNumber: string | null;

  /** True when the truck came out of the shop and owes a fresh inspection this cycle. */
  needsPti: boolean;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

/** The cycle: a week starting Sunday (owner, 2026-10-18), with videos due by end of Wednesday. */
export const PTI_WEEK_STARTS_ON = 0;
export const PTI_DUE_DAY_OFFSET = 3;

/** A row that needs somebody to do something, and how long it has needed it. */
export function isUnresolved(record: PtiRecord): boolean {
  if (record.result !== 'issue_found') return false;
  // A work order is the thing that closes a finding: something is being done about it, and the
  // board can follow that order's status.
  if (record.workOrderId) return false;
  // Or somebody decided, by name, that no repair is needed - which is a decision, not a note.
  return record.noRepairNeeded == null;
}

/**
 * Why free text no longer closes a finding.
 *
 * A finding used to clear the moment anybody typed anything in "Action taken". "Will look at it",
 * "driver says it's fine", a stray keystroke - all of them took a defect off the board while the
 * defect was still on the truck. Unit 2718's slack adjuster sat that way, marked "Nothing yet",
 * with the truck showing Available. Closing a finding is now an act with a name attached to it.
 */
export interface PtiNoRepairDecision {
  reason: string;
  byId: string;
  byName: string;
  at: IsoDateTime;
}

export function daysOpen(record: PtiRecord, today: IsoDate): number {
  const from = Date.parse(`${record.checkedDate ?? record.weekStart}T00:00:00Z`);
  const to = Date.parse(`${today}T00:00:00Z`);
  return Math.max(0, Math.round((to - from) / 86_400_000));
}

/** Truck statuses to the three groups the board reads in. */
export function truckStateFor(status: string): PtiTruckState {
  const value = status.toLowerCase();
  if (value === 'in_shop' || value === 'maintenance') return 'shop';
  if (
    value === 'inactive' ||
    value === 'sold' ||
    value === 'out_of_service' ||
    value === 'archived'
  )
    return 'inactive';
  return 'road';
}

export const PTI_GROUP_LABEL: Record<PtiTruckState, string> = {
  road: 'On the road / home',
  shop: 'In shop',
  inactive: 'Inactive and sold',
};
