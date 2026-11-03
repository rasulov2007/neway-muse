import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { NO_TRUCK_LEASE_NOTE, type StatementComputation } from '@neway/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { truckDriverAssignments } from '../src/database/schema/fleet';
import { loads } from '../src/database/schema/loads';
import { odometerReadings } from '../src/database/schema/pm';
import { drivers } from '../src/database/schema/roster';

const ACCT = '/api/v1/accounting';

type Listed = { id: string; partyId: string; periodStart: string; periodEnd: string; batchId: string; status: string; netCents: number; payableCents: number; carryCents: number; computation: StatementComputation };

/**
 * Owner, 2026-10-22:
 *  1. The week list never shows a stale draft: an odometer typo inflated a lease maintenance fee
 *     on a draft; once the reading is voided the list shows the corrected money without anybody
 *     pressing "Update draft statements".
 *  2. Lease charges are taken only for a week the driver had a truck assigned.
 *  3. A typed odometer far above the last reading is kept as a conflict and the save says so.
 */
describe('Fresh drafts, lease only with a truck, odometer jump guard (e2e)', () => {
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
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: payload === undefined ? {} : { 'content-type': 'application/json' }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const leaseLines = (c: StatementComputation) => Object.fromEntries(c.deductions.filter((d) => d.kind === 'lease').map((d) => [d.ref ?? d.description, d.cents]));
  const created: Array<{ driverId: string; truckId: string }> = [];

  async function truck(code: string): Promise<string> {
    const t = await call('POST', '/api/v1/trucks', { unitNumber: `${code}-${tag}`.slice(0, 20), vin: `1${code}${tag}`.replace(/[IOQ]/g, '0').padEnd(17, '7').slice(0, 17), year: 2021, make: 'E2E', model: 'Fresh', odometer: 100_000, status: 'available' });
    expect(t.statusCode, t.body).toBe(201);
    return (t.json() as { id: string }).id;
  }
  async function leaseDriver(code: string, truckId: string, assignment: { on: string; ended: string | null } | null): Promise<string> {
    const driverId = `drv_e2e_${code}_${tag}`.toLowerCase();
    await db.insert(drivers).values({ id: driverId, companyId, driverNumber: `E2E-${code}-${tag}`, firstName: 'E2E', lastName: `${code} ${tag}`, phone: '5550000010', email: `e2e-${code}-${tag}@example.test`.toLowerCase(), driverType: 'lease_operator', cdlState: 'IL', cdlClass: 'A', cdlExpiresOn: '2030-01-01', cdlStatus: 'missing', medicalCardStatus: 'missing', hireDate: shift(today, -90), status: 'active', dispatcherId: '', dispatcherName: '', currentTruckId: truckId, homeCity: 'Chicago', homeState: 'IL', payPlanKind: 'lease_owner', payPlanRate: '0' });
    if (assignment) await db.insert(truckDriverAssignments).values({ id: `tda_e2e_${code}_${tag}`.toLowerCase(), companyId, truckId, driverId, assignedOn: assignment.on, endedOn: assignment.ended, source: 'truck_page' });
    created.push({ driverId, truckId });
    return driverId;
  }
  const reading = (truckId: string, date: string, miles: number, id = `odo_e2e_fr_${truckId}_${date}`) => ({ id: id.toLowerCase(), companyId, unitId: truckId, readingAt: new Date(`${date}T16:00:00Z`), readingDate: date, odometerMiles: miles, source: 'eld', status: 'ok', createdBy: 'e2e', createdByName: 'e2e' });
  async function load(driverId: string, truckId: string, day: string) {
    const loadId = `lod_e2e_fr_${driverId}_${day}`.toLowerCase();
    const deliveredAt = `${day}T15:00:00.000Z`;
    await db.insert(loads).values({ id: loadId, companyId, loadNumber: `E2E-FR-${tag}-${driverId.slice(-6)}-${day}`, status: 'delivered', driverId, truckId, record: { id: loadId, loadNumber: `E2E-FR-${tag}-${driverId.slice(-6)}-${day}`, status: 'delivered', driverId, truckId, deliveredAt, updatedAt: deliveredAt, rate: 5000, documents: [], charges: [{ id: 'lh', type: 'linehaul', description: 'Linehaul', amount: 5000, billable: true }], stops: [{ kind: 'pickup', city: 'Chicago', state: 'IL' }, { kind: 'delivery', city: 'Dallas', state: 'TX' }] } }).onConflictDoNothing();
  }
  async function generate(day: string) {
    const gen = await call('POST', `${ACCT}/settlements/generate`, { kind: 'lo_oo', weekOf: day });
    expect(gen.statusCode, gen.body).toBeLessThan(300);
  }
  // The week list asks by batch, as the Settlements page does.
  const listed = async (driverId: string, day: string) => {
    const all = (await call('GET', `${ACCT}/settlements?kind=lo_oo`)).json() as Listed[];
    const mine = all.find((s) => s.partyId === driverId && s.periodStart <= day && s.periodEnd >= day)!;
    return ((await call('GET', `${ACCT}/settlements?batchId=${mine.batchId}`)).json() as Listed[]).find((s) => s.id === mine.id)!;
  };
  const stored = async (id: string) => ((await db.execute(sql`select record from acct_settlements where company_id = ${companyId} and id = ${id}`)) as unknown as Array<{ record: Listed }>)[0]!.record;

  beforeAll(async () => {
    setFeatureFlagForTests('fleet_v2', true);
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    const [anyDriver] = await db.select({ companyId: drivers.companyId }).from(drivers).limit(1);
    companyId = anyDriver?.companyId ?? 'co_northwind';
    const s = (await call('GET', `${ACCT}/settings`)).json() as { version: number; settings: { cutoffBasis: string | null; cutoffTimezoneConfirmed: boolean | null } };
    if (s.settings.cutoffBasis === null || s.settings.cutoffTimezoneConfirmed !== true) {
      await call('PUT', `${ACCT}/settings`, { expectedVersion: s.version, settings: { cutoffBasis: s.settings.cutoffBasis ?? 'delivered_at', cutoffTimezoneConfirmed: true } });
    }
  }, 120_000);

  afterAll(async () => {
    for (const c of created) {
      if (c.driverId) await db.update(loads).set({ status: 'cancelled' }).where(and(eq(loads.companyId, companyId), eq(loads.driverId, c.driverId)));
      await db.update(odometerReadings).set({ status: 'void', voidReason: 'e2e cleanup', voidedAt: new Date() }).where(and(eq(odometerReadings.companyId, companyId), eq(odometerReadings.unitId, c.truckId)));
    }
    await app.close();
  });

  it('1 · a draft with an inflated reading: void the reading and the week list shows the corrected money, saved, without "Update draft statements"', async () => {
    const truckId = await truck('FR');
    const driverId = await leaseDriver('fr', truckId, { on: shift(today, -60), ended: null });
    const day = wednesday(2);
    await db.insert(odometerReadings).values([reading(truckId, shift(day, -4), 440_000), reading(truckId, shift(day, 1), 440_667)]);
    // The typo, written as good the way the old work-order path did.
    const typoId = `odo_e2e_fr_typo_${tag}`.toLowerCase();
    await db.insert(odometerReadings).values(reading(truckId, shift(day, 2), 642_085, typoId));
    await load(driverId, truckId, day);
    await generate(day);

    const before = await listed(driverId, day);
    expect(before.status).toMatch(/draft|review/);
    expect(leaseLines(before.computation)['maintenance_fee']).toBe((642_085 - 440_000) * 20);

    await db.update(odometerReadings).set({ status: 'void', voidReason: 'typed by mistake', voidedAt: new Date() }).where(eq(odometerReadings.id, typoId));

    // Listed straight away (no generate): the corrected fee and money.
    const after = await listed(driverId, day);
    expect(leaseLines(after.computation)['maintenance_fee']).toBe(667 * 20);
    expect(after.netCents).toBeGreaterThan(before.netCents);
    // Saved, so every other reader (batch totals, exports) has the same figures.
    const row = await stored(after.id);
    expect(row.netCents).toBe(after.netCents);
    expect(row.payableCents).toBe(after.payableCents);
    expect(row.carryCents).toBe(after.carryCents);
    const batch = ((await db.execute(sql`select record from acct_settlement_batches where company_id = ${companyId} and id = ${after.batchId}`)) as unknown as Array<{ record: { totals: { payableCents: number } } }>)[0]!.record;
    const all = ((await call('GET', `${ACCT}/settlements?batchId=${after.batchId}`)).json() as Listed[]);
    expect(batch.totals.payableCents).toBe(all.reduce((t, s) => t + s.payableCents, 0));
    // The change is audited.
    const audit = (await db.execute(sql`select summary from audit_logs where company_id = ${companyId} and entity_id = ${after.id} and action = 'settlement_draft_refreshed'`)) as unknown as Array<{ summary: string }>;
    expect(audit.length).toBeGreaterThan(0);

    // Read again: nothing changed, nothing more written.
    const v1 = ((await db.execute(sql`select version from acct_settlements where id = ${after.id}`)) as unknown as Array<{ version: number }>)[0]!.version;
    await listed(driverId, day);
    const v2 = ((await db.execute(sql`select version from acct_settlements where id = ${after.id}`)) as unknown as Array<{ version: number }>)[0]!.version;
    expect(v2).toBe(v1);
  }, 120_000);

  it('2 · lease charges only while a truck is assigned: before the assignment none, starting mid-week the full week, ended before the week none', async () => {
    const w2 = wednesday(2);
    const w1 = wednesday(1);
    // Assigned on the Thursday of week 1.
    const truckA = await truck('FA');
    const midWeek = await leaseDriver('fa', truckA, { on: shift(w1, 1), ended: null });
    await db.insert(odometerReadings).values([reading(truckA, w1, 120_000), reading(truckA, shift(w1, 3), 121_000)]);
    // Assignment that ended the Monday a week before week 2 began.
    const truckB = await truck('FB');
    const ended = await leaseDriver('fb', truckB, { on: shift(today, -80), ended: shift(w2, -9) });
    await db.insert(odometerReadings).values([reading(truckB, shift(w2, -4), 300_000), reading(truckB, shift(w2, 2), 301_000)]);
    for (const [d, t] of [[midWeek, truckA], [ended, truckB]] as const) {
      await load(d, t, w2);
      await load(d, t, w1);
    }
    await generate(w2);
    await generate(w1);

    // Week 2, before the assignment: no lease line, the note, and no odometer exception.
    const before = await listed(midWeek, w2);
    expect(Object.keys(leaseLines(before.computation))).toEqual([]);
    expect(before.computation.notes).toEqual([NO_TRUCK_LEASE_NOTE]);
    expect(before.computation.exceptions.some((e) => /odometer/i.test(e))).toBe(false);
    const opened = (await call('GET', `${ACCT}/settlements/${before.id}`)).json() as Listed;
    expect(opened.computation.notes).toEqual([NO_TRUCK_LEASE_NOTE]);

    // Week 1, assigned on Thursday: the full weekly charges; miles from the reading before Thursday.
    const mid = await listed(midWeek, w1);
    const by = leaseLines(mid.computation);
    expect(by['tractor_lease']).toBe(115_000);
    expect(by['trailer_rent']).toBe(22_000);
    expect(by['insurance']).toBe(50_000);
    expect(by['maintenance_fee']).toBe(1_000 * 13);
    expect(mid.computation.notes ?? []).toEqual([]);

    // Ended before week 2: none, said on the statement.
    for (const day of [w2, w1]) {
      const st = await listed(ended, day);
      expect(Object.keys(leaseLines(st.computation))).toEqual([]);
      expect(st.computation.notes).toEqual([NO_TRUCK_LEASE_NOTE]);
    }
  }, 180_000);

  it('3 · an oil change typed 201,418 mi above the last reading is kept as a conflict and the save says so', async () => {
    const truckId = await truck('FW');
    created.push({ driverId: '', truckId });
    const base = new Date(Date.UTC(2018, 0, 1 + Math.floor(Math.random() * 200), 15));
    await db.insert(odometerReadings).values({ ...reading(truckId, base.toISOString().slice(0, 10), 440_667), readingAt: base });
    const at = new Date(base.getTime() + 10 * 86_400_000).toISOString();
    const res = await call('POST', '/api/v1/fleet/work-orders', { assetType: 'truck', unitId: truckId, status: 'completed', workType: 'oil_change', title: 'E2E oil change', vendorName: 'E2E shop', completedAt: at, shopInAt: at, lines: [{ systemCode: 'pm', description: 'Oil & filter', amount: 0 }], invoiceTotal: 0, zeroReason: 'warranty', odometer: 642_085 });
    expect(res.statusCode, res.body).toBe(201);
    const order = res.json() as { id: string; odometerWarning: string | null };
    expect(order.odometerWarning).toBe('Odometer 642,085 is 201,418 mi above the last reading (440,667) — check the number');
    const [row] = await db.select().from(odometerReadings).where(eq(odometerReadings.id, `odo_wo_${order.id}`));
    expect(row).toMatchObject({ status: 'conflict', conflictReason: 'implausible_jump', conflictWith: 440_667 });
    await call('POST', `/api/v1/fleet/work-orders/${order.id}/void`, { reason: 'E2E cleanup' });

    // A plausible figure is a good reading and says nothing.
    const later = new Date(base.getTime() + 80 * 86_400_000).toISOString();
    const ok = await call('POST', '/api/v1/fleet/work-orders', { assetType: 'truck', unitId: truckId, status: 'completed', workType: 'oil_change', title: 'E2E oil change', vendorName: 'E2E shop', completedAt: later, shopInAt: later, lines: [{ systemCode: 'pm', description: 'Oil & filter', amount: 0 }], invoiceTotal: 0, zeroReason: 'warranty', odometer: 470_000 });
    expect(ok.statusCode, ok.body).toBe(201);
    const good = ok.json() as { id: string; odometerWarning: string | null };
    expect(good.odometerWarning).toBeNull();
    const [goodRow] = await db.select().from(odometerReadings).where(eq(odometerReadings.id, `odo_wo_${good.id}`));
    expect(goodRow?.status).toBe('ok');
    await call('POST', `/api/v1/fleet/work-orders/${good.id}/void`, { reason: 'E2E cleanup' });
  }, 120_000);
});
