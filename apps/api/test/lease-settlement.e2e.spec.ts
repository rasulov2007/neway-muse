import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { StatementComputation } from '@neway/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { loads } from '../src/database/schema/loads';
import { odometerReadings } from '../src/database/schema/pm';
import { truckDriverAssignments } from '../src/database/schema/fleet';
import { drivers } from '../src/database/schema/roster';

const ACCT = '/api/v1/accounting';

/**
 * Lease owner settlements (owner's Rent/Lease Contractor sheet, 2026-10-12): a driver on the
 * Lease owner pay plan is ready without set-up - gross less the tractor lease by odometer tier,
 * the maintenance fee per mile (higher past 130,000), the dispatch fee and the weekly charges.
 */
describe('Lease owner settlement (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let companyId = '';
  const tag = Date.now().toString(36).toUpperCase();
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const wednesday = (weeks: number) => {
    const d = new Date(`${today}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() - weeks * 7 - ((d.getUTCDay() + 4) % 7));
    return d.toISOString().slice(0, 10);
  };
  const shift = (day: string, n: number) => {
    const d = new Date(`${day}T12:00:00Z`);
    d.setUTCDate(d.getUTCDate() + n);
    return d.toISOString().slice(0, 10);
  };
  const driverId = `drv_e2e_lease_${tag}`.toLowerCase();
  let truckId = '';
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: payload === undefined ? {} : { 'content-type': 'application/json' }, ...(payload === undefined ? {} : { payload: payload as object }) });

  async function week(day: string, odo: { before: number; end: number }) {
    const reading = (date: string, miles: number) => ({ id: `odo_e2e_${tag}_${date}`.toLowerCase(), companyId, unitId: truckId, readingAt: new Date(`${date}T16:00:00Z`), readingDate: date, odometerMiles: miles, source: 'eld', status: 'ok', createdBy: 'e2e', createdByName: 'e2e' });
    await db.insert(odometerReadings).values([reading(shift(day, -4), odo.before), reading(shift(day, 2), odo.end)]).onConflictDoNothing();
    const loadId = `lod_e2e_lease_${tag}_${day}`.toLowerCase();
    const deliveredAt = `${day}T15:00:00.000Z`;
    await db.insert(loads).values({ id: loadId, companyId, loadNumber: `E2E-LS-${tag}-${day}`, status: 'delivered', driverId, truckId, record: { id: loadId, loadNumber: `E2E-LS-${tag}-${day}`, status: 'delivered', driverId, truckId, deliveredAt, updatedAt: deliveredAt, rate: 5000, documents: [], charges: [{ id: 'lh', type: 'linehaul', description: 'Linehaul', amount: 5000, billable: true }], stops: [{ kind: 'pickup', city: 'Chicago', state: 'IL' }, { kind: 'delivery', city: 'Dallas', state: 'TX' }] } }).onConflictDoNothing();
    const gen = await call('POST', `${ACCT}/settlements/generate`, { kind: 'lo_oo', weekOf: day });
    expect(gen.statusCode, gen.body).toBeLessThan(300);
    const all = (await call('GET', `${ACCT}/settlements`)).json() as Array<{ id: string; partyId: string; periodStart: string; periodEnd: string }>;
    const mine = all.find((s) => s.partyId === driverId && s.periodStart <= day && s.periodEnd >= day)!;
    return (await call('GET', `${ACCT}/settlements/${mine.id}`)).json() as { computation: StatementComputation; netCents: number };
  }

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    const t = await call('POST', '/api/v1/trucks', { unitNumber: `LS-${tag}`.slice(0, 20), vin: `1LS${tag}`.replace(/[IOQ]/g, '0').padEnd(17, '7').slice(0, 17), year: 2021, make: 'E2E', model: 'Lease', odometer: 120_000, status: 'available' });
    expect(t.statusCode, t.body).toBe(201);
    truckId = (t.json() as { id: string }).id;
    const [anyDriver] = await db.select({ companyId: drivers.companyId }).from(drivers).limit(1);
    companyId = anyDriver?.companyId ?? 'co_northwind';
    await db.insert(drivers).values({ id: driverId, companyId, driverNumber: `E2E-LS-${tag}`, firstName: 'E2E', lastName: `Lease ${tag}`, phone: '5550000000', email: `e2e-ls-${tag}@example.test`.toLowerCase(), driverType: 'lease_operator', cdlState: 'IL', cdlClass: 'A', cdlExpiresOn: '2030-01-01', cdlStatus: 'missing', medicalCardStatus: 'missing', hireDate: shift(today, -60), status: 'active', dispatcherId: '', dispatcherName: '', currentTruckId: truckId, homeCity: 'Chicago', homeState: 'IL', payPlanKind: 'lease_owner', payPlanRate: '0' });
    // Lease charges are taken only while the driver has a truck assigned (owner, 2026-10-22).
    await db.insert(truckDriverAssignments).values({ id: `tda_e2e_ls_${tag}`.toLowerCase(), companyId, truckId, driverId, assignedOn: shift(today, -60), source: 'truck_page' });
    const s = (await call('GET', `${ACCT}/settings`)).json() as { version: number; settings: { cutoffBasis: string | null; cutoffTimezoneConfirmed: boolean | null } };
    if (s.settings.cutoffBasis === null || s.settings.cutoffTimezoneConfirmed !== true) {
      await call('PUT', `${ACCT}/settings`, { expectedVersion: s.version, settings: { cutoffBasis: s.settings.cutoffBasis ?? 'delivered_at', cutoffTimezoneConfirmed: true } });
    }
  }, 120_000);

  afterAll(async () => {
    await db.update(loads).set({ status: 'cancelled' }).where(and(eq(loads.companyId, companyId), eq(loads.driverId, driverId)));
    await app.close();
  });

  it('a lease owner is ready without set-up: gross $5,000 less tier 1 lease, $0.13/mi, 20% dispatch and the weekly charges', async () => {
    const acct = (await call('GET', `${ACCT}/drivers/${driverId}/account`)).json() as { profile: { current: { contractType: string; lease: { kind: string } | null; loadedPlan: { kind: string; rate: number } } } };
    expect(acct.profile.current).toMatchObject({ contractType: 'LO', lease: { kind: 'lease_owner' }, loadedPlan: { kind: 'percent_of_gross', rate: 100 } });
    const st = await week(wednesday(2), { before: 120_000, end: 122_000 });
    const by = Object.fromEntries(st.computation.deductions.filter((d) => d.kind === 'lease').map((d) => [d.description.replace(/ \(.*\)$/, ''), d.cents]));
    expect(st.computation.grossCents).toBe(500_000);
    expect(by['Tractor lease · tier 1']).toBe(115_000);
    expect(by['Maintenance fee']).toBe(2_000 * 13);
    expect(by['Dispatch fee']).toBe(100_000);
    expect(by['Trailer rent']).toBe(22_000);
    expect(by['IFTA']).toBe(3_500);
  });

  it('past 130,000 miles the maintenance fee is $0.20 a mile; past 200,000 the lease drops a tier', async () => {
    const st = await week(wednesday(1), { before: 199_000, end: 201_000 });
    const by = Object.fromEntries(st.computation.deductions.filter((d) => d.kind === 'lease').map((d) => [d.description.replace(/ \(.*\)$/, ''), d.cents]));
    expect(by['Maintenance fee']).toBe(2_000 * 20);
    expect(by['Tractor lease · tier 2']).toBe(105_000);
  });

  it('skips or changes a lease charge for one week, and skips, edits and stops a recurring deduction (owner, 2026-10-20)', async () => {
    // A saved profile (the default lease sheet, saved as it is).
    const acct = (await call('GET', `${ACCT}/drivers/${driverId}/account`)).json() as { profile: { version: number; current: Record<string, unknown> } };
    const cur = acct.profile.current as { contractType: string; switches: unknown; loadedPlan: unknown; emptyPlan: unknown; escrow: unknown; lease: unknown };
    const day = wednesday(3);
    const periodStart = shift(day, -((new Date(`${day}T12:00:00Z`).getUTCDay() + 6) % 7));
    const saved = await call('PUT', `${ACCT}/drivers/${driverId}/profile`, { expectedVersion: acct.profile.version, effectiveFrom: shift(today, -90), contractType: cur.contractType, switches: { ...(cur.switches as object), recurringDeductions: true }, loadedPlan: cur.loadedPlan, emptyPlan: cur.emptyPlan, escrow: cur.escrow, lease: cur.lease, reason: 'e2e', openingDebtCents: 0, openingDebtReconciled: true });
    expect(saved.statusCode, saved.body).toBeLessThan(300);

    const before = await week(day, { before: 120_000, end: 121_000 });
    const tractor = before.computation.deductions.find((d) => d.ref === 'tractor_lease')!;
    expect(tractor.cents).toBe(115_000);
    const period = (before.computation as unknown as { period?: { start: string } }).period?.start ?? periodStart;

    // Skip the tractor lease this week: off the statement, on the skipped list, net up by $1,150.
    const skip = await call('POST', `${ACCT}/drivers/${driverId}/lease-week`, { periodStart: period, code: 'tractor_lease', cents: 0, reason: 'truck in the shop' });
    expect(skip.statusCode, skip.body).toBeLessThan(300);
    const skipped = await week(day, { before: 120_000, end: 121_000 });
    expect(skipped.computation.deductions.some((d) => d.ref === 'tractor_lease')).toBe(false);
    expect(skipped.computation.skipped).toEqual([expect.objectContaining({ kind: 'lease', ref: 'tractor_lease', cents: 115_000 })]);
    expect(skipped.netCents - before.netCents).toBe(115_000);

    // Change it for the week instead, then put it back.
    await call('POST', `${ACCT}/drivers/${driverId}/lease-week`, { periodStart: period, code: 'tractor_lease', cents: 50_000, reason: 'half week' });
    expect((await week(day, { before: 120_000, end: 121_000 })).computation.deductions.find((d) => d.ref === 'tractor_lease')?.cents).toBe(50_000);
    await call('POST', `${ACCT}/drivers/${driverId}/lease-week`, { periodStart: period, code: 'tractor_lease', cents: null, reason: 'put back' });
    expect((await week(day, { before: 120_000, end: 121_000 })).computation.deductions.find((d) => d.ref === 'tractor_lease')?.cents).toBe(115_000);

    // A recurring deduction: skipped this week, edited from now on, then stopped (never deleted).
    const rec = await call('POST', `${ACCT}/drivers/${driverId}/recurring`, { category: 'other', label: 'weekly e2e', cadence: 'weekly', amountCents: 50_000, startsOn: shift(day, -30), endsOn: null, appliesWhenNoWork: true, totalCents: null, status: 'active', overrides: [] });
    expect(rec.statusCode, rec.body).toBeLessThan(300);
    const recId = (rec.json() as { id: string }).id;
    expect((await week(day, { before: 120_000, end: 121_000 })).computation.deductions.find((d) => d.ref === recId)?.cents).toBe(50_000);
    await call('POST', `${ACCT}/drivers/${driverId}/recurring/${recId}/week`, { periodStart: period, cents: 0, reason: 'driver on vacation' });
    const recSkipped = await week(day, { before: 120_000, end: 121_000 });
    expect(recSkipped.computation.deductions.some((d) => d.ref === recId)).toBe(false);
    expect(recSkipped.computation.skipped).toEqual(expect.arrayContaining([expect.objectContaining({ kind: 'recurring', ref: recId, cents: 50_000 })]));
    await call('POST', `${ACCT}/drivers/${driverId}/recurring/${recId}/week`, { periodStart: period, cents: null, reason: 'put back' });
    const amount = await call('POST', `${ACCT}/drivers/${driverId}/recurring/${recId}/amount`, { amountCents: 40_000, reason: 'new agreement' });
    expect(amount.statusCode, amount.body).toBeLessThan(300);
    expect((await week(day, { before: 120_000, end: 121_000 })).computation.deductions.find((d) => d.ref === recId)?.cents).toBe(40_000);
    const stop = await call('POST', `${ACCT}/drivers/${driverId}/recurring/${recId}/stop`, { reason: 'agreement ended' });
    expect(stop.statusCode, stop.body).toBeLessThan(300);
    expect((await week(day, { before: 120_000, end: 121_000 })).computation.deductions.some((d) => d.ref === recId)).toBe(false);
    const list = (await call('GET', `${ACCT}/drivers/${driverId}/account`)).json() as { recurring: Array<{ id: string; status: string }> };
    expect(list.recurring.find((r) => r.id === recId)?.status).toBe('cancelled');
  }, 120_000);
});
