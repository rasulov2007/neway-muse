import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { setFeatureFlagForTests } from '../src/common/flags/flags';
import { AdminSeedService } from '../src/database/admin-seed.service';

/**
 * An oil change written up in Repairs is the Oil change board's record too (owner, 2026-10-18):
 * it asks the mileage, it becomes the baseline, and the same oil change entered a second time is
 * refused instead of billed twice. The spec voids what it wrote.
 */
describe('Oil change from Repairs (e2e)', () => {
  let app: NestFastifyApplication;
  let truckId = '';
  const written: string[] = [];
  // A day nobody else's oil change is on: years back, picked per run.
  const at = new Date(Date.UTC(2019, 0, 1 + Math.floor(Math.random() * 300), 15)).toISOString();

  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json' }, ...(payload ? { payload } : {}) });
  const oilChange = (odometer?: number) =>
    call('POST', '/api/v1/fleet/work-orders', {
      assetType: 'truck',
      unitId: truckId,
      status: 'completed',
      workType: 'oil_change',
      title: 'E2E oil change',
      vendorName: 'E2E shop',
      completedAt: at,
      shopInAt: at,
      lines: [{ systemCode: 'pm', description: 'Oil & filter', amount: 0 }],
      invoiceTotal: 0,
      zeroReason: 'warranty',
      ...(odometer === undefined ? {} : { odometer }),
    });

  beforeAll(async () => {
    setFeatureFlagForTests('fleet_v2', true);
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const trucks = (await call('GET', '/api/v1/trucks?pageSize=50')).json() as { data: { id: string }[] };
    truckId = trucks.data[0]!.id;
  });

  afterAll(async () => {
    for (const id of written) await call('POST', `/api/v1/fleet/work-orders/${id}/void`, { reason: 'E2E oil change cleanup' });
    await app.close();
  });

  it('asks the mileage, files it as the board oil change, and refuses the same one twice', async () => {
    const bare = await oilChange();
    expect(bare.statusCode, bare.body).toBe(400);
    expect(bare.body).toContain('odometer');

    const res = await oilChange(123_456);
    expect(res.statusCode, res.body).toBe(201);
    const order = res.json() as { id: string; number: string; pmServiceCode: string | null };
    written.push(order.id);
    expect(order.pmServiceCode).toBe('OIL_CHANGE');

    const twice = await oilChange(123_456);
    expect(twice.statusCode).toBe(400);
    expect(twice.body).toContain(order.number);

    // Voided, it stops counting: the same oil change can be written up again.
    await call('POST', `/api/v1/fleet/work-orders/${order.id}/void`, { reason: 'E2E re-entry' });
    written.pop();
    const again = await oilChange(123_456);
    expect(again.statusCode, again.body).toBe(201);
    written.push((again.json() as { id: string }).id);
  });
});
