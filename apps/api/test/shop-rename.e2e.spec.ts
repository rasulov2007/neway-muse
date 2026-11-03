import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import type { Principal } from '../src/common/auth/principal';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { trucks } from '../src/database/schema/roster';
import { vendors, workOrders } from '../src/database/schema';
import { PmBoardService } from '../src/modules/fleet/pm-board.service';

/**
 * A shop named by its address gets its real name (owner, 2026-10-19): the shop is renamed and
 * activated, its work orders read the new name, their Last update clock is left alone, and a
 * stale rename is refused. Local spec; removes what it wrote.
 */
describe('Name a shop (e2e)', () => {
  let app: NestFastifyApplication;
  let companyId = '';
  const vendorId = `ven_spec_${Date.now()}`;
  const orderId = `wo_spec_${Date.now()}`;
  const principal = (): Principal => ({ userId: 'usr_spec', userName: 'Shop spec', companyId, companyTimezone: 'America/New_York', weekStart: 1, roles: [], permissions: new Set(['maintenance.view', 'maintenance.edit']) });

  beforeAll(async () => {
    setFeatureFlagForTests('pm_module', true);
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    const db = app.get(DatabaseService).db;
    const [t] = await db.select({ id: trucks.id, companyId: trucks.companyId, unitNumber: trucks.unitNumber }).from(trucks).limit(1);
    if (!t) throw new Error('A truck is needed');
    companyId = t.companyId;
    await db.insert(vendors).values({ id: vendorId, companyId, name: '1201 Harrisburg Ave, Carlisle, PA', addressLine: '1201 Harrisburg Ave', city: 'Carlisle', state: 'PA', status: 'draft', source: 'import' });
    await db.insert(workOrders).values({ id: orderId, companyId, number: `RO-SPEC-${Date.now()}`, assetType: 'truck', unitId: t.id, unitNumber: t.unitNumber, status: 'in_shop', workType: 'repair', shopInAt: new Date(), vendorId, vendorName: '1201 Harrisburg Ave, Carlisle, PA', updatedAt: new Date('2026-10-01T12:00:00Z') } as typeof workOrders.$inferInsert);
  }, 120_000);

  afterAll(async () => {
    const db = app.get(DatabaseService).db;
    await db.delete(workOrders).where(eq(workOrders.id, orderId));
    await db.delete(vendors).where(and(eq(vendors.id, vendorId), eq(vendors.companyId, companyId)));
    await app.close();
  });

  it('names the shop and its work orders, and refuses a stale save', async () => {
    const svc = app.get(PmBoardService);
    const before = (await svc.shops(principal())).find((s) => s.id === vendorId)!;
    expect(before.needsName).toBe(true);
    const after = (await svc.renameShop(principal(), vendorId, { name: 'Love’s Truck Care - Carlisle', version: before.version! })).find((s) => s.id === vendorId)!;
    expect(after.name).toBe('Love’s Truck Care - Carlisle');
    expect(after.needsName).toBe(false);
    const db = app.get(DatabaseService).db;
    const [o] = await db.select({ vendorName: workOrders.vendorName, updatedAt: workOrders.updatedAt }).from(workOrders).where(eq(workOrders.id, orderId));
    expect(o?.vendorName).toBe('Love’s Truck Care - Carlisle');
    expect(o?.updatedAt.toISOString()).toBe('2026-10-01T12:00:00.000Z');
    const [v] = await db.select({ status: vendors.status }).from(vendors).where(eq(vendors.id, vendorId));
    expect(v?.status).toBe('active');
    await expect(svc.renameShop(principal(), vendorId, { name: 'Again', version: before.version! })).rejects.toThrow(/changed/);
  });
});
