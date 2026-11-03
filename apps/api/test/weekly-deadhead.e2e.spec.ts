import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { addDays, weekStartMonday, type DailyBoard, type RosterRow, type WeeklyBoard } from '@neway/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { dispatchRoster, dispatchRosterAssignments } from '../src/database/schema/dispatch-ops';
import { loads } from '../src/database/schema/loads';
import { drivers } from '../src/database/schema/roster';

/** Weekly board miles = loaded + deadhead (owner, 2026-10-29), for every load, past ones too. */
describe('Weekly board: deadhead in the miles (e2e)', () => {
  let app: NestFastifyApplication;
  let companyId = '';
  let thisWeek = '';
  const t = Date.now().toString(36);
  const ROW = `drv_e2e_dh_${t}`;
  const made: string[] = [];
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json' }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const today = ((await call('GET', '/api/v1/dispatch/board/daily?day=2026-01-01')).json() as DailyBoard).today;
    thisWeek = weekStartMonday(today);
    const probe = await call('POST', '/api/v1/dispatch/roster', { name: `E2E DH PROBE ${t}`, dispatcherId: `e2e_dh_${t}`, dispatcherName: 'E2E DH TEAM' });
    made.push((probe.json() as RosterRow).id);
    const db = app.get(DatabaseService).db;
    const [found] = await db.select({ companyId: dispatchRoster.companyId }).from(dispatchRoster).where(eq(dispatchRoster.id, made[0]!));
    companyId = found!.companyId;
    await db.insert(drivers).values({
      id: ROW, companyId, driverNumber: ROW, firstName: 'E2E', lastName: `Deadhead ${t}`, phone: '5550000000', email: `${ROW}@example.test`, driverType: 'company',
      cdlState: 'OH', cdlClass: 'A', cdlNumber: ROW, cdlExpiresOn: '2028-01-01', cdlStatus: 'valid', medicalCardStatus: 'valid', hireDate: '2026-01-01',
      status: 'available', dispatcherId: `e2e_dh_${t}`, dispatcherName: 'E2E DH TEAM', homeCity: 'Columbus', homeState: 'OH', payPlanKind: 'percentage',
    } as never);
    const since = addDays(thisWeek, -14);
    await db.insert(dispatchRoster).values({ id: ROW, companyId, driverId: ROW, name: `E2E DEADHEAD ${t}`, truckUnit: '9944', dispatcherId: `e2e_dh_${t}`, dispatcherName: 'E2E DH TEAM' });
    await db.insert(dispatchRosterAssignments).values({ id: `dra_${ROW}`, companyId, rosterId: ROW, effectiveFrom: since, dispatcherId: `e2e_dh_${t}`, dispatcherName: 'E2E DH TEAM', truckUnit: '9944', by: 'e2e', at: new Date(`${since}T15:00:00Z`) });
    made.push(ROW);
    const pickup = `${addDays(thisWeek, -7)}T15:00:00.000Z`; // last week: a load from before the change
    const id = `ld_e2e_dh_${t}`;
    await db.insert(loads).values({
      id, companyId, loadNumber: `E2E-DH-${t}`, status: 'delivered', driverId: ROW, isDemo: false,
      record: { id, loadNumber: `E2E-DH-${t}`, status: 'delivered', driverId: ROW, rate: 2000, loadedMiles: 500, emptyMiles: 80, charges: [], stops: [{ id: `${id}_s1`, kind: 'pickup', sequence: 1, appointmentStartAt: pickup, timezone: 'America/New_York', status: 'completed' }] },
    } as never);
  }, 120_000);

  afterAll(async () => {
    await app.close();
  });

  it('a load with 500 loaded and 80 deadhead counts 580 miles on its day and in the week', async () => {
    const res = await call('GET', `/api/v1/dispatch/board/weekly?week=${addDays(thisWeek, -7)}`);
    expect(res.statusCode, res.body).toBe(200);
    const row = (res.json() as WeeklyBoard).rows.find((r) => r.driverId === ROW)!;
    expect(row).toBeDefined();
    const day = row.days.find((d) => d.loads.length > 0)!;
    expect(day.autoMiles).toBe(580);
    expect(day.loads[0]!.miles).toBe(580);
    expect(row.miles).toBe(580);
  });
});
