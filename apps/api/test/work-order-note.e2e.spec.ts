import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { and, eq, isNull, notLike } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { workOrders } from '../src/database/schema/fleet';

/** Add note on a work order (owner, 2026-10-15): its own entry with who and when, nothing else moves. */
describe('Work order notes (e2e)', () => {
  let app: NestFastifyApplication;
  let id = '';

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const [w] = await app.get(DatabaseService).db.select({ id: workOrders.id }).from(workOrders).where(and(isNull(workOrders.voidedAt), eq(workOrders.status, 'in_shop'), notLike(workOrders.companyId, 'co_acc2_%'))).limit(1); // not the fictional accident fixture companies
    id = w?.id ?? '';
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('adds a note entry and returns the order with it; an empty note is refused', async (ctx) => {
    if (!id) ctx.skip();
    const before = await app.inject({ method: 'GET', url: `/api/v1/fleet/work-orders/${id}` });
    const res = await app.inject({ method: 'POST', url: `/api/v1/fleet/work-orders/${id}/note`, payload: { note: 'E2E test note: waiting on the injector' } });
    expect(res.statusCode).toBe(201);
    const order = res.json() as { status: string; actions: Array<{ action: string; note: string | null }> };
    expect(order.actions.filter((a) => a.action === 'note_added').map((a) => a.note)).toContain('E2E test note: waiting on the injector');
    expect(order.status).toBe((before.json() as { status: string }).status);
    const empty = await app.inject({ method: 'POST', url: `/api/v1/fleet/work-orders/${id}/note`, payload: { note: '   ' } });
    expect(empty.statusCode).toBeGreaterThanOrEqual(400);
  });
});
