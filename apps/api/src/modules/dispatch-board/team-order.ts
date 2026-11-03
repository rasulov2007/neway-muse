/**
 * The order of the teams on the boards, and their TEAM n badge (owner, 2026-10-26).
 *
 * "ADIN is not a team, he's solo": the badge used to be the band's position on the page, so a solo
 * dispatcher sorted between two pairs was called TEAM 2 and pushed every real team down a number.
 *
 * Now:
 *   - a team is a dispatcher record that stands for two people (its name or nickname has a "/",
 *     or its commission split names two or more people); a solo is one person and has no number;
 *   - teams come first, then solos, then Unassigned drivers;
 *   - the company may store the order (`dispatch-team-order` in the server-only workspace store,
 *     written through PUT /dispatch/board/team-order with a version check and an audit line). A
 *     stored team is TEAM <its place in the stored list>; a stored solo is solo whatever its name;
 *   - anything not in the stored list falls in after the stored ones of its kind, alphabetically,
 *     and a team numbers on from the last stored number.
 *
 * Numbers never depend on which teams happen to be on a given day's board: they come from the
 * stored list and the company's whole roster.
 */
import { NO_DISPATCHER_ID } from './no-dispatcher';

/** The workspace key the order lives under (server-only: not in the /state key policy). */
export const TEAM_ORDER_KEY = 'dispatch-team-order';

export interface StoredTeamOrder {
  version: number;
  /** Dispatcher ids of the teams, TEAM 1 first. */
  teams: string[];
  /** Dispatcher ids of the solo dispatchers, in board order. */
  solos: string[];
  updatedAt?: string | null;
  by?: string | null;
}

export function parseTeamOrder(raw: string | null | undefined): StoredTeamOrder | null {
  if (!raw) return null;
  try {
    const v = JSON.parse(raw) as Partial<StoredTeamOrder>;
    if (!v || typeof v !== 'object') return null;
    const ids = (x: unknown) =>
      Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string' && s.length > 0) : [];
    return {
      version: typeof v.version === 'number' && Number.isInteger(v.version) ? v.version : 0,
      teams: ids(v.teams),
      solos: ids(v.solos),
      updatedAt: typeof v.updatedAt === 'string' ? v.updatedAt : null,
      by: typeof v.by === 'string' ? v.by : null,
    };
  } catch {
    return null;
  }
}

export interface KnownDispatcher {
  dispatcherId: string;
  dispatcherName: string;
  nickname?: string | null;
  /** People named in the team's commission split. */
  members?: number;
}

/** Two people behind one dispatcher record. */
export function looksLikeTeam(
  name: string | null | undefined,
  nickname?: string | null,
  members?: number,
): boolean {
  return (members ?? 0) >= 2 || /\//.test(name ?? '') || /\//.test(nickname ?? '');
}

export interface TeamPlace {
  /** The TEAM n badge; null for a solo dispatcher and for Unassigned drivers. */
  teamNumber: number | null;
  /** Lower comes first on the boards. */
  rank: number;
}

export interface TeamOrder {
  placeOf(
    dispatcherId: string,
    dispatcherName?: string | null,
    nickname?: string | null,
  ): TeamPlace;
  /** Board order for anything with a dispatcher id and name: teams, solos, Unassigned; then by name. */
  compare(
    a: { dispatcherId: string; dispatcherName: string },
    b: { dispatcherId: string; dispatcherName: string },
  ): number;
}

const UNASSIGNED_RANK = 9000;

export function teamOrder(
  known: readonly KnownDispatcher[],
  stored: StoredTeamOrder | null,
): TeamOrder {
  const places = new Map<string, TeamPlace>();
  const storedTeams = stored?.teams ?? [];
  const storedSolos = (stored?.solos ?? []).filter((id) => !storedTeams.includes(id));
  storedTeams.forEach((id, i) => places.set(id, { teamNumber: i + 1, rank: i }));
  storedSolos.forEach((id, i) => places.set(id, { teamNumber: null, rank: 2000 + i }));

  const byId = new Map<string, KnownDispatcher>();
  for (const k of known)
    if (k.dispatcherId && !byId.has(k.dispatcherId)) byId.set(k.dispatcherId, k);
  const label = (k: KnownDispatcher) =>
    (k.nickname || k.dispatcherName || k.dispatcherId).toUpperCase();
  const rest = [...byId.values()]
    .filter((k) => !places.has(k.dispatcherId) && !isUnassigned(k.dispatcherId))
    .sort((a, b) => label(a).localeCompare(label(b)));
  let nextTeam = storedTeams.length;
  let teamRank = 1000;
  let soloRank = 3000;
  for (const k of rest) {
    if (looksLikeTeam(k.dispatcherName, k.nickname, k.members))
      places.set(k.dispatcherId, { teamNumber: ++nextTeam, rank: teamRank++ });
    else places.set(k.dispatcherId, { teamNumber: null, rank: soloRank++ });
  }

  const placeOf: TeamOrder['placeOf'] = (id, name, nickname) => {
    if (isUnassigned(id)) return { teamNumber: null, rank: UNASSIGNED_RANK };
    const hit = places.get(id);
    if (hit) return hit;
    // A dispatcher no roster row names any more (a past team on a report): after the known ones.
    return looksLikeTeam(name, nickname)
      ? { teamNumber: null, rank: 1999 }
      : { teamNumber: null, rank: 3999 };
  };
  return {
    placeOf,
    compare: (a, b) =>
      placeOf(a.dispatcherId, a.dispatcherName).rank -
        placeOf(b.dispatcherId, b.dispatcherName).rank ||
      a.dispatcherName.localeCompare(b.dispatcherName),
  };
}

function isUnassigned(id: string): boolean {
  return !id || id === NO_DISPATCHER_ID;
}
