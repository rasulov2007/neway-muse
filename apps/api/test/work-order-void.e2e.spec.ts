import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';

/**
 * Voiding a work order entered by mistake (owner, 2026-09-30: a trailer repair was entered twice).
 * The record stays, marked; lists stop showing it; and it cannot be voided while it still holds
 * the unit in the shop.
 */
describe('Work order void (e2e)', () => {
  let app: NestFastifyApplication;
  let trailerId = '';

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json' }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    setFeatureFlagForTests('fleet_v2', true);
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const trailers = (await call('GET', '/api/v1/trailers?pageSize=50')).json() as { data: { id: string }[] };
    trailerId = trailers.data[0]!.id;
  });

  afterAll(async () => {
    await app.close();
  });

  const schedule = async () => {
    const res = await call('POST', '/api/v1/fleet/work-orders', {
      assetType: 'trailer',
      unitId: trailerId,
      status: 'scheduled',
      workType: 'repair',
      title: `E2E void ${Date.now().toString(36)}`,
      scheduledFor: new Date(Date.now() + 86_400_000).toISOString(),
    });
    expect(res.statusCode, res.body).toBe(201);
    return res.json() as { id: string; number: string };
  };

  it('voids with a reason, keeps the record marked, and drops it from the unit list', async () => {
    const order = await schedule();
    const before = (await call('GET', `/api/v1/fleet/work-orders?unitId=${trailerId}`)).json() as { id: string }[];
    expect(before.some((o) => o.id === order.id)).toBe(true);

    const res = await call('POST', `/api/v1/fleet/work-orders/${order.id}/void`, { reason: 'Duplicate of an earlier order' });
    expect(res.statusCode, res.body).toBe(201);
    const detail = res.json() as { voided: { at: string; by: string | null; reason: string | null } | null; actions: { action: string; note: string | null }[] };
    expect(detail.voided?.reason).toBe('Duplicate of an earlier order');
    expect(detail.actions.some((a) => a.action === 'voided')).toBe(true);

    const after = (await call('GET', `/api/v1/fleet/work-orders?unitId=${trailerId}`)).json() as { id: string }[];
    expect(after.some((o) => o.id === order.id)).toBe(false);

    const again = await call('POST', `/api/v1/fleet/work-orders/${order.id}/void`, { reason: 'Again' });
    expect(again.statusCode).toBe(400);
  });

  it('asks for a reason', async () => {
    const order = await schedule();
    const res = await call('POST', `/api/v1/fleet/work-orders/${order.id}/void`, { reason: '' });
    expect(res.statusCode).toBe(422);
  });

  it('refuses while the unit is in the shop on it', async () => {
    const opened = await call('POST', '/api/v1/fleet/work-orders', {
      assetType: 'trailer',
      unitId: trailerId,
      status: 'in_shop',
      workType: 'repair',
      title: `E2E in shop ${Date.now().toString(36)}`,
    });
    expect(opened.statusCode, opened.body).toBe(201);
    const order = opened.json() as { id: string };
    const res = await call('POST', `/api/v1/fleet/work-orders/${order.id}/void`, { reason: 'Mistake' });
    expect(res.statusCode).toBe(400);
    expect(res.body).toContain('still in the shop');
  });
});
