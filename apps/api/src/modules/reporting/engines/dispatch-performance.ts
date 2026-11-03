/**
 * Dispatch performance engine (docs/DASHBOARD.md §8) — the single implementation of dispatcher
 * KPIs, shared by the dashboard and the dispatch module's own reports.
 *
 * Methodology
 * - Input is one `DispatchTeamWeek` per team per reporting week plus the list of weeks to report
 *   (`weekStart`, `isComplete`, `elapsedDays`). Weeks are reported in the order given; team-weeks
 *   for weeks not in the list are ignored, and a team with no record for a listed week gets a
 *   zero row so every team has one column per week.
 * - Per team-week: gross, loads, activeTrucks (trucks with ≥1 delivered load),
 *   activeDaysPct = activeTruckDays ÷ truckDays × 100, rpm = gross ÷ miles,
 *   grossPerTruck = gross ÷ activeTrucks. Ratios are null (never NaN) when the denominator is 0.
 * - RPM buckets count `truckRpms`: `lt150` < 1.50, `b150to200` [1.50, 2.00), `b200to250`
 *   [2.00, 2.50), `gte250` ≥ 2.50.
 * - Estimated full-week gross: for an incomplete week `gross ÷ elapsedDays × 7` with
 *   `estimated: true`; a complete week returns its actual gross with `estimated: false`.
 * - Team totals sum actual figures over the listed weeks and never include estimates; each
 *   week row also carries `cumulativeGross` (running total of actual gross through that week).
 * - Teams are ranked by total gross descending (ties: team name). `rpmBucketsTotal` is the bucket
 *   distribution across all teams for the latest listed week.
 * Money is rounded to cents, RPM to three decimals, percentages to two decimals.
 */
import type { DispatchTeamWeek } from '../facts';

export interface DispatchWeekInfo {
  weekStart: string;
  isComplete: boolean;
  /** Days of the week up to and including today (1–7); ignored for complete weeks. */
  elapsedDays: number;
}

export type RpmBucketKey = 'lt150' | 'b150to200' | 'b200to250' | 'gte250';

export type RpmBuckets = Record<RpmBucketKey, number>;

export interface EstimatedGross {
  value: number;
  estimated: boolean;
}

export interface DispatchTeamWeekMetrics {
  teamId: string;
  teamName: string;
  weekStart: string;
  isComplete: boolean;
  gross: number;
  loads: number;
  activeTrucks: number;
  miles: number;
  /** activeTruckDays ÷ truckDays × 100; null when truckDays is 0. */
  activeDaysPct: number | null;
  /** gross ÷ miles; null when miles is 0. */
  rpm: number | null;
  /** gross ÷ activeTrucks; null when no truck was active. */
  grossPerTruck: number | null;
  rpmBuckets: RpmBuckets;
  estimatedFullWeekGross: EstimatedGross;
  /** Running total of actual gross through this week (estimates excluded). */
  cumulativeGross: number;
}

export interface DispatchTeamTotals {
  gross: number;
  loads: number;
  miles: number;
  rpm: number | null;
  activeDaysPct: number | null;
  /** Average active trucks per listed week. */
  avgActiveTrucks: number;
}

export interface DispatchTeamSummary {
  teamId: string;
  teamName: string;
  /** 1-based position by total gross. */
  rank: number;
  byWeek: DispatchTeamWeekMetrics[];
  totals: DispatchTeamTotals;
}

export interface DispatchResult {
  weeks: DispatchWeekInfo[];
  /** Ordered by rank. */
  teams: DispatchTeamSummary[];
  latestWeekStart: string | null;
  /** RPM bucket distribution across all teams for the latest listed week. */
  rpmBucketsTotal: RpmBuckets;
}

/** Bucket an RPM value: `< 1.50`, `[1.50, 2.00)`, `[2.00, 2.50)`, `≥ 2.50`. */
export function rpmBucketFor(rpm: number): RpmBucketKey {
  if (rpm < 1.5) return 'lt150';
  if (rpm < 2) return 'b150to200';
  if (rpm < 2.5) return 'b200to250';
  return 'gte250';
}

/** Counts RPM values per bucket; non-finite values are skipped. */
export function countRpmBuckets(rpms: readonly number[]): RpmBuckets {
  const buckets = emptyBuckets();
  for (const rpm of rpms) {
    if (Number.isFinite(rpm)) buckets[rpmBucketFor(rpm)] += 1;
  }
  return buckets;
}

function emptyBuckets(): RpmBuckets {
  return { lt150: 0, b150to200: 0, b200to250: 0, gte250: 0 };
}

function addBuckets(target: RpmBuckets, source: RpmBuckets): void {
  target.lt150 += source.lt150;
  target.b150to200 += source.b150to200;
  target.b200to250 += source.b200to250;
  target.gte250 += source.gte250;
}

function round(value: number, factor: number): number {
  if (!Number.isFinite(value)) return 0;
  const rounded = Math.round(value * factor) / factor;
  return rounded === 0 ? 0 : rounded;
}

function ratio(numerator: number, denominator: number, factor: number): number | null {
  if (!Number.isFinite(denominator) || denominator === 0 || !Number.isFinite(numerator)) {
    return null;
  }
  return round(numerator / denominator, factor);
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

/** Full-week gross: projected for incomplete weeks, actual otherwise. */
export function estimateFullWeekGross(gross: number, week: DispatchWeekInfo): EstimatedGross {
  if (week.isComplete) return { value: round(gross, 100), estimated: false };
  const elapsed = Math.min(7, Math.max(1, Math.floor(finite(week.elapsedDays))));
  return { value: round((gross / elapsed) * 7, 100), estimated: true };
}

function zeroWeek(teamId: string, teamName: string, weekStart: string): DispatchTeamWeek {
  return {
    teamId,
    teamName,
    weekStart,
    gross: 0,
    loads: 0,
    activeTrucks: 0,
    truckDays: 0,
    activeTruckDays: 0,
    miles: 0,
    truckRpms: [],
  };
}

function weekMetrics(
  raw: DispatchTeamWeek,
  week: DispatchWeekInfo,
  cumulativeGross: number,
): DispatchTeamWeekMetrics {
  const gross = finite(raw.gross);
  const miles = finite(raw.miles);
  return {
    teamId: raw.teamId,
    teamName: raw.teamName,
    weekStart: week.weekStart,
    isComplete: week.isComplete,
    gross: round(gross, 100),
    loads: finite(raw.loads),
    activeTrucks: finite(raw.activeTrucks),
    miles: round(miles, 100),
    activeDaysPct: ratio(finite(raw.activeTruckDays) * 100, finite(raw.truckDays), 100),
    rpm: ratio(gross, miles, 1000),
    grossPerTruck: ratio(gross, finite(raw.activeTrucks), 100),
    rpmBuckets: countRpmBuckets(raw.truckRpms),
    estimatedFullWeekGross: estimateFullWeekGross(gross, week),
    cumulativeGross: round(cumulativeGross, 100),
  };
}

/** Sums two records for the same team and week (defensive; sources should emit one). */
function mergeTeamWeeks(a: DispatchTeamWeek, b: DispatchTeamWeek): DispatchTeamWeek {
  return {
    ...a,
    gross: finite(a.gross) + finite(b.gross),
    loads: finite(a.loads) + finite(b.loads),
    activeTrucks: finite(a.activeTrucks) + finite(b.activeTrucks),
    truckDays: finite(a.truckDays) + finite(b.truckDays),
    activeTruckDays: finite(a.activeTruckDays) + finite(b.activeTruckDays),
    miles: finite(a.miles) + finite(b.miles),
    truckRpms: [...a.truckRpms, ...b.truckRpms],
  };
}

/** Computes §8 dispatcher KPIs for the given teams and weeks. Pure; safe on empty input. */
export function computeDispatchPerformance(
  teamWeeks: readonly DispatchTeamWeek[],
  weeks: readonly DispatchWeekInfo[],
): DispatchResult {
  const weekList = weeks.map((w) => ({ ...w }));
  const listed = new Set(weekList.map((w) => w.weekStart));
  const latestWeekStart = weekList.length > 0 ? (weekList.at(-1)?.weekStart ?? null) : null;

  const teams = new Map<string, { name: string; weeks: Map<string, DispatchTeamWeek> }>();
  for (const tw of teamWeeks) {
    if (!listed.has(tw.weekStart)) continue;
    const team = teams.get(tw.teamId) ?? { name: tw.teamName, weeks: new Map() };
    const existing = team.weeks.get(tw.weekStart);
    team.weeks.set(tw.weekStart, existing ? mergeTeamWeeks(existing, tw) : tw);
    teams.set(tw.teamId, team);
  }

  const rpmBucketsTotal = emptyBuckets();
  const summaries: DispatchTeamSummary[] = [];
  for (const [teamId, team] of teams) {
    let cumulative = 0;
    const totals = { gross: 0, loads: 0, miles: 0, truckDays: 0, activeTruckDays: 0, active: 0 };
    const byWeek = weekList.map((week) => {
      const raw = team.weeks.get(week.weekStart) ?? zeroWeek(teamId, team.name, week.weekStart);
      cumulative += finite(raw.gross);
      totals.gross += finite(raw.gross);
      totals.loads += finite(raw.loads);
      totals.miles += finite(raw.miles);
      totals.truckDays += finite(raw.truckDays);
      totals.activeTruckDays += finite(raw.activeTruckDays);
      totals.active += finite(raw.activeTrucks);
      const metrics = weekMetrics(raw, week, cumulative);
      if (week.weekStart === latestWeekStart) addBuckets(rpmBucketsTotal, metrics.rpmBuckets);
      return metrics;
    });
    summaries.push({
      teamId,
      teamName: team.name,
      rank: 0,
      byWeek,
      totals: {
        gross: round(totals.gross, 100),
        loads: totals.loads,
        miles: round(totals.miles, 100),
        rpm: ratio(totals.gross, totals.miles, 1000),
        activeDaysPct: ratio(totals.activeTruckDays * 100, totals.truckDays, 100),
        avgActiveTrucks: weekList.length === 0 ? 0 : round(totals.active / weekList.length, 100),
      },
    });
  }

  summaries.sort((a, b) => b.totals.gross - a.totals.gross || a.teamName.localeCompare(b.teamName));
  summaries.forEach((s, i) => {
    s.rank = i + 1;
  });

  return { weeks: weekList, teams: summaries, latestWeekStart, rpmBucketsTotal };
}
