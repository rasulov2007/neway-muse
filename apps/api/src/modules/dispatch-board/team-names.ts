import { desc, eq, sql } from 'drizzle-orm';
import type { DatabaseService } from '../../database/database.service';
import { dispatchAllocations, dispatchRoster, dispatchRosterAssignments } from '../../database/schema/dispatch-ops';
import { employees } from '../../database/schema/people';
import { drivers } from '../../database/schema/roster';
import { storageKeyFor } from '../state/state.service';
import { TEAM_ORDER_KEY, parseTeamOrder, teamOrder, type StoredTeamOrder, type TeamOrder } from './team-order';

/**
 * Nicknames on the boards (owner, 2026-10-26).
 *
 * A board team is a `dispatcher_id` plus a stored display copy of its name. Where the team is
 * linked to employees, the board shows their nicknames (employees.preferred_name) and keeps the
 * full name for a tooltip:
 *
 *   - `emp_...` id: one employee, picked in the roster dialogs;
 *   - any other id whose current commission split names employees (dispatch_allocations shares
 *     with an employeeId): the people behind "ARLO / MAXWELL", in split order.
 *
 * A free-text team (imported from the sheet and never linked) keeps its name exactly as typed, and
 * so does a linked team in which nobody has a nickname.
 */
export interface TeamPerson {
  id: string;
  firstName: string;
  lastName: string;
  preferredName: string | null;
}

export interface TeamName {
  /** What the board shows instead of the stored name; null = show the stored name. */
  nickname: string | null;
  /** The full name(s), for the tooltip. */
  fullName: string | null;
}

export type TeamNameLookup = ((dispatcherId: string) => TeamName) & {
  /** The board order and TEAM n badges (team-order.ts); absent on a bare lookup. */
  order?: TeamOrder;
};

const full = (p: TeamPerson) => `${p.firstName} ${p.lastName}`.trim();
const nick = (p: TeamPerson) => p.preferredName?.trim() || null;

export function teamNameLookup(
  people: readonly TeamPerson[],
  splits: ReadonlyMap<string, readonly (string | null)[]>,
  /** A pair team run by one dispatcher today (owner, 2026-10-28: Separate dispatchers): that one's name. */
  aloneToday: ReadonlyMap<string, { employeeId: string | null; name: string }> = new Map(),
): TeamNameLookup {
  const byId = new Map(people.map((p) => [p.id, p]));
  const cache = new Map<string, TeamName>();
  const none: TeamName = { nickname: null, fullName: null };
  return (dispatcherId) => {
    const hit = cache.get(dispatcherId);
    if (hit) return hit;
    let out = none;
    const one = byId.get(dispatcherId);
    const alone = aloneToday.get(dispatcherId);
    if (!one && alone) {
      const person = alone.employeeId ? byId.get(alone.employeeId) : undefined;
      out = person ? { nickname: nick(person) ?? person.firstName.toUpperCase(), fullName: full(person) } : { nickname: alone.name.toUpperCase(), fullName: alone.name };
    } else if (one) {
      out = nick(one) ? { nickname: nick(one), fullName: full(one) } : none;
    } else {
      const ids = splits.get(dispatcherId);
      const members = ids?.map((id) => (id ? byId.get(id) : undefined));
      if (members && members.length > 0 && members.every((m): m is TeamPerson => Boolean(m)) && members.some((m) => nick(m))) {
        out = {
          nickname: members.map((m) => nick(m) ?? m.firstName).join(' / '),
          fullName: members.map(full).join(' / '),
        };
      }
    }
    cache.set(dispatcherId, out);
    return out;
  };
}

/** The row with `dispatcherNickname` / `dispatcherFullName` / `teamNumber` filled from the lookup. */
export function withTeamName<T extends { dispatcherId: string; dispatcherName?: string }>(
  row: T,
  lookup: TeamNameLookup,
): T & { dispatcherNickname: string | null; dispatcherFullName: string | null; teamNumber: number | null } {
  const name = lookup(row.dispatcherId);
  const teamNumber = lookup.order?.placeOf(row.dispatcherId, row.dispatcherName, name.nickname).teamNumber ?? null;
  return { ...row, dispatcherNickname: name.nickname, dispatcherFullName: name.fullName, teamNumber };
}

/** Board order by the lookup's team order (teams, solos, Unassigned); by name when it has none. */
export function compareTeams(lookup: TeamNameLookup) {
  return (a: { dispatcherId: string; dispatcherName: string }, b: { dispatcherId: string; dispatcherName: string }): number =>
    lookup.order ? lookup.order.compare(a, b) : a.dispatcherName.localeCompare(b.dispatcherName);
}

/** The company's stored team order, or null when none was saved (or the store cannot be read). */
export async function loadStoredTeamOrder(
  db: DatabaseService['db'],
  companyId: string,
): Promise<{ order: StoredTeamOrder | null; updatedAt: string | null }> {
  try {
    const res = (await db.execute(sql`SELECT value, updated_at FROM app_state WHERE key = ${storageKeyFor(companyId, TEAM_ORDER_KEY)}`)) as unknown as
      | { rows?: { value: string; updated_at: Date | string }[] }
      | { value: string; updated_at: Date | string }[];
    const rows = Array.isArray(res) ? res : (res.rows ?? []);
    const row = rows[0];
    if (!row) return { order: null, updatedAt: null };
    const at = row.updated_at instanceof Date ? row.updated_at.toISOString() : String(row.updated_at);
    return { order: parseTeamOrder(row.value), updatedAt: at };
  } catch {
    return { order: null, updatedAt: null };
  }
}

/** The company's lookup, read once per request. */
export async function loadTeamNames(db: DatabaseService['db'], companyId: string): Promise<TeamNameLookup> {
  const [people, allocations, roster, history, files, stored] = await Promise.all([
    db
      .select({ id: employees.id, firstName: employees.firstName, lastName: employees.lastName, preferredName: employees.preferredName })
      .from(employees)
      .where(eq(employees.companyId, companyId)),
    db
      .select({ dispatcherId: dispatchAllocations.dispatcherId, shares: dispatchAllocations.shares, effectiveFrom: dispatchAllocations.effectiveFrom })
      .from(dispatchAllocations)
      .where(eq(dispatchAllocations.companyId, companyId))
      .orderBy(desc(dispatchAllocations.effectiveFrom), desc(dispatchAllocations.at)),
    db
      .selectDistinct({ dispatcherId: dispatchRoster.dispatcherId, dispatcherName: dispatchRoster.dispatcherName })
      .from(dispatchRoster)
      .where(eq(dispatchRoster.companyId, companyId)),
    db
      .selectDistinct({ dispatcherId: dispatchRosterAssignments.dispatcherId, dispatcherName: dispatchRosterAssignments.dispatcherName })
      .from(dispatchRosterAssignments)
      .where(eq(dispatchRosterAssignments.companyId, companyId)),
    db
      .selectDistinct({ dispatcherId: drivers.dispatcherId, dispatcherName: drivers.dispatcherName })
      .from(drivers)
      .where(eq(drivers.companyId, companyId)),
    loadStoredTeamOrder(db, companyId),
  ]);
  // The current split of each team: the newest row (rows arrive newest first).
  const splits = new Map<string, (string | null)[]>();
  for (const row of allocations) {
    if (splits.has(row.dispatcherId)) continue;
    try {
      const shares = JSON.parse(row.shares) as { employeeId?: string | null }[];
      splits.set(row.dispatcherId, Array.isArray(shares) ? shares.map((s) => s.employeeId ?? null) : []);
    } catch {
      splits.set(row.dispatcherId, []);
    }
  }
  // The split in force today: a pair team one dispatcher runs alone shows that one (owner, 2026-10-28).
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const aloneToday = new Map<string, { employeeId: string | null; name: string }>();
  // A team that ever had two or more dispatchers is a pair team, whatever its newest split says.
  const maxMembers = new Map<string, number>();
  for (const row of allocations) {
    try {
      const n = (JSON.parse(row.shares) as unknown[]).length;
      maxMembers.set(row.dispatcherId, Math.max(maxMembers.get(row.dispatcherId) ?? 0, n));
    } catch {
      /* unreadable split */
    }
  }
  const seenToday = new Set<string>();
  for (const row of allocations) {
    if (seenToday.has(row.dispatcherId) || String(row.effectiveFrom).slice(0, 10) > today) continue;
    seenToday.add(row.dispatcherId);
    try {
      const shares = JSON.parse(row.shares) as { employeeId?: string | null; name?: string }[];
      const members = maxMembers.get(row.dispatcherId) ?? 0;
      if (Array.isArray(shares) && shares.length === 1 && members >= 2) aloneToday.set(row.dispatcherId, { employeeId: shares[0]!.employeeId ?? null, name: shares[0]!.name ?? '' });
    } catch {
      /* a split that does not read keeps the stored name */
    }
  }
  const lookup = teamNameLookup(people, splits, aloneToday);
  // Teams first by their number, then solos; numbers from the stored order and the whole roster,
  // never from the band's position on one day's page (owner, 2026-10-26: "ADIN is not a team").
  lookup.order = teamOrder(
    // Every dispatcher the company has used - board rows, their history and the driver files - so
    // a number never depends on who happens to be on one day's board.
    [...roster, ...history, ...files].map((r) => ({ ...r, nickname: lookup(r.dispatcherId).nickname, members: Math.max(splits.get(r.dispatcherId)?.length ?? 0, maxMembers.get(r.dispatcherId) ?? 0) })),
    stored.order,
  );
  return lookup;
}
