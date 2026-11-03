import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DriverRecord } from '@neway/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { demoPrincipal } from '../src/common/auth/demo-principal.middleware';
import { ComplianceSeedService } from '../src/database/compliance-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { HiringSeedService } from '../src/database/hiring-seed.service';
import { DriversService } from '../src/modules/roster/drivers.service';

const BASE = '/api/v1';

/**
 * Date of birth on the driver (owner, 2026-10-25), end to end on the local database. Needs
 * migration 0075 (drivers.date_of_birth); without the column every case is skipped rather than
 * failed. Nothing is deleted: the spec adds one driver and leaves it on the local roster.
 */
describe('Driver date of birth (e2e)', () => {
  let app: NestFastifyApplication;
  let ready = false;
  let driver: DriverRecord;
  const stamp = `${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
  const call = (method: 'GET' | 'POST' | 'PATCH', url: string, payload?: unknown, role?: string) =>
    app.inject({
      method,
      url,
      headers: { 'content-type': 'application/json', ...(role ? { 'x-demo-role': role } : {}) },
      ...(payload ? { payload: payload as object } : {}),
    });
  const body = (over: Record<string, unknown> = {}) => ({
    firstName: 'Dob',
    lastName: `Driver${stamp}`,
    phone: '+1 312 555 0142',
    email: `dob.${stamp}@example.com`,
    driverType: 'company',
    cdlState: 'IL',
    cdlClass: 'A',
    cdlEndorsements: [],
    cdlExpiresOn: '2030-05-14',
    hireDate: '2026-10-25',
    homeCity: 'Chicago',
    homeState: 'IL',
    payPlan: { kind: 'per_mile', rate: 0.6 },
    preferredLanguage: 'en',
    ...over,
  });

  beforeAll(async () => {
    app = await createApp();
    await app.get(ComplianceSeedService).seed();
    await app.get(HiringSeedService).seedOnboardingTemplates();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const found = await app
      .get(DatabaseService)
      .db.execute(sql`select 1 as ok from information_schema.columns where table_name = 'drivers' and column_name = 'date_of_birth'`);
    ready = (found as unknown as unknown[]).length > 0;
  });

  afterAll(async () => {
    await app?.close();
  });

  it('refuses a future date and an under-18 driver on create with 422', async (ctx) => {
    if (!ready) ctx.skip();
    const future = await call('POST', `${BASE}/drivers`, body({ email: `dob.f.${stamp}@example.com`, dateOfBirth: '2099-01-01' }));
    expect(future.statusCode).toBe(422);
    expect((future.json() as { detail: string }).detail).toBe('Date of birth cannot be in the future');
    const young = await call('POST', `${BASE}/drivers`, body({ email: `dob.y.${stamp}@example.com`, dateOfBirth: '2015-01-01' }));
    expect(young.statusCode).toBe(422);
    expect((young.json() as { detail: string }).detail).toMatch(/at least 18/);
    const badShape = await call('POST', `${BASE}/drivers`, body({ email: `dob.s.${stamp}@example.com`, dateOfBirth: '01/02/1990' }));
    expect(badShape.statusCode).toBe(422);
  });

  it('creates a driver with a date of birth, returns it and audits the create', async (ctx) => {
    if (!ready) ctx.skip();
    const res = await call('POST', `${BASE}/drivers`, body({ dateOfBirth: '1987-04-12' }));
    expect(res.statusCode, res.body).toBe(201);
    driver = res.json() as DriverRecord;
    expect(driver.dateOfBirth).toBe('1987-04-12');
    expect(driver.updatedAt).toBeTruthy();
    const read = (await call('GET', `${BASE}/drivers/${driver.id}`)).json() as DriverRecord;
    expect(read.dateOfBirth).toBe('1987-04-12');
    const audit = (await call('GET', `${BASE}/admin/audit?entityType=driver&entityId=${driver.id}&pageSize=20`)).json() as {
      data: Array<{ action: string; changes: Array<{ field: string; new: string | null }> }>;
    };
    const created = audit.data.find((e) => e.action === 'create');
    expect(created?.changes).toEqual(expect.arrayContaining([{ field: 'dateOfBirth', old: null, new: '1987-04-12' }]));
  });

  it('a driver created without one reads null', async (ctx) => {
    if (!ready) ctx.skip();
    const res = await call('POST', `${BASE}/drivers`, body({ email: `dob.n.${stamp}@example.com`, lastName: `NoDob${stamp}` }));
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as DriverRecord).dateOfBirth).toBeNull();
  });

  it('edits the date of birth with the version read, audits old and new, and refuses a stale save', async (ctx) => {
    if (!ready) ctx.skip();
    const res = await call('PATCH', `${BASE}/drivers/${driver.id}`, { dateOfBirth: '1988-05-13', expectedUpdatedAt: driver.updatedAt });
    expect(res.statusCode, res.body).toBe(200);
    const edited = res.json() as DriverRecord;
    expect(edited.dateOfBirth).toBe('1988-05-13');
    expect(edited.updatedAt).not.toBe(driver.updatedAt);

    // The token read before that save is now stale: 409, and the value is untouched.
    const stale = await call('PATCH', `${BASE}/drivers/${driver.id}`, { dateOfBirth: '1990-01-01', expectedUpdatedAt: driver.updatedAt });
    expect(stale.statusCode).toBe(409);
    expect(((await call('GET', `${BASE}/drivers/${driver.id}`)).json() as DriverRecord).dateOfBirth).toBe('1988-05-13');

    // Refused by the age rule on edit too.
    const young = await call('PATCH', `${BASE}/drivers/${driver.id}`, { dateOfBirth: '2020-01-01', expectedUpdatedAt: edited.updatedAt });
    expect(young.statusCode).toBe(422);

    const audit = (await call('GET', `${BASE}/admin/audit?entityType=driver&entityId=${driver.id}&pageSize=20`)).json() as {
      data: Array<{ action: string; changes: Array<{ field: string; old: string | null; new: string | null }> }>;
    };
    const update = audit.data.find((e) => e.action === 'update');
    expect(update?.changes).toEqual([{ field: 'dateOfBirth', old: '1987-04-12', new: '1988-05-13' }]);

    // Cleared with null.
    const cleared = await call('PATCH', `${BASE}/drivers/${driver.id}`, { dateOfBirth: null, expectedUpdatedAt: edited.updatedAt });
    expect(cleared.statusCode, cleared.body).toBe(200);
    expect((cleared.json() as DriverRecord).dateOfBirth).toBeNull();
  });

  it('refuses the edit without drivers.edit', async (ctx) => {
    if (!ready) ctx.skip();
    const res = await call('PATCH', `${BASE}/drivers/${driver.id}`, { dateOfBirth: '1987-04-12' }, 'operations');
    expect(res.statusCode).toBe(403);
  });

  it('another company cannot read or edit the driver', async (ctx) => {
    if (!ready) ctx.skip();
    const outsider = { ...demoPrincipal('admin'), companyId: `co_other_${stamp}` };
    const service = app.get(DriversService);
    expect(await service.find(outsider, driver.id)).toBeNull();
    await expect(service.update(outsider, driver.id, { dateOfBirth: '1980-01-01' })).rejects.toMatchObject({ status: 404 });
    expect(((await call('GET', `${BASE}/drivers/${driver.id}`)).json() as DriverRecord).dateOfBirth).toBeNull();
  });
});
