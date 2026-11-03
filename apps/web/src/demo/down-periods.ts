/**
 * Down periods: one row per stretch of time a unit is out of service.
 *
 * The Fleet specification's central claim is that **availability is never free text**. A unit is
 * Down because a down period is open on it, and it is Ready because none is. A status somebody
 * typed cannot say when it changed, which is why downtime could not be measured at all: sixteen
 * trucks read "In maintenance" and twelve of them had no work order behind them.
 *
 * A period is opened by Mark down (about ten seconds, while the truck is stopping) and closed by
 * the repair record entered later from the invoice, or by Back in service when the truck is running
 * again before the paperwork arrives.
 *
 * Fleet specification §3.3.
 */

import { DATASET, demoData } from './data';
import { nowIso } from '@/lib/clock';
import { saveSoon } from './state-persist';
import type { IsoDateTime } from './types';

/** The ten systems Mark down offers. One tap, and it is what makes repeats findable later. */
export const DOWN_SYSTEMS = [
  'Brakes',
  'Tires & wheels',
  'Lights',
  'Air & leaks',
  'Engine & warning light',
  'Electrical',
  'Cooling',
  'Body & doors',
  'Coupling',
  'Other',
] as const;
export type DownSystem = (typeof DOWN_SYSTEMS)[number];

/** Where the unit physically is. Suggested from telematics, always editable. */
export type DownPlace = 'shop' | 'yard' | 'road';

export const DOWN_PLACE_LABEL: Record<DownPlace, string> = {
  shop: 'At a shop',
  yard: 'At our yard',
  road: 'On the road',
};

/** What is holding the unit, when anybody knows. Optional on purpose. */
export type DownHold =
  | 'diagnosing'
  | 'waiting_our_ok'
  | 'waiting_parts'
  | 'in_repair'
  | 'ready_for_pickup';

export const DOWN_HOLD_LABEL: Record<DownHold, string> = {
  diagnosing: 'Diagnosing',
  waiting_our_ok: 'Waiting on our OK',
  waiting_parts: 'Waiting for parts',
  in_repair: 'In repair',
  ready_for_pickup: 'Ready for pickup',
};

/** How a period started, so a migrated row is never mistaken for one somebody recorded. */
export type DownStartSource = 'mark_down' | 'work_order_in_shop' | 'repair_record' | 'migrated';

/** How it ended. `back_pending_record` is the truck running again with the paperwork still to come. */
export type DownEndSource = 'repair_record' | 'back_pending_record' | 'no_repair_needed' | 'mistake';

export interface DownPeriod {
  id: string;
  number: string;
  unitId: string;
  unitNumber: string;
  unitType: 'truck' | 'trailer';
  startedAt: IsoDateTime;
  startSource: DownStartSource;
  system: DownSystem | null;
  note: string;
  place: DownPlace;
  /** The shop or yard as written, when there is one. */
  placeName: string;
  vendorId: string | null;
  /** When the shop says the unit comes back. Optional, and its absence is itself a finding. */
  expectedBack: string | null;
  hold: DownHold | null;
  /** Who chases it. */
  ownerName: string | null;
  markedByName: string;
  /** Odometer and driver as they were when the unit stopped. */
  odometer: number | null;
  driverName: string | null;
  /** Open findings this period was raised for. */
  issueIds: string[];
  endedAt: IsoDateTime | null;
  endSource: DownEndSource | null;
  /** The repair record that closed it, when one did. */
  repairOrderId: string | null;
  createdAt: IsoDateTime;
  updatedAt: IsoDateTime;
}

function rows(): DownPeriod[] {
  if (!demoData.downPeriods) demoData.downPeriods = [];
  return demoData.downPeriods;
}

/** Every period, newest first. */
export function listDownPeriods(): DownPeriod[] {
  return [...rows()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
}

/** The periods still open, longest down first — the order the Off the road board reads in. */
export function openDownPeriods(): DownPeriod[] {
  return rows()
    .filter((row) => row.endedAt === null)
    .sort((a, b) => (a.startedAt > b.startedAt ? 1 : -1));
}

/** The open period on a unit, when it has one. A unit has at most one (specification §3.3). */
export function openDownPeriodFor(unitId: string): DownPeriod | null {
  return rows().find((row) => row.unitId === unitId && row.endedAt === null) ?? null;
}

function nextNumber(): string {
  const year = new Date().getFullYear();
  const used = rows().filter((row) => row.number.startsWith(`DP-${year}-`)).length;
  return `DP-${year}-${String(used + 1).padStart(4, '0')}`;
}

export interface MarkDownInput {
  unitId: string;
  unitNumber: string;
  unitType?: 'truck' | 'trailer';
  system: DownSystem | null;
  note: string;
  place: DownPlace;
  placeName?: string;
  vendorId?: string | null;
  expectedBack?: string | null;
  hold?: DownHold | null;
  ownerName?: string | null;
  markedByName: string;
  odometer?: number | null;
  driverName?: string | null;
  issueIds?: string[];
  startSource?: DownStartSource;
}

/**
 * Marks a unit down.
 *
 * The time is now and is never asked for: a date somebody types is a date somebody guesses, and
 * the whole point of the record is that the clock starts when the truck stops. Marking down a unit
 * that is already down returns the period it already has rather than opening a second one.
 */
export async function markDown(input: MarkDownInput): Promise<DownPeriod> {
  const existing = openDownPeriodFor(input.unitId);
  if (existing) return existing;

  const at = nowIso();
  const period: DownPeriod = {
    id: `dp_${at.replace(/\D/g, '')}_${input.unitId}`,
    number: nextNumber(),
    unitId: input.unitId,
    unitNumber: input.unitNumber,
    unitType: input.unitType ?? 'truck',
    startedAt: at,
    startSource: input.startSource ?? 'mark_down',
    system: input.system,
    note: input.note.trim(),
    place: input.place,
    placeName: input.placeName?.trim() ?? '',
    vendorId: input.vendorId ?? null,
    expectedBack: input.expectedBack ?? null,
    hold: input.hold ?? null,
    ownerName: input.ownerName ?? input.markedByName,
    markedByName: input.markedByName,
    odometer: input.odometer ?? null,
    driverName: input.driverName ?? null,
    issueIds: input.issueIds ?? [],
    endedAt: null,
    endSource: null,
    repairOrderId: null,
    createdAt: at,
    updatedAt: at,
  };
  rows().unshift(period);
  saveSoon();
  return period;
}

/** One-click edits from the board: a date, a note about the shop, who is chasing it. */
export async function updateDownPeriod(
  id: string,
  patch: Partial<
    Pick<DownPeriod, 'expectedBack' | 'hold' | 'ownerName' | 'placeName' | 'note' | 'system'>
  >,
): Promise<DownPeriod> {
  const row = rows().find((r) => r.id === id);
  if (!row) throw new Error('That down period no longer exists');
  Object.assign(row, patch);
  row.updatedAt = nowIso();
  saveSoon();
  return row;
}

/**
 * Ends a period.
 *
 * `back_pending_record` is the honest case: the truck is earning again and the invoice has not
 * arrived. It frees the unit for Dispatch and puts the period on the Missing paperwork list rather
 * than pretending the repair was recorded.
 */
export async function endDownPeriod(
  id: string,
  endSource: DownEndSource,
  at?: string,
  repairOrderId?: string,
): Promise<DownPeriod> {
  const row = rows().find((r) => r.id === id);
  if (!row) throw new Error('That down period no longer exists');
  row.endedAt = at ?? nowIso();
  row.endSource = endSource;
  row.repairOrderId = repairOrderId ?? null;
  row.updatedAt = nowIso();
  saveSoon();
  return row;
}

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

/** How long a period has run, in whole days and hours. */
export function downtimeOf(period: DownPeriod, now: number): { ms: number; label: string } {
  const end = period.endedAt ? Date.parse(period.endedAt) : now;
  const ms = Math.max(0, end - Date.parse(period.startedAt));
  const days = Math.floor(ms / DAY);
  const hours = Math.floor((ms % DAY) / HOUR);
  return { ms, label: days >= 1 ? `${days} d` : `${hours} h` };
}

/** Is the shop past the date it gave? */
export function pastExpectedBack(period: DownPeriod, today: string): boolean {
  return period.endedAt === null && period.expectedBack !== null && period.expectedBack < today;
}

/**
 * Gives the demo workspace a believable set of down periods.
 *
 * Without this the new Fleet screens open empty, which reads as "broken" rather than as "nothing is
 * wrong": the roster already says a dozen units are in a shop, and none of them had a record saying
 * when they stopped. That gap is the whole point of the model, so the seed reproduces it honestly —
 * most units get a reason, a place and a date, and a few deliberately do not, because that is what
 * the live workspace looked like.
 *
 * Runs once, only in the demo dataset, and never when periods already exist.
 */
export function seedDemoDownPeriods(
  units: {
    id: string;
    unitNumber: string;
    status: string;
    odometer?: number | null;
    currentDriverName?: string | null;
  }[],
): void {
  if (DATASET !== 'demo') return;
  if (rows().length > 0) return;

  const candidates = units.filter(
    (unit) => unit.status === 'in_shop' || unit.status === 'out_of_service',
  );
  if (candidates.length === 0) return;

  const SHAPES: {
    system: DownSystem | null;
    note: string;
    place: DownPlace;
    placeName: string;
    hold: DownHold | null;
    days: number;
    /** Days from the start the shop promised it back. Null means nobody ever asked. */
    promised: number | null;
  }[] = [
    { system: 'Electrical', note: 'ABS light on again', place: 'shop', placeName: 'Midwest Diesel Repair', hold: 'waiting_our_ok', days: 14, promised: 4 },
    { system: 'Cooling', note: 'Radiator and hoses', place: 'shop', placeName: 'Midwest Diesel Repair', hold: 'in_repair', days: 14, promised: 3 },
    { system: 'Engine & warning light', note: 'Clutch actuator, OEM part on order', place: 'shop', placeName: 'Lone Star Fleet Service', hold: 'waiting_parts', days: 13, promised: 4 },
    { system: 'Cooling', note: 'Radiator and hoses', place: 'shop', placeName: 'Ohio Valley Truck Care', hold: 'ready_for_pickup', days: 13, promised: 2 },
    { system: 'Electrical', note: 'Harness chafe, ABS light on', place: 'shop', placeName: 'Northwind Shop', hold: 'diagnosing', days: 13, promised: 3 },
    { system: 'Cooling', note: 'Radiator', place: 'yard', placeName: 'Naperville, IL', hold: null, days: 11, promised: null },
    { system: null, note: '', place: 'yard', placeName: 'Naperville, IL', hold: null, days: 9, promised: null },
    { system: 'Brakes', note: 'Walk-around finding, slack adjusters', place: 'shop', placeName: 'ZML Shop', hold: 'waiting_parts', days: 2, promised: null },
    { system: 'Tires & wheels', note: 'Drive axle set', place: 'road', placeName: 'Effingham, IL', hold: 'in_repair', days: 3, promised: 1 },
    { system: null, note: '', place: 'yard', placeName: 'Naperville, IL', hold: null, days: 6, promised: null },
  ];

  const MS_DAY = 86_400_000;
  const now = Date.now();
  const marked = ['Sarah Chen', 'Luis Herrera', 'Tom Brennan'];

  candidates.slice(0, SHAPES.length).forEach((unit, index) => {
    const shape = SHAPES[index] as (typeof SHAPES)[number];
    const startedAt = new Date(now - shape.days * MS_DAY).toISOString();
    const expectedBack =
      shape.promised === null
        ? null
        : new Date(Date.parse(startedAt) + shape.promised * MS_DAY).toISOString().slice(0, 10);
    rows().push({
      id: `dp_seed_${unit.id}`,
      number: `DP-${new Date(startedAt).getFullYear()}-${String(index + 1).padStart(4, '0')}`,
      unitId: unit.id,
      unitNumber: unit.unitNumber,
      unitType: 'truck',
      startedAt,
      startSource: 'mark_down',
      system: shape.system,
      note: shape.note,
      place: shape.place,
      placeName: shape.placeName,
      vendorId: null,
      expectedBack,
      hold: shape.hold,
      ownerName: shape.system === null ? null : (marked[index % marked.length] as string),
      markedByName: shape.system === null ? 'status typed by hand' : (marked[index % marked.length] as string),
      odometer: unit.odometer ?? null,
      driverName: unit.currentDriverName ?? null,
      issueIds: [],
      endedAt: null,
      endSource: null,
      repairOrderId: null,
      createdAt: startedAt,
      updatedAt: startedAt,
    });
  });

  /*
   * Two units that came back without their paperwork.
   *
   * The most common real gap, and the one the Missing paperwork list exists for: the truck is
   * earning again and the invoice is still in somebody's van.
   */
  const backAgain = units.filter((u) => u.status === 'available').slice(0, 2);
  backAgain.forEach((unit, index) => {
    const startedAt = new Date(now - (9 + index * 3) * MS_DAY).toISOString();
    const endedAt = new Date(now - (5 + index * 3) * MS_DAY).toISOString();
    rows().push({
      id: `dp_seed_back_${unit.id}`,
      number: `DP-${new Date(startedAt).getFullYear()}-${String(90 + index).padStart(4, '0')}`,
      unitId: unit.id,
      unitNumber: unit.unitNumber,
      unitType: 'truck',
      startedAt,
      startSource: 'mark_down',
      system: index === 0 ? 'Brakes' : 'Lights',
      note: index === 0 ? 'Air leak at the gladhand' : 'Marker lamp out',
      place: 'shop',
      placeName: index === 0 ? 'TA Truck Service' : 'Northwind Shop',
      vendorId: null,
      expectedBack: null,
      hold: null,
      ownerName: 'Luis Herrera',
      markedByName: 'Luis Herrera',
      odometer: unit.odometer ?? null,
      driverName: unit.currentDriverName ?? null,
      issueIds: [],
      endedAt,
      endSource: 'back_pending_record',
      repairOrderId: null,
      createdAt: startedAt,
      updatedAt: endedAt,
    });
  });

  saveSoon();
}

/** Periods closed with the truck back on the road and no repair record behind them. */
export function missingPaperwork(): DownPeriod[] {
  return rows()
    .filter((row) => row.endSource === 'back_pending_record' && row.repairOrderId === null)
    .sort((a, b) => (a.endedAt ?? '') < (b.endedAt ?? '') ? 1 : -1);
}
