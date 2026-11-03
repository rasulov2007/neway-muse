import { Injectable } from '@nestjs/common';
import { and, asc, eq, ilike, inArray, not, or, sql } from 'drizzle-orm';
import {
  INACTIVE_TRAILER_STATUSES,
  type CreateTrailerRequest,
  type RosterPage,
  type RosterQuery,
  type TrailerRecord,
  type UpdateTrailerRequest,
} from '@neway/shared';
import { AppError } from '../../common/errors/app-error';
import type { Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { trailers } from '../../database/schema/fleet';
import { trucks } from '../../database/schema/roster';

type TrailerRow = typeof trailers.$inferSelect;

/**
 * Trailers.
 *
 * The same shape as trucks and for the same reason: every query is filtered by
 * `principal.companyId`, every insert stamps it, and nothing here deletes — a trailer is sold, and
 * it keeps its work orders, its inspections and its history.
 *
 * This is the only place trailers are read from. They were previously generated per session into
 * the workspace snapshot, which is why 160 real ones could sit in the table while the page showed
 * an empty list.
 */
@Injectable()
export class TrailersService {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  async list(principal: Principal, query: RosterQuery): Promise<RosterPage<TrailerRecord>> {
    const filters = [eq(trailers.companyId, principal.companyId)];
    if (!query.includeInactive && INACTIVE_TRAILER_STATUSES.length > 0) {
      filters.push(not(inArray(trailers.status, [...INACTIVE_TRAILER_STATUSES])));
    }
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(
        ilike(trailers.unitNumber, term),
        ilike(trailers.vin, term),
        ilike(trailers.make, term),
        ilike(trailers.model, term),
        ilike(trailers.plate, term),
      );
      if (match) filters.push(match);
    }
    const where = and(...filters);

    const [counted] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(trailers)
      .where(where);

    const rows = await this.db
      .select({ trailer: trailers, truckUnit: trucks.unitNumber })
      .from(trailers)
      .leftJoin(trucks, eq(trailers.currentTruckId, trucks.id))
      .where(where)
      .orderBy(asc(trailers.unitNumber))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      data: rows.map((row) => toTrailerRecord(row.trailer, row.truckUnit)),
      total: counted?.count ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /** Resolves an id or a unit number, because links in this product carry both. */
  async find(principal: Principal, idOrUnit: string): Promise<TrailerRecord | null> {
    const [row] = await this.db
      .select({ trailer: trailers, truckUnit: trucks.unitNumber })
      .from(trailers)
      .leftJoin(trucks, eq(trailers.currentTruckId, trucks.id))
      .where(
        and(
          eq(trailers.companyId, principal.companyId),
          or(eq(trailers.id, idOrUnit), eq(trailers.unitNumber, idOrUnit)),
        ),
      )
      .limit(1);
    return row ? toTrailerRecord(row.trailer, row.truckUnit) : null;
  }

  async get(principal: Principal, idOrUnit: string): Promise<TrailerRecord> {
    const trailer = await this.find(principal, idOrUnit);
    if (!trailer) {
      throw new AppError({
        status: 404,
        title: 'Not Found',
        detail: `No trailer ${idOrUnit} on this fleet`,
      });
    }
    return trailer;
  }

  async create(principal: Principal, input: CreateTrailerRequest): Promise<TrailerRecord> {
    const unitNumber = input.unitNumber.trim();
    const vin = input.vin.trim().toUpperCase();

    const [clash] = await this.db
      .select({ unitNumber: trailers.unitNumber, vin: trailers.vin })
      .from(trailers)
      .where(
        and(
          eq(trailers.companyId, principal.companyId),
          vin
            ? or(eq(trailers.unitNumber, unitNumber), sql`upper(${trailers.vin}) = ${vin}`)
            : eq(trailers.unitNumber, unitNumber),
        ),
      )
      .limit(1);
    if (clash) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail:
          clash.unitNumber === unitNumber
            ? `Trailer ${unitNumber} already exists in the fleet`
            : `A trailer with VIN ${vin} already exists`,
      });
    }

    const id = await this.nextTrailerId(principal, unitNumber);
    const now = new Date();
    const [inserted] = await this.db
      .insert(trailers)
      .values({
        id,
        companyId: principal.companyId,
        unitNumber,
        vin,
        year: input.year ?? null,
        make: input.make?.trim() || null,
        model: input.model?.trim() || null,
        type: input.type,
        lengthFt: input.lengthFt ?? null,
        plate: input.plate?.trim().toUpperCase() || null,
        plateState: input.plateState?.trim().toUpperCase() || null,
        status: 'available',
        ownership: input.ownership,
        currentTruckId: null,
        currentLoadId: null,
        nextInspectionDate: input.nextInspectionDate ?? null,
        homeTerminal: input.homeTerminal?.trim() || null,
        // Typed here, not imported: no source system to name.
        source: null,
        externalId: null,
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return toTrailerRecord(inserted!, null);
  }

  async update(
    principal: Principal,
    idOrUnit: string,
    input: UpdateTrailerRequest,
  ): Promise<TrailerRecord> {
    const current = await this.get(principal, idOrUnit);
    const patch: Partial<TrailerRow> = { updatedAt: new Date() };
    if (input.unitNumber !== undefined) {
      const unitNumber = input.unitNumber.trim();
      // A renamed trailer may not take another trailer's number (owner, 2026-10-24: Edit beside the name).
      if (unitNumber !== current.unitNumber) {
        const [clash] = await this.db
          .select({ id: trailers.id })
          .from(trailers)
          .where(and(eq(trailers.companyId, principal.companyId), eq(trailers.unitNumber, unitNumber), not(eq(trailers.id, current.id))))
          .limit(1);
        if (clash) throw new AppError({ status: 409, title: 'Conflict', detail: `Trailer ${unitNumber} already exists in the fleet` });
      }
      patch.unitNumber = unitNumber;
    }
    if (input.vin !== undefined) patch.vin = input.vin.trim().toUpperCase();
    if (input.year !== undefined) patch.year = input.year;
    if (input.make !== undefined) patch.make = input.make?.trim() || null;
    if (input.model !== undefined) patch.model = input.model?.trim() || null;
    if (input.type !== undefined) patch.type = input.type;
    if (input.lengthFt !== undefined) patch.lengthFt = input.lengthFt;
    if (input.plate !== undefined) patch.plate = input.plate?.trim().toUpperCase() || null;
    if (input.plateState !== undefined) {
      patch.plateState = input.plateState?.trim().toUpperCase() || null;
    }
    if (input.ownership !== undefined) patch.ownership = input.ownership;
    if (input.nextInspectionDate !== undefined) patch.nextInspectionDate = input.nextInspectionDate;
    if (input.homeTerminal !== undefined) patch.homeTerminal = input.homeTerminal?.trim() || null;
    if (input.status !== undefined) patch.status = input.status;
    if (input.currentTruckId !== undefined) patch.currentTruckId = input.currentTruckId;

    await this.db
      .update(trailers)
      .set(patch)
      .where(and(eq(trailers.companyId, principal.companyId), eq(trailers.id, current.id)));
    return this.get(principal, current.id);
  }

  /**
   * A readable id — `trl_53104` — with a fallback for a unit number that is not a plain number.
   * The same rule trucks use, so the two lists read alike.
   */
  private async nextTrailerId(principal: Principal, unitNumber: string): Promise<string> {
    const candidate = /^\d{1,6}$/.test(unitNumber) ? `trl_${unitNumber}` : null;
    if (candidate) {
      const [taken] = await this.db
        .select({ id: trailers.id })
        .from(trailers)
        .where(eq(trailers.id, candidate))
        .limit(1);
      if (!taken) return candidate;
    }
    const [highest] = await this.db
      .select({
        value: sql<number>`coalesce(max(nullif(regexp_replace(${trailers.id}, '\\D', '', 'g'), '')::bigint), 0)::int`,
      })
      .from(trailers);
    // Ids are one key for every company (owner, 2026-10-12: a second company's trailer took an id
    // another company held); the next free one is checked, not assumed.
    void principal;
    let next = (highest?.value ?? 0) + 1;
    for (let attempt = 0; attempt < 50; attempt += 1) {
      const id = `trl_${String(next).padStart(3, '0')}`;
      const [taken] = await this.db.select({ id: trailers.id }).from(trailers).where(eq(trailers.id, id)).limit(1);
      if (!taken) return id;
      next += 1;
    }
    throw new Error('Could not find a free trailer id after 50 attempts');
  }
}

export function toTrailerRecord(row: TrailerRow, truckUnit: string | null): TrailerRecord {
  return {
    id: row.id,
    unitNumber: row.unitNumber,
    vin: row.vin ?? '',
    year: row.year ?? null,
    make: row.make ?? null,
    model: row.model ?? null,
    type: row.type as TrailerRecord['type'],
    lengthFt: row.lengthFt ?? null,
    plate: row.plate ?? null,
    plateState: row.plateState ?? null,
    status: row.status as TrailerRecord['status'],
    ownership: row.ownership as TrailerRecord['ownership'],
    currentTruckId: row.currentTruckId ?? null,
    currentTruckUnit: truckUnit ?? null,
    nextInspectionDate: row.nextInspectionDate ?? null,
    homeTerminal: row.homeTerminal ?? null,
    source: row.source ?? null,
    externalId: row.externalId ?? null,
  };
}
