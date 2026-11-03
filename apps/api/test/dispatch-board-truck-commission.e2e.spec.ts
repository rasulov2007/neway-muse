import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import { addDays, weekStartMonday, type DailyBoard, type DispatcherRotationReport, type RosterRow, type SalaryReport, type WeeklyBoard } from '@neway/shared';
import { eq } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { dispatchRoster, dispatchRosterAssignments } from '../src/database/schema/dispatch-ops';

/**
 * Owner, 2026-10-26, end to end on the local database:
 *   - a dispatcher with no truck is not on the Daily board, the Weekly board, the Salary Report
 *     or the rotation report; once a truck is assigned they are, and a driver without a truck in a
 *     team that has one stays as before;
 *   - a past week with money of theirs still shows them;
 *   - Commission is $0 until the week has gross: an adjustment waits for gross, a manual approved
 *     amount stays (the admin's explicit choice), and the band, grand total and Salary Report agree.
 * The rows this spec makes are removed from the board at the end (never deleted).
 */
describe('Dispatch boards: no truck, no team; no gross, no commission (e2e)', () => {
  let app: NestFastifyApplication;
  let companyId = '';
  let today = '';
  let thisWeek = '';
  let lastWeek = '';
  const tag = Date.now().toString(36).toUpperCase();
  const low = tag.toLowerCase();
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
  const salary = async (week: string) => {
    const res = await call('GET', `/api/v1/dispatch/salary?kind=week&date=${week}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as SalaryReport;
  };
  const add = async (name: string, team: string, truckUnit: string | null) => {
    const res = await call('POST', '/api/v1/dispatch/roster', { name, dispatcherId: team, dispatcherName: team.toUpperCase(), truckUnit });
    expect(res.statusCode, res.body).toBe(201);
    const row = res.json() as RosterRow;
    made.push(row.id);
    return row;
  };
  const typeAmount = async (rowId: string, day: string, value: string) => {
    const res = await call('PUT', '/api/v1/dispatch/board/cells', { cells: [{ driverId: rowId, day, column: 'amount', value }] });
    expect(res.statusCode, res.body).toBe(200);
  };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    today = (await daily('2026-01-01')).today;
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

  it('a dispatcher with no truck is on no board; with a truck the whole team shows, truckless drivers too', async () => {
    const team = `e2e_nt_${low}`;
    const bare = await add(`E2E BARE ${tag}`, team, null);
    const [day, week] = await Promise.all([daily(today), weekly(thisWeek)]);
    expect(day.rows.some((r) => r.driverId === bare.id)).toBe(false);
    expect(day.teams.some((t) => t.dispatcherId === team)).toBe(false);
    expect(week.rows.some((r) => r.driverId === bare.id)).toBe(false);
    expect(week.teams.some((t) => t.dispatcherId === team)).toBe(false);
    expect((await salary(thisWeek)).teams.some((t) => t.dispatcherId === team)).toBe(false);
    const rot = (await call('GET', `/api/v1/dispatch/rotation?from=${lastWeek}&to=${today}`)).json() as DispatcherRotationReport;
    expect(rot.rows.some((r) => r.dispatcherId === team)).toBe(false);
    // The roster (what the dispatcher pickers and the roster dialogs read) still has the row.
    const roster = (await call('GET', '/api/v1/dispatch/roster')).json() as RosterRow[];
    expect(roster.some((r) => r.id === bare.id)).toBe(true);

    // The first truck arrives: the team shows, with its truckless driver as before.
    const trucked = await add(`E2E TRUCKED ${tag}`, team, `NT${tag}`);
    const [day2, week2] = await Promise.all([daily(today), weekly(thisWeek)]);
    expect(day2.teams.find((t) => t.dispatcherId === team)?.driverCount).toBe(2);
    expect(day2.rows.filter((r) => r.dispatcherId === team).map((r) => r.driverId).sort()).toEqual([bare.id, trucked.id].sort());
    expect(week2.rows.filter((r) => r.dispatcherId === team).map((r) => r.driverId).sort()).toEqual([bare.id, trucked.id].sort());
    expect(week2.teams.find((t) => t.dispatcherId === team)?.trucks).toBe(2);
    const rot2 = (await call('GET', `/api/v1/dispatch/rotation?from=${lastWeek}&to=${today}`)).json() as DispatcherRotationReport;
    expect(rot2.rows.some((r) => r.dispatcherId === team)).toBe(true);
  });

  it('a past week with money of theirs still shows a dispatcher who has no truck', async () => {
    const team = `e2e_pw_${low}`;
    const db = app.get(DatabaseService).db;
    const probe = await add(`E2E PROBE ${tag}`, `e2e_probe_${low}`, `P${tag}`);
    const [found] = await db.select({ companyId: dispatchRoster.companyId }).from(dispatchRoster).where(eq(dispatchRoster.id, probe.id));
    companyId = found!.companyId;
    const id = `dbr_e2e_pw_${low}`;
    const madeAt = new Date(`${lastWeek}T15:00:00Z`);
    await db.insert(dispatchRoster).values({ id, companyId, name: `E2E PAST ${tag}`, dispatcherId: team, dispatcherName: team.toUpperCase(), createdAt: madeAt, updatedAt: madeAt });
    await db.insert(dispatchRosterAssignments).values({ id: `dra_e2e_pw_${low}`, companyId, rosterId: id, effectiveFrom: lastWeek, dispatcherId: team, dispatcherName: team.toUpperCase(), by: 'e2e', at: madeAt });
    made.push(id);
    expect((await weekly(lastWeek)).rows.some((r) => r.driverId === id)).toBe(false);

    await typeAmount(id, lastWeek, '1500');
    const last = await weekly(lastWeek);
    expect(last.rows.find((r) => r.driverId === id)?.total).toBe(1500);
    expect(last.teams.some((t) => t.dispatcherId === team)).toBe(true);
    expect((await salary(lastWeek)).teams.find((t) => t.dispatcherId === team)?.grossCents).toBe(150_000);
    // This week holds nothing of theirs, and there is still no truck.
    expect((await weekly(thisWeek)).teams.some((t) => t.dispatcherId === team)).toBe(false);
  });

  it('Commission is $0 until the week has gross: an adjustment waits, a manual amount stays', async () => {
    const team = `e2e_cm_${low}`;
    const row = await add(`E2E COMM ${tag}`, team, `CM${tag}`);
    const override = (body: Record<string, unknown>) =>
      call('PUT', '/api/v1/dispatch/board/commission/override', { rosterId: row.id, weekStart: thisWeek, reason: 'e2e check', ...body });
    const look = async () => {
      const [board, report] = await Promise.all([weekly(thisWeek), salary(thisWeek)]);
      const r = board.rows.find((x) => x.driverId === row.id)!;
      return { r, band: board.teams.find((t) => t.dispatcherId === team)!, report: report.teams.find((t) => t.dispatcherId === team) };
    };

    // No gross, no override: $0, No gross.
    let { r, band, report } = await look();
    expect(r.total).toBe(0);
    expect(r.commission).toMatchObject({ status: 'no_gross', calculatedCents: 0, payableCents: 0 });

    // An adjustment on a week with no gross is held: still $0 on the cell, the band and the report.
    const adj = await override({ mode: 'adjustment', amountCents: 5_000, expectedVersion: null });
    expect(adj.statusCode, adj.body).toBe(200);
    ({ r, band, report } = await look());
    expect(r.commission).toMatchObject({ payableCents: 0, adjustmentHeld: true, override: { mode: 'adjustment', amountCents: 5_000 } });
    expect(band.commissionCents).toBe(0);
    expect(report?.commissionCents).toBe(0);
    expect(report?.trucks.find((t) => t.rosterId === row.id)?.payableCents).toBe(0);

    // Gross arrives but the week misses Plan Adj (owner 2026-10-27: "No payment · missed Plan Adj"):
    // the week still pays nothing, so the adjustment stays held.
    await typeAmount(row.id, thisWeek, '1000');
    ({ r, band, report } = await look());
    expect(r.total).toBe(1000);
    expect(r.commission).toMatchObject({ calculatedCents: 0, payableCents: 0, adjustmentHeld: true });
    expect(band.commissionCents).toBe(0);
    expect(report?.commissionCents).toBe(0);

    // Gross typed away again, and a manual approved amount: the admin's explicit choice stays.
    await typeAmount(row.id, thisWeek, '0');
    const version = r.commission!.override!.version;
    const amount = await override({ mode: 'amount', amountCents: 25_000, expectedVersion: version });
    expect(amount.statusCode, amount.body).toBe(200);
    ({ r, band, report } = await look());
    expect(r.total).toBe(0);
    expect(r.commission).toMatchObject({ status: 'no_gross', calculatedCents: 0, payableCents: 25_000, adjustmentHeld: false, override: { mode: 'amount' } });
    expect(band.commissionCents).toBe(25_000);
    expect(report?.commissionCents).toBe(25_000);
  });
});
