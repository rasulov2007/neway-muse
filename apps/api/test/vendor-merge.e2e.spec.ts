import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { WorkOrderWithCost } from '@neway/shared';
import { and, eq, isNull } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { repairTireEvents, workOrders } from '../src/database/schema/fleet';
import { auditLogs } from '../src/database/schema/people';

/**
 * One shop entered twice (owner, 2026-10-14): its orders move to the record that stays, each
 * move audited. And a tire order saved with positions from the form keeps them as a manual tag.
 */
describe('Vendor merge + work order tire positions (e2e)', () => {
  let app: NestFastifyApplication;
  let db: DatabaseService['db'];
  let truckId = '';
  const tag = Date.now().toString(36);
  const from = `ven_e2e_from_${tag}`;
  const to = `ven_e2e_to_${tag}`;
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
    for (let i = 0; i < 2; i++) {
      const res = await call('POST', '/api/v1/fleet/work-orders', {
        assetType: 'truck',
        unitId: truckId,
        status: 'completed',
        workType: 'tires',
        title: 'new steer tires',
        shopInAt: new Date(Date.now() - 2 * 86_400_000).toISOString(),
        completedAt: new Date(Date.now() - 86_400_000).toISOString(),
        vendorId: from,
        vendorName: 'TRAILER AND TIRE REPAIR',
        lines: [{ systemCode: 'tires_wheels', description: 'new steer tires', amount: 300 }],
        invoiceTotal: 300,
        chargeParty: 'company',
        tirePositions: i === 0 ? [{ positionId: 'S-L', eventType: 'replaced', quantity: 1 }, { positionId: 'S-R', eventType: 'replaced', quantity: 1 }] : undefined,
      });
      expect(res.statusCode, res.body).toBe(201);
      ids.push((res.json() as { id: string }).id);
    }
  }, 120_000);

  afterAll(async () => {
    for (const id of ids) await db.update(workOrders).set({ voidedAt: new Date(), voidedBy: 'e2e', voidReason: 'test' }).where(eq(workOrders.id, id));
    await app.close();
  });

  it('keeps the positions picked on the form as a manual tag, the tire line split between them', async () => {
    const rows = await db.select().from(repairTireEvents).where(and(eq(repairTireEvents.recordId, ids[0]!), isNull(repairTireEvents.voidedAt)));
    expect(rows.map((r) => `${r.positionId}:${r.source}:${r.allocatedCostCents}`).sort()).toEqual(['S-L:manual:15000', 'S-R:manual:15000']);
  });

  it('moves every order to the vendor that stays, audited; merging into itself is refused', async () => {
    expect((await call('POST', '/api/v1/fleet/work-orders/merge-vendor', { fromVendorId: from, toVendorId: from, toVendorName: 'x', reason: 'same shop' })).statusCode).toBe(400);
    const res = await call('POST', '/api/v1/fleet/work-orders/merge-vendor', { fromVendorId: from, toVendorId: to, toVendorName: 'Trailer and Tire Repair LLC', reason: 'Same shop entered twice' });
    expect(res.statusCode, res.body).toBe(201);
    expect(res.json()).toEqual({ moved: 2 });
    const list = (await call('GET', `/api/v1/fleet/work-orders?unitId=${truckId}`)).json() as WorkOrderWithCost[];
    const mine = list.filter((o) => ids.includes(o.id));
    expect(mine.map((o) => `${o.vendorId}|${o.vendorName}`)).toEqual([`${to}|Trailer and Tire Repair LLC`, `${to}|Trailer and Tire Repair LLC`]);
    const audit = await db.select().from(auditLogs).where(eq(auditLogs.action, 'fleet.work_order.vendor_merged'));
    expect(audit.filter((a) => ids.includes(a.entityId ?? '')).length).toBe(2);
  });
});
