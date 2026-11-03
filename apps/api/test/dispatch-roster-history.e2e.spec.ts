import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { addDays, weekStartMonday, type DailyBoard, type RosterRow, type WeeklyBoard } from '@neway/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { dispatchRoster, dispatchRosterAssignments } from '../src/database/schema/dispatch-ops';

/**
 * Board roster history (owner, 2026-10-01), end to end on the local database:
 *   - a driver moved to another dispatcher keeps earlier weeks (and days) under the old team;
 *   - a new driver is absent from last week and present this week;
 *   - an unassigned driver sits in Unassigned drivers from this week on and under his team last week.
 * The rows this spec makes are removed from the board at the end (never deleted).
 */
describe('Dispatch roster history (e2e)', () => {
  let app: NestFastifyApplication;
  let companyId = '';
  let today = '';
  let thisWeek = '';
  let lastWeek = '';
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
  // Every team here has a truck: a dispatcher with none is not on the boards (owner, 2026-10-26).
  const add = async (name: string, team: string, truckUnit: string | null = `T${tag}${made.length}`) => {
    const res = await call('POST', '/api/v1/dispatch/roster', { name, dispatcherId: `e2e_${team}`, dispatcherName: `E2E ${team.toUpperCase()}`, truckUnit });
    expect(res.statusCode, res.body).toBe(201);
    const row = res.json() as RosterRow;
    made.push(row.id);
    return row;
  };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    today = (await daily('2026-01-01')).today; // the server's Eastern today, whatever day is asked for
    thisWeek = weekStartMonday(today);
    lastWeek = addDays(thisWeek, -7);
  });

  afterAll(async () => {
    const rows = (await call('GET', '/api/v1/dispatch/roster')).json() as RosterRow[];
    for (const id of made) {
      const row = rows.find((r) => r.id === id);
      if (row && !row.unassignedAt)
        await call('POST', `/api/v1/dispatch/roster/${id}/remove-from-board`, { reason: 'e2e test row', fromWeek: thisWeek, expectedVersion: row.version });
    }
    await app.close();
  });

  it('a new driver: absent from last week and yesterday, present this week and today', async () => {
    const row = await add(`E2E NEW ${tag}`, 'team_a');
    const [last, current] = await Promise.all([weekly(lastWeek), weekly(thisWeek)]);
    expect(last.rows.some((r) => r.driverId === row.id)).toBe(false);
    expect(last.unassigned.some((r) => r.driverId === row.id)).toBe(false);
    expect(current.rows.some((r) => r.driverId === row.id)).toBe(true);
    expect((await daily(addDays(today, -1))).rows.some((r) => r.driverId === row.id)).toBe(false);
    expect((await daily(today)).rows.some((r) => r.driverId === row.id)).toBe(true);
  });

  it('a driver with no history (as the roster migration left them), moved today: earlier weeks stay with the old team', async () => {
    const probe = await add(`E2E PROBE ${tag}`, 'team_a');
    const db = app.get(DatabaseService).db;
    const [found] = await db.select({ companyId: dispatchRoster.companyId }).from(dispatchRoster).where(eq(dispatchRoster.id, probe.id));
    companyId = found!.companyId;
    // A board row made three weeks ago with no assignment history - the shape the owner hit.
    const id = `dbr_e2e_${tag.toLowerCase()}`;
    const madeAt = new Date(Date.now() - 21 * 86_400_000);
    await db.insert(dispatchRoster).values({
      id,
      companyId,
      name: `E2E MOVED ${tag}`,
      dispatcherId: 'e2e_team_a',
      dispatcherName: 'E2E TEAM_A',
      truckUnit: `M${tag}`,
      createdAt: madeAt,
      updatedAt: madeAt,
    });
    made.push(id);

    const before = await weekly(lastWeek);
    expect(before.rows.find((r) => r.driverId === id)?.dispatcherId).toBe('e2e_team_a');

    const rows = (await call('GET', '/api/v1/dispatch/roster')).json() as RosterRow[];
    const version = rows.find((r) => r.id === id)!.version;
    const moved = await call('PUT', `/api/v1/dispatch/roster/${id}`, { dispatcherId: 'e2e_team_b', dispatcherName: 'E2E TEAM_B', reason: 'Driver asked for a dispatcher change', expectedVersion: version });
    expect(moved.statusCode, moved.body).toBe(200);

    const [last, current, twoBack] = await Promise.all([weekly(lastWeek), weekly(thisWeek), weekly(addDays(lastWeek, -7))]);
    expect(last.rows.find((r) => r.driverId === id)?.dispatcherId).toBe('e2e_team_a');
    expect(twoBack.rows.find((r) => r.driverId === id)?.dispatcherId).toBe('e2e_team_a');
    expect(current.rows.find((r) => r.driverId === id)?.dispatcherId).toBe('e2e_team_b');
    // The daily board: the day before the move under the old team, today under the new one.
    expect((await daily(addDays(today, -1))).rows.find((r) => r.driverId === id)?.dispatcherId).toBe('e2e_team_a');
    expect((await daily(today)).rows.find((r) => r.driverId === id)?.dispatcherId).toBe('e2e_team_b');

    // The history the move wrote: a first row for where it sat, then the move - both audited.
    const history = await db.select().from(dispatchRosterAssignments).where(eq(dispatchRosterAssignments.rosterId, id));
    expect(history.map((h) => [String(h.effectiveFrom), h.dispatcherId]).sort()).toEqual([
      [weekStartMonday(addDays(today, -21)), 'e2e_team_a'],
      [today, 'e2e_team_b'],
    ]);
  });

  it('unassign from this week: in Unassigned drivers this week, under the team last week', async () => {
    // A driver on the board since last week, with the first assignment the backfill gives such a row.
    const db = app.get(DatabaseService).db;
    const id = `dbr_e2e_un_${tag.toLowerCase()}`;
    const madeAt = new Date(`${lastWeek}T15:00:00Z`);
    await db.insert(dispatchRoster).values({ id, companyId, name: `E2E UNASSIGN ${tag}`, dispatcherId: 'e2e_team_a', dispatcherName: 'E2E TEAM_A', truckUnit: `U${tag}`, createdAt: madeAt, updatedAt: madeAt });
    await db.insert(dispatchRosterAssignments).values({ id: `dra_e2e_un_${tag.toLowerCase()}`, companyId, rosterId: id, effectiveFrom: lastWeek, dispatcherId: 'e2e_team_a', dispatcherName: 'E2E TEAM_A', truckUnit: `U${tag}`, by: 'e2e', at: madeAt });
    made.push(id);
    expect((await weekly(lastWeek)).rows.some((r) => r.driverId === id)).toBe(true);
    const row = ((await call('GET', '/api/v1/dispatch/roster')).json() as RosterRow[]).find((r) => r.id === id)!;

    const res = await call('POST', `/api/v1/dispatch/roster/${row.id}/unassign`, { reason: 'Left the company', fromWeek: thisWeek, expectedVersion: row.version });
    expect(res.statusCode, res.body).toBe(201);
    const [last, current] = await Promise.all([weekly(lastWeek), weekly(thisWeek)]);
    expect(last.rows.find((r) => r.driverId === row.id)?.dispatcherId).toBe('e2e_team_a');
    // Never off the board: from the week he is unassigned from he has no dispatcher.
    expect(current.rows.find((r) => r.driverId === row.id)?.dispatcherId).toBe('');
    expect((await daily(today)).rows.find((r) => r.driverId === row.id)?.dispatcherId).toBe('');
  });
});
