/**
 * Schema-valid fixtures for the dashboard endpoints. Every builder returns data that passes the
 * shared zod contracts so tests exercise the same parsing path as production.
 */
import {
  DashboardDataHealthSchema,
  DashboardDispatchSchema,
  DashboardDrilldownSchema,
  DashboardFuelSchema,
  DashboardOpsNetSchema,
  DashboardOverviewSchema,
  DashboardTrendsSchema,
  DashboardTruckPnlSchema,
  maskedMetric,
  nullMetric,
  type DashboardDataHealth,
  type DashboardDispatch,
  type DashboardDrilldown,
  type DashboardFuel,
  type DashboardMeta,
  type DashboardOpsNet,
  type DashboardOverview,
  type DashboardTrends,
  type DashboardTruckPnl,
  type MoneyMetric,
  type ResolvedPeriod,
  type TrendWeek,
  type TruckPnlRow,
} from '@neway/shared';

export const GENERATED_AT = '2026-09-06T12:00:00.000Z';

export const period: ResolvedPeriod = {
  preset: 'this_week',
  from: '2026-08-31',
  to: '2026-09-06',
  label: 'Aug 31 – Sep 6, 2026',
  isComplete: false,
  timezone: 'America/Chicago',
  comparison: { from: '2026-08-24', to: '2026-08-30', label: 'Aug 24 – Aug 30' },
  weekStart: 1,
};

export const meta: DashboardMeta = { source: 'demo', generatedAt: GENERATED_AT, period };

export function metric(value: number, previous: number, extra: Partial<MoneyMetric> = {}) {
  const delta = value - previous;
  const deltaPct = previous === 0 ? null : (delta / Math.abs(previous)) * 100;
  return { value, previous, delta, deltaPct, reasons: [], masked: false, ...extra } as MoneyMetric;
}

export { maskedMetric, nullMetric };

export function overviewFixture(overrides: Partial<DashboardOverview> = {}): DashboardOverview {
  return DashboardOverviewSchema.parse({
    meta,
    financial: {
      gross: metric(125000.5, 110000),
      cost: metric(90000, 85000, { estimated: { amount: 5000 } }),
      operatingProfit: metric(35000.5, 25000),
      inactiveTruckLoss: metric(1200, 0),
      netOperatingProfit: metric(33800.5, 25000),
    },
    unitEconomics: {
      rpm: metric(2.31, 2.2),
      cpm: metric(1.66, 1.7),
      ppm: metric(0.65, 0.5),
      marginPct: metric(28, 22.7),
      totalMiles: metric(54000, 50000),
    },
    fleet: {
      activeTrucks: metric(24, 23),
      inactiveTrucks: metric(2, 3),
      avgGrossPerTruck: metric(5208.35, 4782.61),
      avgCostPerTruck: metric(3750, 3695.65),
      avgProfitPerTruck: metric(1458.35, 1086.96),
      avgMilesPerTruck: metric(2250, 2173.91),
      averagesBasis: 'active_trucks',
    },
    costBreakdown: [
      { category: 'fuel', amount: 40000, estimatedAmount: 0, share: 44.4 },
      { category: 'driver_pay', amount: 30000, estimatedAmount: 5000, share: 33.3 },
      { category: 'insurance', amount: 12000, estimatedAmount: 0, share: 13.3 },
      { category: 'other', amount: 8000, estimatedAmount: 0, share: 8.9 },
    ],
    reconciliation: {
      status: 'ok',
      dashboardGross: 125000.5,
      ledgerGross: 125000.5,
      difference: 0,
    },
    expenseCoverage: { hasData: true },
    costMix: { posted: 0, estimated: 0, unallocatedPosted: 0, hasEstimates: false, dateBasis: 'Gross is counted on the day the load was delivered; a posted cost is counted on the day Accounting posted it.' },
    ...overrides,
  });
}

function week(index: number, overrides: Partial<TrendWeek> = {}): TrendWeek {
  const start = new Date(Date.UTC(2026, 6, 13 + index * 7));
  const end = new Date(start.getTime() + 6 * 86_400_000);
  const iso = (d: Date) => d.toISOString().slice(0, 10);
  return {
    weekStart: iso(start),
    weekEnd: iso(end),
    label: `Wk ${index + 1}`,
    highlighted: index === 7,
    isComplete: index !== 7,
    gross: 100000 + index * 3000,
    cost: 72000 + index * 1500,
    profit: 28000 + index * 1500,
    rpm: 2.2 + index * 0.02,
    cpm: 1.6,
    ppm: 0.6 + index * 0.01,
    marginPct: 27 + index * 0.4,
    totalMiles: 45000 + index * 500,
    activeTrucks: 22 + (index % 3),
    inactiveTrucks: 3 + (index % 2),
    activeByPayType: {
      company: 10 + (index % 3),
      owner_operator: 6,
      lease_owner: 4,
      percentage: 2,
      unknown: 0,
    },
    avgGrossPerTruck: 4500 + index * 60,
    avgCostPerTruck: 3200 + index * 40,
    avgProfitPerTruck: 1300 + index * 20,
    avgMilesPerTruck: 2000 + index * 15,
    hasExpenseData: true,
    ...overrides,
  };
}

export function trendsFixture(overrides: Partial<DashboardTrends> = {}): DashboardTrends {
  return DashboardTrendsSchema.parse({
    meta,
    weeks: [
      week(0),
      week(1),
      week(2, {
        cost: null,
        profit: null,
        cpm: null,
        marginPct: null,
        hasExpenseData: false,
      }),
      week(3),
      week(4),
      week(5),
      week(6),
      week(7),
    ],
    summary: {
      window: { from: '2026-07-13', to: '2026-09-06', weeks: 8 },
      previousWindow: { from: '2026-05-18', to: '2026-07-12', weeks: 8 },
      gross: metric(2158400, 2020000),
      cost: metric(1246780, 1196500),
      profit: metric(911620, 810000),
      rpm: metric(2.43, 2.3),
      cpm: metric(1.72, 1.66),
      ppm: metric(0.63, 0.6),
      marginPct: metric(28.4, 27.5),
      totalMiles: metric(888000, 878000),
      activeTrucks: metric(57, 56),
      // One week of the eight has no expense data, matching `week(2)` above.
      expenseCoverage: { weeks: 8, weeksWithData: 7 },
    },
    masked: false,
    ...overrides,
  });
}

export function opsNetFixture(overrides: Partial<DashboardOpsNet> = {}): DashboardOpsNet {
  const bucket = (
    payType: DashboardOpsNet['buckets'][number]['payType'],
    label: string,
    gross: number,
  ) => ({
    payType,
    label,
    driverCount: 6,
    gross,
    costs: {
      fuel: gross * 0.3,
      insurance: gross * 0.05,
      maintenance: gross * 0.02,
      tolls: gross * 0.01,
      repairs: gross * 0.01,
      dispatch_fee: gross * 0.05,
      factoring: gross * 0.03,
      driver_pay: gross * 0.25,
      staff_payroll: gross * 0.04,
      // No `other` expense line for any bucket: the row must render "—", not $0.
      other: null,
    },
    fuel: gross * 0.3,
    insurance: gross * 0.05,
    factoring: gross * 0.03,
    driverPay: gross * 0.25,
    driverPayEstimated: payType === 'company' ? 2400 : 0,
    other: gross * 0.04,
    totalCost: gross * 0.67,
    operatingProfit: gross * 0.33,
    marginPct: 33,
    rpm: 2.45,
    totalMiles: gross / 2.45,
    activeTrucks: 8,
    avgGrossPerTruck: gross / 8,
    avgMilesPerTruck: gross / 2.45 / 8,
  });
  return DashboardOpsNetSchema.parse({
    meta,
    buckets: [
      bucket('company', 'Company drivers', 60000),
      bucket('owner_operator', 'Owner operators', 40000),
      bucket('lease_owner', 'Lease owners', 12000),
      bucket('percentage', 'Percentage', 4760.5),
      { ...bucket('unknown', 'Unknown pay type', 8240), driverCount: 4 },
    ],
    // The company column: every bucket summed, including unknown. `totals` carries no `payType`.
    totals: (() => {
      const row: Record<string, unknown> = { ...bucket('company', 'Total', 125000.5) };
      delete row.payType;
      return { ...row, driverCount: 28, activeTrucks: 40 };
    })(),
    inactiveTruckLoss: 3250,
    netOperatingProfit: 125000.5 * 0.33 - 3250,
    unknown: {
      driverCount: 4,
      gross: 8240,
      drivers: [
        { driverId: 'drv_1', name: 'Pavel Ivanov', rawPayTag: 'OO-lease?' },
        { driverId: 'drv_2', name: 'Dmitri Volkov', rawPayTag: null },
        { driverId: 'drv_3', name: 'Luis Ortega', rawPayTag: '1099' },
        { driverId: 'drv_4', name: 'Sam Carter', rawPayTag: 'temp' },
      ],
    },
    masked: false,
    ...overrides,
  });
}

export function truckRow(overrides: Partial<TruckPnlRow> = {}): TruckPnlRow {
  return {
    truckId: 'trk_1',
    unitNumber: '2785',
    status: 'driving',
    driverId: 'drv_1',
    driverName: 'Marcus Lee',
    payType: 'company',
    gross: 8200,
    miles: 3100,
    loads: 4,
    cost: 5100,
    costEstimated: 400,
    profit: 3100,
    inactiveLoss: false,
    ...overrides,
  };
}

export function truckPnlFixture(overrides: Partial<DashboardTruckPnl> = {}): DashboardTruckPnl {
  return DashboardTruckPnlSchema.parse({
    meta,
    rows: [
      truckRow(),
      truckRow({ truckId: 'trk_2', unitNumber: '2790', driverName: 'Ana Souza', profit: 2100 }),
      truckRow({
        truckId: 'trk_3',
        unitNumber: '2801',
        status: 'idle',
        driverId: null,
        driverName: null,
        payType: 'unknown',
        gross: 0,
        miles: 0,
        loads: 0,
        cost: 1200,
        costEstimated: 0,
        profit: -1200,
        inactiveLoss: true,
      }),
    ],
    totals: {
      trucks: 26,
      gross: 125000.5,
      miles: 54000,
      loads: 61,
      cost: 90000,
      costEstimated: 5000,
      profit: 35000.5,
      inactiveLoss: 1200,
      inactiveTrucks: 2,
    },
    page: { page: 1, pageSize: 25, total: 26 },
    masked: false,
    ...overrides,
  });
}

export function fuelFixture(overrides: Partial<DashboardFuel> = {}): DashboardFuel {
  return DashboardFuelSchema.parse({
    meta,
    totals: {
      fillUps: 84,
      gallons: 11200,
      discountedCost: 40000,
      grossCost: 43200,
      avgPricePerGallon: 3.57,
      fuelCostPerMile: 0.74,
    },
    byTruck: [
      { id: 'trk_1', label: '2785', fillUps: 6, gallons: 900, cost: 3200, share: 8 },
      { id: 'trk_2', label: '2790', fillUps: 5, gallons: 820, cost: 2950, share: 7.3 },
    ],
    byDriver: [
      { id: 'drv_1', label: 'Marcus Lee', fillUps: 6, gallons: 900, cost: 3200, share: 8 },
      { id: 'drv_2', label: 'Ana Souza', fillUps: 5, gallons: 820, cost: 2950, share: 7.3 },
    ],
    byState: [
      { state: 'IL', fillUps: 20, gallons: 2600, cost: 9400, avgPricePerGallon: 3.62 },
      { state: 'CA', fillUps: 6, gallons: 800, cost: 3800, avgPricePerGallon: 4.75 },
      { state: 'TX', fillUps: 30, gallons: 4100, cost: 13500, avgPricePerGallon: 3.29 },
    ],
    masked: false,
    ...overrides,
  });
}

export function dispatchFixture(overrides: Partial<DashboardDispatch> = {}): DashboardDispatch {
  const weeks = ['2026-08-17', '2026-08-24', '2026-08-31'].map((weekStart, i) => ({
    weekStart,
    label: `Wk ${i + 1}`,
    isComplete: i < 2,
  }));
  const team = (teamId: string, teamName: string, gross: number) => ({
    teamId,
    teamName,
    gross,
    loads: 18,
    activeTrucks: 9,
    activeDaysPct: 82.5,
    rpm: 2.41,
    grossPerTruck: gross / 9,
    estimatedFullWeekGross: { value: gross * 1.4, estimated: true },
    rpmBuckets: { lt150: 1, b150to200: 2, b200to250: 4, gte250: 2 },
    byWeek: [
      { weekStart: '2026-08-17', gross: gross * 1.1, estimated: false },
      { weekStart: '2026-08-24', gross: gross * 1.05, estimated: false },
      { weekStart: '2026-08-31', gross, estimated: true },
    ],
    total: gross * 2.15,
  });
  return DashboardDispatchSchema.parse({
    meta,
    weeks,
    teams: [team('team_a', 'Team Alpha', 42000), team('team_b', 'Team Bravo', 38500)],
    rpmBucketsTotal: { lt150: 2, b150to200: 4, b200to250: 8, gte250: 4 },
    masked: false,
    ...overrides,
  });
}

export function dataHealthFixture(
  overrides: Partial<DashboardDataHealth> = {},
): DashboardDataHealth {
  return DashboardDataHealthSchema.parse({
    meta,
    checks: [
      {
        key: 'revenue_reconciliation',
        status: 'ok',
        title: 'Revenue reconciliation',
        detail: 'Dashboard gross matches the revenue ledger.',
      },
      {
        key: 'expense_completeness',
        status: 'warning',
        title: 'Expense completeness',
        detail: '1 week without expense data (Jul 27).',
        count: 1,
      },
      {
        key: 'unknown_pay_types',
        status: 'warning',
        title: 'Unknown driver pay types',
        detail: '4 drivers have an unknown pay type.',
        count: 4,
        amount: 8240,
        href: '/drivers',
      },
      {
        key: 'missing_truck_assignments',
        status: 'ok',
        title: 'Truck assignments',
        detail: 'Every revenue line has a truck.',
      },
      {
        key: 'missing_driver_assignments',
        status: 'ok',
        title: 'Driver assignments',
        detail: 'Every revenue line has a driver.',
      },
      {
        key: 'missing_fuel_data',
        status: 'ok',
        title: 'Fuel data',
        detail: 'Fuel transactions present for the period.',
      },
    ],
    summary: { ok: 4, warning: 2, error: 0 },
    ...overrides,
  });
}

export function drilldownFixture(overrides: Partial<DashboardDrilldown> = {}): DashboardDrilldown {
  return DashboardDrilldownSchema.parse({
    meta,
    metric: 'gross',
    title: 'Gross revenue',
    total: 125000.5,
    columns: [
      { key: 'loadNumber', label: 'Load', kind: 'text' },
      { key: 'deliveredAt', label: 'Delivered', kind: 'date' },
      { key: 'truck', label: 'Truck', kind: 'text' },
      { key: 'linehaul', label: 'Linehaul', kind: 'money' },
    ],
    rows: [
      { loadNumber: 'L-100245', deliveredAt: '2026-09-02', truck: '2785', linehaul: 3200 },
      { loadNumber: 'L-100246', deliveredAt: '2026-09-03', truck: '2790', linehaul: 2850.5 },
    ],
    page: { page: 1, pageSize: 50, total: 2 },
    ...overrides,
  });
}

/** Everything the page fetches, keyed by endpoint path suffix. */
export interface DashboardFixtures {
  overview: DashboardOverview;
  trends: DashboardTrends;
  opsNet: DashboardOpsNet;
  truckPnl: DashboardTruckPnl;
  fuel: DashboardFuel;
  dispatch: DashboardDispatch;
  dataHealth: DashboardDataHealth;
  drilldown: DashboardDrilldown;
}

export function allFixtures(overrides: Partial<DashboardFixtures> = {}): DashboardFixtures {
  return {
    overview: overviewFixture(),
    trends: trendsFixture(),
    opsNet: opsNetFixture(),
    truckPnl: truckPnlFixture(),
    fuel: fuelFixture(),
    dispatch: dispatchFixture(),
    dataHealth: dataHealthFixture(),
    drilldown: drilldownFixture(),
    ...overrides,
  };
}

/** Maps a request URL to its fixture; `null` means "respond with an error". */
export function fixtureFor(
  url: string,
  fixtures: DashboardFixtures,
  failing: ReadonlyArray<keyof DashboardFixtures> = [],
): unknown | null {
  const path = url.replace(/^.*\/api\/v1/, '').split('?')[0] ?? '';
  const map: Record<string, keyof DashboardFixtures> = {
    '/dashboard/overview': 'overview',
    '/dashboard/trends': 'trends',
    '/dashboard/ops-net': 'opsNet',
    '/dashboard/truck-pnl': 'truckPnl',
    '/dashboard/fuel': 'fuel',
    '/dashboard/dispatch-performance': 'dispatch',
    '/dashboard/data-health': 'dataHealth',
    '/dashboard/drilldown': 'drilldown',
  };
  const key = map[path];
  if (!key || failing.includes(key)) return null;
  return fixtures[key];
}

/** A `fetch` stub that answers every dashboard endpoint from the fixtures. */
export function fetchStub(
  fixtures: DashboardFixtures,
  failing: ReadonlyArray<keyof DashboardFixtures> = [],
): typeof fetch {
  return (async (input: RequestInfo | URL) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const body = fixtureFor(url, fixtures, failing);
    if (body === null) {
      return new Response(
        JSON.stringify({ type: 'about:blank', title: 'Simulated failure', status: 500 }),
        { status: 500, headers: { 'content-type': 'application/problem+json' } },
      );
    }
    return new Response(JSON.stringify(body), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as typeof fetch;
}
