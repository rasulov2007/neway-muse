/**
 * Maintenance spending, computed from the records and nothing else.
 *
 * Pure: every input is passed in — the roster, the work orders, the service records, the odometer
 * readings, the resolved period, today's date and the timezone conversion — so the same records
 * always produce the same figures and a test can pin every rule. The honesty rules the dashboard
 * engines follow apply here too (docs/DASHBOARD.md §4): a figure that cannot be computed is `null`
 * with a reason, a zero is a real zero, and every number carries the ids it was summed from.
 *
 * Spending basis:
 *  - A **work order** counts when it is `completed` and has a completion timestamp, on the
 *    company-local day of that completion, at its canonical `total`. The invoice write path already
 *    makes the latest amount-bearing invoice authoritative for `total`; a disagreement between the
 *    two is reported, never silently resolved here.
 *  - A **service record** counts on its service date when it is not linked to an order. One that
 *    points at an order in the workspace is the same repair seen twice and is counted through the
 *    order. One that points at an order the workspace no longer holds is standalone in practice.
 *  - Draft and cancelled orders, orders still open, orders with no completion date and any record
 *    without a finite amount are excluded and counted as such.
 */
import {
  MAINTENANCE_TYPE_LABEL,
  METRIC_CONFIDENCE,
  SCHEDULED_MAINTENANCE_TYPES,
  maintenanceDue,
  metricConfidence,
  trendIsMeaningful,
  type FleetAnomaly,
  type FleetAnomalyCheck,
  type FleetCategorySlice,
  type FleetExpenseSummary,
  type FleetMetric,
  type FleetMonth,
  type FleetServiceTypeRow,
  type FleetSpendEvent,
  type FleetSpendPeriod,
  type FleetUnitTypeFilter,
  type FleetVehicleRow,
  type UnitKind,
  type FleetVendorRow,
  type MaintenanceTypeCode,
} from '@neway/shared';
import { roundMoney, roundPct, roundRatio, safeDivide, sum } from '../reporting/engines/money';
import { addDays, daysInclusive, type IsoDate } from '../reporting/period/date-utils';

// ---------------------------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------------------------

export interface EngineTruck {
  id: string;
  /** A truck from the roster, or a trailer from the workspace. */
  kind: UnitKind;
  unitNumber: string;
  year: number;
  make: string;
  model: string;
  ownership: string;
  status: string;
  odometer: number | null;
  nextServiceOdometer: number | null;
  nextServiceDate: string | null;
  /** The driver on the unit, for the vehicles table; trailers and idle trucks have none. */
  driverName?: string | null;
}

export interface SourceWorkOrder {
  id: string;
  roNumber: string;
  truckId: string;
  status: string;
  type: string;
  vendorName: string | null;
  vendorId: string | null;
  /** `trailer` with `trailerId` set is a trailer order; anything else is about `truckId`. */
  unitType: string | null;
  trailerId: string | null;
  openedAt: string;
  completedAt: string | null;
  odometer: number | null;
  total: number | null;
  invoices: Array<{ amount: number | null; uploadedAt: string }>;
  /** What the shop did, as the order records it. */
  workDone?: string | null;
  /** The stored invoice, when one is filed, so a spend row can open it. */
  invoiceFileId?: string | null;
  /**
   * The part of `total` charged to the unit's owner rather than the company. Null or zero means
   * the company pays all of it.
   */
  ownerBilledAmount?: number | null;
  /** Who pays (company when absent): driver, investigation or warranty (owner, 2026-10-13). */
  payer?: 'company' | 'driver' | 'investigation' | 'warranty' | 'owner';
}

export interface SourceServiceRecord {
  id: string;
  truckId: string;
  type: string;
  description: string;
  doneAt: string;
  odometer: number | null;
  vendorName: string | null;
  cost: number | null;
  repairOrderId: string | null;
}

/**
 * A Fleet Expense entered by hand (parking, truck wash, tolls ...), counted only in the All fleet
 * costs scope. It is its own kind of event with its own reference, never a fake work order.
 */
export interface SourceFleetExpense {
  id: string;
  reference: string;
  truckId: string;
  /** A Fleet Expense category; manual repairs count as maintenance type `other`. */
  type: string;
  date: IsoDate;
  amount: number;
  vendorName: string | null;
  description: string | null;
  payer?: 'company' | 'driver' | 'investigation' | 'owner';
  /** The part charged to a driver (a partial charge leaves the rest with the company). */
  driverShare?: number;
}

/** A dated odometer reading from any source that records one (fuel fills, mainly). */
export interface SourceOdometerReading {
  truckId: string;
  at: string;
  odometer: number | null;
}

export interface EnginePeriod {
  preset: FleetSpendPeriod;
  from: IsoDate;
  to: IsoDate;
  label: string;
  timezone: string;
  comparison: { from: IsoDate; to: IsoDate; label: string };
}

export interface EngineInput {
  /** The company's roster: the only way a record is tied to this company. */
  trucks: EngineTruck[];
  /** The vendor records the workspace holds, so an id groups under its current name. */
  vendors: Array<{ id: string; name: string }>;
  workOrders: SourceWorkOrder[];
  serviceRecords: SourceServiceRecord[];
  /** Fleet Expenses for the All fleet costs scope; empty (or absent) for Maintenance only. */
  fleetExpenses?: SourceFleetExpense[];
  odometerReadings: SourceOdometerReading[];
  period: EnginePeriod;
  /** Company-local today. */
  today: IsoDate;
  /** Unit ids to restrict to; empty means the roster. Already validated against the roster. */
  selectedUnits: string[];
  /** Trucks, trailers, or both. */
  unitType: FleetUnitTypeFilter;
  /** Ids the caller asked for that are not on the roster. */
  unknownUnits: string[];
  /** Company-local calendar day of an ISO instant; a date-only string passes through; null when unreadable. */
  localDate: (iso: string) => IsoDate | null;
  provenance: 'demo' | 'workspace';
  snapshotUpdatedAt: string | null;
  asOf: string;
}

// ---------------------------------------------------------------------------------------------
// Thresholds — named here so the checks block can state them and a test can pin them.
// ---------------------------------------------------------------------------------------------

export const RULES = {
  /** A unit's period spend must exceed this multiple of its trailing average to be a spike. */
  spikeMultiple: 2,
  /** ...and this many prior equal-length ranges with spend must exist for an average to mean anything. */
  spikeMinPriorPeriods: 2,
  /** ...and the spend must be at least this, so a $60 filter after two $10 ones is not a spike. */
  spikeMinSpend: 500,
  /** How many prior equal-length ranges the trailing average looks back over. */
  spikeLookbackPeriods: 4,
  /** Same repair type on the same unit twice within this many days (owner: 60, 2026-10-06). */
  repeatWindowDays: 60,
  /** A unit's cost per mile must exceed this multiple of the fleet median. */
  cpmMultiple: 1.5,
  /** ...among at least this many units with valid mileage coverage. */
  cpmMinUnits: 3,
  /** An event must exceed this multiple of the median of the same service type... */
  expensiveMultiple: 2,
  /** ...over at least this many other events of that type, and be at least this much. */
  expensiveMinHistory: 5,
  expensiveMinAmount: 250,
  /** Odometer readings must span at least this share of the period for mileage to count. */
  mileageMinCoverage: 0.8,
  /** A service type touching at least this many units is flagged as widespread... */
  widespreadMinUnits: 3,
  /** ...or this share of the selected fleet, whichever is larger. */
  widespreadShare: 0.25,
} as const;

// ---------------------------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------------------------

const TYPES = new Set<string>(Object.keys(MAINTENANCE_TYPE_LABEL));

function asType(value: string): MaintenanceTypeCode {
  return (TYPES.has(value) ? value : 'other') as MaintenanceTypeCode;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function inRange(date: IsoDate, from: IsoDate, to: IsoDate): boolean {
  return date >= from && date <= to;
}

interface EventBuild {
  events: FleetSpendEvent[];
  coverage: FleetExpenseSummary['coverage'];
}

/** Every countable event across all time, plus what was left out and why. */
export function buildEvents(
  input: Pick<EngineInput, 'workOrders' | 'serviceRecords' | 'localDate' | 'fleetExpenses'>,
  trucks: Map<string, EngineTruck>,
  selection: Set<string>,
): EventBuild {
  const excluded = {
    draftOrCancelled: 0,
    notCompleted: 0,
    missingCompletionDate: 0,
    unknownAmount: 0,
    unattributedTruck: 0,
    linkedServiceRecords: 0,
    invoiceMismatch: 0,
    duplicateRecords: 0,
  };
  const invoiceMismatchIds: string[] = [];
  const ownerBilled = { amount: 0, orders: 0 };
  const events: FleetSpendEvent[] = [];
  const orderIds = new Set(input.workOrders.map((order) => order.id));
  let zeroAmountEvents = 0;

  for (const order of input.workOrders) {
    const unitId = order.unitType === 'trailer' ? (order.trailerId ?? '') : order.truckId;
    const truck = trucks.get(unitId);
    if (!truck) {
      excluded.unattributedTruck += 1;
      continue;
    }
    if (!selection.has(unitId)) continue;
    if (order.status === 'draft' || order.status === 'cancelled') {
      excluded.draftOrCancelled += 1;
      continue;
    }
    if (order.status !== 'completed') {
      excluded.notCompleted += 1;
      continue;
    }
    const completedOn = order.completedAt ? input.localDate(order.completedAt) : null;
    if (!completedOn) {
      excluded.missingCompletionDate += 1;
      continue;
    }
    if (!isFiniteNumber(order.total)) {
      excluded.unknownAmount += 1;
      continue;
    }
    // The latest invoice that carries an amount is what the write path made authoritative. If the
    // stored total says something else, somebody edited one without the other; say so.
    const priced = order.invoices.filter((invoice) => isFiniteNumber(invoice.amount));
    const latest = priced.length > 0 ? priced[priced.length - 1] : null;
    if (latest && roundMoney(latest.amount as number) !== roundMoney(order.total)) {
      excluded.invoiceMismatch += 1;
      invoiceMismatchIds.push(order.id);
    }
    const amount = roundMoney(order.total);
    // What the owner pays is the owner's, not the fleet's. A split leaves the company's share in
    // the spend and reports the rest; an order billed entirely to an owner leaves no spend at all.
    const ownerShare = isFiniteNumber(order.ownerBilledAmount)
      ? Math.min(Math.max(roundMoney(order.ownerBilledAmount), 0), amount)
      : 0;
    if (ownerShare > 0) {
      ownerBilled.amount = roundMoney(ownerBilled.amount + ownerShare);
      ownerBilled.orders += 1;
    }
    const companyShare = roundMoney(amount - ownerShare);
    if (companyShare === 0 && ownerShare > 0) continue;
    if (companyShare === 0) zeroAmountEvents += 1;
    events.push({
      id: order.id,
      kind: 'work_order',
      reference: order.roNumber,
      truckId: unitId,
      unitKind: truck.kind,
      unitNumber: truck.unitNumber,
      type: asType(order.type),
      date: completedOn,
      vendorName: order.vendorName?.trim() || null,
      vendorId: order.vendorId || null,
      // What the company pays: the owner's share of a split is not fleet spend.
      amount: companyShare,
      amountSource: latest ? 'invoice' : 'work_order',
      odometer: isFiniteNumber(order.odometer) && order.odometer > 0 ? order.odometer : null,
      description: order.workDone?.trim() || null,
      invoiceFileId: order.invoiceFileId ?? null,
      payer: order.payer ?? 'company',
      driverShare: order.payer === 'driver' ? companyShare : 0,
    });
  }

  for (const record of input.serviceRecords) {
    const truck = trucks.get(record.truckId);
    if (!truck) {
      excluded.unattributedTruck += 1;
      continue;
    }
    if (!selection.has(record.truckId)) continue;
    if (record.repairOrderId && orderIds.has(record.repairOrderId)) {
      excluded.linkedServiceRecords += 1;
      continue;
    }
    const doneOn = record.doneAt ? input.localDate(record.doneAt) : null;
    if (!doneOn) {
      excluded.missingCompletionDate += 1;
      continue;
    }
    if (!isFiniteNumber(record.cost)) {
      excluded.unknownAmount += 1;
      continue;
    }
    const amount = roundMoney(record.cost);
    if (amount === 0) zeroAmountEvents += 1;
    events.push({
      id: record.id,
      kind: 'service_record',
      reference: record.description || MAINTENANCE_TYPE_LABEL[asType(record.type)],
      truckId: record.truckId,
      unitKind: truck.kind,
      unitNumber: truck.unitNumber,
      type: asType(record.type),
      date: doneOn,
      vendorName: record.vendorName?.trim() || null,
      vendorId: null,
      amount,
      amountSource: 'service_record',
      odometer: isFiniteNumber(record.odometer) && record.odometer > 0 ? record.odometer : null,
      description: record.description?.trim() || null,
      // A standalone service record has no invoice of its own.
      invoiceFileId: null,
      payer: 'company',
      driverShare: 0,
    });
  }

  for (const expense of input.fleetExpenses ?? []) {
    const truck = trucks.get(expense.truckId);
    if (!truck) {
      excluded.unattributedTruck += 1;
      continue;
    }
    if (!selection.has(expense.truckId)) continue;
    events.push({
      id: expense.id,
      kind: 'fleet_expense',
      reference: expense.reference,
      truckId: expense.truckId,
      unitKind: truck.kind,
      unitNumber: truck.unitNumber,
      type: asType(expense.type),
      date: expense.date,
      vendorName: expense.vendorName?.trim() || null,
      vendorId: null,
      amount: roundMoney(expense.amount),
      amountSource: 'fleet_expense',
      odometer: null,
      description: expense.description,
      invoiceFileId: null,
      payer: expense.payer ?? 'company',
      driverShare: roundMoney(Math.min(expense.driverShare ?? 0, expense.amount)),
    });
  }

  /*
   * One record, one event - the last line of defence.
   *
   * A work order can reach this report from two places: the workspace snapshot the browser keeps
   * and the server's own table. The service drops the copy it can recognise, but anything it
   * cannot - a number typed twice, a migration that lost its origin - would otherwise be counted
   * twice in every total on the page. So the id is made to mean one record here, and the
   * duplicates are counted rather than silently dropped.
   */
  const byId = new Set<string>();
  const unique: FleetSpendEvent[] = [];
  for (const event of events) {
    if (byId.has(event.id)) {
      excluded.duplicateRecords += 1;
      continue;
    }
    byId.add(event.id);
    unique.push(event);
  }
  events.length = 0;
  events.push(...unique);

  events.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.id.localeCompare(b.id)));

  return {
    events,
    coverage: {
      workOrdersCounted: 0,
      serviceRecordsCounted: 0,
      zeroAmountEvents,
      excluded,
      invoiceMismatchIds,
      ownerBilled,
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Mileage
// ---------------------------------------------------------------------------------------------

export interface MileageResult {
  truckId: string;
  miles: number | null;
  readings: number;
  /** Why `miles` is null. */
  reason: string | null;
}

/**
 * Miles a unit turned inside a range, from the odometer readings its records carry.
 *
 * Readings are sorted by time; a reading that goes backwards means a reset or a typo and voids the
 * unit rather than producing negative miles. The readings must also span most of the range: a
 * unit with two fills in the last week of a quarter did not turn its whole quarter's miles between
 * them, and dividing a quarter's spend by a week's miles would say it did.
 */
export function mileageFor(
  truckId: string,
  readings: Array<{ date: IsoDate; odometer: number }>,
  from: IsoDate,
  to: IsoDate,
): MileageResult {
  const rows = readings
    .filter((r) => isFiniteNumber(r.odometer) && r.odometer > 0 && inRange(r.date, from, to))
    .sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : a.odometer - b.odometer));
  // The same reading recorded twice (a fill and its expense line, say) is one reading.
  const distinct = rows.filter(
    (r, index) =>
      index === 0 || r.date !== rows[index - 1]?.date || r.odometer !== rows[index - 1]?.odometer,
  );
  if (distinct.length < 2) {
    return {
      truckId,
      miles: null,
      readings: distinct.length,
      reason: 'fewer than two odometer readings',
    };
  }
  for (let i = 1; i < distinct.length; i += 1) {
    if ((distinct[i]?.odometer ?? 0) < (distinct[i - 1]?.odometer ?? 0)) {
      return { truckId, miles: null, readings: distinct.length, reason: 'odometer went backwards' };
    }
  }
  const first = distinct[0] as { date: IsoDate; odometer: number };
  const last = distinct[distinct.length - 1] as { date: IsoDate; odometer: number };
  const span = daysInclusive(from, to);
  const covered = daysInclusive(first.date, last.date);
  if (covered < span * RULES.mileageMinCoverage) {
    return {
      truckId,
      miles: null,
      readings: distinct.length,
      reason: `readings cover ${covered} of ${span} days`,
    };
  }
  const miles = last.odometer - first.odometer;
  if (miles <= 0)
    return { truckId, miles: null, readings: distinct.length, reason: 'no miles between readings' };
  return { truckId, miles, readings: distinct.length, reason: null };
}

// ---------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------

/**
 * The six calendar months ending in the month `to` falls in, from every counted event: the
 * chart shows a run-up whatever the period preset, and the last bar is the month still open.
 */
function monthlySeries(
  events: FleetSpendEvent[],
  to: IsoDate,
  spendOf: (rows: FleetSpendEvent[]) => number,
): FleetMonth[] {
  const endYear = Number(to.slice(0, 4));
  const endMonth = Number(to.slice(5, 7));
  const months: FleetMonth[] = [];
  for (let back = 5; back >= 0; back -= 1) {
    const index = endYear * 12 + (endMonth - 1) - back;
    const year = Math.floor(index / 12);
    const month = (index % 12) + 1;
    const key = `${year}-${String(month).padStart(2, '0')}`;
    const rows = events.filter((e) => e.date.startsWith(key));
    months.push({
      month: key,
      label: new Date(Date.UTC(year, month - 1, 1)).toLocaleDateString('en-US', {
        month: 'short',
        timeZone: 'UTC',
      }),
      spend: spendOf(rows),
      events: rows.length,
      current: back === 0,
    });
  }
  const years = new Set(months.map((m) => m.month.slice(0, 4)));
  if (years.size > 1) for (const m of months) m.label = `${m.label} ${m.month.slice(0, 4)}`;
  return months;
}

function deltaPct(value: number | null, previous: number | null): number | null {
  if (value === null || previous === null || previous === 0) return null;
  return roundPct(((value - previous) / Math.abs(previous)) * 100);
}

function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? (sorted[mid] as number)
    : ((sorted[mid - 1] as number) + (sorted[mid] as number)) / 2;
}

function money(value: number): string {
  return `$${value.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function normaliseVendor(name: string | null): string {
  const key = (name ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  return key === '' ? 'unknown' : key;
}

function groupBy<T, K>(rows: T[], key: (row: T) => K): Map<K, T[]> {
  const out = new Map<K, T[]>();
  for (const row of rows) {
    const k = key(row);
    const bucket = out.get(k);
    if (bucket) bucket.push(row);
    else out.set(k, [row]);
  }
  return out;
}

function metric(partial: Partial<FleetMetric> & Pick<FleetMetric, 'basis'>): FleetMetric {
  return {
    value: null,
    previous: null,
    deltaPct: null,
    reasons: [],
    current: false,
    recordIds: [],
    link: null,
    confidence: null,
    ...partial,
  };
}

// ---------------------------------------------------------------------------------------------
// The summary
// ---------------------------------------------------------------------------------------------

export function computeExpenseSummary(input: EngineInput): FleetExpenseSummary {
  const { period, today } = input;
  const trucks = new Map(input.trucks.map((truck) => [truck.id, truck]));
  // Trucks, trailers or both, then the explicit unit list inside that.
  const inKind = input.trucks.filter((u) => input.unitType === 'all' || u.kind === input.unitType);
  const selection = new Set(
    (input.selectedUnits.length > 0
      ? inKind.filter((u) => input.selectedUnits.includes(u.id))
      : inKind
    ).map((u) => u.id),
  );
  const selectedTrucks = input.trucks.filter((truck) => selection.has(truck.id));
  const poweredUnits = selectedTrucks.filter((u) => u.kind === 'truck');
  const fleetMix = {
    trucks: poweredUnits.length,
    trailers: selectedTrucks.length - poweredUnits.length,
  };
  const mixLabel = `${fleetMix.trucks} truck${fleetMix.trucks === 1 ? '' : 's'}, ${fleetMix.trailers} trailer${fleetMix.trailers === 1 ? '' : 's'}`;

  const built = buildEvents(input, trucks, selection);
  const all = built.events;
  const current = all.filter((e) => inRange(e.date, period.from, period.to));
  const previous = all.filter((e) => inRange(e.date, period.comparison.from, period.comparison.to));
  const coverage: FleetExpenseSummary['coverage'] = {
    ...built.coverage,
    workOrdersCounted: current.filter((e) => e.kind === 'work_order').length,
    serviceRecordsCounted: current.filter((e) => e.kind === 'service_record').length,
    zeroAmountEvents: current.filter((e) => e.amount === 0).length,
  };

  const spendOf = (events: FleetSpendEvent[]): number =>
    roundMoney(sum(events.map((e) => e.amount)));
  const ids = (events: FleetSpendEvent[]): string[] => events.map((e) => e.id);

  // ---- mileage, per unit, for the period and for the comparison ------------------------------
  const readingsByTruck = groupBy(
    [
      ...input.odometerReadings
        .filter(
          (r) => trucks.has(r.truckId) && selection.has(r.truckId) && isFiniteNumber(r.odometer),
        )
        .map((r) => ({
          truckId: r.truckId,
          date: input.localDate(r.at),
          odometer: r.odometer as number,
        }))
        .filter((r): r is { truckId: string; date: IsoDate; odometer: number } => r.date !== null),
      ...all
        .filter((e) => e.odometer !== null)
        .map((e) => ({ truckId: e.truckId, date: e.date, odometer: e.odometer as number })),
    ],
    (r) => r.truckId,
  );
  // Cost per mile is a truck figure: a trailer carries no odometer, so it is not in the ratio.
  const mileage = (from: IsoDate, to: IsoDate): Map<string, MileageResult> =>
    new Map(
      poweredUnits.map((truck) => [
        truck.id,
        mileageFor(truck.id, readingsByTruck.get(truck.id) ?? [], from, to),
      ]),
    );
  const currentMileage = mileage(period.from, period.to);
  const previousMileage = mileage(period.comparison.from, period.comparison.to);

  const cpmOver = (
    events: FleetSpendEvent[],
    miles: Map<string, MileageResult>,
  ): { cpm: number | null; miles: number; spend: number; units: string[] } => {
    const units = [...miles.values()].filter((m) => m.miles !== null).map((m) => m.truckId);
    const unitSet = new Set(units);
    const spend = spendOf(events.filter((e) => unitSet.has(e.truckId)));
    const total = sum(units.map((id) => miles.get(id)?.miles ?? 0));
    const ratio = safeDivide(spend, total);
    return { cpm: ratio === null ? null : roundRatio(ratio), miles: total, spend, units };
  };
  // Cost per mile is a maintenance figure: parking, cash advances and the like are not in it.
  const maintenanceOnly = (events: FleetSpendEvent[]) => events.filter((e) => e.kind !== 'fleet_expense');
  const cpmNow = cpmOver(maintenanceOnly(current), currentMileage);
  const cpmBefore = cpmOver(maintenanceOnly(previous), previousMileage);

  // ---- KPIs ------------------------------------------------------------------------------------
  const totalNow = spendOf(current);
  const totalBefore = spendOf(previous);
  const totalSpend = metric({
    value: totalNow,
    previous: totalBefore,
    // A period that spent $80 and now spends $240 is "up 200%", which is a sentence about three
    // oil filters. No percentage below the base the specification sets (A17).
    deltaPct: trendIsMeaningful(totalBefore, previous.length)
      ? deltaPct(totalNow, totalBefore)
      : null,
    basis: `${coverage.workOrdersCounted} completed work orders by completion date and ${coverage.serviceRecordsCounted} standalone service records by service date, deduplicated`,
    recordIds: ids(current),
    reasons: current.length === 0 ? ['No completed work in this period'] : [],
  });

  const uncovered = [...currentMileage.values()].filter((m) => m.miles === null);
  /*
   * How much of the fleet this figure actually measured.
   *
   * Cost per mile divides spend by the miles of the trucks whose odometers can be trusted. When
   * that is a third of the fleet, the quotient is not the fleet's cost per mile, and printing it
   * anyway is how a number nobody can reproduce ends up in a decision. Below the floor the figure
   * is withheld and the coverage is shown in its place; between the floor and High it is shown
   * with its coverage attached (Fleet specification; acceptance test A16).
   */
  const cpmConfidence = metricConfidence(cpmNow.units.length, poweredUnits.length);
  const cpmShown = cpmConfidence.level === 'low' ? null : cpmNow.cpm;
  const cpmTrend =
    cpmShown !== null &&
    cpmConfidence.level === 'high' &&
    trendIsMeaningful(cpmBefore.spend, previous.length)
      ? deltaPct(cpmNow.cpm, cpmBefore.cpm)
      : null;
  const costPerMile = metric({
    value: cpmShown,
    previous: cpmBefore.cpm,
    deltaPct: cpmTrend,
    confidence: cpmConfidence,
    basis:
      cpmNow.units.length > 0
        ? `${money(cpmNow.spend)} on the ${cpmNow.units.length} of ${poweredUnits.length} trucks with valid odometer coverage, over ${Math.round(cpmNow.miles).toLocaleString('en-US')} miles between their first and last readings in the period; trailers carry no odometer and are not in this figure`
        : 'Spend divided by miles between dated odometer readings on the same trucks in the same period; trailers carry no odometer',
    reasons:
      cpmNow.cpm !== null && cpmShown === null
        ? [
            `Not shown: odometer readings cover only ${cpmConfidence.coveragePct}% of the ${poweredUnits.length} trucks in scope, and a fleet figure needs ${METRIC_CONFIDENCE.mediumPct}%`,
            ...(uncovered.length > 0
              ? [`${uncovered.length} trucks left out: ${summariseReasons(uncovered)}`]
              : []),
          ]
        : cpmNow.cpm === null
          ? [
              input.unitType === 'trailer'
                ? 'Not applicable to trailers: a trailer carries no odometer, so there are no miles to divide by'
                : poweredUnits.length === 0
                  ? 'No trucks selected'
                  : `No truck has odometer readings spanning at least ${Math.round(RULES.mileageMinCoverage * 100)}% of the period (${summariseReasons(uncovered)})`,
            ]
          : [
              ...(uncovered.length > 0
                ? [`${uncovered.length} trucks left out: ${summariseReasons(uncovered)}`]
                : []),
              ...(fleetMix.trailers > 0
                ? [
                    `${fleetMix.trailers} trailers in scope carry no odometer and are not in this figure`,
                  ]
                : []),
            ],
    recordIds: ids(maintenanceOnly(current).filter((e) => cpmNow.units.includes(e.truckId))),
  });

  const inShop = selectedTrucks.filter((t) => t.status === 'in_shop');
  const inShopNow = metric({
    value: inShop.length,
    current: true,
    basis: `Units whose status is in shop, as stored now (${inShop.filter((t) => t.kind === 'truck').length} trucks, ${inShop.filter((t) => t.kind === 'trailer').length} trailers of ${mixLabel} in scope); an open work order alone does not put a unit here`,
    recordIds: inShop.map((t) => t.id),
    link: unitLink(inShop),
  });

  const onRoster = selectedTrucks.filter((t) => t.status !== 'sold' && t.status !== 'archived');
  const onRosterIds = new Set(onRoster.map((t) => t.id));
  const rosterSpendNow = spendOf(current.filter((e) => onRosterIds.has(e.truckId)));
  const rosterSpendBefore = spendOf(previous.filter((e) => onRosterIds.has(e.truckId)));
  const avgNow = safeDivide(rosterSpendNow, onRoster.length);
  const avgBefore = safeDivide(rosterSpendBefore, onRoster.length);
  const averagePerVehicle = metric({
    value: avgNow === null ? null : roundMoney(avgNow),
    previous: avgBefore === null ? null : roundMoney(avgBefore),
    deltaPct: deltaPct(avgNow, avgBefore),
    basis: `${money(rosterSpendNow)} on the ${onRoster.length} units on the roster now (${onRoster.filter((t) => t.kind === 'truck').length} trucks, ${onRoster.filter((t) => t.kind === 'trailer').length} trailers; status other than sold) ÷ ${onRoster.length}; membership is by current status, not by who was active in the period`,
    reasons: onRoster.length === 0 ? ['No units on the roster'] : [],
    recordIds: ids(current.filter((e) => onRosterIds.has(e.truckId))),
  });

  const inactive = selectedTrucks.filter((t) => t.status === 'inactive');
  const inactiveNow = metric({
    value: inactive.length,
    current: true,
    basis: `Units whose status is inactive now (${inactive.filter((t) => t.kind === 'truck').length} trucks, ${inactive.filter((t) => t.kind === 'trailer').length} trailers); there is no status history, so this is not a period count`,
    recordIds: inactive.map((t) => t.id),
    link: unitLink(inactive),
  });

  const leaseOverage = metric({
    value: null,
    basis:
      'Miles over a lease allowance times the lease rate, which needs the allowance, term, rate and dated mileage per unit',
    reasons: [
      'Lease mileage terms not configured — no unit records an allowance, term or rate, and there is no screen to enter one yet',
    ],
  });

  // ---- vendors ---------------------------------------------------------------------------------
  // By record where the order names one, so two spellings of one shop are one row; by normalised
  // name for the rest, and the response says how many fell back.
  const vendorNameById = new Map(input.vendors.map((v) => [v.id, v.name]));
  const vendors: FleetVendorRow[] = [
    ...groupBy(current, (e) =>
      e.vendorId && vendorNameById.has(e.vendorId)
        ? `id:${e.vendorId}`
        : normaliseVendor(e.vendorName),
    ).entries(),
  ]
    .map(([key, events]) => {
      const latest = [...events].sort((a, b) => (a.date < b.date ? 1 : -1))[0];
      const vendorId = key.startsWith('id:') ? key.slice(3) : null;
      return {
        key: vendorId ?? key,
        vendorId,
        name: vendorId
          ? (vendorNameById.get(vendorId) as string)
          : key === 'unknown'
            ? 'Unknown vendor'
            : (latest?.vendorName ?? key),
        spend: spendOf(events),
        events: events.length,
        truckCount: new Set(events.map((e) => e.truckId)).size,
        recordIds: ids(events),
      };
    })
    .sort((a, b) => b.spend - a.spend || a.name.localeCompare(b.name));
  const byNameOnly = current.filter((e) => !(e.vendorId && vendorNameById.has(e.vendorId))).length;

  // ---- categories ------------------------------------------------------------------------------
  const categoryRows: FleetCategorySlice[] = [...groupBy(current, (e) => e.type).entries()]
    .map(([type, events]) => ({
      key: type,
      type,
      label: MAINTENANCE_TYPE_LABEL[type],
      spend: spendOf(events),
      events: events.length,
      sharePct: totalNow > 0 ? roundPct((spendOf(events) / totalNow) * 100) : 0,
      recordIds: ids(events),
    }))
    .sort((a, b) => b.spend - a.spend || a.label.localeCompare(b.label));
  let slices = categoryRows;
  let otherMembers: FleetCategorySlice[] = [];
  if (categoryRows.length > 6) {
    const top = categoryRows.slice(0, 5);
    otherMembers = categoryRows.slice(5);
    const restSpend = roundMoney(sum(otherMembers.map((s) => s.spend)));
    slices = [
      ...top,
      {
        // Its own key: the roll-up and the `other` category are different sets of records.
        key: 'all-other-types',
        type: 'other',
        label: `All other types (${otherMembers.length})`,
        spend: restSpend,
        events: sum(otherMembers.map((s) => s.events)),
        sharePct: totalNow > 0 ? roundPct((restSpend / totalNow) * 100) : 0,
        recordIds: otherMembers.flatMap((s) => s.recordIds),
      },
    ];
  }

  // ---- service types ---------------------------------------------------------------------------
  const widespreadThreshold = Math.max(
    RULES.widespreadMinUnits,
    Math.ceil(selectedTrucks.length * RULES.widespreadShare),
  );
  const serviceTypes: FleetServiceTypeRow[] = [...groupBy(current, (e) => e.type).entries()]
    .map(([type, events]) => {
      const truckCount = new Set(events.map((e) => e.truckId)).size;
      return {
        type,
        label: MAINTENANCE_TYPE_LABEL[type],
        events: events.length,
        spend: spendOf(events),
        truckCount,
        widespread: truckCount >= widespreadThreshold,
        recordIds: ids(events),
      };
    })
    .sort((a, b) => b.events - a.events || b.spend - a.spend || a.label.localeCompare(b.label));

  // ---- anomalies -------------------------------------------------------------------------------
  const findings: FleetAnomaly[] = [];
  const checks: FleetAnomalyCheck[] = [];
  const currentByTruck = groupBy(current, (e) => e.truckId);
  const allByTruck = groupBy(all, (e) => e.truckId);

  // Spend spike against the unit's own trailing average.
  {
    const span = daysInclusive(period.from, period.to);
    const windows: Array<{ from: IsoDate; to: IsoDate }> = [];
    for (let i = 1; i <= RULES.spikeLookbackPeriods; i += 1) {
      const to = addDays(period.from, -((i - 1) * span) - 1);
      windows.push({ from: addDays(to, -(span - 1)), to });
    }
    for (const truck of selectedTrucks) {
      const now = spendOf(currentByTruck.get(truck.id) ?? []);
      if (now < RULES.spikeMinSpend) continue;
      const history = allByTruck.get(truck.id) ?? [];
      const priorTotals = windows
        .map((w) => spendOf(history.filter((e) => inRange(e.date, w.from, w.to))))
        .filter((total) => total > 0);
      if (priorTotals.length < RULES.spikeMinPriorPeriods) continue;
      const average = roundMoney(sum(priorTotals) / priorTotals.length);
      if (now <= average * RULES.spikeMultiple) continue;
      const multiple = average > 0 ? now / average : Number.POSITIVE_INFINITY;
      findings.push({
        key: `spend_spike:${truck.id}`,
        rule: 'spend_spike',
        severity: multiple >= RULES.spikeMultiple * 2 ? 'critical' : 'warning',
        truckId: truck.id,
        unitNumber: truck.unitNumber,
        title: `Unit ${truck.unitNumber} spent ${multiple.toFixed(1)}× its trailing average`,
        detail: `${money(now)} this period against an average of ${money(average)} over ${priorTotals.length} prior ${span}-day ranges with spend`,
        current: false,
        recordIds: ids(currentByTruck.get(truck.id) ?? []),
      });
    }
    checks.push({
      rule: 'spend_spike',
      label: 'Spend above the unit’s trailing average',
      threshold: `More than ${RULES.spikeMultiple}× the average of up to ${RULES.spikeLookbackPeriods} prior equal-length ranges, needing at least ${RULES.spikeMinPriorPeriods} with spend and at least ${money(RULES.spikeMinSpend)} this period`,
      status: 'ran',
      reason: null,
    });
  }

  // The same repair type on the same unit twice inside the window.
  {
    const scheduled = new Set<string>(SCHEDULED_MAINTENANCE_TYPES);
    for (const truck of selectedTrucks) {
      const byType = groupBy(
        // Parking twice in a month is not a failed repair: only maintenance events repeat.
        (allByTruck.get(truck.id) ?? []).filter((e) => !scheduled.has(e.type) && e.kind !== 'fleet_expense'),
        (e) => e.type,
      );
      for (const [type, events] of byType) {
        const sorted = [...events].sort((a, b) => (a.date < b.date ? -1 : 1));
        const pairs: FleetSpendEvent[][] = [];
        for (let i = 1; i < sorted.length; i += 1) {
          const later = sorted[i] as FleetSpendEvent;
          const earlier = sorted[i - 1] as FleetSpendEvent;
          const gap = daysInclusive(earlier.date, later.date) - 1;
          if (gap <= RULES.repeatWindowDays && inRange(later.date, period.from, period.to)) {
            pairs.push([earlier, later]);
          }
        }
        if (pairs.length === 0) continue;
        const involved = [...new Set(pairs.flat().map((e) => e.id))];
        const closest = Math.min(
          ...pairs.map(
            ([a, b]) => daysInclusive((a as FleetSpendEvent).date, (b as FleetSpendEvent).date) - 1,
          ),
        );
        findings.push({
          key: `repeat_service:${truck.id}:${type}`,
          rule: 'repeat_service',
          severity: 'warning',
          truckId: truck.id,
          unitNumber: truck.unitNumber,
          title: `${MAINTENANCE_TYPE_LABEL[type]} repeated on unit ${truck.unitNumber}`,
          detail: `${involved.length} ${MAINTENANCE_TYPE_LABEL[type].toLowerCase()} events within ${RULES.repeatWindowDays} days (closest ${closest} days apart). The records do not say whether the same part was involved`,
          current: false,
          recordIds: involved,
        });
      }
    }
    checks.push({
      rule: 'repeat_service',
      label: 'Repeated repair type on one unit',
      threshold: `The same non-scheduled service type on the same unit within ${RULES.repeatWindowDays} days, with the later event in the period; scheduled upkeep (${SCHEDULED_MAINTENANCE_TYPES.map((t) => MAINTENANCE_TYPE_LABEL[t].toLowerCase()).join(', ')}) is not counted`,
      status: 'ran',
      reason: null,
    });
  }

  // Cost per mile against the fleet median, among units with valid mileage.
  {
    const perUnit = cpmNow.units
      .map((id) => {
        const miles = currentMileage.get(id)?.miles ?? null;
        const spend = spendOf(currentByTruck.get(id) ?? []);
        const cpm = safeDivide(spend, miles);
        return { id, miles: miles ?? 0, spend, cpm };
      })
      .filter(
        (row): row is { id: string; miles: number; spend: number; cpm: number } => row.cpm !== null,
      );
    if (perUnit.length >= RULES.cpmMinUnits) {
      const fleetMedian = median(perUnit.map((row) => row.cpm)) as number;
      for (const row of perUnit) {
        if (fleetMedian <= 0 || row.cpm <= fleetMedian * RULES.cpmMultiple) continue;
        const truck = trucks.get(row.id) as EngineTruck;
        findings.push({
          key: `cpm_above_median:${row.id}`,
          rule: 'cpm_above_median',
          severity: 'info',
          truckId: row.id,
          unitNumber: truck.unitNumber,
          title: `Unit ${truck.unitNumber} costs ${(row.cpm / fleetMedian).toFixed(1)}× the fleet median per mile`,
          detail: `$${row.cpm.toFixed(4)}/mi (${money(row.spend)} over ${Math.round(row.miles).toLocaleString('en-US')} miles) against a median of $${fleetMedian.toFixed(4)}/mi across ${perUnit.length} units with valid mileage`,
          current: false,
          recordIds: ids(currentByTruck.get(row.id) ?? []),
        });
      }
      checks.push({
        rule: 'cpm_above_median',
        label: 'Cost per mile above the fleet median',
        threshold: `More than ${RULES.cpmMultiple}× the median of the ${perUnit.length} units with valid odometer coverage`,
        status: 'ran',
        reason: null,
      });
    } else {
      checks.push({
        rule: 'cpm_above_median',
        label: 'Cost per mile above the fleet median',
        threshold: `More than ${RULES.cpmMultiple}× the fleet median, needing at least ${RULES.cpmMinUnits} units with valid odometer coverage`,
        status: 'unavailable',
        reason: `Only ${perUnit.length} units have odometer readings spanning the period`,
      });
    }
  }

  // Shop stay: there is no shop-entry timestamp to measure from.
  checks.push({
    rule: 'long_shop_stay',
    label: 'Unit in the shop too long',
    threshold: 'Days since the unit entered the shop, above a documented limit',
    status: 'unavailable',
    reason:
      'Work orders record when they were opened, not when the unit entered the shop, and the roster status carries no timestamp',
  });

  // PM overdue, now, from the same rule the Trucks page uses. Trucks only: a trailer has no
  // service interval on the roster.
  {
    for (const truck of poweredUnits) {
      if (truck.status === 'sold' || truck.status === 'archived') continue;
      const due = maintenanceDue(
        {
          nextDueOdometer: truck.nextServiceOdometer,
          nextDueAt: truck.nextServiceDate,
          currentOdometer: truck.odometer,
        },
        today,
      );
      if (due.urgency !== 'overdue') continue;
      const severe =
        (due.milesRemaining !== null && due.milesRemaining <= -5000) ||
        (due.daysRemaining !== null && due.daysRemaining <= -30);
      findings.push({
        key: `pm_overdue:${truck.id}`,
        rule: 'pm_overdue',
        severity: severe ? 'critical' : 'warning',
        truckId: truck.id,
        unitNumber: truck.unitNumber,
        title: `Unit ${truck.unitNumber} is overdue for service now`,
        detail: due.summary,
        current: true,
        recordIds: [truck.id],
      });
    }
    checks.push({
      rule: 'pm_overdue',
      label: 'Preventive maintenance overdue now',
      threshold:
        'Past the next-service odometer or date on the roster, as of today; critical beyond 5,000 miles or 30 days',
      status: 'ran',
      reason: null,
    });
  }

  // An event far above what the same service type usually costs.
  {
    const allByType = groupBy(all, (e) => e.type);
    for (const event of current) {
      if (event.kind === 'fleet_expense') continue;
      const peers = (allByType.get(event.type) ?? []).filter((e) => e.id !== event.id);
      if (peers.length < RULES.expensiveMinHistory) continue;
      const typical = median(peers.map((e) => e.amount)) as number;
      if (typical <= 0 || event.amount < RULES.expensiveMinAmount) continue;
      if (event.amount <= typical * RULES.expensiveMultiple) continue;
      const source =
        event.amountSource === 'invoice'
          ? 'invoice amount'
          : event.amountSource === 'work_order'
            ? 'work order total'
            : 'service record cost';
      findings.push({
        key: `expensive_service:${event.id}`,
        rule: 'expensive_service',
        severity: 'info',
        truckId: event.truckId,
        unitNumber: event.unitNumber,
        title: `${event.amountSource === 'invoice' ? 'Invoice' : 'Amount'} ${(event.amount / typical).toFixed(1)}× the usual ${MAINTENANCE_TYPE_LABEL[event.type].toLowerCase()} cost`,
        detail: `${event.reference} on unit ${event.unitNumber}: ${money(event.amount)} (${source}) against a median of ${money(typical)} over ${peers.length} other ${MAINTENANCE_TYPE_LABEL[event.type].toLowerCase()} events`,
        current: false,
        recordIds: [event.id],
      });
    }
    checks.push({
      rule: 'expensive_service',
      label: 'Unusually expensive service',
      threshold: `More than ${RULES.expensiveMultiple}× the median of at least ${RULES.expensiveMinHistory} other events of the same type, and at least ${money(RULES.expensiveMinAmount)}`,
      status: 'ran',
      reason: null,
    });
  }

  const severityRank = { critical: 0, warning: 1, info: 2 } as const;
  findings.sort(
    (a, b) =>
      severityRank[a.severity] - severityRank[b.severity] ||
      a.unitNumber.localeCompare(b.unitNumber),
  );
  const counts = {
    critical: findings.filter((f) => f.severity === 'critical').length,
    warning: findings.filter((f) => f.severity === 'warning').length,
    info: findings.filter((f) => f.severity === 'info').length,
  };
  const flagsByTruck = groupBy(findings, (f) => f.truckId);

  // ---- vehicles --------------------------------------------------------------------------------
  const previousByTruck = groupBy(previous, (e) => e.truckId);
  const vehicles: FleetVehicleRow[] = selectedTrucks
    .map((truck) => {
      const events = currentByTruck.get(truck.id) ?? [];
      const top = [...groupBy(events, (e) => e.type).entries()]
        .map(([type, rows]) => ({ type, count: rows.length, spend: spendOf(rows) }))
        .sort((a, b) => b.count - a.count || b.spend - a.spend)[0];
      const spend = spendOf(events);
      const before = previousByTruck.get(truck.id) ?? [];
      const previousSpend = before.length > 0 ? spendOf(before) : null;
      const miles = truck.kind === 'truck' ? (currentMileage.get(truck.id) ?? null) : null;
      const cpm = miles?.miles ? safeDivide(spend, miles.miles) : null;
      return {
        truckId: truck.id,
        driverName: truck.driverName ?? null,
        miles: miles?.miles ?? null,
        milesReason:
          truck.kind === 'trailer' ? 'trailers carry no odometer' : (miles?.reason ?? null),
        costPerMile: cpm === null ? null : roundRatio(cpm),
        kind: truck.kind,
        unitNumber: truck.unitNumber,
        description: `${truck.year} ${truck.make} ${truck.model}`.trim(),
        ownership: truck.ownership,
        status: truck.status,
        topType: top?.type ?? null,
        topTypeLabel: top ? MAINTENANCE_TYPE_LABEL[top.type] : null,
        topTypeEvents: top?.count ?? 0,
        events: events.length,
        spend,
        previousSpend,
        trendPct: deltaPct(spend, previousSpend),
        flags: flagsByTruck.get(truck.id)?.length ?? 0,
        recordIds: ids(events),
        /*
         * Work orders only. A standalone service record's `reference` is its description, not an
         * order number, and putting "steer tire LH" in a column headed Work order would be a lie
         * about what the row points at.
         */
        // Each order with its id, so the breakdown can list and link every RO (owner, 2026-10-06).
        // One line per RO in the breakdown: its own category and its own spend.
        workOrders: [...groupBy(
          events.filter((e) => e.kind === 'work_order' && e.reference.trim() !== ''),
          (e) => e.reference.trim(),
        ).entries()]
          .map(([number, rows]) => {
            const first = rows[0] as FleetSpendEvent;
            return {
              id: first.id,
              number,
              date: rows.map((r) => r.date).sort().at(-1) ?? first.date,
              typeLabel: MAINTENANCE_TYPE_LABEL[first.type],
              services: rows.length,
              spend: spendOf(rows),
            };
          })
          .sort((a, b) => b.date.localeCompare(a.date)),
        // What the unit spent outside any RO (standalone service records), shown on its own line.
        otherSpend: spendOf(events.filter((e) => e.kind !== 'work_order' || e.reference.trim() === '')),
        workOrderNumbers: [
          ...new Set(
            events
              .filter((e) => e.kind === 'work_order' && e.reference.trim() !== '')
              .sort((a, b) => b.date.localeCompare(a.date))
              .map((e) => e.reference.trim()),
          ),
        ],
      };
    })
    .sort(
      (a, b) => b.spend - a.spend || b.flags - a.flags || a.unitNumber.localeCompare(b.unitNumber),
    );

  return {
    meta: {
      asOf: input.asOf,
      period: {
        preset: period.preset,
        from: period.from,
        to: period.to,
        label: period.label,
        timezone: period.timezone,
        comparison: period.comparison,
      },
      source: {
        kind: 'workspace_snapshot',
        provenance: input.provenance,
        snapshotUpdatedAt: input.snapshotUpdatedAt,
        scope: `Records attributed through the company roster: ${input.trucks.length} units; records on any other unit are excluded`,
        basis:
          'Completed work orders at their canonical total, dated by completion; standalone service records at their cost, dated by service date; no estimates, allocations or accounting lines',
      },
      filters: {
        units: input.selectedUnits,
        unknownUnits: input.unknownUnits,
        unitType: input.unitType,
      },
      fleet: fleetMix,
    },
    coverage,
    kpis: { totalSpend, costPerMile, inShopNow, averagePerVehicle, inactiveNow, leaseOverage },
    vendors: {
      rows: vendors,
      groupedBy: vendors.some((v) => v.vendorId) ? 'vendor_id' : 'normalised_name',
      byNameOnly,
    },
    categories: { total: totalNow, slices, otherMembers },
    serviceTypes: { rows: serviceTypes, widespreadThreshold },
    vehicles: { rows: vehicles, flagged: vehicles.filter((v) => v.flags > 0).length },
    series: { months: monthlySeries(all, period.to, spendOf) },
    anomalies: { counts, findings, checks },
    events: current,
    split: spendSplit(current, input.workOrders, selection),
  };
}

/**
 * The period's spend two ways (owner, 2026-10-13) - maintenance against other expenses, and who
 * bears it - plus the repairs still open. Each split adds up to the period total.
 */
function spendSplit(events: FleetSpendEvent[], orders: SourceWorkOrder[], selection: Set<string>): FleetExpenseSummary['split'] {
  const out = { maintenance: 0, expenses: 0, company: 0, driver: 0, investigation: 0, warranty: 0, owner: 0 };
  for (const e of events) {
    if (e.kind === 'fleet_expense') out.expenses += e.amount;
    else out.maintenance += e.amount;
    const driver = Math.min(Math.max(e.driverShare, 0), e.amount);
    out.driver += driver;
    const rest = e.amount - driver;
    if (e.payer === 'investigation') out.investigation += rest;
    else if (e.payer === 'warranty') out.warranty += rest;
    else if (e.payer === 'owner') out.owner += rest;
    else out.company += rest;
  }
  let openAmount = 0;
  let openOrders = 0;
  for (const o of orders) {
    const unitId = o.unitType === 'trailer' ? (o.trailerId ?? '') : o.truckId;
    if (!selection.has(unitId)) continue;
    if (o.status === 'completed' || o.status === 'draft' || o.status === 'cancelled') continue;
    openOrders += 1;
    if (isFiniteNumber(o.total)) openAmount += o.total;
  }
  const r = (v: number) => roundMoney(v);
  return {
    maintenance: r(out.maintenance),
    expenses: r(out.expenses),
    company: r(out.company),
    driver: r(out.driver),
    investigation: r(out.investigation),
    warranty: r(out.warranty),
    owner: r(out.owner),
    openRepairs: { amount: r(openAmount), orders: openOrders },
  };
}

/**
 * Where a present-tense count opens. The trucks list can be handed the exact ids; the trailers
 * list cannot yet, so a trailer-only count opens the list unfiltered and a mixed count opens the
 * trucks it contains.
 */
function unitLink(units: EngineTruck[]): FleetMetric['link'] {
  if (units.length === 0) return null;
  const truckIds = units.filter((u) => u.kind === 'truck').map((u) => u.id);
  if (truckIds.length === 0) return { to: '/fleet/trailers' };
  const status = units[0]?.status ?? '';
  return { to: '/fleet/trucks', search: { status, ids: truckIds.join(',') } };
}

function summariseReasons(rows: MileageResult[]): string {
  const counts = new Map<string, number>();
  for (const row of rows) {
    const reason = row.reason ?? 'unknown';
    const key = reason.startsWith('readings cover') ? 'readings do not span the period' : reason;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return [...counts.entries()].map(([reason, n]) => `${n} ${reason}`).join(', ');
}
