import { Inject, Injectable } from '@nestjs/common';
import {
  pairingRefusal,
  partnerOn,
  teamLabel,
  unpairingRefusal,
  type DriverTeamList,
  type DriverTeamStanding,
  type DriverTeamView,
  type PairDriversInput,
  type PairingRefusal,
  type UnpairDriversInput,
} from '@neway/shared';
import { AppError } from '../../common/errors/app-error';
import type { Principal } from '../../common/auth/principal';
import type { DriverTeamRow } from '../../database/schema/roster';
import { easternToday } from './driver-archive.data';
import { TEAM_STORE, type TeamDriver, type TeamStore } from './teams.data';

const fail = (r: PairingRefusal) => new AppError({ status: r.status, title: r.status === 409 ? 'Conflict' : 'Unprocessable Entity', detail: r.message });
const nameOf = (d: Pick<TeamDriver, 'firstName' | 'lastName'>) => `${d.firstName} ${d.lastName}`.trim();

/**
 * Team or Solo (owner, 2026-10-25). Pair puts two drivers of one company into a team with each
 * other (one row each, symmetric); Unpair, with a reason, makes both Solo again. Each write is
 * audited on both drivers in the same transaction; Unpair is version-checked; a driver who already
 * has a partner is refused with 409 (by the rules, and by the database's unique open-row index).
 * Nothing is deleted: an ended pairing stays with its dates, so a past week reads its own team.
 */
@Injectable()
export class TeamsService {
  constructor(@Inject(TEAM_STORE) private readonly store: TeamStore) {}

  /** The server clock; a spec may pin it. */
  now: () => Date = () => new Date();

  private canWrite(principal: Principal) {
    if (!principal.permissions.has('drivers.edit') && !principal.permissions.has('dispatch.manage')) {
      throw new AppError({ status: 403, title: 'Forbidden', detail: 'Pairing drivers needs drivers.edit or dispatch.manage.' });
    }
  }

  private async driver(principal: Principal, idOrNumber: string): Promise<TeamDriver> {
    const d = await this.store.driver(principal.companyId, idOrNumber);
    if (!d) throw new AppError({ status: 404, title: 'Not Found', detail: `No driver ${idOrNumber} on this roster` });
    return d;
  }

  private async views(principal: Principal, rows: readonly DriverTeamRow[]): Promise<DriverTeamView[]> {
    const ids = [...new Set(rows.flatMap((r) => [r.driverId, r.partnerId]))];
    const byId = new Map((await this.store.drivers(principal.companyId, ids)).map((d) => [d.id, d]));
    return rows.map((r) => {
      const d = byId.get(r.driverId);
      const p = byId.get(r.partnerId);
      return {
        id: r.id,
        pairId: r.pairId,
        driverId: r.driverId,
        driverName: d ? nameOf(d) : r.driverId,
        driverNumber: d?.driverNumber ?? null,
        partnerId: r.partnerId,
        partnerName: p ? nameOf(p) : r.partnerId,
        partnerNumber: p?.driverNumber ?? null,
        state: r.endedOn ? 'ended' : 'active',
        startedOn: r.startedOn,
        endedOn: r.endedOn,
        note: r.note,
        startedBy: r.startedBy,
        endedBy: r.endedBy,
        endReason: r.endReason,
        version: r.version,
      };
    });
  }

  /** Every team in force, one entry per driver: the Drivers list reads Team / Solo from this. */
  async list(principal: Principal): Promise<DriverTeamList> {
    const today = easternToday(this.now());
    const rows = await this.store.openRows(principal.companyId);
    return { today, teams: await this.views(principal, rows) };
  }

  /** One driver: the team in force (null = Solo) and every pairing, newest first. */
  async standing(principal: Principal, idOrNumber: string): Promise<DriverTeamStanding> {
    const d = await this.driver(principal, idOrNumber);
    const today = easternToday(this.now());
    const history = await this.views(principal, await this.store.rowsOf(principal.companyId, d.id));
    return { today, current: history.find((h) => h.state === 'active') ?? null, history };
  }

  /**
   * The partner on a business day (US Eastern), for readers that look back at a past week.
   * Null = Solo that day.
   */
  async partnerOnDay(principal: Principal, driverId: string, day: string): Promise<DriverTeamView | null> {
    const rows = await this.store.rowsOf(principal.companyId, driverId);
    const row = partnerOn(rows, driverId, day);
    return row ? ((await this.views(principal, [row]))[0] ?? null) : null;
  }

  private async facts(principal: Principal, d: TeamDriver) {
    const rows = await this.store.rowsOf(principal.companyId, d.id);
    const open = rows.find((r) => r.endedOn === null) ?? null;
    let currentPartnerName: string | null = null;
    if (open) {
      const [p] = await this.store.drivers(principal.companyId, [open.partnerId]);
      currentPartnerName = p ? nameOf(p) : open.partnerId;
    }
    const lastEndedOn = rows.reduce<string | null>((max, r) => (r.endedOn && (!max || r.endedOn > max) ? r.endedOn : max), null);
    return { id: d.id, name: nameOf(d), status: d.status, archived: d.archivedAt !== null, currentPartnerName, lastEndedOn };
  }

  async pair(principal: Principal, idOrNumber: string, input: PairDriversInput): Promise<DriverTeamStanding> {
    this.canWrite(principal);
    const d = await this.driver(principal, idOrNumber);
    // Same company only: a driver of another company is simply not found.
    const p = await this.driver(principal, input.partnerId);
    const now = this.now();
    const today = easternToday(now);
    const startedOn = input.startedOn ?? today;
    const refusal = pairingRefusal(await this.facts(principal, d), await this.facts(principal, p), startedOn, today);
    if (refusal) throw fail(refusal);

    const by = principal.userName ?? principal.userId;
    const pairId = `dtp_${crypto.randomUUID()}`;
    const side = (driverId: string, partnerId: string) => ({
      id: `dtm_${crypto.randomUUID()}`,
      companyId: principal.companyId,
      pairId,
      driverId,
      partnerId,
      startedOn,
      note: input.note ?? null,
      startedBy: by,
      createdAt: now,
      updatedAt: now,
    });
    const audit = (self: TeamDriver, other: TeamDriver) => ({
      action: 'driver_team_paired',
      entityType: 'driver',
      entityId: self.id,
      entityLabel: nameOf(self),
      summary: `Team with ${nameOf(other)} (${other.driverNumber}) from ${startedOn}`,
      changes: [{ field: 'team', old: teamLabel(null), new: teamLabel(nameOf(other)) }],
      reason: input.note ?? null,
      at: now,
    });
    try {
      await this.store.insertPair(principal, [side(d.id, p.id), side(p.id, d.id)], [audit(d, p), audit(p, d)]);
    } catch (error) {
      // Two people pairing the same driver at once: the open-row index lets only one through.
      if ((error as { code?: string }).code === '23505') {
        throw fail({ status: 409, message: `${nameOf(d)} or ${nameOf(p)} was just put in another team. Reload and try again.` });
      }
      throw error;
    }
    return this.standing(principal, d.id);
  }

  async unpair(principal: Principal, idOrNumber: string, pairId: string, input: UnpairDriversInput): Promise<DriverTeamStanding> {
    this.canWrite(principal);
    const d = await this.driver(principal, idOrNumber);
    const rows = await this.store.rowsOf(principal.companyId, d.id);
    const mine = rows.find((r) => r.pairId === pairId);
    if (!mine) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such team for this driver' });
    const now = this.now();
    const today = easternToday(now);
    const endedOn = input.endedOn ?? today;
    const refusal = unpairingRefusal(mine, endedOn, today);
    if (refusal) throw fail(refusal);
    if (mine.version !== input.version) throw fail({ status: 409, message: 'This team was changed by someone else. Reload and try again.' });

    const p = (await this.store.drivers(principal.companyId, [mine.partnerId]))[0];
    const partnerName = p ? nameOf(p) : mine.partnerId;
    const by = principal.userName ?? principal.userId;
    const audit = (id: string, label: string, otherName: string) => ({
      action: 'driver_team_unpaired',
      entityType: 'driver',
      entityId: id,
      entityLabel: label,
      summary: `Team with ${otherName} split; solo from ${endedOn}: ${input.reason}`,
      changes: [{ field: 'team', old: teamLabel(otherName), new: teamLabel(null) }],
      reason: input.reason,
      at: now,
    });
    const ended = await this.store.endPair(
      principal,
      pairId,
      mine.id,
      input.version,
      { endedOn, endedBy: by, endedAt: now, endReason: input.reason },
      [audit(d.id, nameOf(d), partnerName), audit(mine.partnerId, partnerName, nameOf(d))],
    );
    if (!ended) throw fail({ status: 409, message: 'This team was changed by someone else. Reload and try again.' });
    return this.standing(principal, d.id);
  }
}
