import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DriverTx, JournalEntry, StatementComputation } from '@neway/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { loads } from '../src/database/schema/loads';
import { odometerReadings } from '../src/database/schema/pm';
import { truckDriverAssignments } from '../src/database/schema/fleet';
import { drivers } from '../src/database/schema/roster';
import { LedgerService } from '../src/modules/accounting/ledger.service';
import { SettlementsService, finalizedSourceKey } from '../src/modules/accounting/settlements.service';

const ACCT = '/api/v1/accounting';

type StatementJson = { id: string; settlementNumber: string; status: string; exceptions: string[]; computation: StatementComputation; approvedAt: string | null; approvedBy: string | null; snapshot: unknown; versions: unknown[]; netCents: number };
type Outcome = { ok: boolean; blocked?: string; statement: StatementJson };

/**
 * Reopening an approved statement (owner, 2026-10-21): approval is not final until the payment
 * is posted. Reopen undoes every effect of the approval - the ledger entry is reversed, the
 * recoveries given back, the week's deductions unapplied, the charges approval wrote voided -
 * and the statement is a draft again; approving it again posts once more, never twice. A paid
 * statement and a draft are refused.
 */
describe('Reopening an approved statement (e2e)', () => {
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
  const wednesday = (weeks: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - weeks * 7 - ((d.getUTCDay() + 4) % 7));
    return d.toISOString().slice(0, 10);
  };
  const day = wednesday(2);
  const driverId = `drv_e2e_reopen_${tag}`.toLowerCase();
  let truckId = '';
  let statementId = '';
  let chargeId = '';
  let recurringId = '';
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: payload === undefined ? {} : { 'content-type': 'application/json' }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const statement = async () => (await call('GET', `${ACCT}/settlements/${statementId}`)).json() as StatementJson;
  const tx = async (id: string) => ((await db.execute(sql`select record from acct_driver_transactions where company_id = ${companyId} and id = ${id}`)) as unknown as Array<{ record: DriverTx }>)[0]!.record;
  const txsOf = async () => ((await db.execute(sql`select id, record from acct_driver_transactions where company_id = ${companyId} and driver_id = ${driverId} order by created_at`)) as unknown as Array<{ id: string; record: DriverTx }>).map((r) => r.record);
  /** Every entry that references this statement: its approvals and their reversals, in posting order. */
  const entries = async () => ((await db.execute(sql`select record from acct_journal_entries where company_id = ${companyId} and record->'reference'->>'id' = ${statementId} and source_key not like 'settlement_paid:%' order by posted_at, id`)) as unknown as Array<{ record: JournalEntry & { reversalOf?: string | null } }>).map((r) => r.record);
  /** Debits less credits per account over a set of entries. */
  const netByAccount = (rows: JournalEntry[]) => {
    const out: Record<string, number> = {};
    for (const e of rows) for (const l of e.lines) out[l.accountCode] = (out[l.accountCode] ?? 0) + (l.debit ?? 0) - (l.credit ?? 0);
    return out;
  };
  const chargedCents = async () => Number(((await db.execute(sql`select record->>'chargedCents' as c from acct_recurring_deductions where company_id = ${companyId} and id = ${recurringId}`)) as unknown as Array<{ c: string | null }>)[0]?.c ?? 0);

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    // One clock for the whole run: approval, reversal and audit times do not drift between calls.
    const fixed = new Date();
    app.get(SettlementsService).clock = () => fixed;
    app.get(LedgerService).clock = () => fixed;

    const t = await call('POST', '/api/v1/trucks', { unitNumber: `RO-${tag}`.slice(0, 20), vin: `1RO${tag}`.replace(/[IOQ]/g, '0').padEnd(17, '7').slice(0, 17), year: 2021, make: 'E2E', model: 'Reopen', odometer: 120_000, status: 'available' });
    expect(t.statusCode, t.body).toBe(201);
    truckId = (t.json() as { id: string }).id;
    const [anyDriver] = await db.select({ companyId: drivers.companyId }).from(drivers).limit(1);
    companyId = anyDriver?.companyId ?? 'co_northwind';
    await db.insert(drivers).values({ id: driverId, companyId, driverNumber: `E2E-RO-${tag}`, firstName: 'E2E', lastName: `Reopen ${tag}`, phone: '5550000002', email: `e2e-ro-${tag}@example.test`.toLowerCase(), driverType: 'lease_operator', cdlState: 'IL', cdlClass: 'A', cdlExpiresOn: '2030-01-01', cdlStatus: 'missing', medicalCardStatus: 'missing', hireDate: shift(today, -60), status: 'active', dispatcherId: '', dispatcherName: '', currentTruckId: truckId, homeCity: 'Chicago', homeState: 'IL', payPlanKind: 'lease_owner', payPlanRate: '0' });
    // Lease charges are taken only while the driver has a truck assigned (owner, 2026-10-22).
    await db.insert(truckDriverAssignments).values({ id: `tda_e2e_ro_${tag}`.toLowerCase(), companyId, truckId, driverId, assignedOn: shift(today, -60), source: 'truck_page' });
    const s = (await call('GET', `${ACCT}/settings`)).json() as { version: number; settings: { cutoffBasis: string | null; cutoffTimezoneConfirmed: boolean | null; payOnFundingOnly: boolean | null } };
    await call('PUT', `${ACCT}/settings`, { expectedVersion: s.version, settings: { cutoffBasis: s.settings.cutoffBasis ?? 'delivered_at', cutoffTimezoneConfirmed: true, payOnFundingOnly: s.settings.payOnFundingOnly ?? false } });

    // The profile saved as it comes (lease sheet, recurring deductions on, opening debt reconciled).
    const acct = (await call('GET', `${ACCT}/drivers/${driverId}/account`)).json() as { profile: { version: number; current: Record<string, unknown> } };
    const cur = acct.profile.current as { contractType: string; switches: object; loadedPlan: unknown; emptyPlan: unknown; escrow: unknown; lease: unknown };
    const saved = await call('PUT', `${ACCT}/drivers/${driverId}/profile`, { expectedVersion: acct.profile.version, effectiveFrom: shift(today, -90), contractType: cur.contractType, switches: { ...cur.switches, recurringDeductions: true, deductApprovedAdvances: true }, loadedPlan: cur.loadedPlan, emptyPlan: cur.emptyPlan, escrow: cur.escrow, lease: cur.lease, reason: 'e2e', openingDebtCents: 0, openingDebtReconciled: true });
    expect(saved.statusCode, saved.body).toBeLessThan(300);
    // A charge from before the week, repaid in two installments: this statement recovers half.
    const charge = await call('POST', `${ACCT}/drivers/${driverId}/charges`, { kind: 'manual_charge', amountCents: 40_000, onDate: shift(day, -30), description: `Cracked mirror ${tag}`, reason: 'e2e', installments: 2 });
    expect(charge.statusCode, charge.body).toBeLessThan(300);
    chargeId = (charge.json() as { id: string }).id;
    // A recurring deduction approval writes a transaction for, and counts on the plan.
    const rec = await call('POST', `${ACCT}/drivers/${driverId}/recurring`, { category: 'other', label: `weekly e2e ${tag}`, cadence: 'weekly', amountCents: 50_000, startsOn: shift(day, -30), endsOn: null, appliesWhenNoWork: true, totalCents: null, status: 'active', overrides: [] });
    expect(rec.statusCode, rec.body).toBeLessThan(300);
    recurringId = (rec.json() as { id: string }).id;

    const reading = (date: string, miles: number) => ({ id: `odo_e2e_ro_${tag}_${date}`.toLowerCase(), companyId, unitId: truckId, readingAt: new Date(`${date}T16:00:00Z`), readingDate: date, odometerMiles: miles, source: 'eld', status: 'ok', createdBy: 'e2e', createdByName: 'e2e' });
    await db.insert(odometerReadings).values([reading(shift(day, -4), 120_000), reading(shift(day, 2), 122_000)]).onConflictDoNothing();
    const loadId = `lod_e2e_ro_${tag}`.toLowerCase();
    const deliveredAt = `${day}T15:00:00.000Z`;
    await db.insert(loads).values({ id: loadId, companyId, loadNumber: `E2E-RO-${tag}`, status: 'delivered', driverId, truckId, record: { id: loadId, loadNumber: `E2E-RO-${tag}`, status: 'delivered', driverId, truckId, deliveredAt, updatedAt: deliveredAt, rate: 5000, documents: [], charges: [{ id: 'lh', type: 'linehaul', description: 'Linehaul', amount: 5000, billable: true }], stops: [{ kind: 'pickup', city: 'Chicago', state: 'IL' }, { kind: 'delivery', city: 'Dallas', state: 'TX' }] } }).onConflictDoNothing();
    const gen = await call('POST', `${ACCT}/settlements/generate`, { kind: 'lo_oo', weekOf: day });
    expect(gen.statusCode, gen.body).toBeLessThan(300);
    const all = (await call('GET', `${ACCT}/settlements`)).json() as Array<{ id: string; partyId: string; periodStart: string; periodEnd: string }>;
    statementId = all.find((s) => s.partyId === driverId && s.periodStart <= day && s.periodEnd >= day)!.id;
  }, 120_000);

  afterAll(async () => {
    await db.update(loads).set({ status: 'cancelled' }).where(and(eq(loads.companyId, companyId), eq(loads.driverId, driverId)));
    await db.delete(odometerReadings).where(and(eq(odometerReadings.companyId, companyId), eq(odometerReadings.unitId, truckId)));
    await app.close();
  });

  it('a draft cannot be reopened', async () => {
    const st = await statement();
    expect(st.exceptions, st.exceptions.join(' ')).toEqual([]);
    expect(st.status).toBe('draft');
    const r = await call('POST', `${ACCT}/settlements/${statementId}/reopen`, { reason: 'too early' });
    expect(r.statusCode, r.body).toBeLessThan(300);
    expect(r.json() as Outcome).toMatchObject({ ok: false, blocked: expect.stringContaining('only an approved statement is reopened') });
    // A reason shorter than three characters is refused by validation.
    expect((await call('POST', `${ACCT}/settlements/${statementId}/reopen`, { reason: 'x' })).statusCode).toBe(422);
  });

  it('approve, then reopen: the ledger nets to zero, the account is as it was, the statement is a draft again', async () => {
    const approved = (await call('POST', `${ACCT}/settlements/${statementId}/approve`, {})).json() as Outcome;
    expect(approved.ok, approved.blocked).toBe(true);
    expect(approved.statement.status).toBe('approved');
    const comp = approved.statement.computation;
    expect(comp.recoveries).toEqual([{ txId: chargeId, cents: 20_000 }]);
    expect(comp.recurringCharges.map((r) => r.deductionId)).toContain(recurringId);
    const leaseCount = (comp.leaseCharges ?? []).length;
    expect(leaseCount).toBeGreaterThan(0);

    // What approval wrote.
    const chargeAfter = await tx(chargeId);
    expect(chargeAfter).toMatchObject({ recoveredCents: 20_000, state: 'approved', installments: { total: 2, remaining: 1 } });
    expect(chargeAfter.recoveryLog).toEqual([expect.objectContaining({ settlementId: statementId, cents: 20_000 })]);
    const writtenBefore = (await txsOf()).filter((t) => t.settlementId === statementId && t.state !== 'void');
    expect(writtenBefore.filter((t) => t.source === 'settlement' && t.kind === 'recurring')).toHaveLength(1);
    expect(writtenBefore.filter((t) => t.source === 'lease')).toHaveLength(leaseCount);
    expect(await chargedCents()).toBe(50_000);
    const [finalized] = await entries();
    expect(finalized?.sourceKey).toBe(finalizedSourceKey(statementId, 1));

    // Reopen.
    const reopened = (await call('POST', `${ACCT}/settlements/${statementId}/reopen`, { reason: 'Fuel from Tuesday was missing' })).json() as Outcome;
    expect(reopened.ok, reopened.blocked).toBe(true);
    expect(reopened.statement).toMatchObject({ status: 'draft', approvedAt: null, approvedBy: null, snapshot: null });
    expect(reopened.statement.versions).toHaveLength(1); // the approval stays in the history
    const st = await statement();
    expect(st.status).toBe('draft');
    expect(st.netCents).toBe(approved.statement.netCents);

    // The ledger: the entry stands, mirrored by a reversal that links back; net effect zero.
    const after = await entries();
    expect(after).toHaveLength(2);
    const reversal = after.find((e) => e.reversalOf === finalized!.id)!;
    expect(reversal).toBeDefined();
    expect(reversal.memo).toContain('reopened: Fuel from Tuesday was missing');
    const net = netByAccount(after);
    for (const code of Object.keys(net)) expect(net[code], code).toBe(0);

    // The driver's account: the recovery given back, the charge whole again, the written rows voided with the reason, the plan's total back.
    const chargeBack = await tx(chargeId);
    expect(chargeBack).toMatchObject({ recoveredCents: 0, state: 'approved', installments: { total: 2, remaining: 2 } });
    expect(chargeBack.recoveryLog).toEqual([expect.objectContaining({ settlementId: statementId, cents: 20_000, reversedAt: expect.any(String), reason: 'Fuel from Tuesday was missing' })]);
    const rows = await txsOf();
    const stillApplied = rows.filter((t) => t.settlementId === statementId && t.state !== 'void');
    expect(stillApplied).toEqual([]);
    const voided = rows.filter((t) => t.settlementId === statementId && t.state === 'void');
    expect(voided).toHaveLength(writtenBefore.length);
    expect(voided.every((t) => t.reason?.includes('reopened: Fuel from Tuesday was missing'))).toBe(true);
    expect(await chargedCents()).toBe(0);

    // Audited, with the reason.
    const audit = (await db.execute(sql`select reason, summary from audit_logs where company_id = ${companyId} and action = 'settlement_reopened' and entity_id = ${statementId}`)) as unknown as Array<{ reason: string | null; summary: string }>;
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ reason: 'Fuel from Tuesday was missing', summary: expect.stringContaining(`reversed by ${reversal.id}`) });
  }, 120_000);

  it('approved again: posts once more under its own key, revives the voided rows, and nothing is taken twice', async () => {
    const again = (await call('POST', `${ACCT}/settlements/${statementId}/approve`, {})).json() as Outcome;
    expect(again.ok, again.blocked).toBe(true);
    expect(again.statement.versions).toHaveLength(2);
    const all = await entries();
    expect(all.map((e) => e.sourceKey).filter((k) => k.startsWith('settlement_finalized:'))).toEqual([finalizedSourceKey(statementId, 1), finalizedSourceKey(statementId, 2)]);
    const net = netByAccount(all);
    // Three entries: v1, its reversal, v2 - the books carry exactly one approval.
    const v2 = all.find((e) => e.sourceKey === finalizedSourceKey(statementId, 2))!;
    expect(net).toEqual(netByAccount([v2]));

    const charge = await tx(chargeId);
    expect(charge).toMatchObject({ recoveredCents: 20_000, installments: { total: 2, remaining: 1 } });
    expect((charge.recoveryLog ?? []).filter((l) => !l.reversedAt)).toHaveLength(1);
    const rows = await txsOf();
    const live = rows.filter((t) => t.settlementId === statementId && t.state !== 'void');
    expect(rows.filter((t) => t.settlementId === statementId && t.state === 'void')).toEqual([]); // revived, not written beside
    expect(live.filter((t) => t.source === 'settlement' && t.kind === 'recurring')).toHaveLength(1);
    expect(await chargedCents()).toBe(50_000);
  }, 120_000);

  it('once paid, reopening is refused: the correction goes on next week', async () => {
    const paid = (await call('POST', `${ACCT}/settlements/${statementId}/paid`, { paidOn: today, reference: `ACH-${tag}`, method: 'ach' })).json() as Outcome;
    expect(paid.ok, paid.blocked).toBe(true);
    const r = (await call('POST', `${ACCT}/settlements/${statementId}/reopen`, { reason: 'changed my mind' })).json() as Outcome;
    expect(r.ok).toBe(false);
    expect(r.blocked).toBe(`${paid.statement.settlementNumber} is already paid; a correction goes on next week's statement.`);
    expect((await statement()).status).toBe('paid');
  });
});
