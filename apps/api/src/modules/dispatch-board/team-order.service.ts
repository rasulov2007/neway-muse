import { Injectable } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import type { TeamOrderEntry, TeamOrderView, WriteTeamOrderInput } from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { storageKeyFor } from '../state/state.service';
import { audit, conflict, forbidden, unprocessable } from './ops.helpers';
import { loadTeamNames, loadStoredTeamOrder } from './team-names';
import { TEAM_ORDER_KEY, parseTeamOrder, type StoredTeamOrder } from './team-order';

/**
 * The stored board order of the teams (owner, 2026-10-26). Kept in the server-only workspace store
 * (no migration): one JSON row per company with a version. Reading takes dispatch.view; saving
 * takes dispatch.manage, checks the version and writes an audit line with before and after.
 */
@Injectable()
export class TeamOrderService {
  constructor(private readonly database: DatabaseService) {}

  clock: () => Date = () => new Date();

  async view(principal: Principal): Promise<TeamOrderView> {
    const db = this.database.db;
    const [names, stored] = await Promise.all([
      loadTeamNames(db, principal.companyId),
      loadStoredTeamOrder(db, principal.companyId),
    ]);
    // The dispatchers on the board today: a row's own team, or the driver file's when the row has none
    // (the same fall-back the board reads use).
    const rows = await db.execute(sql`
      SELECT DISTINCT
        CASE WHEN r.dispatcher_id <> '' THEN r.dispatcher_id ELSE coalesce(d.dispatcher_id, '') END AS dispatcher_id,
        CASE WHEN r.dispatcher_id <> '' THEN r.dispatcher_name ELSE coalesce(d.dispatcher_name, '') END AS dispatcher_name
      FROM dispatch_roster r
      LEFT JOIN drivers d ON d.id = r.driver_id AND d.company_id = r.company_id
      WHERE r.company_id = ${principal.companyId} AND r.unassigned_at IS NULL AND r.dispatcher_id <> 'none:unassigned'
    `);
    const list = (Array.isArray(rows) ? rows : ((rows as { rows?: unknown[] }).rows ?? [])) as {
      dispatcher_id: string;
      dispatcher_name: string;
    }[];
    const seen = new Set<string>();
    const entries: (TeamOrderEntry & { rank: number })[] = [];
    const add = (id: string, name: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      const nick = names(id).nickname;
      const place = names.order!.placeOf(id, name, nick);
      entries.push({
        dispatcherId: id,
        dispatcherName: name,
        dispatcherNickname: nick,
        teamNumber: place.teamNumber,
        rank: place.rank,
      });
    };
    for (const r of list) if (r.dispatcher_id) add(r.dispatcher_id, r.dispatcher_name);
    entries.sort((a, b) => a.rank - b.rank || a.dispatcherName.localeCompare(b.dispatcherName));
    const strip = ({ rank: _rank, ...e }: TeamOrderEntry & { rank: number }): TeamOrderEntry => e;
    return {
      version: stored.order?.version ?? 0,
      stored: stored.order !== null,
      teams: entries.filter((e) => e.teamNumber !== null).map(strip),
      solos: entries.filter((e) => e.teamNumber === null).map(strip),
    };
  }

  async save(principal: Principal, input: WriteTeamOrderInput): Promise<TeamOrderView> {
    if (!hasPermission(principal, 'dispatch.manage'))
      throw forbidden('Changing the team order takes dispatch.manage');
    const teams = dedupe(input.teams);
    const solos = dedupe(input.solos).filter((id) => !teams.includes(id));
    if (teams.length + solos.length === 0) throw unprocessable('The order names no dispatcher');
    const now = this.clock();
    const key = storageKeyFor(principal.companyId, TEAM_ORDER_KEY);
    await this.database.db.transaction(async (tx) => {
      const res = await tx.execute(sql`SELECT value FROM app_state WHERE key = ${key} FOR UPDATE`);
      const rows = (Array.isArray(res) ? res : ((res as { rows?: unknown[] }).rows ?? [])) as {
        value: string;
      }[];
      const before = parseTeamOrder(rows[0]?.value ?? null);
      const current = before?.version ?? 0;
      if (current !== input.expectedVersion)
        throw conflict('The team order was changed by someone else. Reload and try again.', {
          currentVersion: current,
        });
      const after: StoredTeamOrder = {
        version: current + 1,
        teams,
        solos,
        updatedAt: now.toISOString(),
        by: principal.userId,
      };
      await tx.execute(sql`
        INSERT INTO app_state (key, value, updated_at) VALUES (${key}, ${JSON.stringify(after)}, now())
        ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = now()
      `);
      await audit(
        tx,
        principal,
        now,
        'team_order',
        principal.companyId,
        before ? 'update' : 'create',
        before,
        after,
      );
    });
    return this.view(principal);
  }
}

function dedupe(ids: readonly string[]): string[] {
  const out: string[] = [];
  for (const raw of ids) {
    const id = raw.trim();
    if (id && id !== 'none:unassigned' && !out.includes(id)) out.push(id);
  }
  return out;
}
