import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DriverTx, StatementComputation } from '@neway/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { loads } from '../src/database/schema/loads';
import { drivers } from '../src/database/schema/roster';
import { StateService } from '../src/modules/state/state.service';

const ACCT = '/api/v1/accounting';
const FUEL_KEY = 'ws2-fueltransactions';

type StatementJson = { id: string; settlementNumber: string; status: string; periodStart: string; startsAt?: string | null; cutoffAt: string; exceptions: string[]; computation: StatementComputation; loadIds: string[]; removedLoads?: Array<{ loadId: string; reason: string; by: string }>; addedLoads?: Array<{ loadId: string; how: string }> };
type Outcome = { ok: boolean; blocked?: string; statement: StatementJson; carriedTo?: string | null };
type PayJson = { payAt: string; source: string; override: { at: string; reason: string; byName: string } | null; period: { start: string; label: string } | null; statements: Array<{ id: string; onIt: boolean; removed: unknown }> };

/**
 * The pay week (owner, 2026-10-21): Monday 12:00 noon Eastern to the next Monday noon. A load
 * counts at its delivery unless Accounting sets "Counts for pay on"; then it is on that week's
 * statement only. A load taken off a draft is put back in one click or goes on next week's.
 * Fuel bought in the week comes off that week's statement, once.
 */
describe('Pay week, pay-date override, put back and fuel (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let state: StateService;
  let companyId = '';
  const tag = Date.now().toString(36).toUpperCase();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const shift = (day: string, n: number) => {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  /** The Monday `weeks` weeks before this one. */
  const monday = (weeks: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - weeks * 7 - ((d.getUTCDay() + 6) % 7));
    return d.toISOString().slice(0, 10);
  };
  // Two consecutive weeks safely in the past. October/September 2026 weeks are EDT (UTC−4): noon = 16:00Z.
  const weekA = monday(5);
  const weekB = shift(weekA, 7);
  const noonZ = (day: string) => {
    // Noon Eastern on that day, whatever the offset.
    const probe = new Date(`${day}T16:00:00Z`);
    const hour = Number(probe.toLocaleString('en-US', { timeZone: 'America/New_York', hour: '2-digit', hourCycle: 'h23' }));
    return new Date(probe.getTime() + (12 - hour) * 3_600_000).toISOString();
  };
  const plusMin = (iso: string, m: number) => new Date(Date.parse(iso) + m * 60_000).toISOString();
  const driverId = `drv_e2e_payweek_${tag}`.toLowerCase();
  let truckId = '';
  const l1 = `lod_e2e_pw1_${tag}`.toLowerCase(); // delivered Monday evening of week B
  const l2 = `lod_e2e_pw2_${tag}`.toLowerCase(); // delivered mid-week A
  const stmA = `stm_${driverId}_${weekA}`;
  const stmB = `stm_${driverId}_${weekB}`;
  const f1 = `fue_e2e_pw1_${tag}`.toLowerCase(); // Thursday of week A
  const f2 = `fue_e2e_pw2_${tag}`.toLowerCase(); // Monday of week B at 11:00 ET → still week A
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: payload === undefined ? {} : { 'content-type': 'application/json' }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const statement = async (id: string) => (await call('GET', `${ACCT}/settlements/${id}`)).json() as StatementJson;
  const generate = async (weekOf: string) => {
    const r = await call('POST', `${ACCT}/settlements/generate`, { kind: 'lo_oo', weekOf });
    expect(r.statusCode, r.body).toBeLessThan(300);
  };
  const fuelTxs = async () => ((await db.execute(sql`select record from acct_driver_transactions where company_id = ${companyId} and driver_id = ${driverId} and source = 'fuel_ledger' order by created_at`)) as unknown as Array<{ record: DriverTx }>).map((r) => r.record);
  const fuelLines = (s: StatementJson) => s.computation.deductions.filter((d) => d.kind === 'fuel');
  const loadUpdatedAt = async (id: string) => (((await db.select({ record: loads.record }).from(loads).where(eq(loads.id, id)))[0]!.record) as { updatedAt: string }).updatedAt;

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    state = app.get(StateService);

    const t = await call('POST', '/api/v1/trucks', { unitNumber: `PW-${tag}`.slice(0, 20), vin: `1PW${tag}`.replace(/[IOQ]/g, '0').padEnd(17, '8').slice(0, 17), year: 2022, make: 'E2E', model: 'PayWeek', odometer: 100_000, status: 'available' });
    expect(t.statusCode, t.body).toBe(201);
    truckId = (t.json() as { id: string }).id;
    const [anyDriver] = await db.select({ companyId: drivers.companyId }).from(drivers).limit(1);
    companyId = anyDriver?.companyId ?? 'co_northwind';
    await db.insert(drivers).values({ id: driverId, companyId, driverNumber: `E2E-PW-${tag}`, firstName: 'E2E', lastName: `PayWeek ${tag}`, phone: '5550000003', email: `e2e-pw-${tag}@example.test`.toLowerCase(), driverType: 'lease_operator', cdlState: 'IL', cdlClass: 'A', cdlExpiresOn: '2030-01-01', cdlStatus: 'missing', medicalCardStatus: 'missing', hireDate: shift(today, -120), status: 'active', dispatcherId: '', dispatcherName: '', currentTruckId: truckId, homeCity: 'Chicago', homeState: 'IL', payPlanKind: 'per_mile', payPlanRate: '1' });
    const s = (await call('GET', `${ACCT}/settings`)).json() as { version: number; settings: { payOnFundingOnly: boolean | null; payPeriodCutoffTime: string } };
    const put = await call('PUT', `${ACCT}/settings`, { expectedVersion: s.version, settings: { cutoffBasis: 'delivered_at', cutoffTimezoneConfirmed: true, payOnFundingOnly: s.settings.payOnFundingOnly ?? false, payPeriodCutoffTime: '12:00' } });
    expect(put.statusCode, put.body).toBeLessThan(300);

    // LO paid per mile, fuel deducted, nothing recurring, no escrow, no lease sheet.
    const acct = (await call('GET', `${ACCT}/drivers/${driverId}/account`)).json() as { profile: { version: number } };
    const saved = await call('PUT', `${ACCT}/drivers/${driverId}/profile`, { expectedVersion: acct.profile.version, effectiveFrom: shift(today, -120), contractType: 'LO', switches: { deductFuel: true, deductTolls: true, deductApprovedAdvances: true, recurringDeductions: false, escrowEnabled: false }, loadedPlan: { kind: 'per_mile', rate: 1 }, emptyPlan: { kind: 'none', rate: 0 }, escrow: { targetCents: 0, perSettlementCents: 0, openingBalanceCents: 0, openingReconciled: true }, lease: null, reason: 'e2e', openingDebtCents: 0, openingDebtReconciled: true, confirmRate: true });
    expect(saved.statusCode, saved.body).toBeLessThan(300);

    const loadRow = (id: string, n: string, deliveredAt: string) => ({ id, companyId, loadNumber: n, status: 'delivered', driverId, truckId, record: { id, loadNumber: n, status: 'delivered', driverId, truckId, deliveredAt, updatedAt: deliveredAt, rate: 2000, loadedMiles: 1000, emptyMiles: 0, documents: [], charges: [{ id: 'lh', type: 'linehaul', description: 'Linehaul', amount: 2000, billable: true }], stops: [{ kind: 'pickup', city: 'Chicago', state: 'IL' }, { kind: 'delivery', city: 'Dallas', state: 'TX' }] } });
    // L1: picked up Sunday, the facility closed, completed Monday 19:30 ET → week B by its real time.
    await db.insert(loads).values(loadRow(l1, `E2E-PW1-${tag}`, plusMin(noonZ(weekB), 7 * 60 + 30))).onConflictDoNothing();
    await db.insert(loads).values(loadRow(l2, `E2E-PW2-${tag}`, plusMin(noonZ(shift(weekA, 2)), 0))).onConflictDoNothing();

    // Two purchases in the Fleet › Fuel ledger, appended to whatever is there.
    const ledger = await state.getFor(companyId, FUEL_KEY);
    const rows = ledger ? (JSON.parse(ledger.value) as unknown[]) : [];
    const fill = (id: string, at: string, amount: number, gallons: number) => ({ id, truckId, unitNumber: `PW-${tag}`, driverId, driverName: 'E2E PayWeek', loadId: null, at, station: { brand: 'Pilot', name: 'Pilot #77', city: 'Joliet', state: 'IL' }, product: 'diesel', gallons, pricePerGallon: amount / gallons, amount, odometer: 0, cardLast4: '0000', anomalyFlags: [], status: 'verified' });
    rows.push(fill(f1, plusMin(noonZ(shift(weekA, 3)), 60), 300, 80), fill(f2, plusMin(noonZ(weekB), -60), 150.5, 40.2));
    await state.putFor(companyId, FUEL_KEY, JSON.stringify(rows));

    await generate(weekA);
    await generate(weekB);
  }, 180_000);

  afterAll(async () => {
    await db.update(loads).set({ status: 'cancelled' }).where(and(eq(loads.companyId, companyId), eq(loads.driverId, driverId)));
    const ledger = await state.getFor(companyId, FUEL_KEY);
    if (ledger) await state.putFor(companyId, FUEL_KEY, JSON.stringify((JSON.parse(ledger.value) as Array<{ id: string }>).filter((r) => r.id !== f1 && r.id !== f2)));
    await app.close();
  });

  it('each load is on the statement of the week it was delivered in, by the Monday-noon window', async () => {
    const a = await statement(stmA);
    const b = await statement(stmB);
    expect(a.startsAt).toBe(noonZ(weekA).replace(/\.\d{3}Z$/, '.000Z'));
    expect(a.cutoffAt).toBe(b.startsAt);
    expect(a.loadIds).toEqual([l2]);
    expect(b.loadIds).toEqual([l1]);
    // The statement PDF prints the real window.
    const pdf = await call('GET', `${ACCT}/settlements/${stmA}/pdf`);
    expect(pdf.statusCode).toBe(200);
    expect(pdf.rawPayload.subarray(0, 4).toString()).toBe('%PDF');
  });

  it('fuel bought in the week is deducted once - Monday 11:00 ET still counts for the ending week - and survives recompute', async () => {
    let a = await statement(stmA);
    const b = await statement(stmB);
    expect(fuelLines(a).map((d) => d.cents).sort()).toEqual([15_050, 30_000]);
    expect(fuelLines(a)[0]!.description).toMatch(/^Fuel · Pilot #77 · Joliet, IL · \d+(\.\d)? gal$/);
    expect(fuelLines(b)).toEqual([]);
    // Read again and regenerate: nothing is written twice.
    a = await statement(stmA);
    await generate(weekA);
    await generate(weekB);
    a = await statement(stmA);
    expect(fuelLines(a)).toHaveLength(2);
    expect(await fuelTxs()).toHaveLength(2);
  }, 120_000);

  it('the pay-date override moves a load into week A only; a stale save is a conflict; it is shown with who changed it', async () => {
    const stale = await call('POST', `${ACCT}/loads/${l1}/pay-date`, { at: plusMin(noonZ(weekB), -120), reason: 'Driver was at the facility Sunday', expectedUpdatedAt: '2000-01-01T00:00:00.000Z' });
    expect(stale.statusCode, stale.body).toBe(409);

    const moved = await call('POST', `${ACCT}/loads/${l1}/pay-date`, { at: plusMin(noonZ(weekB), -120), reason: 'Driver was at the facility Sunday', expectedUpdatedAt: await loadUpdatedAt(l1) });
    expect(moved.statusCode, moved.body).toBeLessThan(300);
    const pay = moved.json() as PayJson;
    expect(pay).toMatchObject({ source: 'override', period: { start: weekA }, override: { reason: 'Driver was at the facility Sunday' } });
    expect(pay.override!.byName).toBeTruthy();
    expect(pay.period!.label).toMatch(/^Mon \w{3} \d{1,2}, 12:00 PM – Mon \w{3} \d{1,2}, 12:00 PM ET$/);

    // One source of truth: on A, not on B - and regenerating either week keeps it that way.
    expect((await statement(stmA)).loadIds.sort()).toEqual([l1, l2].sort());
    expect((await statement(stmB)).loadIds).toEqual([]);
    await generate(weekB);
    await generate(weekA);
    expect((await statement(stmA)).loadIds.sort()).toEqual([l1, l2].sort());
    expect((await statement(stmB)).loadIds).not.toContain(l1);
    // The delivery facts are untouched.
    const rec = (await db.select({ record: loads.record }).from(loads).where(eq(loads.id, l1)))[0]!.record as { deliveredAt: string };
    expect(rec.deliveredAt).toBe(plusMin(noonZ(weekB), 7 * 60 + 30));
    const audit = (await db.execute(sql`select reason from audit_logs where company_id = ${companyId} and action = 'load_pay_date_set' and entity_id = ${l1}`)) as unknown as Array<{ reason: string }>;
    expect(audit.map((x) => x.reason)).toContain('Driver was at the facility Sunday');
  }, 120_000);

  it('a load taken off a draft is listed there, goes to next week’s draft, and Put back returns it in one click', async () => {
    const off = (await call('POST', `${ACCT}/settlements/${stmA}/loads/${l2}/remove`, { reason: 'POD not received yet' })).json() as Outcome;
    expect(off.ok, off.blocked).toBe(true);
    expect(off.statement.loadIds).not.toContain(l2);
    expect(off.statement.removedLoads).toEqual([expect.objectContaining({ loadId: l2, reason: 'POD not received yet' })]);
    expect(off.carriedTo).toBeTruthy();
    expect((await statement(stmB)).loadIds).toContain(l2);
    // Regenerating A does not bring it back; regenerating B keeps it there.
    await generate(weekA);
    await generate(weekB);
    expect((await statement(stmA)).loadIds).not.toContain(l2);
    expect((await statement(stmB)).loadIds).toContain(l2);

    const back = (await call('POST', `${ACCT}/settlements/${stmA}/loads/${l2}/put-back`, {})).json() as Outcome;
    expect(back.ok, back.blocked).toBe(true);
    expect(back.statement.loadIds).toContain(l2);
    expect(back.statement.removedLoads ?? []).toEqual([]);
    expect((await statement(stmB)).loadIds).not.toContain(l2);
    const audit = (await db.execute(sql`select action from audit_logs where company_id = ${companyId} and entity_id = ${stmA} and action in ('settlement_load_removed','settlement_load_put_back')`)) as unknown as Array<{ action: string }>;
    expect(audit.map((x) => x.action).sort()).toEqual(['settlement_load_put_back', 'settlement_load_removed']);
  }, 120_000);

  it('once week A is approved its loads cannot move; reopen gives the fuel back and it is deducted once again', async () => {
    const st = await statement(stmA);
    expect(st.exceptions, st.exceptions.join(' ')).toEqual([]);
    const approved = (await call('POST', `${ACCT}/settlements/${stmA}/approve`, {})).json() as Outcome;
    expect(approved.ok, approved.blocked).toBe(true);
    expect((await fuelTxs()).every((t) => t.settlementId === stmA && t.state === 'applied')).toBe(true);

    const refused = await call('POST', `${ACCT}/loads/${l1}/pay-date`, { at: null, reason: 'Back to the delivered time', expectedUpdatedAt: await loadUpdatedAt(l1) });
    expect(refused.statusCode).toBe(422);
    expect(refused.body).toContain('Reopen that statement first');
    // Week B never picks up what A paid, however it is regenerated.
    await generate(weekB);
    const b = await statement(stmB);
    expect(b.loadIds).not.toContain(l1);
    expect(b.loadIds).not.toContain(l2);
    expect(fuelLines(b)).toEqual([]);

    const reopened = (await call('POST', `${ACCT}/settlements/${stmA}/reopen`, { reason: 'e2e: check fuel comes back once' })).json() as Outcome;
    expect(reopened.ok, reopened.blocked).toBe(true);
    const again = await statement(stmA);
    expect(fuelLines(again)).toHaveLength(2);
    expect(await fuelTxs()).toHaveLength(2);
    expect((await fuelTxs()).every((t) => t.settlementId === null && t.state === 'approved' && t.recoveredCents === 0)).toBe(true);
  }, 120_000);
});
