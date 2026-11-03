import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { addDays, weekStartMonday, type DailyBoard, type DispatchTeamMembers, type RosterRow, type WeeklyBoard } from '@neway/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { dispatchAllocations, dispatchAudit, dispatchRoster, dispatchRosterAssignments } from '../src/database/schema/dispatch-ops';
import { drivers } from '../src/database/schema/roster';
import { RosterService } from '../src/modules/dispatch-board/roster.service';
import { splitTeamPay } from '../src/modules/dispatch-board/salary.service';
import { loadTeamNames } from '../src/modules/dispatch-board/team-names';

/**
 * Separate team (owner, 2026-10-28): the board asks who stays, from which week the one who stays is
 * solo, why, and whether the other comes back - from that day it is a team again. Separate
 * dispatchers: the one who stays is paid 100 % of the team commission, 50/50 again from the return day.
 */
describe('Separate team and Separate dispatchers (e2e)', () => {
  let app: NestFastifyApplication;
  let companyId = '';
  let today = '';
  let thisWeek = '';
  let lastWeek = '';
  const tag = Date.now().toString(36).toUpperCase();
  const t = tag.toLowerCase();
  const TEAM = `e2e_sep_team_${t}`;
  const made: string[] = [];

  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json' }, ...(payload ? { payload } : {}) });
  const weekly = async (week: string) => {
    const res = await call('GET', `/api/v1/dispatch/board/weekly?week=${week}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as WeeklyBoard;
  };
  const daily = async (day: string) => {
    const res = await call('GET', `/api/v1/dispatch/board/daily?day=${day}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as DailyBoard;
  };
  const roster = async () => (await call('GET', '/api/v1/dispatch/roster')).json() as RosterRow[];
  const rowOf = async (id: string) => (await roster()).find((r) => r.id === id)!;

  const seedRow = async (id: string, name: string, coDriver: string | null, truck: string, driverId: string | null = null) => {
    const db = app.get(DatabaseService).db;
    const since = addDays(thisWeek, -21);
    const madeAt = new Date(`${since}T15:00:00Z`);
    await db.insert(dispatchRoster).values({ id, companyId, driverId, name, coDriver, truckUnit: truck, dispatcherId: TEAM, dispatcherName: 'E2E DARYL / E2E TAVI', createdAt: madeAt, updatedAt: madeAt });
    await db.insert(dispatchRosterAssignments).values({ id: `dra_${id}`, companyId, rosterId: id, effectiveFrom: since, dispatcherId: TEAM, dispatcherName: 'E2E DARYL / E2E TAVI', truckUnit: truck, coDriver, by: 'e2e', at: madeAt });
    made.push(id);
  };
  const driverFile = (id: string, first: string, last: string) => ({
    id, companyId, driverNumber: id, firstName: first, lastName: last, phone: '5550000000', email: `${id}@example.test`, driverType: 'company',
    cdlState: 'OH', cdlClass: 'A', cdlNumber: id, cdlExpiresOn: '2028-01-01', cdlStatus: 'valid', medicalCardStatus: 'valid', hireDate: '2026-01-01',
    status: 'available', dispatcherId: TEAM, dispatcherName: 'E2E DARYL / E2E TAVI', homeCity: 'Columbus', homeState: 'OH', payPlanKind: 'percentage',
  });

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    today = (await daily('2026-01-01')).today;
    thisWeek = weekStartMonday(today);
    lastWeek = addDays(thisWeek, -7);
    const probe = await call('POST', '/api/v1/dispatch/roster', { name: `E2E SEP PROBE ${tag}`, dispatcherId: TEAM, dispatcherName: 'E2E DARYL / E2E TAVI' });
    expect(probe.statusCode, probe.body).toBe(201);
    made.push((probe.json() as RosterRow).id);
    const [found] = await app.get(DatabaseService).db.select({ companyId: dispatchRoster.companyId }).from(dispatchRoster).where(eq(dispatchRoster.id, made[0]!));
    companyId = found!.companyId;
  }, 120_000);

  afterAll(async () => {
    app.get(RosterService).clock = () => new Date();
    const rows = await roster();
    for (const id of made) {
      const row = rows.find((r) => r.id === id);
      if (row && !row.unassignedAt) await call('POST', `/api/v1/dispatch/roster/${id}/remove-from-board`, { reason: 'e2e test row', fromWeek: thisWeek, expectedVersion: row.version });
    }
    await app.close();
  });

  it('the row’s driver stays: solo from last week, the team before, the partner back from the return day', async () => {
    const id = `dbr_e2e_sep_a_${t}`;
    const partner = `E2E PARTNER ${tag}`;
    await seedRow(id, `E2E STAYER ${tag}`, partner, '9911');
    const returnsOn = addDays(thisWeek, 9);
    const res = await call('POST', `/api/v1/dispatch/roster/${id}/separate`, { stays: 'driver', fromWeek: lastWeek, reason: 'Partner went home', returnsOn, expectedVersion: (await rowOf(id)).version });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as RosterRow).coDriver).toBeNull();
    const unitIn = (b: WeeklyBoard) => b.rows.find((r) => r.driverId === id)?.unit;
    expect(unitIn(await weekly(addDays(lastWeek, -7)))).toBe('team');
    expect(unitIn(await weekly(lastWeek))).toBe('solo');
    expect(unitIn(await weekly(thisWeek))).toBe('solo');
    const db = app.get(DatabaseService).db;
    const [line] = await db.select().from(dispatchAudit).where(and(eq(dispatchAudit.entityId, id), eq(dispatchAudit.action, 'separate-team')));
    expect(JSON.parse(line!.after!)).toMatchObject({ leaves: partner, soloFrom: lastWeek, returnsOn, reason: 'Partner went home' });
    // A second split while solo is refused.
    const again = await call('POST', `/api/v1/dispatch/roster/${id}/separate`, { stays: 'driver', fromWeek: thisWeek, reason: 'again', expectedVersion: (await rowOf(id)).version });
    expect(again.statusCode).toBe(422);
    // The return day comes: the row is a team again, without anybody touching it.
    const roster = app.get(RosterService);
    roster.clock = () => new Date(`${returnsOn}T16:00:00Z`);
    const rows = await roster.rows(companyId);
    expect(rows.find((r) => r.id === id)?.coDriver).toBe(partner);
    roster.clock = () => new Date();
  });

  it('the co-driver stays: their own row takes the team and the truck; the driver who left is in Unassigned drivers', async () => {
    const db = app.get(DatabaseService).db;
    await db.insert(drivers).values([driverFile(`drv_sep_l_${t}`, 'E2E Leaver', tag), driverFile(`drv_sep_s_${t}`, 'E2E Keeper', tag)] as never);
    const leaverRow = `dbr_e2e_sep_l_${t}`;
    await seedRow(leaverRow, `E2E Leaver ${tag}`, `E2E Keeper ${tag}`, '9922', `drv_sep_l_${t}`);
    const res = await call('POST', `/api/v1/dispatch/roster/${leaverRow}/separate`, { stays: 'co_driver', fromWeek: thisWeek, reason: 'Quit the company', expectedVersion: (await rowOf(leaverRow)).version });
    expect(res.statusCode, res.body).toBe(201);
    const keeper = res.json() as RosterRow;
    made.push(keeper.id);
    expect(keeper.driverId).toBe(`drv_sep_s_${t}`);
    expect(keeper.dispatcherId).toBe(TEAM);
    expect(keeper.truckUnit).toBe('9922');
    expect(keeper.coDriver).toBeNull();
    expect((await rowOf(leaverRow)).dispatcherId).toBe('');
    const board = await daily(today);
    expect(board.rows.find((r) => r.driverId === keeper.id)?.dispatcherId).toBe(TEAM);
    expect(board.rows.find((r) => r.driverId === leaverRow)?.dispatcherId ?? '').toBe('');
  });

  it('Separate dispatchers: 100 % to the one who stays from that week, 50/50 again from the return day, and the board names the one who stays', async () => {
    const members = await call('GET', `/api/v1/dispatch/teams/${TEAM}/members`);
    expect(members.statusCode, members.body).toBe(200);
    const m = members.json() as DispatchTeamMembers;
    expect(m.members.map((x) => [x.name, x.sharePct])).toEqual([['E2E DARYL', 50], ['E2E TAVI', 50]]);
    const dave = m.members.find((x) => x.name === 'E2E DARYL')!;
    const nextWeek = addDays(thisWeek, 7);
    const res = await call('POST', `/api/v1/dispatch/teams/${TEAM}/separate`, { staysKey: dave.key, fromWeek: lastWeek, reason: 'Tavi on leave', returnsOn: nextWeek });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as DispatchTeamMembers).inForce).toEqual([{ name: 'E2E DARYL', sharePct: 100 }]);
    const db = app.get(DatabaseService).db;
    const rows = (await db.select().from(dispatchAllocations).where(eq(dispatchAllocations.dispatcherId, TEAM)))
      .map((r) => ({ dispatcherId: r.dispatcherId, effectiveFrom: String(r.effectiveFrom), shares: JSON.parse(r.shares) }))
      .sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
    const pay = splitTeamPay(rows, TEAM, addDays(nextWeek, 6), [
      { weekStart: addDays(lastWeek, -7), commissionCents: 100_000 },
      { weekStart: lastWeek, commissionCents: 100_000 },
      { weekStart: thisWeek, commissionCents: 100_000 },
      { weekStart: nextWeek, commissionCents: 100_000 },
    ], 0);
    const cents = Object.fromEntries((pay?.allocation ?? []).map((a) => [a.name, a.payableCents]));
    // Before the split there was no split row: the period-end 50/50 applies; then 100 % Dave for two weeks; 50/50 again.
    expect(cents).toEqual({ 'E2E DARYL': 50_000 + 100_000 + 100_000 + 50_000, 'E2E TAVI': 50_000 + 50_000 });
    const names = await loadTeamNames(db, companyId);
    expect(names(TEAM).nickname).toBe('E2E DARYL');
    const [line] = await db.select().from(dispatchAudit).where(and(eq(dispatchAudit.entityId, TEAM), eq(dispatchAudit.action, 'separate-dispatchers')));
    expect(JSON.parse(line!.after!)).toMatchObject({ stays: 'E2E DARYL', leaves: ['E2E TAVI'], reason: 'Tavi on leave' });
  });
});
