import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DriverRecord, DriverVacationList, DriverVacationView, RosterRow } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';

/**
 * VACATION on the Daily board puts the driver on vacation (owner, 2026-10-17), so the board and
 * the vacation page agree. The spec restores the cell and cancels the vacation it opened.
 */
describe('Board VACATION -> driver vacation (e2e)', () => {
  let app: NestFastifyApplication;
  let today = '';
  let row: RosterRow | undefined;
  let driverId = '';
  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json' }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    today = ((await call('GET', '/api/v1/drivers/vacations')).json() as DriverVacationList).today;
    const drivers = ((await call('GET', '/api/v1/drivers?pageSize=1000')).json() as { data: DriverRecord[] }).data;
    const free = new Set(drivers.filter((d) => d.status === 'available' || d.status === 'off_duty').map((d) => d.id));
    const roster = (await call('GET', '/api/v1/dispatch/roster')).json() as RosterRow[];
    row = roster.find((r) => r.driverId && free.has(r.driverId) && !r.unassignedAt);
    driverId = row?.driverId ?? '';
  });

  afterAll(async () => {
    if (row) {
      await call('PUT', '/api/v1/dispatch/board/cells', { cells: [{ driverId: row.id, day: today, column: 'status', value: null, restore: true }] });
      const history = (await call('GET', `/api/v1/drivers/${driverId}/vacations`)).json() as DriverVacationView[];
      for (const v of history.filter((x) => x.state === 'away' && x.note === 'Marked VACATION on the Daily board')) {
        await call('POST', `/api/v1/drivers/${driverId}/vacations/${v.id}/cancel`, { version: v.version, reason: 'E2E board sync cleanup' });
      }
    }
    await app?.close();
  });

  it('VACATION written today opens a vacation from today and lists the driver as away', async () => {
    if (!row) return; // no available driver on this local board
    const res = await call('PUT', '/api/v1/dispatch/board/cells', { cells: [{ driverId: row.id, day: today, column: 'status', value: 'VACATION' }] });
    expect(res.statusCode, res.body).toBe(200);
    const list = (await call('GET', '/api/v1/drivers/vacations')).json() as DriverVacationList;
    const v = list.away.find((x) => x.driverId === driverId);
    expect(v?.startedOn).toBe(today);
    const d = (await call('GET', `/api/v1/drivers/${driverId}`)).json() as DriverRecord;
    expect(d.status).toBe('vacation');
    // Writing it again opens nothing new.
    await call('PUT', '/api/v1/dispatch/board/cells', { cells: [{ driverId: row.id, day: today, column: 'status', value: 'VACATION' }] });
    const again = (await call('GET', '/api/v1/drivers/vacations')).json() as DriverVacationList;
    expect(again.away.filter((x) => x.driverId === driverId)).toHaveLength(1);
  });
});
