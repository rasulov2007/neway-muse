import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TireEvent } from '@neway/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { auditLogs } from '../src/database/schema/people';
import { repairTireEvents, workOrderLines, workOrders } from '../src/database/schema/fleet';

const TP = '/api/v1/fleet/tire-positions';

/** Tire position map (owner brief, 2026-10-13), on fictional records. */
describe('Tire positions (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  const tag = Date.now().toString(36).toUpperCase();
  const eastern = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const today = eastern(new Date());
  let truckId = '';
  const woId = `wo_e2e_tp_${tag}`.toLowerCase();
  const call = (method: 'GET' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: payload === undefined ? {} : { 'content-type': 'application/json' }, ...(payload === undefined ? {} : { payload: payload as object }) });
  const mine = async () => {
    const res = await call('GET', `${TP}?window=12m&scope=all&units=${truckId}`);
    expect(res.statusCode, res.body).toBe(200);
    return (res.json() as { events: TireEvent[] }).events.filter((e) => e.recordId === woId);
  };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    const unit = `TP-${tag}`.slice(0, 20);
    const created = await app.inject({
      method: 'POST',
      url: '/api/v1/trucks',
      headers: { 'content-type': 'application/json' },
      payload: { unitNumber: unit, vin: `1TP${tag}`.replace(/[IOQ]/g, '0').padEnd(17, '7').slice(0, 17), year: 2022, make: 'E2E', model: 'Tires', odometer: 100_000, status: 'available' },
    });
    expect(created.statusCode, created.body).toBe(201);
    truckId = (created.json() as { id: string }).id;
    const [anyRow] = await db.select({ companyId: workOrders.companyId }).from(workOrders).limit(1);
    const companyId = anyRow?.companyId ?? 'co_northwind';
    await db.insert(workOrders).values({
      id: woId,
      companyId,
      number: `RO-TP-${tag}`,
      assetType: 'truck',
      unitId: truckId,
      unitNumber: unit,
      status: 'completed',
      workType: 'tires',
      workDone: 'REPLACE 8 DRIVE TIRES · REPLACE OUTPUT SEAL II AXLE',
      shopInAt: new Date(`${today}T12:00:00Z`),
      completedAt: new Date(`${today}T14:00:00Z`),
      total: '4000.00',
      invoiceTotal: '4000.00',
      vendorName: `E2E Tires ${tag}`,
      createdBy: 'e2e',
    } as typeof workOrders.$inferInsert);
    await db.insert(workOrderLines).values({ id: `wol_e2e_tp_${tag}`, companyId, workOrderId: woId, systemCode: 'tires_wheels', lineKind: 'repair', description: 'Drive tires', totalAmount: '3600.00', sort: 0 } as typeof workOrderLines.$inferInsert);
  }, 120_000);

  afterAll(async () => {
    // Test data is never deleted: the order is voided.
    await db.update(workOrders).set({ voidedAt: new Date(), voidedBy: 'e2e', voidReason: 'test' }).where(eq(workOrders.id, woId));
    await app.close();
  });

  it('reads the description once into eight drive positions, the tire line split evenly', async () => {
    const first = await mine();
    expect(first.map((e) => e.positionId).sort()).toEqual(['D1-LI', 'D1-LO', 'D1-RI', 'D1-RO', 'D2-LI', 'D2-LO', 'D2-RI', 'D2-RO']);
    expect(first.every((e) => e.source === 'parsed' && e.eventType === 'replaced')).toBe(true);
    expect(first.reduce((s, e) => s + e.costCents, 0)).toBe(360000);
    // Read again: the same rows, nothing written twice.
    const again = await mine();
    expect(again.map((e) => e.id).sort()).toEqual(first.map((e) => e.id).sort());
  });

  it('reads it again when the description changes, voiding the old rows', async () => {
    const before = await mine();
    await db.update(workOrders).set({ workDone: 'new steer tires' }).where(eq(workOrders.id, woId));
    const after = await mine();
    expect(after.map((e) => e.positionId).sort()).toEqual(['S-L', 'S-R']);
    const old = await db.select().from(repairTireEvents).where(eq(repairTireEvents.id, before[0]!.id));
    expect(old[0]?.voidedAt).not.toBeNull();
  });

  it('a manual tag replaces the parsed rows, is audited, and a stale tag is refused', async () => {
    const current = await mine();
    const stale = await call('PUT', `${TP}/work_order/${woId}`, { basis: ['rte_nope'], unitId: truckId, unitKind: 'truck', events: [{ positionId: 'S-L', eventType: 'blowout', quantity: 1 }] });
    expect(stale.statusCode).toBe(409);
    const ok = await call('PUT', `${TP}/work_order/${woId}`, { basis: current.map((e) => e.id), unitId: truckId, unitKind: 'truck', events: [{ positionId: 'S-L', eventType: 'blowout', quantity: 1 }] });
    expect(ok.statusCode, ok.body).toBe(200);
    const tagged = await mine();
    expect(tagged.map((e) => `${e.positionId}:${e.eventType}:${e.source}`)).toEqual(['S-L:blowout:manual']);
    expect(tagged[0]!.costCents).toBe(360000);
    // A later description change never reads over a person's tag.
    await db.update(workOrders).set({ workDone: 'REPLACE 8 DRIVE TIRES' }).where(eq(workOrders.id, woId));
    expect((await mine()).map((e) => e.positionId)).toEqual(['S-L']);
    const audit = await db.select().from(auditLogs).where(and(eq(auditLogs.entityId, woId), eq(auditLogs.action, 'tire_positions_tagged')));
    expect(audit).toHaveLength(1);
  });
});
