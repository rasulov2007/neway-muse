import { Injectable } from '@nestjs/common';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { trailers } from '../../database/schema/fleet';
import { storedFiles } from '../../database/schema/files';
import { loads as loadsTable } from '../../database/schema/loads';
import { trucks } from '../../database/schema/roster';
import type { DriverContext } from './driver-context.service';

const unprocessable = (detail: string) => new AppError({ status: 422, title: 'Unprocessable Entity', detail });
const notFound = (detail: string) => new AppError({ status: 404, title: 'Not Found', detail });

export interface OwnFile {
  id: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
}

/** Statuses of a load the driver is still on (or just finished): units on it count as theirs. */
const LIVE_LOAD = ['booked', 'assigned', 'dispatched', 'at_pickup', 'loading', 'loaded', 'in_transit', 'at_delivery', 'unloading', 'delivered'];

/**
 * What a driver may name in a write: their own uploads, their own loads, the units they are
 * assigned to. Every check runs against the server's records for the driver the session resolved
 * to; an id from another driver or company is refused exactly like one that does not exist.
 */
@Injectable()
export class DriverOwnershipService {
  constructor(private readonly database: DatabaseService) {}

  private get db() {
    return this.database.db;
  }

  /** Files this account uploaded (POST /driver/files), in this company, not removed. */
  async ownFiles(principal: Principal, ids: readonly string[], accept?: (contentType: string) => boolean): Promise<Map<string, OwnFile>> {
    const unique = [...new Set(ids)];
    const out = new Map<string, OwnFile>();
    if (unique.length === 0) return out;
    const rows = await this.db
      .select({ id: storedFiles.id, fileName: storedFiles.fileName, contentType: storedFiles.contentType, sizeBytes: storedFiles.sizeBytes, uploadedBy: storedFiles.uploadedBy })
      .from(storedFiles)
      .where(and(eq(storedFiles.companyId, principal.companyId), inArray(storedFiles.id, unique), sql`${storedFiles.deletedAt} is null`));
    const byId = new Map(rows.map((r) => [r.id, r]));
    for (const id of unique) {
      const row = byId.get(id);
      if (!row || row.uploadedBy !== principal.userId) throw unprocessable(`File ${id} was not uploaded from this account. Send it with POST /driver/files first.`);
      if (accept && !accept(row.contentType)) throw unprocessable(`${row.fileName} is not a kind of file this accepts.`);
      out.set(id, { id: row.id, fileName: row.fileName, contentType: row.contentType, sizeBytes: row.sizeBytes });
    }
    return out;
  }

  /** One of the driver's own loads (driver or co-driver, this company, not demo); else 404. */
  async ownLoad(ctx: DriverContext, loadId: string): Promise<{ id: string; loadNumber: string; truckId: string | null; trailerId: string | null; dispatcherId: string | null }> {
    const [row] = await this.db
      .select({ id: loadsTable.id, loadNumber: loadsTable.loadNumber, truckId: loadsTable.truckId, trailerId: loadsTable.trailerId, dispatcherId: loadsTable.dispatcherId })
      .from(loadsTable)
      .where(
        and(
          eq(loadsTable.companyId, ctx.companyId),
          eq(loadsTable.isDemo, false),
          or(eq(loadsTable.id, loadId), eq(loadsTable.loadNumber, loadId)),
          or(eq(loadsTable.driverId, ctx.driverId), sql`${loadsTable.record}->>'coDriverId' = ${ctx.driverId}`),
        ),
      )
      .limit(1);
    if (!row) throw notFound('No such load.');
    return row;
  }

  /**
   * The truck and trailer a report is about: the driver's assignment, unless they name another
   * unit that is also theirs (a truck that names them, a trailer on their truck, a unit on one of
   * their live loads). Anything else is refused.
   */
  async units(ctx: DriverContext, input: { truckId?: string | null; trailerId?: string | null }): Promise<{ truck: { id: string; unitNumber: string } | null; trailer: { id: string; unitNumber: string } | null }> {
    const live = await this.db
      .select({ truckId: loadsTable.truckId, trailerId: loadsTable.trailerId })
      .from(loadsTable)
      .where(and(eq(loadsTable.companyId, ctx.companyId), eq(loadsTable.isDemo, false), eq(loadsTable.driverId, ctx.driverId), inArray(loadsTable.status, LIVE_LOAD)));
    const truckIds = new Set<string>([...(ctx.truck ? [ctx.truck.id] : []), ...live.map((l) => l.truckId).filter((t): t is string => Boolean(t))]);
    const mine = await this.db.select({ id: trucks.id }).from(trucks).where(and(eq(trucks.companyId, ctx.companyId), eq(trucks.currentDriverId, ctx.driverId)));
    for (const t of mine) truckIds.add(t.id);
    const trailerIds = new Set<string>([...(ctx.trailer ? [ctx.trailer.id] : []), ...live.map((l) => l.trailerId).filter((t): t is string => Boolean(t))]);
    if (truckIds.size) {
      const hooked = await this.db
        .select({ id: trailers.id })
        .from(trailers)
        .where(and(eq(trailers.companyId, ctx.companyId), inArray(trailers.currentTruckId, [...truckIds])));
      for (const t of hooked) trailerIds.add(t.id);
    }

    const truckId = input.truckId === undefined ? (ctx.truck?.id ?? null) : input.truckId;
    const trailerId = input.trailerId === undefined ? (ctx.trailer?.id ?? null) : input.trailerId;
    if (truckId && !truckIds.has(truckId)) throw unprocessable('That truck is not assigned to you.');
    if (trailerId && !trailerIds.has(trailerId)) throw unprocessable('That trailer is not assigned to you.');
    const [truck] = truckId ? await this.db.select({ id: trucks.id, unitNumber: trucks.unitNumber }).from(trucks).where(and(eq(trucks.companyId, ctx.companyId), eq(trucks.id, truckId))).limit(1) : [];
    const [trailer] = trailerId
      ? await this.db
          .select({ id: trailers.id, unitNumber: trailers.unitNumber })
          .from(trailers)
          .where(and(eq(trailers.companyId, ctx.companyId), eq(trailers.id, trailerId)))
          .limit(1)
      : [];
    return { truck: truck ?? null, trailer: trailer ?? null };
  }
}

export const isImage = (t: string) => t.startsWith('image/');
export const isImageOrPdf = (t: string) => t.startsWith('image/') || t === 'application/pdf';
export const isMedia = (t: string) => t.startsWith('image/') || t.startsWith('video/');
