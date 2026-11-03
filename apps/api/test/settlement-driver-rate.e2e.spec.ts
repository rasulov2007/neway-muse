import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { invoiceLinesFor, type BillableLoad, type StatementComputation } from '@neway/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { loads } from '../src/database/schema/loads';
import { drivers } from '../src/database/schema/roster';

const ACCT = '/api/v1/accounting';

type StatementJson = { id: string; status: string; settlementNumber: string; computation: StatementComputation; netCents: number };

/**
 * Real rate vs For driver rate (owner, 2026-10-23): the broker pays $3,000, the owner operator is
 * paid 30% of $2,500. Detention bills $200 and pays the driver on $150. Accounting corrects the
 * For driver figures and the REF number on the draft statement; the load is written, audited and
 * version-checked, and billing keeps reading the real amounts.
 */
describe('Statement pays the For driver amounts (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let companyId = '';
  const tag = Date.now().toString(36).toUpperCase();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const shift = (day: string, n: number) => {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  // A Wednesday two weeks back: inside a closed pay week, never on its Monday-noon edge.
  const day = (() => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - 14 - ((d.getUTCDay() + 4) % 7));
    return d.toISOString().slice(0, 10);
  })();
  const driverId = `drv_e2e_fdr_${tag}`.toLowerCase();
  const loadId = `lod_e2e_fdr_${tag}`.toLowerCase();
  let statementId = '';
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: payload === undefined ? {} : { 'content-type': 'application/json' }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const statement = async () => (await call('GET', `${ACCT}/settlements/${statementId}`)).json() as StatementJson;
  const record = async () => ((await db.select({ record: loads.record }).from(loads).where(eq(loads.id, loadId)))[0]!.record) as Record<string, unknown> & { updatedAt: string };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    const [anyDriver] = await db.select({ companyId: drivers.companyId }).from(drivers).limit(1);
    companyId = anyDriver?.companyId ?? 'co_northwind';
    await db.insert(drivers).values({ id: driverId, companyId, driverNumber: `E2E-FD-${tag}`, firstName: 'E2E', lastName: `ForDriver ${tag}`, phone: '5550000021', email: `e2e-fd-${tag}@example.test`.toLowerCase(), driverType: 'owner_operator', cdlState: 'IL', cdlClass: 'A', cdlExpiresOn: '2030-01-01', cdlStatus: 'missing', medicalCardStatus: 'missing', hireDate: shift(today, -120), status: 'active', dispatcherId: '', dispatcherName: '', currentTruckId: null, homeCity: 'Chicago', homeState: 'IL', payPlanKind: 'percent_of_linehaul', payPlanRate: '30' });
    const s = (await call('GET', `${ACCT}/settings`)).json() as { version: number; settings: { payOnFundingOnly: boolean | null } };
    const put = await call('PUT', `${ACCT}/settings`, { expectedVersion: s.version, settings: { cutoffBasis: 'delivered_at', cutoffTimezoneConfirmed: true, payOnFundingOnly: s.settings.payOnFundingOnly ?? false } });
    expect(put.statusCode, put.body).toBeLessThan(300);
    const acct = (await call('GET', `${ACCT}/drivers/${driverId}/account`)).json() as { profile: { version: number } };
    const saved = await call('PUT', `${ACCT}/drivers/${driverId}/profile`, { expectedVersion: acct.profile.version, effectiveFrom: shift(today, -120), contractType: 'OO', switches: { deductFuel: false, deductTolls: false, deductApprovedAdvances: false, recurringDeductions: false, escrowEnabled: false }, loadedPlan: { kind: 'percent_of_linehaul', rate: 30 }, emptyPlan: { kind: 'none', rate: 0 }, escrow: { targetCents: 0, perSettlementCents: 0, openingBalanceCents: 0, openingReconciled: true }, lease: null, reason: 'e2e', openingDebtCents: 0, openingDebtReconciled: true, confirmRate: true });
    expect(saved.statusCode, saved.body).toBeLessThan(300);

    const deliveredAt = `${day}T15:00:00.000Z`;
    await db.insert(loads).values({ id: loadId, companyId, loadNumber: `E2E-FD-${tag}`, status: 'delivered', driverId, record: { id: loadId, loadNumber: `E2E-FD-${tag}`, status: 'delivered', driverId, brokerReference: '123456', deliveredAt, updatedAt: deliveredAt, rate: 3000, driverRate: 2500, loadedMiles: 1000, emptyMiles: 0, documents: [], timeline: [], notes: [], charges: [{ id: 'lh', type: 'linehaul', description: 'Linehaul', amount: 3000, billable: true }, { id: 'det', type: 'detention', description: 'Detention', amount: 200, billable: true, status: 'accepted', driverAmount: 150 }], stops: [{ kind: 'pickup', city: 'Chicago', state: 'IL' }, { kind: 'delivery', city: 'Dallas', state: 'TX' }] } }).onConflictDoNothing();
    const al = await call('POST', `${ACCT}/billing/loads/${loadId}/accessorials`, { chargeId: 'det', treatment: 'paid_separately', mode: 'full', value: 100, nature: 'earning', recipients: [driverId] });
    expect(al.statusCode, al.body).toBeLessThan(300);
    const gen = await call('POST', `${ACCT}/settlements/generate`, { kind: 'lo_oo', weekOf: day });
    expect(gen.statusCode, gen.body).toBeLessThan(300);
    const all = (await call('GET', `${ACCT}/settlements`)).json() as Array<{ id: string; partyId: string; periodStart: string; periodEnd: string }>;
    statementId = all.find((x) => x.partyId === driverId && x.periodStart <= day && x.periodEnd >= day)!.id;
  }, 180_000);

  afterAll(async () => {
    await db.update(loads).set({ status: 'cancelled' }).where(and(eq(loads.companyId, companyId), eq(loads.driverId, driverId)));
    await app.close();
  });

  it('pays 30% of the For driver rate and the For driver detention, and shows Real beside it', async () => {
    const st = await statement();
    const pay = st.computation.earnings.find((e) => e.kind === 'percentage')!;
    expect(pay).toMatchObject({ payBasisCents: 250_000, cents: 75_000, brokerReference: '123456' });
    expect(st.computation.earnings.find((e) => e.chargeId === 'det')!.cents).toBe(15_000);
    expect(st.computation.loadFacts).toEqual([expect.objectContaining({ loadId, brokerReference: '123456', realLinehaulCents: 300_000, linehaulCents: 250_000, accessorials: [expect.objectContaining({ id: 'det', realAmountCents: 20_000, amountCents: 15_000 })] })]);
  });

  it('Accounting corrects For driver and the REF on the draft: the load is written, audited, and the draft recomputes', async () => {
    const before = await record();
    const r = await call('POST', `${ACCT}/settlements/${statementId}/loads/${loadId}/pay-facts`, { expectedUpdatedAt: before.updatedAt, driverRate: 2000, charges: [{ chargeId: 'det', driverAmount: 100 }], brokerReference: '654321', reason: 'Lane agreed at $2,000' });
    expect(r.statusCode, r.body).toBeLessThan(300);
    const out = r.json() as { statement: StatementJson };
    expect(out.statement.computation.earnings.find((e) => e.kind === 'percentage')!.cents).toBe(60_000);
    expect(out.statement.computation.earnings.find((e) => e.chargeId === 'det')!.cents).toBe(10_000);
    const after = await record();
    expect(after).toMatchObject({ driverRate: 2000, brokerReference: '654321', rate: 3000 });
    expect((after['charges'] as Array<{ id: string; amount: number; driverAmount?: number }>).find((c) => c.id === 'det')).toMatchObject({ amount: 200, driverAmount: 100 });
    const audit = (await db.execute(sql`select action, reason from audit_logs where company_id = ${companyId} and entity_id = ${loadId} and action = 'load_pay_facts_set'`)) as unknown as Array<{ action: string; reason: string | null }>;
    expect(audit[0]).toMatchObject({ reason: 'Lane agreed at $2,000' });
    // The invoice the broker gets still bills the real amounts.
    expect(invoiceLinesFor({ ...(after as object), status: 'delivered', charges: after['charges'] } as unknown as BillableLoad).map((l) => l.amount)).toEqual([3000, 200]);
  });

  it('a stale copy is a conflict, never an overwrite', async () => {
    const r = await call('POST', `${ACCT}/settlements/${statementId}/loads/${loadId}/pay-facts`, { expectedUpdatedAt: '2020-01-01T00:00:00.000Z', driverRate: 1 });
    expect(r.statusCode).toBe(409);
    expect((await record())['driverRate']).toBe(2000);
  });
});
