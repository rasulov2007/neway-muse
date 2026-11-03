import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { addDays, weekStartMonday, type DailyBoard, type OffBoardDriver, type RosterRow, type WeeklyBoard } from '@neway/shared';
import { and, eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { dispatchAudit, dispatchRoster, dispatchRosterAssignments } from '../src/database/schema/dispatch-ops';
import { drivers } from '../src/database/schema/roster';

/**
 * Assign a driver to a dispatcher (owner, 2026-10-26): a driver on the Drivers page who is not on
 * the board can be found and added from the board's Add driver and from his profile. End to end
 * on the local database. Rows this spec makes are removed from the board at the end.
 */
describe('Dispatch roster: assign a driver to a dispatcher (e2e)', () => {
  let app: NestFastifyApplication;
  let companyId = '';
  let thisWeek = '';
  let lastWeek = '';
  const tag = Date.now().toString(36).toUpperCase();
  const low = tag.toLowerCase();
  const made: string[] = [];
  const TEAM_A = { dispatcherId: 'e2e_as_team_a', dispatcherName: 'E2E AS TEAM A' };
  const TEAM_B = { dispatcherId: 'e2e_as_team_b', dispatcherName: 'E2E AS TEAM B' };

  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({ method, url, headers: { 'content-type': 'application/json' }, ...(payload ? { payload } : {}) });
  const weekly = async (week: string) => {
    const res = await call('GET', `/api/v1/dispatch/board/weekly?week=${week}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as WeeklyBoard;
  };
  const roster = async () => (await call('GET', '/api/v1/dispatch/roster')).json() as RosterRow[];
  const offBoard = async () => {
    const res = await call('GET', '/api/v1/dispatch/roster/off-board');
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as OffBoardDriver[];
  };
  const assign = (body: Record<string, unknown>) => call('POST', '/api/v1/dispatch/roster/assign', body);

  const driverFile = async (label: string, first: string, last: string) => {
    const db = app.get(DatabaseService).db;
    const id = `drv_e2e_as_${label}_${low}`;
    await db.insert(drivers).values({
      id,
      companyId,
      driverNumber: `E2E-AS-${label.toUpperCase()}-${tag}`,
      firstName: first,
      lastName: last,
      phone: '5550002112',
      email: `e2e-as-${label}-${low}@example.test`,
      driverType: 'company',
      cdlState: 'IL',
      cdlClass: 'A',
      cdlExpiresOn: '2030-01-01',
      cdlStatus: 'missing',
      medicalCardStatus: 'missing',
      hireDate: '2026-01-01',
      status: 'active',
      dispatcherId: '',
      dispatcherName: '',
      currentTruckId: null,
      homeCity: 'Chicago',
      homeState: 'IL',
      payPlanKind: 'flat_rate',
    });
    return id;
  };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    const today = ((await call('GET', '/api/v1/dispatch/board/daily?day=2026-01-01')).json() as DailyBoard).today;
    thisWeek = weekStartMonday(today);
    lastWeek = addDays(thisWeek, -7);
    const probe = await call('POST', '/api/v1/dispatch/roster', { name: `E2E AS PROBE ${tag}`, ...TEAM_A });
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

  it('a driver file with no board row is offered, found by D-number, and added under the team from this week only', async () => {
    const driverId = await driverFile('file', 'Jerry', `Ashford${tag}`);
    // The id his row would take is held by an old row, so the board never made him one (the bug).
    const db = app.get(DatabaseService).db;
    await db.insert(dispatchRoster).values({ id: driverId, companyId, driverId: null, name: `E2E AS OLD ROW ${tag}`, dispatcherId: '', dispatcherName: '', unassignedAt: new Date(), unassignedReason: 'old', createdAt: new Date(), updatedAt: new Date() });
    made.push(driverId);

    const offered = (await offBoard()).find((o) => o.driverId === driverId);
    expect(offered).toMatchObject({ kind: 'file', rosterId: null, driverNumber: `E2E-AS-FILE-${tag}`, name: `Gerald Ashford${tag}` });

    const res = await assign({ driverId, ...TEAM_A });
    expect(res.statusCode, res.body).toBe(201);
    const row = res.json() as RosterRow;
    made.push(row.id);
    expect(row.driverId).toBe(driverId);
    expect(row.id).not.toBe(driverId);
    expect(row.dispatcherId).toBe(TEAM_A.dispatcherId);
    expect(row.driverNumber).toBe(`E2E-AS-FILE-${tag}`);

    const [current, last] = await Promise.all([weekly(thisWeek), weekly(lastWeek)]);
    expect(current.rows.find((r) => r.driverId === row.id)?.dispatcherId).toBe(TEAM_A.dispatcherId);
    expect(last.rows.some((r) => r.driverId === row.id)).toBe(false);

    const history = await db.select().from(dispatchRosterAssignments).where(eq(dispatchRosterAssignments.rosterId, row.id));
    expect(history.map((h) => String(h.effectiveFrom))).toEqual([thisWeek]);
    const [line] = await db.select().from(dispatchAudit).where(and(eq(dispatchAudit.entityId, row.id), eq(dispatchAudit.action, 'add-on-assign')));
    expect(line).toBeDefined();

    // No duplicate: he is no longer offered, and a second add without the row's version is a conflict.
    expect((await offBoard()).some((o) => o.driverId === driverId)).toBe(false);
    expect((await assign({ driverId, ...TEAM_B })).statusCode).toBe(409);
    expect((await db.select().from(dispatchRoster).where(eq(dispatchRoster.driverId, driverId))).length).toBe(1);
  });

  it('a row removed from the board is offered and put back on the board under the team', async () => {
    const driverId = await driverFile('removed', 'Removed', `Driver${tag}`);
    made.push(driverId);
    let row = (await roster()).find((r) => r.driverId === driverId)!; // every driver file gets a row
    const removed = await call('POST', `/api/v1/dispatch/roster/${row.id}/remove-from-board`, { reason: 'Left for a while', fromWeek: lastWeek, expectedVersion: row.version });
    expect(removed.statusCode, removed.body).toBe(201);
    row = removed.json() as RosterRow;

    const offered = (await offBoard()).find((o) => o.rosterId === row.id)!;
    expect(offered).toMatchObject({ kind: 'removed', driverId, version: row.version });

    const res = await assign({ driverId, ...TEAM_A, expectedVersion: offered.version });
    expect(res.statusCode, res.body).toBe(201);
    const back = res.json() as RosterRow;
    expect(back.unassignedAt).toBeNull();
    expect(back.dispatcherId).toBe(TEAM_A.dispatcherId);
    expect((await weekly(thisWeek)).rows.find((r) => r.driverId === row.id)?.dispatcherId).toBe(TEAM_A.dispatcherId);
  });

  it('moving a driver from another dispatcher needs a reason and the current version', async () => {
    const driverId = await driverFile('move', 'Moving', `Driver${tag}`);
    made.push(driverId);
    const row = (await roster()).find((r) => r.driverId === driverId)!;
    const first = await assign({ driverId, ...TEAM_A, expectedVersion: row.version });
    expect(first.statusCode, first.body).toBe(201);
    const underA = first.json() as RosterRow;

    expect((await assign({ driverId, ...TEAM_B, expectedVersion: underA.version })).statusCode).toBe(422);
    expect((await assign({ driverId, ...TEAM_B, reason: 'Driver asked', expectedVersion: underA.version - 1 })).statusCode).toBe(409);
    const moved = await assign({ driverId, ...TEAM_B, reason: 'Driver asked', expectedVersion: underA.version });
    expect(moved.statusCode, moved.body).toBe(201);
    expect((moved.json() as RosterRow).dispatcherId).toBe(TEAM_B.dispatcherId);
  });

  it('a board row the sheet ran under the same name is linked, not duplicated', async () => {
    const db = app.get(DatabaseService).db;
    const sheetRow = `dbr_e2e_as_sheet_${low}`;
    await db.insert(dispatchRoster).values({ id: sheetRow, companyId, driverId: null, name: `NAMED DRIVER${tag}`, dispatcherId: '', dispatcherName: '', createdAt: new Date(), updatedAt: new Date() });
    made.push(sheetRow);
    // Assigned straight after the file is made, before any board read gives it a row of its own.
    const driverId = await driverFile('named', 'Named', `Driver${tag}`);
    made.push(driverId);
    const res = await assign({ driverId, ...TEAM_A });
    expect(res.statusCode, res.body).toBe(201);
    const row = res.json() as RosterRow;
    expect(row.id).toBe(sheetRow);
    expect(row.driverId).toBe(driverId);
    expect(row.dispatcherId).toBe(TEAM_A.dispatcherId);
  });

  it('a future week and the "no dispatcher" team are refused', async () => {
    const driverId = await driverFile('future', 'Future', `Driver${tag}`);
    made.push(driverId);
    const row = (await roster()).find((r) => r.driverId === driverId)!;
    expect((await assign({ driverId, ...TEAM_A, fromWeek: addDays(thisWeek, 7), expectedVersion: row.version })).statusCode).toBe(422);
    expect((await assign({ driverId, dispatcherId: 'none:unassigned', dispatcherName: 'x', expectedVersion: row.version })).statusCode).toBe(422);
  });
});
