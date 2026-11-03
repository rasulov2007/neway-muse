import { Injectable } from '@nestjs/common';
import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import type { Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { driverTeams, drivers, type DriverTeamRow } from '../../database/schema/roster';
import { AuditService, type AuditEvent, type WriteAuditInput } from '../people/audit.service';

/** What the team rules read about a driver. */
export interface TeamDriver {
  id: string;
  firstName: string;
  lastName: string;
  driverNumber: string;
  status: string;
  archivedAt: Date | null;
}

export type NewTeamRow = Omit<DriverTeamRow, 'endedOn' | 'endedBy' | 'endedAt' | 'endReason' | 'version'>;
export interface EndTeamPatch {
  endedOn: string;
  endedBy: string;
  endedAt: Date;
  endReason: string;
}

/**
 * Where team pairings are read and written. Every call takes the company and filters by it.
 * Writes run in one transaction with their audit entries, so a pairing and its audit lines commit
 * or roll back together. The service holds the rules; this holds only the SQL (and a unit spec
 * swaps it for an in-memory store).
 */
export interface TeamStore {
  driver(companyId: string, idOrNumber: string): Promise<TeamDriver | null>;
  drivers(companyId: string, ids: readonly string[]): Promise<TeamDriver[]>;
  /** Open rows (teams in force), for every driver or the given ones. */
  openRows(companyId: string, driverIds?: readonly string[]): Promise<DriverTeamRow[]>;
  /** Every row of one driver, newest first. */
  rowsOf(companyId: string, driverId: string): Promise<DriverTeamRow[]>;
  /** Inserts both sides; a second open row for either driver raises a unique violation (23505). */
  insertPair(principal: Principal, rows: readonly [NewTeamRow, NewTeamRow], audits: readonly WriteAuditInput[]): Promise<void>;
  /**
   * Ends both open sides of `pairId` when the acting side still has `version`. Returns the ended
   * rows, or null when the version is stale or the pair is no longer open.
   */
  endPair(principal: Principal, pairId: string, sideId: string, version: number, patch: EndTeamPatch, audits: readonly WriteAuditInput[]): Promise<DriverTeamRow[] | null>;
}

export const TEAM_STORE = Symbol('TEAM_STORE');

@Injectable()
export class DrizzleTeamStore implements TeamStore {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private readonly driverColumns = {
    id: drivers.id,
    firstName: drivers.firstName,
    lastName: drivers.lastName,
    driverNumber: drivers.driverNumber,
    status: drivers.status,
    archivedAt: drivers.archivedAt,
  };

  async driver(companyId: string, idOrNumber: string): Promise<TeamDriver | null> {
    const [d] = await this.db
      .select(this.driverColumns)
      .from(drivers)
      .where(and(eq(drivers.companyId, companyId), or(eq(drivers.id, idOrNumber), eq(drivers.driverNumber, idOrNumber))))
      .limit(1);
    return d ?? null;
  }

  async drivers(companyId: string, ids: readonly string[]): Promise<TeamDriver[]> {
    if (ids.length === 0) return [];
    return this.db
      .select(this.driverColumns)
      .from(drivers)
      .where(and(eq(drivers.companyId, companyId), inArray(drivers.id, [...ids])));
  }

  async openRows(companyId: string, driverIds?: readonly string[]): Promise<DriverTeamRow[]> {
    if (driverIds && driverIds.length === 0) return [];
    const filters = [eq(driverTeams.companyId, companyId), isNull(driverTeams.endedOn)];
    if (driverIds) filters.push(inArray(driverTeams.driverId, [...driverIds]));
    return this.db.select().from(driverTeams).where(and(...filters));
  }

  async rowsOf(companyId: string, driverId: string): Promise<DriverTeamRow[]> {
    return this.db
      .select()
      .from(driverTeams)
      .where(and(eq(driverTeams.companyId, companyId), eq(driverTeams.driverId, driverId)))
      .orderBy(desc(driverTeams.startedOn), desc(driverTeams.createdAt));
  }

  async insertPair(principal: Principal, rows: readonly [NewTeamRow, NewTeamRow], audits: readonly WriteAuditInput[]): Promise<void> {
    const events: AuditEvent[] = [];
    await this.db.transaction(async (tx) => {
      await tx.insert(driverTeams).values(rows.map((r) => ({ ...r, companyId: principal.companyId })));
      for (const a of audits) events.push(await this.audit.writeIn(tx, principal, a));
    });
    await this.audit.publish(...events);
  }

  async endPair(principal: Principal, pairId: string, sideId: string, version: number, patch: EndTeamPatch, audits: readonly WriteAuditInput[]): Promise<DriverTeamRow[] | null> {
    const events: AuditEvent[] = [];
    const ended = await this.db.transaction(async (tx) => {
      // The acting side carries the version check; the other side follows in the same transaction.
      const [side] = await tx
        .update(driverTeams)
        .set({ ...patch, version: version + 1, updatedAt: patch.endedAt })
        .where(and(eq(driverTeams.companyId, principal.companyId), eq(driverTeams.id, sideId), eq(driverTeams.version, version), isNull(driverTeams.endedOn)))
        .returning();
      if (!side) return null;
      // Both sides move together and keep one version between them.
      const others = await tx
        .update(driverTeams)
        .set({ ...patch, version: side.version, updatedAt: patch.endedAt })
        .where(and(eq(driverTeams.companyId, principal.companyId), eq(driverTeams.pairId, pairId), isNull(driverTeams.endedOn)))
        .returning();
      for (const a of audits) events.push(await this.audit.writeIn(tx, principal, a));
      return [side, ...others];
    });
    if (ended) await this.audit.publish(...events);
    return ended;
  }
}
