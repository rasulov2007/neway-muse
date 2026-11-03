import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import type { Principal } from '../../common/auth/principal';
import type { DatabaseService } from '../../database/database.service';
import type { DateRange, ReportingDataSource } from '../reporting/facts';
import { ReportingPeriodService } from '../reporting/period/reporting-period.service';
import { buildReportingFacts, type RawReportingRows } from '../reporting/workspace/workspace-reporting-data-source';
import {
  buildAccessorialSplit,
  readAccessorialRaw,
  type AccessorialLoad,
  type AccessorialRaw,
} from './accessorial-split';
import { AnalyticsService } from './analytics.service';

/**
 * Accessorials - who gets what. Every split is recomputed by hand from the raw rows below:
 * Billed is the broker amount gross counts, To driver what approved statements paid (else the
 * allocation, else the For driver amount), To dispatcher the claim's updater payout, Company the
 * rest, and an unknown driver share is null with its reason, never 0.
 */

const WEEK: DateRange = { from: '2026-10-12', to: '2026-10-18' };

function load(over: Partial<AccessorialLoad> & Pick<AccessorialLoad, 'id'>): AccessorialLoad {
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

const LOADS: AccessorialLoad[] = [
  // Detention $200 with For driver $150 (no statement, no allocation) and a lumper $100 with no
  // For driver figure (= the billed amount). A draft layover is not billed. Claim: Mia, $40.
  load({
    id: 'l1',
    rate: 3000,
    deliveredAt: '2026-10-14T15:00:00Z',
    charges: [
      { id: 'c_lh', type: 'linehaul', amount: 3000, billable: true },
      { id: 'c_det', type: 'detention', amount: 200, billable: true, status: 'accepted', driverAmount: 150 },
      { id: 'c_lum', type: 'lumper', amount: 100, billable: true },
      { id: 'c_lay', type: 'layover', amount: 300, billable: true, status: 'draft' },
    ],
  }),
  // TONU $250 cancelled Thursday; the cancel freed the driver, the approved statement of drv_2 pays
  // a $100 flat line on it. Claim by REF (lower case), $25 to the updater.
  load({
    id: 'l2',
    status: 'tonu',
    driverId: null,
    brokerReference: 'REF-77',
    rate: 2000,
    cancellation: { outcome: 'tonu', fee: 250, at: '2026-10-15T14:00:00Z' },
    charges: [{ id: 'c_tonu', type: 'tonu', amount: 250, billable: true, payableToDriver: false }],
  }),
  // Detention $120 Accounting put in the percentage base; no statement yet: unknown.
  load({
    id: 'l3',
    deliveredAt: '2026-10-16T12:00:00Z',
    charges: [{ id: 'c_det3', type: 'detention', amount: 120, billable: true, status: 'accepted' }],
  }),
  // Delivered 23:30 ET Sunday the 18th (03:30 UTC Monday): in this week. Layover $400 paid
  // separately at 50% of the For driver amount ($400) = $200 expected.
  load({
    id: 'l4',
    deliveredAt: '2026-10-19T03:30:00Z',
    charges: [{ id: 'c_lay4', type: 'layover', amount: 400, billable: true, status: 'accepted' }],
  }),
  // Delivered 23:30 ET on Sunday the 11th (03:30 UTC on the 12th): last week, not counted.
  load({
    id: 'l5',
    deliveredAt: '2026-10-12T03:30:00Z',
    charges: [{ id: 'c_det5', type: 'detention', amount: 999, billable: true, status: 'accepted' }],
  }),
  // Detention $180 (For driver $180) - the approved statement paid $90 for it: the statement wins.
  // A stop charge $50 is Other; the statement paid nothing for it, so the driver got $0.
  load({
    id: 'l7',
    deliveredAt: '2026-10-17T16:00:00Z',
    charges: [
      { id: 'c_det7', type: 'detention', amount: 180, billable: true, status: 'accepted' },
      { id: 'c_stop7', type: 'stop_charge', amount: 50, billable: true, status: 'accepted' },
    ],
  }),
];

const RAW: AccessorialRaw = {
  loads: LOADS,
  statements: [
    {
      id: 'stm_1',
      settlementNumber: 'ST-1',
      status: 'approved',
      partyId: 'drv_2',
      partyName: 'Bob Stone',
      loadIds: ['l2'],
      earnings: [{ kind: 'flat', loadId: 'l2', cents: 10_000 }],
    },
    {
      id: 'stm_2',
      settlementNumber: 'ST-2',
      status: 'paid',
      partyId: 'drv_1',
      partyName: 'Ann Lee',
      loadIds: ['l7'],
      earnings: [
        { kind: 'percentage', loadId: 'l7', cents: 30_000, payBasisCents: 100_000 },
        { kind: 'accessorial', loadId: 'l7', chargeId: 'c_det7', cents: 9_000 },
      ],
    },
    // A draft is not what was paid: ignored.
    { id: 'stm_3', settlementNumber: 'ST-3', status: 'draft', partyId: 'drv_1', partyName: 'Ann Lee', loadIds: ['l1'], earnings: [{ kind: 'accessorial', loadId: 'l1', chargeId: 'c_det', cents: 1 }] },
  ],
  allocations: {
    'l3:c_det3': { chargeId: 'c_det3', treatment: 'in_percentage_base', mode: 'full', value: 100, nature: 'earning', recipients: ['drv_1'] },
    'l4:c_lay4': { chargeId: 'c_lay4', treatment: 'paid_separately', mode: 'percent', value: 50, nature: 'earning', recipients: ['drv_1'] },
  },
  claims: [
    { id: 'cl1', loadNumber: 'L1', claimType: 'detention', status: 'recovered', updater: 'Mia', updaterPayoutCents: 4_000, claimDate: '2026-10-14' },
    { id: 'cl2', loadNumber: 'ref-77', claimType: 'tonu', status: 'paid', updater: 'Sam', updaterPayoutCents: 2_500, claimDate: '2026-10-15' },
    // Names a load nobody booked in NeWay Loads: counted in a note, not in money.
    { id: 'cl3', loadNumber: 'X-404', claimType: 'detention', status: 'open', updater: 'Mia', updaterPayoutCents: 1_000, claimDate: '2026-10-16' },
  ],
  drivers: [
    { id: 'drv_1', name: 'Ann Lee' },
    { id: 'drv_2', name: 'Bob Stone' },
  ],
};

const entry = (split: ReturnType<typeof buildAccessorialSplit>, loadId: string, type: string) =>
  split.loads.items.find((e) => e.loadId === loadId && e.type === type);

describe('accessorial split', () => {
  const split = buildAccessorialSplit(WEEK, RAW, { pageSize: 100 });

  it('detention with a For driver amount and a claim: 200 billed, 150 driver, 40 dispatcher, 10 company', () => {
    expect(entry(split, 'l1', 'detention')).toMatchObject({
      billed: 200,
      toDriver: 150,
      driverBasis: 'for_driver',
      toDispatcher: 40,
      companyKeeps: 10,
      driverName: 'Ann Lee',
      dispatcherName: 'Mia',
      claimStatus: 'recovered',
    });
    // No For driver figure: the driver is paid on the billed amount.
    expect(entry(split, 'l1', 'lumper')).toMatchObject({ billed: 100, toDriver: 100, toDispatcher: 0, companyKeeps: 0 });
    // The draft layover is not billed, so there is no layover line for l1.
    expect(entry(split, 'l1', 'layover')).toBeUndefined();
  });

  it('TONU with a statement pay line: the cancellation fee, what the statement paid, the claim by REF', () => {
    expect(entry(split, 'l2', 'tonu')).toMatchObject({
      day: '2026-10-15',
      billed: 250,
      toDriver: 100,
      driverBasis: 'statement',
      toDispatcher: 25,
      companyKeeps: 125,
      driverName: 'Bob Stone',
      dispatcherName: 'Sam',
      brokerReference: 'REF-77',
    });
  });

  it('what the statement paid wins over the For driver amount; a charge it did not pay is $0', () => {
    expect(entry(split, 'l7', 'detention')).toMatchObject({ billed: 180, toDriver: 90, driverBasis: 'statement', companyKeeps: 90 });
    expect(entry(split, 'l7', 'other')).toMatchObject({ billed: 50, toDriver: 0, driverBasis: 'statement', companyKeeps: 50 });
  });

  it('an allocation on the For driver amount when no statement holds the load', () => {
    expect(entry(split, 'l4', 'layover')).toMatchObject({ day: '2026-10-18', billed: 400, toDriver: 200, driverBasis: 'allocation', companyKeeps: 200 });
  });

  it('an unknown driver share is null with the reason, never 0, and so is Company keeps', () => {
    const e = entry(split, 'l3', 'detention');
    expect(e?.toDriver).toBeNull();
    expect(e?.companyKeeps).toBeNull();
    expect(e?.driverReason).toMatch(/percentage base/);
    const detention = split.rows.find((r) => r.type === 'detention')!;
    // l1 200 + l3 120 + l7 180 billed; one unknown driver share makes the row's driver and company null.
    expect(detention).toMatchObject({ billed: 500, toDriver: null, companyKeeps: null, toDispatcher: 40, unknownDriver: 1, loads: 3, charges: 3, claims: 1 });
    expect(detention.toDriverReason).toMatch(/percentage base/);
    expect(split.totals.toDriver).toBeNull();
    expect(split.totals.companyKeeps).toBeNull();
  });

  it('rows and totals add up from the entries, in a fixed order', () => {
    expect(split.rows.map((r) => r.type)).toEqual(['detention', 'layover', 'tonu', 'lumper', 'other']);
    expect(split.rows.find((r) => r.type === 'tonu')).toMatchObject({ billed: 250, toDriver: 100, toDispatcher: 25, companyKeeps: 125 });
    expect(split.rows.find((r) => r.type === 'layover')).toMatchObject({ billed: 400, toDriver: 200, toDispatcher: 0, companyKeeps: 200 });
    expect(split.totals).toMatchObject({ billed: 500 + 400 + 250 + 100 + 50, toDispatcher: 65, loads: 5, unknownDriver: 1 });
  });

  it('Eastern boundary: 23:30 ET Sunday counts that Sunday, the load before the week is left out', () => {
    expect(split.loads.items.some((e) => e.loadId === 'l5')).toBe(false);
    expect(entry(split, 'l4', 'layover')?.day).toBe('2026-10-18');
    const next = buildAccessorialSplit({ from: '2026-10-05', to: '2026-10-11' }, RAW);
    expect(next.loads.items.map((e) => e.loadId)).toEqual(['l5']);
  });

  it('Billed equals the accessorials and TONU gross counts for the same rows and week', () => {
    const facts = buildReportingFacts('C1', WEEK, {
      loads: LOADS,
      snapshot: null,
      ledger: { lines: [], settled: new Set(), postedRefs: new Set() } as unknown as RawReportingRows['ledger'],
      trucks: [],
      drivers: [],
      workOrders: [],
      fleetExpenses: [],
      driverTransactions: [],
      settlementPeriodEnd: new Map(),
    });
    const gross = facts.revenue.reduce((s, r) => s + (r.accessorials ?? 0) + (r.tonu ?? 0), 0);
    expect(split.totals.billed).toBeCloseTo(gross, 2);
  });

  it('a TONU no statement pays and with no For driver amount is unknown', () => {
    const only = buildAccessorialSplit(WEEK, { ...RAW, statements: [] });
    expect(entry(only, 'l2', 'tonu')).toMatchObject({ toDriver: null, companyKeeps: null, driverBasis: 'unknown' });
    expect(entry(only, 'l2', 'tonu')?.driverReason).toMatch(/TONU/);
  });

  it('lists loads most recent first, paged, and names unmatched claims', () => {
    const paged = buildAccessorialSplit(WEEK, RAW, { page: 1, pageSize: 2 });
    expect(paged.loads.total).toBe(7);
    expect(paged.loads.items.map((e) => `${e.loadId}:${e.type}`)).toEqual(['l4:layover', 'l7:detention']);
    expect(split.loads.items.map((e) => e.day)).toEqual([...split.loads.items.map((e) => e.day)].sort().reverse());
    expect(split.notes.join(' ')).toMatch(/1 dispatcher claim/);
  });

  it('empty period: no rows, zero totals', () => {
    const none = buildAccessorialSplit({ from: '2026-01-01', to: '2026-01-07' }, RAW);
    expect(none.rows).toEqual([]);
    expect(none.loads.total).toBe(0);
    expect(none.totals).toMatchObject({ billed: 0, toDriver: 0, toDispatcher: 0, companyKeeps: 0 });
  });
});

describe('accessorial split - company scoping', () => {
  it('the service reads only the principal’s company', async () => {
    const asked: string[] = [];
    const analytics = new AnalyticsService(
      { kind: 'database', facts: async () => { throw new Error('not read'); } } as ReportingDataSource,
      new ReportingPeriodService(),
      {} as DatabaseService,
      () => new Date('2026-10-16T12:00:00Z'),
    );
    analytics.accessorialSource = async (companyId) => {
      asked.push(companyId);
      return RAW;
    };
    const p = { companyId: 'co_other', companyTimezone: 'America/New_York', weekStart: 1 } as unknown as Principal;
    const out = await analytics.accessorials(p, 'custom', WEEK.from, WEEK.to);
    expect(asked).toEqual(['co_other']);
    expect(out.range).toEqual(WEEK);
  });

  it('every query the reader runs filters by company_id', async () => {
    const dialect = new PgDialect();
    const wheres: { sql: string; params: unknown[] }[] = [];
    const chain = {
      select: () => chain,
      from: () => chain,
      where: (cond: SQL) => {
        const q = dialect.sqlToQuery(cond);
        wheres.push({ sql: q.sql, params: q.params });
        return Promise.resolve([]);
      },
    };
    const raw = await readAccessorialRaw({ db: chain } as unknown as DatabaseService, 'co_scope');
    expect(wheres).toHaveLength(5);
    for (const w of wheres) {
      expect(w.sql).toContain('"company_id" = $1');
      expect(w.params[0]).toBe('co_scope');
    }
    expect(raw).toEqual({ loads: [], statements: [], allocations: {}, claims: [], drivers: [] });
  });
});
