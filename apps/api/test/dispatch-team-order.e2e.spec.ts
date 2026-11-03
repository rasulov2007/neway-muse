import type { NestFastifyApplication } from '@nestjs/platform-fastify';
import {
  weekStartMonday,
  type DailyBoard,
  type RosterRow,
  type TeamOrderView,
  type WeeklyBoard,
} from '@neway/shared';
import { and, eq, sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createApp } from '../src/app.factory';
import { AdminSeedService } from '../src/database/admin-seed.service';
import { DatabaseService } from '../src/database/database.service';
import { dispatchAudit, dispatchRoster } from '../src/database/schema/dispatch-ops';
import { storageKeyFor } from '../src/modules/state/state.service';
import { TEAM_ORDER_KEY } from '../src/modules/dispatch-board/team-order';

/**
 * Team order and TEAM n badges (owner, 2026-10-26: "ADIN is not a team, he's solo"). End to end on
 * the local database. The company's stored order is put back as it was at the end; the board rows
 * this spec makes are removed from the board (never deleted).
 */
describe('Dispatch boards: team order and badges (e2e)', () => {
  let app: NestFastifyApplication;
  let companyId = '';
  let today = '';
  let before: string | null = null;
  const tag = Date.now().toString(36).toLowerCase();
  const made: string[] = [];
  const TEAM_A = `e2e_to_a_${tag}`;
  const TEAM_B = `e2e_to_b_${tag}`;
  const SOLO = `e2e_to_solo_${tag}`;

  const call = (method: 'GET' | 'POST' | 'PUT', url: string, payload?: unknown) =>
    app.inject({
      method,
      url,
      headers: { 'content-type': 'application/json' },
      ...(payload ? { payload } : {}),
    });
  const daily = async () => {
    const res = await call('GET', `/api/v1/dispatch/board/daily?day=${today}`);
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as DailyBoard;
  };
  const view = async () => {
    const res = await call('GET', '/api/v1/dispatch/board/team-order');
    expect(res.statusCode, res.body).toBe(200);
    return res.json() as TeamOrderView;
  };
  const add = async (name: string, dispatcherId: string, dispatcherName: string) => {
    const res = await call('POST', '/api/v1/dispatch/roster', {
      name,
      dispatcherId,
      dispatcherName,
    });
    expect(res.statusCode, res.body).toBe(201);
    made.push((res.json() as RosterRow).id);
  };

  beforeAll(async () => {
    app = await createApp();
    await app.get(AdminSeedService).seed();
    await app.init();
    await app.getHttpAdapter().getInstance().ready();
    today = (await daily()).today;
    await add(`E2E TO DRIVER A ${tag}`, TEAM_A, `ZZ E2E ALPHA ${tag} / BETA`);
    await add(`E2E TO DRIVER B ${tag}`, TEAM_B, `ZZ E2E GAMMA ${tag} / DELTA`);
    await add(`E2E TO DRIVER S ${tag}`, SOLO, `AA E2E SOLO ${tag}`);
    const db = app.get(DatabaseService).db;
    const [found] = await db
      .select({ companyId: dispatchRoster.companyId })
      .from(dispatchRoster)
      .where(eq(dispatchRoster.id, made[0]!));
    companyId = found!.companyId;
    const rows = (await db.execute(
      sql`SELECT value FROM app_state WHERE key = ${storageKeyFor(companyId, TEAM_ORDER_KEY)}`,
    )) as unknown as { value: string }[];
    before = rows[0]?.value ?? null;
  });

  afterAll(async () => {
    const db = app.get(DatabaseService).db;
    const key = storageKeyFor(companyId, TEAM_ORDER_KEY);
    if (before === null) await db.execute(sql`DELETE FROM app_state WHERE key = ${key}`);
    else
      await db.execute(
        sql`UPDATE app_state SET value = ${before}, updated_at = now() WHERE key = ${key}`,
      );
    const rows = (await (await call('GET', '/api/v1/dispatch/roster')).json()) as RosterRow[];
    for (const id of made) {
      const row = rows.find((r) => r.id === id);
      if (row && !row.unassignedAt)
        await call('POST', `/api/v1/dispatch/roster/${id}/remove-from-board`, {
          reason: 'e2e test row',
          fromWeek: weekStartMonday(today),
          expectedVersion: row.version,
        });
    }
    await app.close();
  });

  it('a solo dispatcher has no TEAM number even when it sorts first; teams come before solos', async () => {
    const board = await daily();
    const solo = board.teams.find((t) => t.dispatcherId === SOLO)!;
    const a = board.teams.find((t) => t.dispatcherId === TEAM_A)!;
    expect(solo.teamNumber).toBeNull();
    expect(a.teamNumber).toEqual(expect.any(Number));
    const ids = board.teams.map((t) => t.dispatcherId);
    expect(ids.indexOf(SOLO)).toBeGreaterThan(ids.indexOf(TEAM_A));
    expect(board.rows.find((r) => r.dispatcherId === SOLO)!.teamNumber).toBeNull();
  });

  it('saving an order is version-checked, audited, and every board follows it', async () => {
    const current = await view();
    const teams = [
      TEAM_B,
      TEAM_A,
      ...current.teams.map((t) => t.dispatcherId).filter((id) => id !== TEAM_A && id !== TEAM_B),
    ];
    const solos = current.solos.map((t) => t.dispatcherId);

    const stale = await call('PUT', '/api/v1/dispatch/board/team-order', {
      expectedVersion: current.version + 5,
      teams,
      solos,
    });
    expect(stale.statusCode, stale.body).toBe(409);

    const saved = await call('PUT', '/api/v1/dispatch/board/team-order', {
      expectedVersion: current.version,
      teams,
      solos,
    });
    expect(saved.statusCode, saved.body).toBe(200);
    const after = saved.json() as TeamOrderView;
    expect(after.version).toBe(current.version + 1);
    expect(after.teams.slice(0, 2).map((t) => [t.dispatcherId, t.teamNumber])).toEqual([
      [TEAM_B, 1],
      [TEAM_A, 2],
    ]);

    const board = await daily();
    const ids = board.teams.map((t) => t.dispatcherId);
    expect(ids.indexOf(TEAM_B)).toBeLessThan(ids.indexOf(TEAM_A));
    expect(board.teams.find((t) => t.dispatcherId === TEAM_B)!.teamNumber).toBe(1);
    const week = (
      await call('GET', `/api/v1/dispatch/board/weekly?week=${weekStartMonday(today)}`)
    ).json() as WeeklyBoard;
    const wIds = week.teams.map((t) => t.dispatcherId);
    if (wIds.includes(TEAM_A) && wIds.includes(TEAM_B))
      expect(wIds.indexOf(TEAM_B)).toBeLessThan(wIds.indexOf(TEAM_A));

    // The same save again is refused as stale: no silent overwrite.
    const again = await call('PUT', '/api/v1/dispatch/board/team-order', {
      expectedVersion: current.version,
      teams,
      solos,
    });
    expect(again.statusCode).toBe(409);

    const db = app.get(DatabaseService).db;
    const lines = await db
      .select()
      .from(dispatchAudit)
      .where(and(eq(dispatchAudit.companyId, companyId), eq(dispatchAudit.entity, 'team_order')));
    expect(lines.some((l) => (l.after ?? '').includes(TEAM_B))).toBe(true);
  });
});
