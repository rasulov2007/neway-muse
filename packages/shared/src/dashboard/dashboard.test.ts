import { describe, expect, it } from 'vitest';
import {
  DashboardOverviewSchema,
  DashboardPeriodQuerySchema,
  DrilldownQuerySchema,
  ResolvedPeriodSchema,
  TruckPnlQuerySchema,
  maskedMetric,
  nullMetric,
  type DashboardOverview,
  type MoneyMetric,
} from './index.js';

const metric = (value: number, previous: number): MoneyMetric => ({
  value,
  previous,
  delta: value - previous,
  deltaPct: previous === 0 ? null : ((value - previous) / Math.abs(previous)) * 100,
  reasons: [],
  masked: false,
});

const period = {
  preset: 'this_week' as const,
  from: '2026-08-31',
  to: '2026-09-06',
  label: 'Aug 31 - Sep 6, 2026',
  isComplete: false,
  timezone: 'America/Chicago',
  comparison: { from: '2026-08-24', to: '2026-08-30', label: 'Aug 24 - Aug 30, 2026' },
  weekStart: 1,
};

const overview: DashboardOverview = {
  meta: { source: 'demo', generatedAt: '2026-09-06T12:00:00.000Z', period },
  financial: {
    gross: metric(125000.5, 110000),
    cost: metric(90000, 85000),
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
  ],
  reconciliation: {
    status: 'ok',
    dashboardGross: 125000.5,
    ledgerGross: 125000.5,
    difference: 0,
  },
  expenseCoverage: { hasData: true },
  costMix: { posted: 0, estimated: 0, unallocatedPosted: 0, hasEstimates: false, dateBasis: 'Gross is counted on the day the load was delivered; a posted cost is counted on the day Accounting posted it.' },
};

describe('DashboardOverviewSchema', () => {
  it('parses a full sample overview', () => {
    const parsed = DashboardOverviewSchema.parse(overview);
    expect(parsed.financial.gross.value).toBe(125000.5);
    expect(parsed.fleet.averagesBasis).toBe('active_trucks');
  });

  it('accepts null metrics with reasons and masked metrics', () => {
    const sample: DashboardOverview = {
      ...overview,
      financial: { ...overview.financial, cost: nullMetric('no_expense_data') },
      unitEconomics: { ...overview.unitEconomics, rpm: maskedMetric() },
    };
    const parsed = DashboardOverviewSchema.parse(sample);
    expect(parsed.financial.cost).toEqual({
      value: null,
      previous: null,
      delta: null,
      deltaPct: null,
      reasons: ['no_expense_data'],
      masked: false,
    });
    expect(parsed.unitEconomics.rpm.masked).toBe(true);
    expect(parsed.unitEconomics.rpm.value).toBeNull();
  });

  it('rejects an unknown averages basis', () => {
    const bad = { ...overview, fleet: { ...overview.fleet, averagesBasis: 'all_trucks' } };
    expect(DashboardOverviewSchema.safeParse(bad).success).toBe(false);
  });

  it('accepts a resolved period and rejects a bad weekStart', () => {
    expect(ResolvedPeriodSchema.safeParse(period).success).toBe(true);
    expect(ResolvedPeriodSchema.safeParse({ ...period, weekStart: 7 }).success).toBe(false);
  });
});

describe('DashboardPeriodQuerySchema', () => {
  it('defaults the preset to this_week', () => {
    expect(DashboardPeriodQuerySchema.parse({})).toEqual({ period: 'this_week' });
  });

  it('accepts every preset without dates', () => {
    for (const p of ['today', 'this_week', 'last_week', 'this_month', 'last_month']) {
      expect(DashboardPeriodQuerySchema.safeParse({ period: p }).success).toBe(true);
    }
  });

  it('rejects custom without dates', () => {
    const result = DashboardPeriodQuerySchema.safeParse({ period: 'custom' });
    expect(result.success).toBe(false);
    const onlyFrom = DashboardPeriodQuerySchema.safeParse({ period: 'custom', from: '2026-09-01' });
    expect(onlyFrom.success).toBe(false);
  });

  it('rejects from after to and malformed dates', () => {
    expect(
      DashboardPeriodQuerySchema.safeParse({
        period: 'custom',
        from: '2026-09-08',
        to: '2026-09-01',
      }).success,
    ).toBe(false);
    expect(
      DashboardPeriodQuerySchema.safeParse({
        period: 'custom',
        from: '09/01/2026',
        to: '2026-09-01',
      }).success,
    ).toBe(false);
  });

  it('accepts a valid custom range', () => {
    const result = DashboardPeriodQuerySchema.parse({
      period: 'custom',
      from: '2026-09-01',
      to: '2026-09-07',
    });
    expect(result).toEqual({ period: 'custom', from: '2026-09-01', to: '2026-09-07' });
  });
});

describe('extended query schemas', () => {
  it('truck P&L query applies defaults, coerces paging and caps pageSize', () => {
    const parsed = TruckPnlQuerySchema.parse({ period: 'last_week', page: '2', pageSize: '25' });
    expect(parsed).toMatchObject({ view: 'all', sort: '-profit', page: 2, pageSize: 25 });
    expect(TruckPnlQuerySchema.safeParse({ pageSize: 500 }).success).toBe(false);
    expect(TruckPnlQuerySchema.safeParse({ sort: 'bogus' }).success).toBe(false);
    expect(TruckPnlQuerySchema.safeParse({ period: 'custom' }).success).toBe(false);
  });

  it('drilldown query requires a metric and keeps the period rules', () => {
    expect(DrilldownQuerySchema.safeParse({ period: 'today' }).success).toBe(false);
    expect(DrilldownQuerySchema.safeParse({ metric: 'gross', period: 'custom' }).success).toBe(
      false,
    );
    expect(DrilldownQuerySchema.parse({ metric: 'fuel' })).toEqual({
      metric: 'fuel',
      period: 'this_week',
      page: 1,
      pageSize: 50,
    });
  });
});
