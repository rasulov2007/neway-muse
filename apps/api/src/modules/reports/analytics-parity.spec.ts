import { describe, expect, it } from 'vitest';
import type { Principal } from '../../common/auth/principal';
import type { DatabaseService } from '../../database/database.service';
import type { Clock } from '../dashboard/clock';
import type { DateRange, ReportingDataSource, ReportingFacts } from '../reporting/facts';
import { ReportingPeriodService } from '../reporting/period/reporting-period.service';
import {
  buildReportingFacts,
  businessDay,
  recoveryClassOf,
  type DriverTxRow,
  type LoadRecord,
  type RawReportingRows,
  type WorkOrderRow,
} from '../reporting/workspace/workspace-reporting-data-source';
import { AnalyticsService } from './analytics.service';

/**
 * Data parity (owner decisions, 2026-10-25). Every KPI the Analytics API returns is recomputed
 * here from the raw fixture rows, by hand, and must match to the cent. The fixture covers each
 * decision: TONU, accessorials, linehaul RPM, recoveries, DEF, trailer repairs, Eastern days,
 * driver pay by the week earned, one-sided profit.
 */

const WEEK: DateRange = { from: '2026-10-12', to: '2026-10-18' };

function load(over: Partial<LoadRecord> & Pick<LoadRecord, 'id'>): LoadRecord {
  return {
    loadNumber: over.id.toUpperCase(),
    status: 'delivered',
    truckId: 'trk_1',
    driverId: 'drv_1',
    rate: 0,
    loadedMiles: 0,
    emptyMiles: 0,
    deliveredAt: null,
    charges: [],
    ...over,
  };
}

const LOADS: LoadRecord[] = [
  // Linehaul $3,000 + detention $200 (accepted) + lumper $150; a draft layover and a dropped stop
  // charge do not count; the For driver amount ($100) is a pay figure, never revenue.
  load({
    id: 'l1',
    rate: 3000,
    loadedMiles: 900,
    emptyMiles: 100,
    deliveredAt: '2026-10-14T15:00:00Z',
    charges: [
      { type: 'linehaul', amount: 3000, billable: true },
      { type: 'detention', amount: 200, billable: true, status: 'accepted', driverAmount: 100 },
      { type: 'lumper', amount: 150, billable: true },
      { type: 'layover', amount: 300, billable: true, status: 'draft' },
      { type: 'stop_charge', amount: 75, billable: true, status: 'dropped' },
    ],
  }),
  // Delivered 23:30 ET on Sunday the 18th = 03:30 UTC on the 19th: it belongs to this week.
  load({ id: 'l2', rate: 1000, loadedMiles: 400, emptyMiles: 100, deliveredAt: '2026-10-19T03:30:00Z' }),
  // Delivered 00:30 ET Monday the 12th = 04:30 UTC: this week, not the prior one.
  load({ id: 'l3', rate: 500, loadedMiles: 200, emptyMiles: 0, deliveredAt: '2026-10-12T04:30:00Z', truckId: 'trk_2', driverId: 'drv_2' }),
  // Delivered 23:00 ET on Sunday the 11th (= 03:00 UTC on the 12th): the PRIOR week.
  load({ id: 'l4', rate: 800, loadedMiles: 300, emptyMiles: 0, deliveredAt: '2026-10-12T03:00:00Z' }),
  // A TONU the broker pays $250, cancelled on the 15th: revenue on its own line, no miles, no truck.
  load({
    id: 'l5',
    status: 'tonu',
    rate: 2500,
    loadedMiles: 700,
    truckId: null,
    driverId: null,
    cancellation: { outcome: 'tonu', fee: 250, at: '2026-10-15T14:00:00Z' },
    charges: [{ type: 'tonu', amount: 250, billable: true }],
  }),
  // Not delivered: never revenue.
  load({ id: 'l6', status: 'in_transit', rate: 9999, deliveredAt: null }),
  // A plain cancellation: nothing.
  load({ id: 'l7', status: 'cancelled', rate: 1200, cancellation: { outcome: 'cancelled', fee: null, at: '2026-10-13T10:00:00Z' } }),
];

const ORDERS: WorkOrderRow[] = [
  { id: 'wo_t', number: 'WO-1', status: 'completed', workType: 'repair', assetType: 'truck', unitId: 'trk_1', unitNumber: '101', vendorName: 'Shop', invoiceNumber: null, invoiceTotal: 400, total: 400, completedAt: '2026-10-13T16:00:00Z', migratedFrom: null },
  // Completed 23:45 ET on the 18th (03:45Z on the 19th): this week.
  { id: 'wo_pm', number: 'WO-2', status: 'completed', workType: 'oil_change', assetType: 'truck', unitId: 'trk_2', unitNumber: '102', vendorName: null, invoiceNumber: null, invoiceTotal: 150, total: 150, completedAt: '2026-10-19T03:45:00Z', migratedFrom: null },
  // A trailer's repair: the trailer's cost, never truck 101's even though 101 pulls it.
  { id: 'wo_tr', number: 'WO-3', status: 'completed', workType: 'repair', assetType: 'trailer', unitId: 'trl_9', unitNumber: 'T-9', vendorName: null, invoiceNumber: null, invoiceTotal: 600, total: 600, completedAt: '2026-10-16T12:00:00Z', migratedFrom: null },
  { id: 'wo_open', number: 'WO-4', status: 'in_shop', workType: 'repair', assetType: 'truck', unitId: 'trk_1', unitNumber: '101', vendorName: null, invoiceNumber: null, invoiceTotal: 999, total: 999, completedAt: null, migratedFrom: null },
];

const FUEL = [
  { id: 'f1', at: '2026-10-13T12:00:00Z', truckId: 'trk_1', driverId: 'drv_1', gallons: 100, amount: 400, product: 'diesel', station: { name: 'Pilot', state: 'IN' } },
  { id: 'f2', at: '2026-10-13T12:05:00Z', truckId: 'trk_1', driverId: 'drv_1', gallons: 10, amount: 50, product: 'def', station: { name: 'Pilot', state: 'IN' } },
  // 23:50 ET on the 18th: this week's diesel.
  { id: 'f3', at: '2026-10-19T03:50:00Z', truckId: 'trk_2', driverId: 'drv_2', gallons: 50, amount: 210, product: 'diesel', station: { name: 'Loves', state: 'OH' } },
  // A truck that ran no load this week: cost only.
  { id: 'f4', at: '2026-10-14T09:00:00Z', truckId: 'trk_3', driverId: null, gallons: 20, amount: 90, product: 'diesel', station: { name: 'TA', state: 'PA' } },
];

const TX: DriverTxRow[] = [
  // A repair charged back on the Oct 12-18 statement: recovered $120.
  { id: 'tx1', driverId: 'drv_1', kind: 'repair', onDate: '2026-10-13', recoveredCents: 12000, state: 'applied', source: 'work_order', truckId: 'trk_1', settlementId: 'stm_1', companyCost: false, recoveryLog: [{ settlementId: 'stm_1', cents: 12000 }], description: 'Shop charge' },
  // A reversed then re-applied recovery counts once.
  { id: 'tx2', driverId: 'drv_1', kind: 'manual_charge', onDate: '2026-10-12', recoveredCents: 3000, state: 'applied', source: 'manual', truckId: 'trk_1', settlementId: null, companyCost: false, recoveryLog: [{ settlementId: 'stm_1', cents: 3000, reversedAt: '2026-10-20T00:00:00Z' }, { settlementId: 'stm_1', cents: 3000 }], description: 'Other — Fuel' },
  // NOT recoveries: a lease payment, a fine, a per-mile charge.
  { id: 'tx3', driverId: 'drv_1', kind: 'recurring', onDate: '2026-10-18', recoveredCents: 60000, state: 'applied', source: 'lease', truckId: 'trk_1', settlementId: 'stm_1', companyCost: false, recoveryLog: [], description: 'Lease' },
  { id: 'tx4', driverId: 'drv_1', kind: 'manual_charge', onDate: '2026-10-18', recoveredCents: 10000, state: 'applied', source: 'manual', truckId: 'trk_1', settlementId: 'stm_1', companyCost: false, recoveryLog: [{ settlementId: 'stm_1', cents: 10000 }], description: 'Fine or ticket — 1111' },
  { id: 'tx5', driverId: 'drv_1', kind: 'manual_charge', onDate: '2026-10-18', recoveredCents: 21234, state: 'applied', source: 'manual', truckId: 'trk_1', settlementId: 'stm_1', companyCost: false, recoveryLog: [{ settlementId: 'stm_1', cents: 21234 }], description: 'Other — Cost per mile (13 cents)' },
];

/** Driver pay for Oct 12-18, POSTED on Oct 21: it belongs to Oct 12-18 (the week earned). */
const PAY_LINE = {
  id: 'jrn_pay_5200',
  date: '2026-10-18',
  category: 'driver_pay' as const,
  amount: 1800,
  truckId: 'trk_1',
  driverId: 'drv_1',
  source: 'ledger' as const,
  isEstimate: false,
  obligationKey: null,
};

function rawFor(range: DateRange): RawReportingRows {
  return {
    loads: LOADS,
    snapshot: { fuelTransactions: FUEL },
    ledger: {
      lines: range.from === WEEK.from ? [PAY_LINE] : [],
      settled: new Set(),
      postedRefs: new Set(),
    },
    trucks: [
      { id: 'trk_1', unitNumber: '101', status: 'available', currentDriverId: 'drv_1' },
      { id: 'trk_2', unitNumber: '102', status: 'available', currentDriverId: 'drv_2' },
      { id: 'trk_3', unitNumber: '103', status: 'available', currentDriverId: null },
    ],
    drivers: [
      { id: 'drv_1', firstName: 'Ann', lastName: 'Lee', driverType: 'owner_operator' },
      { id: 'drv_2', firstName: 'Bo', lastName: 'Kim', driverType: 'company' },
    ],
    workOrders: ORDERS,
    fleetExpenses: [],
    driverTransactions: TX,
    settlementPeriodEnd: new Map([['stm_1', '2026-10-18']]),
  };
}

class FixtureSource implements ReportingDataSource {
  readonly kind = 'database' as const;
  constructor(private readonly companyId: string) {}
  async facts(companyId: string, range: DateRange): Promise<ReportingFacts> {
    // Another company sees none of these rows.
    if (companyId !== this.companyId) {
      return buildReportingFacts(companyId, range, { ...rawFor(range), loads: [], snapshot: null, workOrders: [], driverTransactions: [], ledger: { lines: [], settled: new Set(), postedRefs: new Set() } });
    }
    return buildReportingFacts(companyId, range, rawFor(range));
  }
}

const principal = (companyId: string): Principal => ({
  userId: 'u',
  companyId,
  companyTimezone: 'America/Chicago',
  weekStart: 1,
  roles: [],
  permissions: new Set(['analytics.view']),
});

const clock: Clock = () => new Date('2026-10-25T16:00:00Z');
const service = () =>
  new AnalyticsService(new FixtureSource('co_a'), new ReportingPeriodService(), {} as DatabaseService, clock);

const metric = (metrics: { key: string; current: number | null }[], key: string) =>
  metrics.find((m) => m.key === key)?.current;

describe('Analytics data parity (fixture rows → API values)', () => {
  // Independent arithmetic from the raw rows above.
  const linehaul = 3000 + 1000 + 500; // l1, l2, l3 (l4 is the prior week)
  const accessorials = 200 + 150;
  const tonu = 250;
  const gross = linehaul + accessorials + tonu;
  const miles = 900 + 100 + 400 + 100 + 200; // TONU earns no miles
  const diesel = 400 + 210 + 90;
  const def = 50;
  const repairs = 400;
  const maintenance = 150;
  const trailer = 600;
  const pay = 1800;
  const costBefore = diesel + def + repairs + maintenance + trailer + pay;
  const recovered = 120 + 30; // the lease, the fine and the per-mile charge are not recoveries
  const net = costBefore - recovered;

  it('Executive KPIs equal the hand-computed figures', async () => {
    const res = await service().executive(principal('co_a'), 'custom', WEEK.from, WEEK.to);
    const m = res.metrics;
    expect(metric(m, 'linehaul')).toBe(linehaul);
    expect(metric(m, 'accessorials')).toBe(accessorials);
    expect(metric(m, 'tonu')).toBe(tonu);
    expect(metric(m, 'gross')).toBe(gross);
    expect(metric(m, 'miles')).toBe(miles);
    expect(metric(m, 'rpm')).toBeCloseTo(gross / miles, 4);
    expect(metric(m, 'linehaulRpm')).toBeCloseTo(linehaul / miles, 4);
    expect(metric(m, 'costBeforeRecovery')).toBe(costBefore);
    expect(metric(m, 'recovered')).toBe(recovered);
    expect(metric(m, 'cost')).toBe(net);
    expect(metric(m, 'profit')).toBe(gross - net);
    expect(metric(m, 'marginPct')).toBeCloseTo(((gross - net) / gross) * 100, 1);
    expect(metric(m, 'cpm')).toBeCloseTo(net / miles, 4);
    expect(metric(m, 'ppm')).toBeCloseTo((gross - net) / miles, 4);
    expect(metric(m, 'activeTrucks')).toBe(2);
    expect(res.profitHidden).toBeNull();
    expect(res.source).toBe('database');
    expect(res.dataStatus.revenue.loadsOnFile).toBe(LOADS.length);
  });

  it('TONU is its own line, included in gross, with no miles and no delivered load', async () => {
    const ops = await service().operations(principal('co_a'), 'custom', WEEK.from, WEEK.to);
    expect(ops.loads).toBe(3);
    expect(ops.tonuLoads).toBe(1);
    expect(ops.totalMiles).toBe(miles);
  });

  it('accessorials at the billed amount (not For driver; drafts and dropped excluded)', async () => {
    const facts = await new FixtureSource('co_a').facts('co_a', WEEK);
    const l1 = facts.revenue.find((r) => r.loadId === 'l1')!;
    expect(l1.linehaul).toBe(3000);
    expect(l1.accessorials).toBe(350);
  });

  it('cost breakdown: DEF, trailer repairs and recovered are separate lines', async () => {
    const res = await service().costDrivers(principal('co_a'), 'custom', WEEK.from, WEEK.to);
    const byCat = Object.fromEntries(res.drivers.map((d) => [d.category, d.amount]));
    expect(byCat.fuel).toBe(diesel);
    expect(byCat.def).toBe(def);
    expect(byCat.repairs).toBe(repairs);
    expect(byCat.maintenance).toBe(maintenance);
    expect(byCat.trailer_repairs).toBe(trailer);
    expect(byCat.driver_pay).toBe(pay);
    expect(byCat.recovered).toBe(-recovered);
    expect(res.totals).toEqual({ costBeforeRecovery: costBefore, recovered, net, recoveredUnapplied: 0 });
    expect(res.byTrailer).toEqual([{ trailerId: 'trl_9', unitNumber: 'T-9', amount: trailer, orders: 1 }]);
  });

  it('trailer repairs never reach a truck P&L; trucks net their recoveries', async () => {
    const res = await service().truckRanking(principal('co_a'), 'custom', WEEK.from, WEEK.to);
    const t1 = res.rows.find((r) => r.id === 'trk_1')!;
    // trk_1: diesel 400 + DEF 50 + repair 400 + pay 1800 - recovered 150. No trailer $600.
    expect(t1.cost).toBe(400 + 50 + 400 + 1800 - 150);
    expect(t1.gross).toBe(3000 + 350 + 1000);
    expect(t1.profit).toBe(4350 - 2500);
    expect(t1.linehaulRpm).toBeCloseTo(4000 / 1500, 2);
    const sumTruckCost = res.rows.reduce((s, r) => s + (r.cost ?? 0), 0);
    expect(sumTruckCost).toBe(net - trailer);
  });

  it('one-sided trucks show no profit and say why (F19)', async () => {
    const res = await service().truckRanking(principal('co_a'), 'custom', WEEK.from, WEEK.to);
    const t3 = res.rows.find((r) => r.id === 'trk_3')!;
    expect(t3.oneSided).toBe('cost_only');
    expect(t3.profit).toBeNull();
    expect(t3.profitReason).toMatch(/No delivered load/);
  });

  it('fuel: gallons and $/gal are diesel only, DEF apart', async () => {
    const res = await service().fuel(principal('co_a'), 'custom', WEEK.from, WEEK.to);
    expect(res.totals.gallons).toBe(170);
    expect(res.totals.discountedCost).toBe(diesel);
    expect(res.totals.avgPricePerGallon).toBeCloseTo(diesel / 170, 3);
    expect(res.totals.def).toEqual({ fillUps: 1, gallons: 10, cost: def });
    expect(res.totals.fuelCostPerMile).toBeCloseTo(diesel / miles, 3);
  });

  it('driver pay lands in the week it was earned, not the posting week', async () => {
    const res = await service().costDrivers(principal('co_a'), 'custom', '2026-10-19', '2026-10-25');
    expect(res.drivers.find((d) => d.category === 'driver_pay')).toBeUndefined();
  });

  it('a statement not approved yet is an estimate on its period end; an orphan statement adds nothing', async () => {
    const withDrafts = new (class implements ReportingDataSource {
      readonly kind = 'database' as const;
      async facts(companyId: string, range: DateRange) {
        return buildReportingFacts(companyId, range, {
          ...rawFor(range),
          statements: [
            { id: 's_draft', status: 'draft', partyType: 'driver', partyId: 'drv_2', periodEnd: '2026-10-25', truckId: 'trk_2', settlementNumber: 'ST-1', earnings: [{ loadId: 'l3', cents: 50000, kind: 'linehaul' }] },
            { id: 's_orphan', status: 'draft', partyType: 'driver', partyId: 'drv_2', periodEnd: '2026-10-25', truckId: 'trk_2', settlementNumber: 'ST-2', earnings: [{ loadId: 'ld_missing', cents: 99900, kind: 'linehaul' }] },
            { id: 's_posted', status: 'approved', partyType: 'driver', partyId: 'drv_1', periodEnd: '2026-10-25', truckId: 'trk_1', settlementNumber: 'ST-3', earnings: [{ loadId: 'l1', cents: 77700, kind: 'linehaul' }] },
          ],
        });
      }
    })();
    const res = await new AnalyticsService(withDrafts, new ReportingPeriodService(), {} as DatabaseService, clock).costDrivers(principal('co_a'), 'custom', '2026-10-19', '2026-10-25');
    expect(res.drivers.find((d) => d.category === 'driver_pay')?.amount).toBe(500);
    expect(res.notes.join(' ')).toMatch(/not approved yet/);
  });

  it('weekly trend includes cost-only weeks and agrees with the header (F25)', async () => {
    const res = await service().executive(principal('co_a'), 'custom', WEEK.from, WEEK.to);
    const sumGross = res.trend.reduce((s, t) => s + t.gross, 0);
    const sumCost = res.trend.reduce((s, t) => s + (t.cost ?? 0), 0);
    expect(Math.round(sumGross * 100) / 100).toBe(gross);
    expect(Math.round(sumCost * 100) / 100).toBe(net);
  });

  it('company scoping: B never sees A', async () => {
    const res = await service().executive(principal('co_b'), 'custom', WEEK.from, WEEK.to);
    expect(metric(res.metrics, 'gross')).toBe(0);
    expect(metric(res.metrics, 'cost')).toBeNull();
    const trucks = await service().truckRanking(principal('co_b'), 'custom', WEEK.from, WEEK.to);
    expect(trucks.rows.every((r) => r.gross === 0 && r.cost === null)).toBe(true);
  });

  it('uses the resolved comparison period (F6): this month vs the same span last month', async () => {
    const res = await service().executive(principal('co_a'), 'this_month');
    expect(res.range).toMatchObject({ from: '2026-10-01', to: '2026-10-25' });
    expect(res.comparison).toEqual({ from: '2026-09-01', to: '2026-09-25' });
  });

  it('periods resolve in Eastern time whatever the company setting says', async () => {
    // 2026-10-26 02:00 UTC is still Sunday the 25th in New York.
    const late = new AnalyticsService(new FixtureSource('co_a'), new ReportingPeriodService(), {} as DatabaseService, () => new Date('2026-10-26T02:00:00Z'));
    const res = await late.executive(principal('co_a'), 'last_week');
    expect(res.range).toMatchObject({ from: '2026-10-12', to: '2026-10-18' });
  });
});

describe('profit is hidden when one side is missing (decision 1)', () => {
  const costOnly = new (class implements ReportingDataSource {
    readonly kind = 'database' as const;
    async facts(companyId: string, range: DateRange) {
      return buildReportingFacts(companyId, range, { ...rawFor(range), loads: [] });
    }
  })();
  const svc = () => new AnalyticsService(costOnly, new ReportingPeriodService(), {} as DatabaseService, clock);

  it('cost but no loads in NeWay Loads: no profit, no margin, no PPM, and the reason', async () => {
    const res = await svc().executive(principal('co_a'), 'custom', WEEK.from, WEEK.to);
    expect(metric(res.metrics, 'gross')).toBe(0);
    expect(metric(res.metrics, 'cost')).not.toBeNull();
    expect(metric(res.metrics, 'profit')).toBeNull();
    expect(metric(res.metrics, 'marginPct')).toBeNull();
    expect(metric(res.metrics, 'ppm')).toBeNull();
    expect(res.profitHidden?.code).toBe('no_revenue');
    expect(res.notes.join(' ')).toMatch(/no loads in NeWay Loads/);
    expect(res.dataStatus.revenue.connected).toBe(false);
  });

  it('Needs attention names the gap instead of an all-clear (F26)', async () => {
    const res = await svc().executive(principal('co_a'), 'custom', WEEK.from, WEEK.to);
    expect(res.insights[0]?.key).toBe('data_no_loads');
    expect(res.insights[0]?.severity).toBe('critical');
  });

  it('weekly chart shows the cost-only week with no profit', async () => {
    const res = await svc().executive(principal('co_a'), 'custom', WEEK.from, WEEK.to);
    expect(res.trend.length).toBeGreaterThan(0);
    expect(res.trend.every((t) => t.profit === null && t.gross === 0)).toBe(true);
  });

  it('revenue but no cost: profit hidden', async () => {
    const revenueOnly = new (class implements ReportingDataSource {
      readonly kind = 'database' as const;
      async facts(companyId: string, range: DateRange) {
        return buildReportingFacts(companyId, range, { ...rawFor(range), snapshot: null, workOrders: [], driverTransactions: [], ledger: { lines: [], settled: new Set(), postedRefs: new Set() } });
      }
    })();
    const res = await new AnalyticsService(revenueOnly, new ReportingPeriodService(), {} as DatabaseService, clock).executive(principal('co_a'), 'custom', WEEK.from, WEEK.to);
    expect(metric(res.metrics, 'gross')).toBe(5100);
    expect(metric(res.metrics, 'profit')).toBeNull();
    expect(res.profitHidden?.code).toBe('no_cost');
  });

  it('a recovery larger than its recorded cost is named, not netted silently', async () => {
    const noFuel = new (class implements ReportingDataSource {
      readonly kind = 'database' as const;
      async facts(companyId: string, range: DateRange) {
        return buildReportingFacts(companyId, range, { ...rawFor(range), snapshot: null });
      }
    })();
    const res = await new AnalyticsService(noFuel, new ReportingPeriodService(), {} as DatabaseService, clock).executive(principal('co_a'), 'custom', WEEK.from, WEEK.to);
    expect(res.notes.join(' ')).toMatch(/Fuel cost not connected for this company/);
    expect(res.insights.some((i) => i.key === 'data_recovery_fuel')).toBe(true);
  });
});

describe('Eastern business days', () => {
  it('a 23:30 ET event lands on the ET day', () => {
    expect(businessDay('2026-10-19T03:30:00Z')).toBe('2026-10-18');
    expect(businessDay('2026-10-12T04:30:00Z')).toBe('2026-10-12');
    // Winter time (EST, UTC-5).
    expect(businessDay('2026-12-02T04:30:00Z')).toBe('2026-12-01');
    expect(businessDay('2026-10-18')).toBe('2026-10-18');
  });
});

describe('what counts as Recovered (owner, 2026-10-25)', () => {
  const tx = (kind: string, source: string, description: string) => ({ kind, source, description });
  it('charge-backs of company-paid costs', () => {
    expect(recoveryClassOf(tx('fuel', 'fuel_ledger', 'Fuel · Pilot'))).toBe('fuel');
    expect(recoveryClassOf(tx('repair', 'work_order', 'Shop charge'))).toBe('repairs');
    expect(recoveryClassOf(tx('tolls', 'manual', 'Tolls'))).toBe('tolls');
    expect(recoveryClassOf(tx('manual_charge', 'manual', 'Damage — light'))).toBe('damage');
    expect(recoveryClassOf(tx('manual_charge', 'driver_charge', 'Claim CLM-1'))).toBe('damage');
    expect(recoveryClassOf(tx('manual_charge', 'manual', 'Other — Fuel'))).toBe('fuel');
    expect(recoveryClassOf(tx('manual_charge', 'manual', 'Other — TOLL'))).toBe('tolls');
  });
  it('not recoveries: lease, fines, per-mile, violations, advances, escrow, uniforms', () => {
    expect(recoveryClassOf(tx('recurring', 'lease', 'Lease'))).toBeNull();
    expect(recoveryClassOf(tx('manual_charge', 'manual', 'Fine or ticket — 1'))).toBeNull();
    expect(recoveryClassOf(tx('manual_charge', 'manual', 'Other — Cost per mile (13 cents)'))).toBeNull();
    expect(recoveryClassOf(tx('manual_charge', 'safety_violation', 'Violation charge'))).toBeNull();
    expect(recoveryClassOf(tx('advance', 'manual', 'Advance'))).toBeNull();
    expect(recoveryClassOf(tx('escrow_deposit', 'settlement', 'Escrow'))).toBeNull();
    expect(recoveryClassOf(tx('carry_forward', 'opening', 'Opening'))).toBeNull();
    expect(recoveryClassOf(tx('manual_charge', 'manual', 'Uniform'))).toBeNull();
    expect(recoveryClassOf(tx('recurring', 'settlement', 'ELD'))).toBeNull();
  });
});
