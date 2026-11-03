import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DriverRecord, DriverVacationList, DriverVacationView } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';

/**
 * Driver vacations (owner, 2026-10-17), end to end on the local database: start, duplicate and
 * invalid dates refused, expected return edited without ending anything, actual return recorded,
 * a second vacation cancelled as a mistake, and the writes refused without the permission.
 * Nothing is deleted: the spec leaves the driver available and its vacations on record.
 */
describe('Driver vacations (e2e)', () => {
  let app: NestFastifyApplication;
  let driver: DriverRecord;
  let today = '';
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, role?: string) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json', ...(role ? { 'x-demo-role': role } : {}) }, ...(payload ? { payload } : {}) });
  const daysBefore = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const list = (await call('GET', '/api/v1/drivers?pageSize=1000')).json() as { data: DriverRecord[] };
    const free = list.data.find((d) => d.status === 'available' || d.status === 'off_duty');
    if (!free) throw new Error('The local database has no available driver to test with');
    driver = free;
    today = ((await call('GET', '/api/v1/drivers/vacations')).json() as DriverVacationList).today;
  });

  afterAll(async () => {
    // Leave the driver's vacations cancelled (kept on record) so a re-run does not overlap them.
    if (driver) {
      const history = (await call('GET', `/api/v1/drivers/${driver.id}/vacations`)).json() as DriverVacationView[];
      for (const v of history.filter((x) => x.state !== 'cancelled' && x.note?.startsWith('E2E'))) await call('POST', `/api/v1/drivers/${driver.id}/vacations/${v.id}/cancel`, { version: v.version, reason: 'E2E vacation spec cleanup' });
    }
    await app?.close();
  });

  it('refuses a vacation without the permission', async () => {
    const res = await call('POST', `/api/v1/drivers/${driver.id}/vacations`, { startedOn: today }, 'operations');
    expect(res.statusCode).toBe(403);
  });

  it('refuses a future start and an expected return before the start', async () => {
    const future = new Date(Date.parse(`${today}T00:00:00Z`) + 2 * 86_400_000).toISOString().slice(0, 10);
    expect((await call('POST', `/api/v1/drivers/${driver.id}/vacations`, { startedOn: future })).statusCode).toBe(422);
    expect((await call('POST', `/api/v1/drivers/${driver.id}/vacations`, { startedOn: today, expectedReturnOn: daysBefore(3) })).statusCode).toBe(422);
  });

  let vac: DriverVacationView;
  it('starts a vacation 31 days ago: the driver is on vacation and the test is due', async () => {
    const res = await call('POST', `/api/v1/drivers/${driver.id}/vacations`, { startedOn: daysBefore(31), note: 'E2E vacation' });
    expect(res.statusCode, res.body).toBe(201);
    vac = res.json() as DriverVacationView;
    expect(vac.state).toBe('away');
    expect(vac.daysAway).toBe(31);
    expect(vac.drugTestRequired).toBe(true);
    const d = (await call('GET', `/api/v1/drivers/${driver.id}`)).json() as DriverRecord;
    expect(d.status).toBe('vacation');
    const list = (await call('GET', '/api/v1/drivers/vacations')).json() as DriverVacationList;
    expect(list.away.some((v) => v.id === vac.id)).toBe(true);
  });

  it('refuses a second open vacation', async () => {
    const res = await call('POST', `/api/v1/drivers/${driver.id}/vacations`, { startedOn: today });
    expect(res.statusCode).toBe(409);
  });

  it('29 and 30 days: the threshold is 30 days away (company policy)', async () => {
    const at29 = await call('PATCH', `/api/v1/drivers/${driver.id}/vacations/${vac.id}`, { version: vac.version, startedOn: daysBefore(29) });
    expect(at29.statusCode, at29.body).toBe(200);
    expect((at29.json() as DriverVacationView).drugTestRequired).toBe(false);
    const v29 = at29.json() as DriverVacationView;
    const at30 = await call('PATCH', `/api/v1/drivers/${driver.id}/vacations/${vac.id}`, { version: v29.version, startedOn: daysBefore(30) });
    expect((at30.json() as DriverVacationView).drugTestRequired).toBe(true);
    vac = at30.json() as DriverVacationView;
  });

  it('an expected return in the past does not end the vacation; a stale version is refused', async () => {
    const res = await call('PATCH', `/api/v1/drivers/${driver.id}/vacations/${vac.id}`, { version: vac.version, expectedReturnOn: daysBefore(1) });
    expect(res.statusCode, res.body).toBe(200);
    const v = res.json() as DriverVacationView;
    expect(v.state).toBe('away');
    expect(v.endedOn).toBeNull();
    expect(v.note).toBe('E2E vacation'); // a date edit keeps the note
    expect((await call('PATCH', `/api/v1/drivers/${driver.id}/vacations/${vac.id}`, { version: vac.version, note: 'stale' })).statusCode).toBe(409);
    vac = v;
  });

  it('records the actual return: days stop, the driver is available, and a second return is refused', async () => {
    expect((await call('POST', `/api/v1/drivers/${driver.id}/vacations/${vac.id}/return`, { version: vac.version, returnedOn: daysBefore(40) })).statusCode).toBe(422);
    const res = await call('POST', `/api/v1/drivers/${driver.id}/vacations/${vac.id}/return`, { version: vac.version, returnedOn: today });
    expect(res.statusCode, res.body).toBe(201);
    const v = res.json() as DriverVacationView;
    expect(v.state).toBe('returned');
    expect(v.daysAway).toBe(30);
    expect(v.drugTestRequired).toBe(true);
    const d = (await call('GET', `/api/v1/drivers/${driver.id}`)).json() as DriverRecord;
    expect(d.status).toBe('available');
    expect((await call('POST', `/api/v1/drivers/${driver.id}/vacations/${vac.id}/return`, { version: v.version, returnedOn: today })).statusCode).toBe(409);
    const list = (await call('GET', '/api/v1/drivers/vacations')).json() as DriverVacationList;
    expect(list.returned.some((x) => x.id === vac.id)).toBe(true);
  });

  it('refuses a vacation that overlaps the one just ended', async () => {
    const res = await call('POST', `/api/v1/drivers/${driver.id}/vacations`, { startedOn: daysBefore(10) });
    expect(res.statusCode, res.body).toBe(409);
  });

  it('cancels a vacation entered by mistake: kept in the history, the driver available again', async () => {
    const started = await call('POST', `/api/v1/drivers/${driver.id}/vacations`, { startedOn: today });
    expect(started.statusCode, started.body).toBe(201);
    const v = started.json() as DriverVacationView;
    expect((await call('POST', `/api/v1/drivers/${driver.id}/vacations/${v.id}/cancel`, { version: v.version, reason: 'x' })).statusCode).toBe(422);
    const res = await call('POST', `/api/v1/drivers/${driver.id}/vacations/${v.id}/cancel`, { version: v.version, reason: 'Entered on the wrong driver' });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as DriverVacationView).state).toBe('cancelled');
    const d = (await call('GET', `/api/v1/drivers/${driver.id}`)).json() as DriverRecord;
    expect(d.status).toBe('available');
    const history = (await call('GET', `/api/v1/drivers/${driver.id}/vacations`)).json() as DriverVacationView[];
    expect(history.find((x) => x.id === v.id)?.cancelReason).toBe('Entered on the wrong driver');
    const list = (await call('GET', '/api/v1/drivers/vacations')).json() as DriverVacationList;
    expect(list.away.some((x) => x.id === v.id)).toBe(false);
  });
});
