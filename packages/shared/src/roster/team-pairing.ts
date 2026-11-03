import { z } from 'zod';

/**
 * Team or Solo (owner, 2026-10-25): two drivers of one company are paired into a team, and either
 * of them unpairs it. A pairing is symmetric - each driver holds one row naming the other - and is
 * kept forever with its dates, so a past week reads the team that was in force on that week and
 * not today's.
 *
 * Dates are US Eastern business dates (YYYY-MM-DD). `startedOn` is the first day as a team;
 * `endedOn` is the first day solo again, so a team is in force on day D when
 * startedOn <= D < endedOn (or endedOn is null).
 */

export const DRIVER_TEAM_STATES = ['active', 'ended'] as const;
export type DriverTeamState = (typeof DRIVER_TEAM_STATES)[number];

/** One driver's side of a pairing. */
export interface DriverTeamView {
  /** This side's row id. */
  id: string;
  /** Shared by both sides of one pairing. */
  pairId: string;
  driverId: string;
  driverName: string;
  driverNumber: string | null;
  partnerId: string;
  partnerName: string;
  partnerNumber: string | null;
  state: DriverTeamState;
  startedOn: string;
  endedOn: string | null;
  note: string | null;
  startedBy: string;
  endedBy: string | null;
  endReason: string | null;
  version: number;
}

/** Every team in force today, one entry per driver (both sides of each pair). */
export interface DriverTeamList {
  today: string;
  teams: DriverTeamView[];
}

/** One driver's team answer: the pairing in force (or null = Solo) and every past one. */
export interface DriverTeamStanding {
  today: string;
  current: DriverTeamView | null;
  history: DriverTeamView[];
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const PairDriversSchema = z.object({
  partnerId: z.string().trim().min(1, 'Choose the partner'),
  /** Defaults to today (US Eastern, server clock). */
  startedOn: isoDate.optional(),
  note: z.string().trim().max(500).nullish().transform((v) => v || null),
});
export type PairDriversInput = z.input<typeof PairDriversSchema>;

export const UnpairDriversSchema = z.object({
  version: z.number().int().min(1),
  reason: z.string().trim().min(3, 'Say why the team is split').max(500),
  /** Defaults to today: the first day both drive solo. */
  endedOn: isoDate.optional(),
});
export type UnpairDriversInput = z.input<typeof UnpairDriversSchema>;

/** Driver statuses that cannot join a team (they are not on the roster any more). */
export const UNPAIRABLE_DRIVER_STATUSES: readonly string[] = ['terminated', 'inactive'];

/** What the pairing rules need to know about one driver. */
export interface PairingDriverFacts {
  id: string;
  name: string;
  status: string;
  archived: boolean;
  /** The partner's name when this driver is in a team today, else null. */
  currentPartnerName: string | null;
  /** The latest day any past pairing of this driver ended (first solo day), else null. */
  lastEndedOn: string | null;
}

export type PairingRefusal = { status: 409 | 422; message: string };

/**
 * May these two drivers become a team from `startedOn`? Null = yes, else the refusal the server
 * returns. One function so the dialog and the server cannot disagree.
 */
export function pairingRefusal(driver: PairingDriverFacts, partner: PairingDriverFacts, startedOn: string, today: string): PairingRefusal | null {
  if (driver.id === partner.id) return { status: 422, message: 'A driver cannot be paired with themselves.' };
  for (const d of [driver, partner]) {
    if (d.archived) return { status: 422, message: `${d.name} is archived and cannot be paired.` };
    if (UNPAIRABLE_DRIVER_STATUSES.includes(d.status)) return { status: 422, message: `${d.name} is ${d.status} and cannot be paired.` };
  }
  for (const d of [driver, partner]) {
    if (d.currentPartnerName) return { status: 409, message: `${d.name} is already in a team with ${d.currentPartnerName}. Unpair them first.` };
  }
  if (startedOn > today) return { status: 422, message: 'A team starts today or earlier; a future start is not supported.' };
  for (const d of [driver, partner]) {
    if (d.lastEndedOn && startedOn < d.lastEndedOn) {
      return { status: 409, message: `${d.name} was in another team until ${d.lastEndedOn}; the new team cannot start before that.` };
    }
  }
  return null;
}

/** May this pairing end on `endedOn`? Null = yes. */
export function unpairingRefusal(team: { startedOn: string; endedOn: string | null }, endedOn: string, today: string): PairingRefusal | null {
  if (team.endedOn) return { status: 409, message: `This team was already split on ${team.endedOn}.` };
  if (endedOn > today) return { status: 422, message: 'A team cannot be split on a future day.' };
  if (endedOn < team.startedOn) return { status: 422, message: `The split cannot be before the team started (${team.startedOn}).` };
  return null;
}

/** Was this pairing in force on `day`? */
export function teamInForceOn(team: { startedOn: string; endedOn: string | null }, day: string): boolean {
  return team.startedOn <= day && (team.endedOn === null || day < team.endedOn);
}

/** The partner of `driverId` on `day`, from that driver's pairing rows (any order), else null = Solo. */
export function partnerOn<T extends { driverId: string; startedOn: string; endedOn: string | null }>(rows: readonly T[], driverId: string, day: string): T | null {
  return rows.find((r) => r.driverId === driverId && teamInForceOn(r, day)) ?? null;
}

/** "Team · with Name" or "Solo". */
export function teamLabel(partnerName: string | null | undefined): string {
  return partnerName ? `Team · with ${partnerName}` : 'Solo';
}

/**
 * The drivers the Pair dialog offers for `driverId`: same company (the caller's list already is),
 * not the driver, not archived or gone, not in a team today, matching the search.
 */
export function pairableCandidates<T extends { id: string; name: string; driverNumber?: string | null; status: string; archivedAt?: string | null }>(
  drivers: readonly T[],
  driverId: string,
  pairedIds: ReadonlySet<string>,
  search: string,
): T[] {
  const q = search.trim().toLowerCase();
  return drivers
    .filter((d) => d.id !== driverId && !d.archivedAt && !UNPAIRABLE_DRIVER_STATUSES.includes(d.status) && !pairedIds.has(d.id))
    .filter((d) => !q || d.name.toLowerCase().includes(q) || (d.driverNumber ?? '').toLowerCase().includes(q))
    .sort((a, b) => a.name.localeCompare(b.name));
}
