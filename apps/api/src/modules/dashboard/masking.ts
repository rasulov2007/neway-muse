import {
  maskedMetric,
  type DashboardDataHealth,
  type DashboardDispatch,
  type DashboardDrilldown,
  type DashboardFuel,
  type DashboardOpsNet,
  type DashboardOverview,
  type DashboardTrends,
  type DashboardTruckPnl,
  type MoneyMetric,
  type OpsNetCosts,
  type OpsNetTotals,
} from '@neway/shared';
import { DASHBOARD_PERMISSIONS, hasPermission, type Principal } from '../../common/auth/principal';

/** Every dashboard response body keyed by section. */
export interface DashboardBodies {
  overview: DashboardOverview;
  trends: DashboardTrends;
  opsNet: DashboardOpsNet;
  truckPnl: DashboardTruckPnl;
  fuel: DashboardFuel;
  dispatch: DashboardDispatch;
  dataHealth: DashboardDataHealth;
  drilldown: DashboardDrilldown;
}

export type DashboardSection = keyof DashboardBodies;

/** True when the principal may see money (docs/DASHBOARD.md §10). */
export function canViewFinancial(principal: Principal): boolean {
  return hasPermission(principal, DASHBOARD_PERMISSIONS.viewFinancial);
}

/** Money-looking fragments in free text (`$1,234.56`), replaced when masking. */
const MONEY_IN_TEXT = /\$\s?-?[\d,]+(?:\.\d+)?/g;

function scrubText(text: string): string {
  return text.replace(MONEY_IN_TEXT, '••••••');
}

const masked = (): MoneyMetric => maskedMetric();

function maskOverview(body: DashboardOverview): DashboardOverview {
  return {
    ...body,
    financial: {
      gross: masked(),
      cost: masked(),
      operatingProfit: masked(),
      inactiveTruckLoss: masked(),
      netOperatingProfit: masked(),
    },
    unitEconomics: {
      rpm: masked(),
      cpm: masked(),
      ppm: masked(),
      marginPct: masked(),
      totalMiles: body.unitEconomics.totalMiles,
    },
    fleet: {
      ...body.fleet,
      avgGrossPerTruck: masked(),
      avgCostPerTruck: masked(),
      avgProfitPerTruck: masked(),
    },
    costBreakdown: body.costBreakdown.map((item) => ({
      category: item.category,
      amount: null,
      estimatedAmount: null,
      share: null,
    })),
    reconciliation: {
      status: body.reconciliation.status,
      dashboardGross: null,
      ledgerGross: null,
      difference: null,
    },
  };
}

function maskTrends(body: DashboardTrends): DashboardTrends {
  return {
    ...body,
    weeks: body.weeks.map((week) => ({
      ...week,
      gross: null,
      cost: null,
      profit: null,
      rpm: null,
      cpm: null,
      ppm: null,
      marginPct: null,
      avgGrossPerTruck: null,
      avgCostPerTruck: null,
      avgProfitPerTruck: null,
      // Miles, truck counts and the pay-type split are operational, not financial: they stay.
    })),
    summary:
      body.summary === null
        ? null
        : {
            ...body.summary,
            gross: masked(),
            cost: masked(),
            profit: masked(),
            rpm: masked(),
            cpm: masked(),
            ppm: masked(),
            marginPct: masked(),
            // `totalMiles` and `activeTrucks` stay, as they do on the per-week rows above.
          },
    masked: true,
  };
}

/** Nulls every money field of an ops-net row; `totalMiles`, `activeTrucks` and
 * `avgMilesPerTruck` are operational and survive masking. */
function maskOpsNetRow<T extends OpsNetTotals>(row: T): T {
  const costs = {} as OpsNetCosts;
  for (const category of Object.keys(row.costs) as (keyof OpsNetCosts)[]) costs[category] = null;
  return {
    ...row,
    gross: null,
    costs,
    fuel: null,
    insurance: null,
    factoring: null,
    driverPay: null,
    driverPayEstimated: null,
    other: null,
    totalCost: null,
    operatingProfit: null,
    marginPct: null,
    rpm: null,
    avgGrossPerTruck: null,
  };
}

function maskOpsNet(body: DashboardOpsNet): DashboardOpsNet {
  return {
    ...body,
    buckets: body.buckets.map(maskOpsNetRow),
    totals: maskOpsNetRow(body.totals),
    inactiveTruckLoss: null,
    netOperatingProfit: null,
    unknown: { ...body.unknown, gross: null },
    masked: true,
  };
}

function maskTruckPnl(body: DashboardTruckPnl): DashboardTruckPnl {
  return {
    ...body,
    rows: body.rows.map((row) => ({
      ...row,
      gross: null,
      cost: null,
      costEstimated: null,
      profit: null,
    })),
    totals: {
      ...body.totals,
      gross: null,
      cost: null,
      costEstimated: null,
      profit: null,
      inactiveLoss: null,
    },
    masked: true,
  };
}

function maskFuel(body: DashboardFuel): DashboardFuel {
  return {
    ...body,
    totals: {
      ...body.totals,
      discountedCost: null,
      grossCost: null,
      avgPricePerGallon: null,
      fuelCostPerMile: null,
    },
    byTruck: body.byTruck.map((group) => ({ ...group, cost: null, share: null })),
    byDriver: body.byDriver.map((group) => ({ ...group, cost: null, share: null })),
    byState: body.byState.map((row) => ({ ...row, cost: null, avgPricePerGallon: null })),
    masked: true,
  };
}

function maskDispatch(body: DashboardDispatch): DashboardDispatch {
  return {
    ...body,
    teams: body.teams.map((team) => ({
      ...team,
      gross: null,
      rpm: null,
      grossPerTruck: null,
      estimatedFullWeekGross: { value: null, estimated: team.estimatedFullWeekGross.estimated },
      byWeek: team.byWeek.map((week) => ({ ...week, gross: null })),
      total: null,
    })),
    masked: true,
  };
}

function maskDataHealth(body: DashboardDataHealth): DashboardDataHealth {
  return {
    ...body,
    checks: body.checks.map((check) => ({
      ...check,
      detail: scrubText(check.detail),
      ...(check.amount !== undefined ? { amount: null } : {}),
    })),
  };
}

function maskDrilldown(body: DashboardDrilldown): DashboardDrilldown {
  const moneyKeys = body.columns.filter((c) => c.kind === 'money').map((c) => c.key);
  return {
    ...body,
    total: null,
    rows: body.rows.map((row) => {
      const copy = { ...row };
      for (const key of moneyKeys) copy[key] = null;
      return copy;
    }),
  };
}

type Maskers = { [K in DashboardSection]: (body: DashboardBodies[K]) => DashboardBodies[K] };

const MASKERS: Maskers = {
  overview: maskOverview,
  trends: maskTrends,
  opsNet: maskOpsNet,
  truckPnl: maskTruckPnl,
  fuel: maskFuel,
  dispatch: maskDispatch,
  dataHealth: maskDataHealth,
  drilldown: maskDrilldown,
};

/**
 * Applies financial visibility: principals without `dashboard.view_financial` receive money
 * metrics as `maskedMetric()` and every money field as `null`; operational counts stay.
 */
export function applyVisibility<K extends DashboardSection>(
  section: K,
  body: DashboardBodies[K],
  principal: Principal,
): DashboardBodies[K] {
  if (canViewFinancial(principal)) return body;
  const mask = MASKERS[section] as (input: DashboardBodies[K]) => DashboardBodies[K];
  return mask(body);
}
