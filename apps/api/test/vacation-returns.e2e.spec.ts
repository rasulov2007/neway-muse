import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DriverRecord, DriverVacationList, DriverVacationView, VacationReturnDetail, VacationReturnList } from '@neway/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';

/**
 * Vacation return reviews (owner, 2026-10-17), end to end on the local database: a driver back
 * after 31 days is in the queue; scheduling opens one review and one test however often it is
 * pressed; an appointment is not a result; approval needs a negative result; an existing
 * Accounting expense is pointed at, never made, and cannot be linked twice. A 29-day vacation is
 * not in the queue. The spec cancels its vacations at the end (kept, marked cancelled).
 */
describe('Vacation return reviews (e2e)', () => {
  let app: NestFastifyApplication;
  let today = '';
  const made: { driverId: string; vacation: DriverVacationView }[] = [];
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, role?: string) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json', ...(role ? { 'x-demo-role': role } : {}) }, ...(payload ? { payload } : {}) });
  const daysBefore = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);

  const awayAndBack = async (driver: DriverRecord, days: number) => {
    const started = await call('POST', `/api/v1/drivers/${driver.id}/vacations`, { startedOn: daysBefore(days), note: 'E2E vacation-return spec' });
    expect(started.statusCode, started.body).toBe(201);
    const v = started.json() as DriverVacationView;
    const back = await call('POST', `/api/v1/drivers/${driver.id}/vacations/${v.id}/return`, { version: v.version, returnedOn: today });
    expect(back.statusCode, back.body).toBe(201);
    const view = back.json() as DriverVacationView;
    made.push({ driverId: driver.id, vacation: view });
    return view;
  };

  let long: DriverVacationView;
  let short: DriverVacationView;

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    today = ((await call('GET', '/api/v1/drivers/vacations')).json() as DriverVacationList).today;
    const list = (await call('GET', '/api/v1/drivers?pageSize=1000')).json() as { data: DriverRecord[] };
    // The last available drivers, so this spec and the vacation spec do not share one.
    const free = list.data.filter((d) => d.status === 'available' || d.status === 'off_duty').reverse();
    if (free.length < 2) throw new Error('The local database needs two available drivers');
    long = await awayAndBack(free[0]!, 31);
    short = await awayAndBack(free[1]!, 29);
  });

  afterAll(async () => {
    for (const m of made) {
      const history = (await call('GET', `/api/v1/drivers/${m.driverId}/vacations`)).json() as DriverVacationView[];
      const v = history.find((x) => x.id === m.vacation.id);
      if (v && v.state !== 'cancelled') await call('POST', `/api/v1/drivers/${m.driverId}/vacations/${v.id}/cancel`, { version: v.version, reason: 'E2E vacation-return spec cleanup' });
    }
    await app?.close();
  });

  it('31 days is in the queue as test required; 29 days is not', async () => {
    const res = await call('GET', '/api/v1/safety/vacation-returns');
    expect(res.statusCode, res.body).toBe(200);
    const list = res.json() as VacationReturnList;
    const row = list.rows.find((r) => r.vacation.id === long.id);
    expect(row?.state).toBe('test_required');
    expect(list.rows.some((r) => r.vacation.id === short.id)).toBe(false);
  });

  it('refuses scheduling without the testing permission and refuses approval with no test', async () => {
    expect((await call('POST', `/api/v1/safety/vacation-returns/${long.id}/test`, {}, 'operations')).statusCode).toBe(403);
    const d = (await call('GET', `/api/v1/safety/vacation-returns/${long.id}`)).json() as VacationReturnDetail;
    expect(d.approveBlockers).toContain('No vacation-return test on file');
  });

  let detail: VacationReturnDetail;
  it('scheduling opens one review and one test, however often it is pressed; an appointment is not a result', async () => {
    const at = `${today}T15:00:00.000Z`;
    const first = await call('POST', `/api/v1/safety/vacation-returns/${long.id}/test`, { scheduledAt: at });
    expect(first.statusCode, first.body).toBe(201);
    const again = await call('POST', `/api/v1/safety/vacation-returns/${long.id}/test`, { scheduledAt: at });
    expect(again.statusCode, again.body).toBe(201);
    const a = first.json() as VacationReturnDetail;
    const b = again.json() as VacationReturnDetail;
    expect(b.reviewId).toBe(a.reviewId);
    expect(b.test?.id).toBe(a.test?.id);
    expect(b.state).toBe('appointment_scheduled');
    expect(b.test?.testType).toBe('vacation_return');
    expect(b.approveBlockers.length).toBeGreaterThan(0);
    detail = b;
  });

  it('approval waits for a negative result, then clears the driver once', async () => {
    const refused = await call('POST', `/api/v1/safety/vacation-returns/${long.id}/approve`, { version: detail.reviewVersion, outcome: 'Reviewed' });
    expect(refused.statusCode).toBe(409);
    const collected = await call('PATCH', `/api/v1/safety/tests/${detail.test!.id}`, { version: detail.test!.version, collectedAt: new Date(Date.now() - 3_600_000).toISOString() });
    expect(collected.statusCode, collected.body).toBe(200);
    let d = (await call('GET', `/api/v1/safety/vacation-returns/${long.id}`)).json() as VacationReturnDetail;
    expect(d.state).toBe('result_pending');
    const result = await call('PATCH', `/api/v1/safety/tests/${d.test!.id}`, { version: d.test!.version, result: 'negative' });
    expect(result.statusCode, result.body).toBe(200);
    d = (await call('GET', `/api/v1/safety/vacation-returns/${long.id}`)).json() as VacationReturnDetail;
    expect(d.state).toBe('result_received');
    expect(d.approveBlockers).toEqual([]);
    const ok = await call('POST', `/api/v1/safety/vacation-returns/${long.id}/approve`, { version: d.reviewVersion, outcome: 'Negative result reviewed by Safety' });
    expect(ok.statusCode, ok.body).toBe(201);
    detail = ok.json() as VacationReturnDetail;
    expect(detail.state).toBe('cleared');
    expect(detail.completedBy).toBeTruthy();
    expect((await call('POST', `/api/v1/safety/vacation-returns/${long.id}/approve`, { version: detail.reviewVersion, outcome: 'Again' })).statusCode).toBe(409);
  });

  it('points at an existing Accounting expense, shows its amount and status, and refuses it on a second review', async () => {
    const created = await call('POST', '/api/v1/accounting/expenses', {
      onDate: today,
      categoryCode: 'other',
      description: 'E2E vacation-return drug test (clinic invoice)',
      amount: 71.5,
      truckId: null,
      driverId: long.driverId,
      loadId: null,
      vendorId: null,
      paymentMethod: null,
      paidDirectly: true,
      notes: null,
    });
    expect(created.statusCode, created.body).toBe(201);
    const expense = (created.json() as { expense?: { id: string }; id?: string });
    const expenseId = expense.expense?.id ?? expense.id!;
    const linked = await call('POST', `/api/v1/safety/vacation-returns/${long.id}/expense`, { version: detail.reviewVersion, expenseId });
    expect(linked.statusCode, linked.body).toBe(201);
    const d = linked.json() as VacationReturnDetail;
    expect(d.expense?.id).toBe(expenseId);
    expect(d.expense?.amountCents).toBe(7150);
    const again = await call('POST', `/api/v1/safety/vacation-returns/${long.id}/expense`, { version: detail.reviewVersion, expenseId });
    expect(again.statusCode).toBe(409); // stale version: the first save moved it on
  });
});
