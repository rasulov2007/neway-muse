/**
 * The revenue and cost mix behind the Analytics headline (owner decisions, 2026-10-25).
 *
 * Pure functions over facts, like every engine: Analytics reads these instead of adding numbers
 * up itself.
 */
import type { RecoveredFor, ReportingFacts } from '../facts';
import { hasExpenseData } from './financial-calculator';
import { roundMoney, roundRatio, sum } from './money';

export interface RevenueMix {
  /** Linehaul + accessorials + TONU. */
  gross: number;
  linehaul: number;
  accessorials: number;
  tonu: number;
  /** Delivered loads (TONU lines are not deliveries). */
  loads: number;
  tonuLoads: number;
  loadedMiles: number;
  emptyMiles: number;
  /** Loaded + empty: the one miles figure RPM, CPM and PPM divide by. Null with no revenue lines. */
  loadMiles: number | null;
  rpm: number | null;
  linehaulRpm: number | null;
}

export function computeRevenueMix(facts: Pick<ReportingFacts, 'revenue'>): RevenueMix {
  const lines = facts.revenue;
  const linehaul = sum(lines.map((l) => l.linehaul));
  const accessorials = sum(lines.map((l) => l.accessorials ?? 0));
  const tonu = sum(lines.map((l) => l.tonu ?? 0));
  const loaded = sum(lines.map((l) => l.loadedMiles));
  const empty = sum(lines.map((l) => l.emptyMiles));
  const miles = lines.length === 0 ? null : loaded + empty;
  const usable = miles !== null && miles > 0 ? miles : null;
  const gross = linehaul + accessorials + tonu;
  return {
    gross: roundMoney(gross),
    linehaul: roundMoney(linehaul),
    accessorials: roundMoney(accessorials),
    tonu: roundMoney(tonu),
    loads: lines.filter((l) => l.kind !== 'tonu').length,
    tonuLoads: lines.filter((l) => l.kind === 'tonu').length,
    loadedMiles: Math.round(loaded),
    emptyMiles: Math.round(empty),
    loadMiles: miles === null ? null : roundRatio(miles),
    rpm: usable === null ? null : roundRatio(gross / usable),
    linehaulRpm: usable === null ? null : roundRatio(linehaul / usable),
  };
}

export interface CostMix {
  /** Every cost line in full (recoveries excluded). Null when the period has no expense data. */
  costBeforeRecovery: number | null;
  /** What drivers paid back, as a positive number. Null when the period has no expense data. */
  recovered: number | null;
  /** costBeforeRecovery - recovered. */
  net: number | null;
  /** Recovered amounts by what they paid back. */
  recoveredByKind: Partial<Record<RecoveredFor, number>>;
  /**
   * Recoveries larger than the matching cost recorded in the period: the cost side is not
   * connected (Harbor Line recovers fuel but has no fuel feed). Only `applied` is in `recovered`; the
   * rest is named here, never netted away silently (owner, 2026-10-25).
   */
  unmatchedRecoveries: Array<{ kind: RecoveredFor; recovered: number; applied: number; cost: number }>;
  /** Total recovered but not taken off cost, for want of a matching cost. */
  recoveredUnapplied: number;
}

export function computeCostMix(facts: Pick<ReportingFacts, 'expenses' | 'expenseCoverage' | 'provenance'>): CostMix {
  const known = hasExpenseData(facts as ReportingFacts);
  const recoveries = facts.expenses.filter((l) => l.category === 'recovered');
  const costs = facts.expenses.filter((l) => l.category !== 'recovered');
  const before = sum(costs.map((l) => l.amount));
  const recovered = -sum(recoveries.map((l) => l.amount));
  const byKind: Partial<Record<RecoveredFor, number>> = {};
  for (const line of recoveries) {
    const kind = line.recoveredFor ?? 'damage';
    byKind[kind] = roundMoney((byKind[kind] ?? 0) - line.amount);
  }
  const unmatched = facts.provenance?.unappliedRecoveries ?? [];
  return {
    costBeforeRecovery: known ? roundMoney(before) : null,
    recovered: known ? roundMoney(recovered) : null,
    net: known ? roundMoney(before - recovered) : null,
    recoveredByKind: byKind,
    unmatchedRecoveries: unmatched,
    recoveredUnapplied: roundMoney(sum(unmatched.map((u) => u.recovered - u.applied))),
  };
}

export type ProfitBasisCode = 'ok' | 'no_revenue' | 'no_cost' | 'no_data';

export interface ProfitBasis {
  available: boolean;
  code: ProfitBasisCode;
  /** Why profit is not shown; null when it is. */
  reason: string | null;
}

/**
 * Profit, margin and PPM are shown only when the period has BOTH a revenue source and a cost
 * source (owner, 2026-10-25). Cost with no revenue is not a loss and revenue with no cost is not
 * a profit: the reason is shown instead.
 */
export function profitBasis(
  facts: Pick<ReportingFacts, 'revenue' | 'expenses' | 'expenseCoverage' | 'provenance'>,
): ProfitBasis {
  const hasRevenue = facts.revenue.length > 0;
  const hasCost = hasExpenseData(facts as ReportingFacts);
  if (hasRevenue && hasCost) return { available: true, code: 'ok', reason: null };
  const notConnected = facts.provenance && !facts.provenance.generated && facts.provenance.loadsOnFile === 0;
  if (!hasRevenue && hasCost) {
    return {
      available: false,
      code: 'no_revenue',
      reason: notConnected
        ? 'Profit is not shown: this company has no loads in NeWay Loads, so revenue is not connected. Costs are shown as recorded.'
        : 'Profit is not shown: no loads were delivered in NeWay Loads in this period. Costs are shown as recorded.',
    };
  }
  if (hasRevenue && !hasCost) {
    return {
      available: false,
      code: 'no_cost',
      reason: 'Profit is not shown: no cost is recorded for this period, so revenue alone would read as profit.',
    };
  }
  return {
    available: false,
    code: 'no_data',
    reason: notConnected
      ? 'Profit is not shown: this company has no loads in NeWay Loads and no cost recorded in this period.'
      : 'Profit is not shown: no delivered loads and no cost recorded in this period.',
  };
}
