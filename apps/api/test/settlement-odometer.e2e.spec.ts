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

type StatementJson = { id: string; settlementNumber: string; status: string; exceptions: string[]; computation: StatementComputation };
type OdometerEntry = { statement: StatementJson; readings: Array<{ end: 'start' | 'end'; readingAt: string; odometerMiles: number; status: string; conflictReason: string | null }> };

/**
 * The odometer typed in from a statement (owner, 2026-10-21): a lease driver whose truck has no
 * ELD readings is told the maintenance fee cannot be figured; Accounting enters the odometer at
 * both ends of the week and the statement recomputes with the fee and the lease tier on it.
 */
describe('Manual odometer on a lease statement (e2e)', () => {
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
  const driverId = `drv_e2e_odo_${tag}`.toLowerCase();
  let truckId = '';
  let statementId = '';
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: payload === undefined ? {} : { 'content-type': 'application/json' }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const leaseLines = (c: StatementComputation) => Object.fromEntries(c.deductions.filter((d) => d.kind === 'lease').map((d) => [d.description.replace(/ \(.*\)$/, ''), d.cents]));

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    const t = await call('POST', '/api/v1/trucks', { unitNumber: `OD-${tag}`.slice(0, 20), vin: `1OD${tag}`.replace(/[IOQ]/g, '0').padEnd(17, '7').slice(0, 17), year: 2021, make: 'E2E', model: 'Odometer', odometer: 120_000, status: 'available' });
    expect(t.statusCode, t.body).toBe(201);
    truckId = (t.json() as { id: string }).id;
    const [anyDriver] = await db.select({ companyId: drivers.companyId }).from(drivers).limit(1);
    companyId = anyDriver?.companyId ?? 'co_northwind';
    await db.insert(drivers).values({ id: driverId, companyId, driverNumber: `E2E-OD-${tag}`, firstName: 'E2E', lastName: `Odometer ${tag}`, phone: '5550000001', email: `e2e-od-${tag}@example.test`.toLowerCase(), driverType: 'lease_operator', cdlState: 'IL', cdlClass: 'A', cdlExpiresOn: '2030-01-01', cdlStatus: 'missing', medicalCardStatus: 'missing', hireDate: shift(today, -60), status: 'active', dispatcherId: '', dispatcherName: '', currentTruckId: truckId, homeCity: 'Chicago', homeState: 'IL', payPlanKind: 'lease_owner', payPlanRate: '0' });
    // Lease charges are taken only while the driver has a truck assigned (owner, 2026-10-22).
    await db.insert(truckDriverAssignments).values({ id: `tda_e2e_od_${tag}`.toLowerCase(), companyId, truckId, driverId, assignedOn: shift(today, -60), source: 'truck_page' });
    const s = (await call('GET', `${ACCT}/settings`)).json() as { version: number; settings: { cutoffBasis: string | null; cutoffTimezoneConfirmed: boolean | null } };
    if (s.settings.cutoffBasis === null || s.settings.cutoffTimezoneConfirmed !== true) {
      await call('PUT', `${ACCT}/settings`, { expectedVersion: s.version, settings: { cutoffBasis: s.settings.cutoffBasis ?? 'delivered_at', cutoffTimezoneConfirmed: true } });
    }
    // One delivered load two weeks back; the truck has no odometer readings at all.
    const day = wednesday(2);
    const loadId = `lod_e2e_odo_${tag}`.toLowerCase();
    const deliveredAt = `${day}T15:00:00.000Z`;
    await db.insert(loads).values({ id: loadId, companyId, loadNumber: `E2E-OD-${tag}`, status: 'delivered', driverId, truckId, record: { id: loadId, loadNumber: `E2E-OD-${tag}`, status: 'delivered', driverId, truckId, deliveredAt, updatedAt: deliveredAt, rate: 5000, documents: [], charges: [{ id: 'lh', type: 'linehaul', description: 'Linehaul', amount: 5000, billable: true }], stops: [{ kind: 'pickup', city: 'Chicago', state: 'IL' }, { kind: 'delivery', city: 'Dallas', state: 'TX' }] } }).onConflictDoNothing();
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

  it('without readings the statement says the fee cannot be figured and carries no maintenance fee', async () => {
    const st = (await call('GET', `${ACCT}/settlements/${statementId}`)).json() as StatementJson;
    expect(st.exceptions.some((e) => /No odometer readings for unit .* at both ends of the week/.test(e))).toBe(true);
    expect(st.exceptions.some((e) => /No odometer reading for unit .* the tractor lease tier/.test(e))).toBe(true);
    const by = leaseLines(st.computation);
    expect(by['Maintenance fee']).toBeUndefined();
    expect(by['Tractor lease · tier 1']).toBeUndefined();
    expect(st.status).toBe('review');
  });

  it('refuses an empty entry', async () => {
    const r = await call('POST', `${ACCT}/settlements/${statementId}/odometer`, { note: 'nothing typed' });
    expect(r.statusCode, r.body).toBe(422);
  });

  it('entering the odometer at both ends saves manual readings, and the statement recomputes with the fee and the tier', async () => {
    const r = await call('POST', `${ACCT}/settlements/${statementId}/odometer`, { startMiles: 120_000, endMiles: 122_000, note: 'from the dash photo' });
    expect(r.statusCode, r.body).toBeLessThan(300);
    const out = r.json() as OdometerEntry;
    expect(out.readings.map((x) => [x.end, x.odometerMiles, x.status])).toEqual([['start', 120_000, 'ok'], ['end', 122_000, 'ok']]);
    const by = leaseLines(out.statement.computation);
    expect(by['Maintenance fee']).toBe(2_000 * 13);
    expect(by['Tractor lease · tier 1']).toBe(115_000);
    expect(out.statement.exceptions.some((e) => /odometer/i.test(e))).toBe(false);

    // The readings are the truck's, source manual, dated the day before the week and its last day.
    const rows = await db.select().from(odometerReadings).where(and(eq(odometerReadings.companyId, companyId), eq(odometerReadings.unitId, truckId)));
    expect(rows).toHaveLength(2);
    expect(rows.every((x) => x.source === 'manual' && x.status === 'ok' && x.note?.includes(out.statement.settlementNumber) && x.note?.includes('from the dash photo'))).toBe(true);
    const st = (await call('GET', `${ACCT}/settlements/${statementId}`)).json() as StatementJson & { periodStart: string; periodEnd: string };
    const dates = rows.map((x) => x.readingDate).sort();
    expect(dates).toEqual([shift(st.periodStart, -1), st.periodEnd]);

    // Read again and listed: the saved draft carries the recomputed figures, not the old warning.
    expect(leaseLines(st.computation)['Maintenance fee']).toBe(26_000);
    expect(st.exceptions.some((e) => /odometer/i.test(e))).toBe(false);
    const listed = ((await call('GET', `${ACCT}/settlements`)).json() as StatementJson[]).find((s) => s.id === statementId)!;
    expect(listed.exceptions.some((e) => /odometer/i.test(e))).toBe(false);
  });

  it('a figure below an earlier reading follows the PM rule: kept as a conflict, never used', async () => {
    const r = await call('POST', `${ACCT}/settlements/${statementId}/odometer`, { endMiles: 121_000 });
    expect(r.statusCode, r.body).toBeLessThan(300);
    const out = r.json() as OdometerEntry;
    expect(out.readings[0]!.status).toBe('conflict');
    expect(out.readings[0]!.conflictReason).toBe('below_previous');
    // The statement still stands on the good 122,000 reading.
    expect(leaseLines(out.statement.computation)['Maintenance fee']).toBe(26_000);
  });
});
