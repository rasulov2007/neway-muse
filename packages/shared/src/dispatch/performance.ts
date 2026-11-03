import { z } from 'zod';

/**
 * The Dispatcher Performance board.
 *
 * Pure: loads in, ranked dispatchers out. No database, no clock, no network — so the four scores
 * can be argued with in a test rather than against a live week, which matters more here than
 * anywhere else in this product because these numbers decide who is top of the board.
 *
 * Every load picked up inside the period counts, and it belongs to the dispatcher whose board the
 * driver is on — not to whoever booked it. Cancelled and TONU loads earn no revenue and are
 * counted separately in CXL rather than dropped, because a dispatcher who books ten and loses
 * four has not had the same week as one who books six.
 *
 * The four scores are each a percentage of a target, so they can be averaged. A target that is
 * zero — no trucks on the board, no miles run — makes its score unmeasurable, and unmeasurable is
 * `null` here and a dash on the page. It is never 0%, which would read as "did badly" when what
 * happened is "had nothing to do it with".
 */

// ------------------------------------------------------------------------------------ the targets

export const PerformanceTargetsSchema = z.object({
  /** Dollars per loaded mile the fleet aims at. */
  rpm: z.number().positive(),
  /** Dollars per truck per week the fleet aims at. */
  grossPerTruckWeek: z.number().positive(),
  /** Miles per truck per week the fleet aims at. */
  milesPerTruckWeek: z.number().positive(),
  /** How the four roll into OVERALL. They are normalised, so they need not sum to 1 exactly. */
  weights: z.object({
    onTime: z.number().min(0),
    rpm: z.number().min(0),
    efficiency: z.number().min(0),
    activity: z.number().min(0),
  }),
});
export type PerformanceTargets = z.infer<typeof PerformanceTargetsSchema>;

/** The owner's numbers (2026-09-25). Changed in Settings; every response says which were used. */
export const DEFAULT_PERFORMANCE_TARGETS: PerformanceTargets = {
  rpm: 2.9,
  grossPerTruckWeek: 10_000,
  milesPerTruckWeek: 5_000,
  weights: { onTime: 0.25, rpm: 0.25, efficiency: 0.25, activity: 0.25 },
};

// -------------------------------------------------------------------------------- what goes in

/** A stop, as far as on-time cares: when it was due and when the truck actually arrived. */
export interface DispatcherPerformanceStop {
  kind: 'pickup' | 'delivery';
  appointmentStartAt: string;
  appointmentEndAt: string;
  arrivedAt: string | null;
}

/** A load, reduced to what the board counts. */
export interface DispatcherPerformanceLoad {
  id: string;
  status: string;
  driverId: string | null;
  /** The first pickup's appointment: the period a load belongs to. */
  pickupAt: string;
  rate: number;
  loadedMiles: number;
  /** Pounds. Null when nobody recorded one; it is left out of the average rather than counted as 0. */
  weightLbs: number | null;
  stops: DispatcherPerformanceStop[];
}

/** A driver on somebody's board, and whether they have a truck. */
export interface PerformanceRosterRow {
  driverId: string | null;
  /** The name the board shows. */
  name: string;
  /** `C`, `C-30`, `OO` — the pay tag beside the name on the board. */
  payTag: string | null;
  dispatcherId: string;
  dispatcherName: string;
  truckUnit: string | null;
  /** Taken off the board: counted in neither the driver nor the truck tally. */
  unassignedAt: string | null;
}

export interface PerformanceInput {
  /** The period, as ISO instants; `weeks` scales the weekly targets. */
  from: string;
  to: string;
  weeks: number;
  loads: DispatcherPerformanceLoad[];
  roster: PerformanceRosterRow[];
  targets: PerformanceTargets;
  /** The previous period's ranking, dispatcher id → rank, for the ▲▼ arrow. Optional. */
  previousRanks?: Record<string, number>;
}

// ------------------------------------------------------------------------------- what comes out

/**
 * One driver under a dispatcher.
 *
 * The same measures as the dispatcher, read against one truck rather than a board: a driver is
 * their own denominator, so efficiency and activity are against a single truck's weekly target.
 * `DRV / TRUCK` and `AVG / TRUCK` are a board's questions and are not asked of a driver.
 */
export interface PerformanceDriverRow {
  driverId: string;
  name: string;
  payTag: string | null;
  truckUnit: string | null;
  loads: number;
  cancelled: number;
  gross: number;
  miles: number;
  rpm: number | null;
  avgWeightLbs: number | null;
  onTimePickupPct: number | null;
  onTimeDeliveryPct: number | null;
  onTimePct: number | null;
  rpmPct: number | null;
  efficiencyPct: number | null;
  activityPct: number | null;
  overall: number | null;
}

export interface PerformanceRow {
  dispatcherId: string;
  dispatcherName: string;
  /** Nickname(s) when the team is linked to employees (2026-10-26); null = show dispatcherName. */
  dispatcherNickname?: string | null;
  dispatcherFullName?: string | null;
  rank: number;
  /** Ranks gained since the previous period. Positive is up. Null when there is nothing to compare. */
  movement: number | null;
  drivers: number;
  trucks: number;
  loads: number;
  cancelled: number;
  gross: number;
  /** Gross ÷ trucks. Null with no trucks: it is not zero, it is not a number yet. */
  grossPerTruck: number | null;
  miles: number;
  rpm: number | null;
  avgWeightLbs: number | null;
  onTimePickupPct: number | null;
  onTimeDeliveryPct: number | null;
  /** The 50/50 blend the spec asks for; null when neither side has a measured arrival. */
  onTimePct: number | null;
  rpmPct: number | null;
  efficiencyPct: number | null;
  activityPct: number | null;
  overall: number | null;
  /** How far behind the rank above, as a percentage of that score. Null for first place. */
  behindPct: number | null;
  /** The drivers on this board, best first. Opened from the row. */
  driverRows: PerformanceDriverRow[];
}

export interface DispatcherPerformanceSummary {
  dispatchers: number;
  loads: number;
  cancelled: number;
  gross: number;
  miles: number;
  rpm: number | null;
  onTimePct: number | null;
  avgOverall: number | null;
  efficiencyPct: number | null;
}

export interface PerformanceBoard {
  from: string;
  to: string;
  weeks: number;
  targets: PerformanceTargets;
  rows: PerformanceRow[];
  summary: DispatcherPerformanceSummary;
}

/** Cancelled and TONU: no revenue, counted in CXL. */
const CANCELLED_STATUSES = new Set(['cancelled', 'tonu']);

/** Green at or above target, amber from 80%, red below. The page paints from this and nothing else. */
export type ScoreBand = 'good' | 'warn' | 'bad' | 'none';

export function scoreBand(pct: number | null): ScoreBand {
  if (pct === null) return 'none';
  if (pct >= 100) return 'good';
  if (pct >= 80) return 'warn';
  return 'bad';
}

function round(value: number, places = 1): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}

/**
 * On time means arrived before the appointment window closed.
 *
 * A stop with no recorded arrival is not late — it is unmeasured, and it is left out of both the
 * numerator and the denominator. Counting it as late would punish a dispatcher for a truck whose
 * GPS did not report, and counting it as on time would flatter everybody to 100%.
 */
function onTimeOf(stops: DispatcherPerformanceStop[], kind: 'pickup' | 'delivery'): { hit: number; measured: number } {
  let hit = 0;
  let measured = 0;
  for (const stop of stops) {
    if (stop.kind !== kind || !stop.arrivedAt) continue;
    const due = Date.parse(stop.appointmentEndAt || stop.appointmentStartAt);
    const at = Date.parse(stop.arrivedAt);
    if (Number.isNaN(due) || Number.isNaN(at)) continue;
    measured += 1;
    if (at <= due) hit += 1;
  }
  return { hit, measured };
}

function pct(part: number, whole: number): number | null {
  return whole > 0 ? round((part / whole) * 100) : null;
}

/** The instant a load is counted in: its first pickup appointment. */
export function inPeriod(load: DispatcherPerformanceLoad, from: string, to: string): boolean {
  const at = Date.parse(load.pickupAt);
  if (Number.isNaN(at)) return false;
  return at >= Date.parse(from) && at <= Date.parse(to);
}

/** The tally a load lands in, for a board or for one driver. */
interface Counts {
  loads: number;
  cancelled: number;
  gross: number;
  miles: number;
  weightTotal: number;
  weightCount: number;
  pickHit: number;
  pickMeasured: number;
  delHit: number;
  delMeasured: number;
}

function emptyCounts(): Counts {
  return {
    loads: 0,
    cancelled: 0,
    gross: 0,
    miles: 0,
    weightTotal: 0,
    weightCount: 0,
    pickHit: 0,
    pickMeasured: 0,
    delHit: 0,
    delMeasured: 0,
  };
}

function add(counts: Counts, load: DispatcherPerformanceLoad): void {
  if (CANCELLED_STATUSES.has(load.status)) {
    counts.cancelled += 1;
    return;
  }
  counts.loads += 1;
  counts.gross += load.rate;
  counts.miles += load.loadedMiles;
  if (load.weightLbs !== null && load.weightLbs > 0) {
    counts.weightTotal += load.weightLbs;
    counts.weightCount += 1;
  }
  const pick = onTimeOf(load.stops, 'pickup');
  const del = onTimeOf(load.stops, 'delivery');
  counts.pickHit += pick.hit;
  counts.pickMeasured += pick.measured;
  counts.delHit += del.hit;
  counts.delMeasured += del.measured;
}

/**
 * The measures every row shares, against however many trucks the row answers for.
 *
 * One function for a board and for a driver, so a dispatcher's efficiency and their driver's are
 * the same arithmetic against a different denominator and can never drift apart.
 */
function score(counts: Counts, trucks: number, targets: PerformanceTargets, weeks: number) {
  const rpm = counts.miles > 0 ? round(counts.gross / counts.miles, 2) : null;
  const onTimePickupPct = pct(counts.pickHit, counts.pickMeasured);
  const onTimeDeliveryPct = pct(counts.delHit, counts.delMeasured);
  const onTimePct =
    onTimePickupPct !== null && onTimeDeliveryPct !== null
      ? round((onTimePickupPct + onTimeDeliveryPct) / 2)
      : (onTimePickupPct ?? onTimeDeliveryPct);

  const grossTarget = trucks * targets.grossPerTruckWeek * weeks;
  const milesTarget = trucks * targets.milesPerTruckWeek * weeks;
  const rpmPct = rpm === null ? null : round((rpm / targets.rpm) * 100);
  const efficiencyPct = grossTarget > 0 ? round((counts.gross / grossTarget) * 100) : null;
  const activityPct = milesTarget > 0 ? round((counts.miles / milesTarget) * 100) : null;

  const parts: [number | null, number][] = [
    [onTimePct, targets.weights.onTime],
    [rpmPct, targets.weights.rpm],
    [efficiencyPct, targets.weights.efficiency],
    [activityPct, targets.weights.activity],
  ];
  const measured = parts.filter(([value, weight]) => value !== null && weight > 0);
  const weightSum = measured.reduce((sum, [, weight]) => sum + weight, 0);
  const overall =
    weightSum > 0
      ? round(measured.reduce((sum, [value, weight]) => sum + value! * weight, 0) / weightSum)
      : null;

  return {
    gross: round(counts.gross, 2),
    miles: Math.round(counts.miles),
    rpm,
    avgWeightLbs: counts.weightCount > 0 ? Math.round(counts.weightTotal / counts.weightCount) : null,
    onTimePickupPct,
    onTimeDeliveryPct,
    onTimePct,
    rpmPct,
    efficiencyPct,
    activityPct,
    overall,
  };
}

export function buildPerformance(input: PerformanceInput): PerformanceBoard {
  const { targets, weeks } = input;
  const active = input.roster.filter((r) => !r.unassignedAt);

  /** Which dispatcher a driver's loads belong to. */
  const dispatcherOf = new Map<string, PerformanceRosterRow>();
  for (const row of active) if (row.driverId) dispatcherOf.set(row.driverId, row);

  interface Tally {
    row: PerformanceRosterRow;
    trucks: Set<string>;
    counts: Counts;
    /** Per driver, so a board can be opened and read one line at a time. */
    drivers: Map<string, { roster: PerformanceRosterRow; counts: Counts }>;
  }
  const tallies = new Map<string, Tally>();
  const tally = (row: PerformanceRosterRow): Tally => {
    const found = tallies.get(row.dispatcherId);
    if (found) return found;
    const fresh: Tally = { row, trucks: new Set(), counts: emptyCounts(), drivers: new Map() };
    tallies.set(row.dispatcherId, fresh);
    return fresh;
  };

  // Every dispatcher with a board appears, even one whose week was empty: an absent row reads as
  // "not a dispatcher", and a dispatcher who booked nothing is exactly who the board is for. The
  // same goes for a driver who ran nothing — they are on the board and their line says so.
  for (const row of active) {
    const t = tally(row);
    if (row.truckUnit) t.trucks.add(row.truckUnit);
    if (row.driverId) t.drivers.set(row.driverId, { roster: row, counts: emptyCounts() });
  }

  for (const load of input.loads) {
    if (!load.driverId) continue;
    if (!inPeriod(load, input.from, input.to)) continue;
    const row = dispatcherOf.get(load.driverId);
    if (!row) continue;
    const t = tally(row);
    add(t.counts, load);
    const driver = t.drivers.get(load.driverId);
    if (driver) add(driver.counts, load);
  }

  const scored = [...tallies.values()].map((t) => {
    const trucks = t.trucks.size;
    const board = score(t.counts, trucks, targets, weeks);

    /*
     * A driver is measured against one truck, because that is what they have. Ranked by OVERALL
     * like their dispatcher, so opening a board answers the next question: who on it is carrying
     * it, and who is not.
     */
    const drivers: PerformanceDriverRow[] = [...t.drivers.values()]
      .map(({ roster, counts }) => ({
        driverId: roster.driverId!,
        name: roster.name,
        payTag: roster.payTag,
        truckUnit: roster.truckUnit,
        loads: counts.loads,
        cancelled: counts.cancelled,
        ...score(counts, roster.truckUnit ? 1 : 0, targets, weeks),
      }))
      .sort((a, b) => {
        if (a.overall === null && b.overall === null) return b.gross - a.gross;
        if (a.overall === null) return 1;
        if (b.overall === null) return -1;
        return b.overall - a.overall || b.gross - a.gross;
      });

    return {
      dispatcherId: t.row.dispatcherId,
      dispatcherName: t.row.dispatcherName,
      rank: 0,
      movement: null as number | null,
      drivers: t.drivers.size,
      trucks,
      loads: t.counts.loads,
      cancelled: t.counts.cancelled,
      grossPerTruck: trucks > 0 ? round(t.counts.gross / trucks, 2) : null,
      ...board,
      behindPct: null as number | null,
      driverRows: drivers,
    };
  });

  /*
   * Ranked by OVERALL, and a dispatcher with no score at all sits below everyone who has one —
   * by gross, so an empty board is not ordered at random. Ties keep the higher gross first.
   */
  scored.sort((a, b) => {
    if (a.overall === null && b.overall === null) return b.gross - a.gross;
    if (a.overall === null) return 1;
    if (b.overall === null) return -1;
    return b.overall - a.overall || b.gross - a.gross;
  });

  const rows = scored.map((row, index) => {
    const above = index > 0 ? scored[index - 1]! : null;
    const previous = input.previousRanks?.[row.dispatcherId];
    return {
      ...row,
      rank: index + 1,
      movement: previous === undefined ? null : previous - (index + 1),
      behindPct:
        above && above.overall !== null && row.overall !== null && above.overall > 0
          ? round(((above.overall - row.overall) / above.overall) * 100)
          : null,
    };
  });

  const totals = rows.reduce(
    (sum, r) => ({
      loads: sum.loads + r.loads,
      cancelled: sum.cancelled + r.cancelled,
      gross: sum.gross + r.gross,
      miles: sum.miles + r.miles,
      trucks: sum.trucks + r.trucks,
    }),
    { loads: 0, cancelled: 0, gross: 0, miles: 0, trucks: 0 },
  );
  const measuredOverall = rows.filter((r) => r.overall !== null);
  const measuredOnTime = rows.filter((r) => r.onTimePct !== null);
  const fleetGrossTarget = totals.trucks * targets.grossPerTruckWeek * weeks;

  return {
    from: input.from,
    to: input.to,
    weeks,
    targets,
    rows,
    summary: {
      dispatchers: rows.length,
      loads: totals.loads,
      cancelled: totals.cancelled,
      gross: round(totals.gross, 2),
      miles: totals.miles,
      rpm: totals.miles > 0 ? round(totals.gross / totals.miles, 2) : null,
      onTimePct:
        measuredOnTime.length > 0
          ? round(measuredOnTime.reduce((s, r) => s + r.onTimePct!, 0) / measuredOnTime.length)
          : null,
      avgOverall:
        measuredOverall.length > 0
          ? round(measuredOverall.reduce((s, r) => s + r.overall!, 0) / measuredOverall.length)
          : null,
      efficiencyPct: fleetGrossTarget > 0 ? round((totals.gross / fleetGrossTarget) * 100) : null,
    },
  };
}
