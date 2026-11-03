import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { TireEvent } from '@neway/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { repairTireEvents, trailers, workOrderLines, workOrders } from '../src/database/schema/fleet';

/**
 * The tire work order (owner mockup, 2026-10-14): one line per tire priced on its own, the labor
 * split across the tires, fees on their own line, and a trailer's tire filed to the trailer even
 * on the truck's order. Fictional records; the orders are voided after.
 */
describe('Tire work order (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let truckId = '';
  let trailerId = '';
  let companyId = '';
  const ids: string[] = [];
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json' }, ...(payload ? { payload: payload as object } : {}) });

  beforeAll(async () => {
    setFeatureFlagForTests('fleet_v2', true);
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    db = app.get(DatabaseService).db;
    const units = (await call('GET', '/api/v1/fleet/units?assetType=truck')).json() as { data: { id: string }[] };
    truckId = units.data[0]!.id;
    const [w] = await db.select({ companyId: workOrders.companyId }).from(workOrders).limit(1);
    companyId = w?.companyId ?? 'co_northwind';
    const [t] = await db.select({ id: trailers.id }).from(trailers).where(eq(trailers.companyId, companyId)).limit(1);
    trailerId = t!.id;
  }, 120_000);

  afterAll(async () => {
    for (const id of ids) await db.update(workOrders).set({ voidedAt: new Date(), voidedBy: 'e2e', voidReason: 'test' }).where(eq(workOrders.id, id));
    await app.close();
  });

  it('saves one priced row per tire, the trailer tire to the trailer, and reads them back with their details', async () => {
    const tire = (positionId: string, action: 'new' | 'used', costCents: number, owner?: string) => ({
      positionId,
      eventType: 'replaced',
      quantity: 1,
      action,
      brand: 'Michelin X Line Energy Z',
      reason: 'Irregular wear',
      treadRemoved32: 3,
      tireCostCents: costCents,
      laborCents: 4_500,
      ownerUnitId: owner ?? null,
      ownerUnitKind: owner ? 'trailer' : null,
    });
    const res = await call('POST', '/api/v1/fleet/work-orders', {
      assetType: 'truck',
      unitId: truckId,
      status: 'completed',
      workType: 'tires',
      title: 'Tire replacement · 2 tires',
      shopInAt: new Date(Date.now() - 86_400_000).toISOString(),
      completedAt: new Date().toISOString(),
      odometer: 383_010,
      vendorName: 'E2E Tire Shop',
      lines: [
        { systemCode: 'tires_wheels', description: 'Steer · Left · Replace new', amount: 635 },
        { systemCode: 'tires_wheels', description: 'Trailer 1 · Right outer · Replace used', amount: 290 },
        { systemCode: 'fees', description: 'Shop supplies / tax', amount: 28 },
      ],
      invoiceTotal: 953,
      chargeParty: 'company',
      tirePositions: [tire('S-L', 'new', 59_000), tire('T1-RO', 'used', 24_500, trailerId)],
    });
    expect(res.statusCode, res.body).toBe(201);
    const id = (res.json() as { id: string }).id;
    ids.push(id);
    const rows = await db.select().from(repairTireEvents).where(and(eq(repairTireEvents.recordId, id), isNull(repairTireEvents.voidedAt)));
    const steer = rows.find((r) => r.positionId === 'S-L')!;
    const trl = rows.find((r) => r.positionId === 'T1-RO')!;
    expect(steer).toMatchObject({ unitId: truckId, action: 'new', tireCostCents: 59_000, laborCents: 4_500, allocatedCostCents: 63_500, odometer: 383_010, recordedOnUnitId: null });
    expect(trl).toMatchObject({ unitId: trailerId, unitKind: 'trailer', action: 'used', recordedOnUnitId: truckId, odometer: null });
    const lines = await db.select().from(workOrderLines).where(eq(workOrderLines.workOrderId, id));
    expect(lines).toHaveLength(3);

    const read = await call('GET', `/api/v1/fleet/tire-positions?window=30d&scope=all`);
    expect(read.statusCode, read.body).toBe(200);
    const mine = (read.json() as { events: TireEvent[] }).events.filter((e) => e.recordId === id);
    expect(mine.find((e) => e.positionId === 'T1-RO')).toMatchObject({ unitId: trailerId, brand: 'Michelin X Line Energy Z', reason: 'Irregular wear', tireCostCents: 24_500, costCents: 29_000 });
  });

  it('refuses a trailer that is not in the company, and guesses the hooked trailer', async () => {
    const res = await call('POST', '/api/v1/fleet/work-orders', {
      assetType: 'truck',
      unitId: truckId,
      status: 'completed',
      workType: 'tires',
      shopInAt: new Date(Date.now() - 86_400_000).toISOString(),
      completedAt: new Date().toISOString(),
      vendorName: 'E2E Tire Shop',
      lines: [{ systemCode: 'tires_wheels', description: 'x', amount: 100 }],
      invoiceTotal: 100,
      chargeParty: 'company',
      tirePositions: [{ positionId: 'T1-RO', eventType: 'replaced', quantity: 1, tireCostCents: 10_000, ownerUnitId: 'trl_not_ours', ownerUnitKind: 'trailer' }],
    });
    expect(res.statusCode).toBe(400);
    const hooked = await call('GET', `/api/v1/fleet/units/${truckId}/hooked-trailer`);
    expect(hooked.statusCode, hooked.body).toBe(200);
    expect(hooked.json()).toHaveProperty('trailerId');
  });
});
