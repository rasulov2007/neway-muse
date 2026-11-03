import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import type { DriverRecord, DriverTeamList, DriverTeamStanding } from '@neway/shared';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';

/**
 * Team or Solo (owner, 2026-10-25), end to end over HTTP on the local database. Needs migration
 * 0074 (driver_teams) applied to that database; without the table every case is skipped rather
 * than failed, so the suite stays honest on a database that has not been migrated yet.
 * Nothing is deleted: the spec leaves both drivers Solo with the ended pairing on record.
 */
describe('Driver teams (e2e)', () => {
  let app: NestFastifyApplication;
  let ready = false;
  let a: DriverRecord;
  let b: DriverRecord;
  let c: DriverRecord;
  const call = (method: 'GET' | 'POST', url: string, payload?: unknown, role?: string) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json', ...(role ? { 'x-demo-role': role } : {}) }, ...(payload ? { payload } : {}) });

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const found = await app.get(DatabaseService).db.execute(sql`select to_regclass('driver_teams') as t`);
    ready = Boolean((found as unknown as Array<{ t: string | null }>)[0]?.t);
    if (!ready) return;
    const list = (await call('GET', '/api/v1/drivers?pageSize=1000')).json() as { data: DriverRecord[] };
    const teams = (await call('GET', '/api/v1/drivers/teams')).json() as DriverTeamList;
    const paired = new Set(teams.teams.map((t) => t.driverId));
    const free = list.data.filter((d) => !paired.has(d.id) && !['terminated', 'inactive'].includes(d.status));
    if (free.length < 3) throw new Error('The local database needs three unpaired active drivers');
    [a, b, c] = free as [DriverRecord, DriverRecord, DriverRecord];
  });

  afterAll(async () => {
    if (ready && a) {
      const s = (await call('GET', `/api/v1/drivers/${a.id}/team`)).json() as DriverTeamStanding;
      if (s.current) await call('POST', `/api/v1/drivers/${a.id}/team/${s.current.pairId}/end`, { version: s.current.version, reason: 'E2E team spec cleanup' });
    }
    await app?.close();
  });

  it('refuses a pairing without the permission', async (ctx) => {
    if (!ready) ctx.skip();
    expect((await call('POST', `/api/v1/drivers/${a.id}/team`, { partnerId: b.id }, 'operations')).statusCode).toBe(403);
  });

  let pairId = '';
  it('pairs two drivers: both read Team with each other, the list carries both sides', async (ctx) => {
    if (!ready) ctx.skip();
    const res = await call('POST', `/api/v1/drivers/${a.id}/team`, { partnerId: b.id, note: 'E2E team' });
    expect(res.statusCode, res.body).toBe(201);
    const s = res.json() as DriverTeamStanding;
    expect(s.current?.partnerId).toBe(b.id);
    pairId = s.current!.pairId;
    const other = (await call('GET', `/api/v1/drivers/${b.id}/team`)).json() as DriverTeamStanding;
    expect(other.current?.partnerId).toBe(a.id);
    const list = (await call('GET', '/api/v1/drivers/teams')).json() as DriverTeamList;
    expect(list.teams.filter((t) => t.pairId === pairId)).toHaveLength(2);
  });

  it('refuses a second partner for either driver with 409', async (ctx) => {
    if (!ready) ctx.skip();
    const res = await call('POST', `/api/v1/drivers/${c.id}/team`, { partnerId: b.id });
    expect(res.statusCode).toBe(409);
    expect((res.json() as { detail: string }).detail).toMatch(/already in a team with/);
  });

  it('unpairs with a reason; a stale version is refused; both are Solo and audited', async (ctx) => {
    if (!ready) ctx.skip();
    expect((await call('POST', `/api/v1/drivers/${a.id}/team/${pairId}/end`, { version: 99, reason: 'stale' })).statusCode).toBe(409);
    const res = await call('POST', `/api/v1/drivers/${b.id}/team/${pairId}/end`, { version: 1, reason: 'E2E split' });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as DriverTeamStanding).current).toBeNull();
    expect(((await call('GET', `/api/v1/drivers/${a.id}/team`)).json() as DriverTeamStanding).current).toBeNull();
    for (const d of [a, b]) {
      const audit = (await call('GET', `/api/v1/admin/audit?entityType=driver&entityId=${d.id}&pageSize=10`)).json() as { data: Array<{ action: string }> };
      expect(audit.data.map((e) => e.action)).toEqual(expect.arrayContaining(['driver_team_paired', 'driver_team_unpaired']));
    }
  });
});
