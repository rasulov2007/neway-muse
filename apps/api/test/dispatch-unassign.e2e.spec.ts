import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { addDays, weekStartMonday, type DailyBoard, type RosterRow, type WeeklyBoard } from '@neway/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { dispatchAudit, dispatchRoster, dispatchRosterAssignments } from '../src/database/schema/dispatch-ops';
import { NO_DISPATCHER_ID } from '../src/modules/dispatch-board/no-dispatcher';
import { RosterService } from '../src/modules/dispatch-board/roster.service';

/**
 * Unassign = move to Unassigned drivers (owner, 2026-10-26): "whatever week I unassign him from,
 * from that week on he should leave that dispatcher and move into the Unassigned drivers group".
 * End to end on the local database. Rows this spec makes are removed from the board at the end
 * (never deleted).
 */
describe('Dispatch roster: Unassign moves the driver to Unassigned drivers (e2e)', () => {
  let app: NestFastifyApplication;
  let companyId = '';
  let today = '';
  let thisWeek = '';
  let lastWeek = '';
  let nextWeek = '';
  const tag = Date.now().toString(36).toUpperCase();
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
  const teamIn = (board: WeeklyBoard | DailyBoard, id: string) => board.rows.find((r) => r.driverId === id)?.dispatcherId;

  /** A board row under team A since three weeks ago, with the first assignment the backfill gives it. */
  const seed = async (label: string) => {
    const db = app.get(DatabaseService).db;
    const id = `dbr_e2e_ua_${label}_${tag.toLowerCase()}`;
    const since = addDays(thisWeek, -21);
    const madeAt = new Date(`${since}T15:00:00Z`);
    await db.insert(dispatchRoster).values({ id, companyId, name: `E2E UA ${label.toUpperCase()} ${tag}`, truckUnit: '9901', dispatcherId: 'e2e_ua_team_a', dispatcherName: 'E2E UA TEAM A', createdAt: madeAt, updatedAt: madeAt });
    await db.insert(dispatchRosterAssignments).values({ id: `dra_e2e_ua_${label}_${tag.toLowerCase()}`, companyId, rosterId: id, effectiveFrom: since, dispatcherId: 'e2e_ua_team_a', dispatcherName: 'E2E UA TEAM A', truckUnit: '9901', by: 'e2e', at: madeAt });
    made.push(id);
    return id;
  };
  const unassign = async (id: string, fromWeek: string, version?: number) => {
    const v = version ?? (await rowOf(id)).version;
    return call('POST', `/api/v1/dispatch/roster/${id}/unassign`, { reason: 'Driver asked for a dispatcher change', fromWeek, expectedVersion: v });
  };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    today = (await daily('2026-01-01')).today; // the server's Eastern today
    thisWeek = weekStartMonday(today);
    lastWeek = addDays(thisWeek, -7);
    nextWeek = addDays(thisWeek, 7);
    const probe = await call('POST', '/api/v1/dispatch/roster', { name: `E2E UA PROBE ${tag}`, dispatcherId: 'e2e_ua_team_a', dispatcherName: 'E2E UA TEAM A' });
    expect(probe.statusCode, probe.body).toBe(201);
    made.push((probe.json() as RosterRow).id);
    const db = app.get(DatabaseService).db;
    const [found] = await db.select({ companyId: dispatchRoster.companyId }).from(dispatchRoster).where(eq(dispatchRoster.id, made[0]!));
    companyId = found!.companyId;
  });

  afterAll(async () => {
    const rows = await roster();
    for (const id of made) {
      const row = rows.find((r) => r.id === id);
      if (row && !row.unassignedAt)
        await call('POST', `/api/v1/dispatch/roster/${id}/remove-from-board`, { reason: 'e2e test row', fromWeek: thisWeek, expectedVersion: row.version });
    }
    await app.close();
  });

  it('from this week: today he is in Unassigned drivers (daily, weekly, roster); last week keeps the old team; audited', async () => {
    const id = await seed('now');
    const res = await unassign(id, today);
    expect(res.statusCode, res.body).toBe(201);
    const after = res.json() as RosterRow;
    expect(after.dispatcherId).toBe('');
    expect(after.unassignedAt).toBeNull(); // not hidden: he stays on the boards

    const [current, last] = await Promise.all([weekly(thisWeek), weekly(lastWeek)]);
    expect(teamIn(current, id)).toBe('');
    expect(current.unassigned.some((r) => r.driverId === id)).toBe(false);
    expect(teamIn(last, id)).toBe('e2e_ua_team_a');
    expect(teamIn(await daily(today), id)).toBe('');
    expect(teamIn(await daily(addDays(thisWeek, -1)), id)).toBe('e2e_ua_team_a');

    const db = app.get(DatabaseService).db;
    const history = await db.select().from(dispatchRosterAssignments).where(eq(dispatchRosterAssignments.rosterId, id));
    const move = history.find((h) => h.dispatcherId === NO_DISPATCHER_ID)!;
    expect(String(move.effectiveFrom)).toBe(thisWeek);
    expect(move.reason).toBe('Driver asked for a dispatcher change');
    expect(move.truckUnit).toBe('9901');
    const [line] = await db.select().from(dispatchAudit).where(and(eq(dispatchAudit.entityId, id), eq(dispatchAudit.action, 'unassign')));
    expect(line).toBeDefined();
    expect(JSON.parse(line!.before!)).toMatchObject({ dispatcherId: 'e2e_ua_team_a' });
    expect(JSON.parse(line!.after!)).toMatchObject({ dispatcherId: null, fromWeek: thisWeek, takesEffect: 'now' });

    // A second Unassign from the same week is refused, not written twice.
    expect((await unassign(id, thisWeek)).statusCode).toBe(422);
  });

  it('from a past week: that week and later in Unassigned drivers, earlier weeks unchanged, a later-dated change does not bring him back', async () => {
    const id = await seed('past');
    // A truck change dated inside last week, written before the Unassign.
    const db = app.get(DatabaseService).db;
    await db.insert(dispatchRosterAssignments).values({ id: `dra_e2e_ua_t_${tag.toLowerCase()}`, companyId, rosterId: id, effectiveFrom: addDays(lastWeek, 2), dispatcherId: 'e2e_ua_team_a', dispatcherName: 'E2E UA TEAM A', truckUnit: '9902', by: 'e2e', at: new Date() });
    const res = await unassign(id, addDays(lastWeek, 3)); // any day of the week means its Monday
    expect(res.statusCode, res.body).toBe(201);

    const [twoBack, last, current] = await Promise.all([weekly(addDays(lastWeek, -7)), weekly(lastWeek), weekly(thisWeek)]);
    expect(teamIn(twoBack, id)).toBe('e2e_ua_team_a');
    expect(teamIn(last, id)).toBe('');
    expect(teamIn(current, id)).toBe('');
    expect(teamIn(await daily(addDays(lastWeek, -1)), id)).toBe('e2e_ua_team_a');
    expect(teamIn(await daily(addDays(lastWeek, 4)), id)).toBe('');
    expect((await rowOf(id)).dispatcherId).toBe('');
  });

  it('from next week: still under his dispatcher this week; the move takes effect when the week comes', async () => {
    const id = await seed('next');
    const res = await unassign(id, nextWeek);
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as RosterRow).dispatcherId).toBe('e2e_ua_team_a');
    expect(teamIn(await weekly(thisWeek), id)).toBe('e2e_ua_team_a');
    expect(teamIn(await daily(today), id)).toBe('e2e_ua_team_a');
    expect(teamIn(await weekly(nextWeek), id)).toBe('');
    expect(teamIn(await daily(addDays(nextWeek, 1)), id)).toBe('');
    // Reading the roster again today changes nothing (the dated move is not an "outside change").
    expect((await rowOf(id)).dispatcherId).toBe('e2e_ua_team_a');

    // The week comes: the first read moves the board row itself.
    const service = app.get(RosterService);
    const realClock = service.clock;
    try {
      service.clock = () => new Date(`${nextWeek}T16:00:00Z`);
      expect((await service.rows(companyId)).find((r) => r.id === id)?.dispatcherId).toBe('');
    } finally {
      service.clock = realClock;
    }
    const db = app.get(DatabaseService).db;
    const [stored] = await db.select().from(dispatchRoster).where(eq(dispatchRoster.id, id));
    expect(stored!.dispatcherId).toBe(NO_DISPATCHER_ID);
    const [took] = await db.select().from(dispatchAudit).where(and(eq(dispatchAudit.entityId, id), eq(dispatchAudit.action, 'team-change-takes-effect')));
    expect(took).toBeDefined();
  });

  it('assigning him to a dispatcher again moves him back from the chosen week; a future move is refused', async () => {
    const id = await seed('back');
    expect((await unassign(id, lastWeek)).statusCode).toBe(201);
    const row = await rowOf(id);
    expect(row.dispatcherId).toBe('');

    const future = await call('PUT', `/api/v1/dispatch/roster/${id}`, { dispatcherId: 'e2e_ua_team_b', dispatcherName: 'E2E UA TEAM B', fromWeek: nextWeek, expectedVersion: row.version });
    expect(future.statusCode, future.body).toBe(422);

    const back = await call('PUT', `/api/v1/dispatch/roster/${id}`, { dispatcherId: 'e2e_ua_team_b', dispatcherName: 'E2E UA TEAM B', fromWeek: thisWeek, expectedVersion: row.version });
    expect(back.statusCode, back.body).toBe(200);
    expect((back.json() as RosterRow).dispatcherId).toBe('e2e_ua_team_b');
    const [last, current] = await Promise.all([weekly(lastWeek), weekly(thisWeek)]);
    expect(teamIn(last, id)).toBe('');
    expect(teamIn(current, id)).toBe('e2e_ua_team_b');
    expect(teamIn(await daily(today), id)).toBe('e2e_ua_team_b');
    expect(teamIn(await weekly(addDays(lastWeek, -7)), id)).toBe('e2e_ua_team_a');
  });

  it('an earlier assignment that named no team keeps showing the old team after the Unassign', async () => {
    const id = await seed('legacy');
    const db = app.get(DatabaseService).db;
    // The shape a driver file with no dispatcher gave a first assignment: the boards read the row's team.
    await db.update(dispatchRosterAssignments).set({ dispatcherId: '', dispatcherName: '' }).where(eq(dispatchRosterAssignments.rosterId, id));
    expect(teamIn(await weekly(lastWeek), id)).toBe('e2e_ua_team_a');
    expect((await unassign(id, thisWeek)).statusCode).toBe(201);
    expect(teamIn(await weekly(lastWeek), id)).toBe('e2e_ua_team_a');
    expect(teamIn(await weekly(thisWeek), id)).toBe('');
  });

  it('a stale version is a conflict and writes nothing', async () => {
    const id = await seed('stale');
    const row = await rowOf(id);
    const res = await unassign(id, thisWeek, row.version - 1);
    expect(res.statusCode).toBe(409);
    expect((await rowOf(id)).dispatcherId).toBe('e2e_ua_team_a');
    const db = app.get(DatabaseService).db;
    const history = await db.select().from(dispatchRosterAssignments).where(eq(dispatchRosterAssignments.rosterId, id));
    expect(history.some((h) => h.dispatcherId === NO_DISPATCHER_ID)).toBe(false);
  });

  it('another company cannot unassign the row', async () => {
    const id = await seed('scope');
    const row = await rowOf(id);
    const outsider = {
      userId: 'e2e_outsider',
      userName: 'Outsider',
      companyId: 'co_e2e_not_this_one',
      companyTimezone: 'America/New_York',
      weekStart: 1,
      roles: ['administrator'],
      permissions: new Set(['dispatch.manage', 'dispatch.view']),
    };
    await expect(app.get(RosterService).unassign(outsider, id, { reason: 'Not yours', fromWeek: thisWeek, expectedVersion: row.version })).rejects.toMatchObject({ status: 404 });
    expect((await rowOf(id)).dispatcherId).toBe('e2e_ua_team_a');
  });

  it('Remove from board still takes a row off every board from that week (hidden, restorable)', async () => {
    const id = await seed('remove');
    const row = await rowOf(id);
    const res = await call('POST', `/api/v1/dispatch/roster/${id}/remove-from-board`, { reason: 'Duplicate board row', fromWeek: thisWeek, expectedVersion: row.version });
    expect(res.statusCode, res.body).toBe(201);
    expect((res.json() as RosterRow).unassignedAt).not.toBeNull();
    const current = await weekly(thisWeek);
    expect(current.rows.some((r) => r.driverId === id)).toBe(false);
    expect((await daily(today)).rows.some((r) => r.driverId === id)).toBe(false);
    expect(teamIn(await weekly(lastWeek), id)).toBe('e2e_ua_team_a');
    // Unassign is refused on a row that is off the boards.
    expect((await unassign(id, thisWeek)).statusCode).toBe(422);
  });
});
