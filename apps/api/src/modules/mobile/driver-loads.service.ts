import { createHash } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import {
  DRIVER_DOC_TYPES,
  DRIVER_DOC_TYPE_LABEL,
  DRIVER_UPLOAD_MAX_BYTES,
  type DriverDocType,
  type DriverDocumentUploadResponse,
  type DriverFileLink,
  type DriverFileUploadResponse,
  type DriverLoadDetail,
  type DriverLoadScope,
  type DriverLoadsResponse,
  type DriverMe,
  type DriverStopEventRequest,
  type StoredLoad,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { env } from '../../config/env';
import { DatabaseService } from '../../database/database.service';
import { storedFiles } from '../../database/schema/files';
import { loads as loadsTable } from '../../database/schema/loads';
import { ptiInspections } from '../../database/schema/pti';
import { cleanFileName, sniff } from '../driver-relations/receipts';
import { SIGNED_LINK_TTL_MS, signFileLink } from '../files/file-access';
import { FilesService } from '../files/files.service';
import { LoadsService } from '../loads/loads.service';
import { companyDay, DriverContextService, type DriverContext } from './driver-context.service';
import { documentsDue, driverDocuments, scopeSort, toDriverDocument, toDriverStop, toDriverSummary } from './driver-load-view';

const notFound = () => new AppError({ status: 404, title: 'Not Found', detail: 'No such load.' });
const unprocessable = (detail: string) => new AppError({ status: 422, title: 'Unprocessable Entity', detail });

/** A minute of telematics older than this reads as stale in the app. */
const FRESH_MINUTES = 60;

/**
 * The driver's own loads, read and written for the app. Every query filters by the company and by
 * the driver the session resolves to; a load of another driver or another company is "not found".
 */
@Injectable()
export class DriverLoadsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly context: DriverContextService,
    private readonly loads: LoadsService,
    private readonly files: FilesService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async me(principal: Principal): Promise<DriverMe> {
    const ctx = await this.context.resolve(principal);
    const now = this.loads.clock();
    const d = ctx.driver;
    const truck = ctx.truck;
    let telematics: DriverMe['telematics'] = null;
    if (truck) {
      const loc = (truck.location ?? null) as Record<string, unknown> | null;
      const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
      const syncedAt = truck.telematicsSyncedAt?.toISOString() ?? null;
      const age = truck.telematicsSyncedAt ? Math.max(0, Math.round((now.getTime() - truck.telematicsSyncedAt.getTime()) / 60_000)) : null;
      telematics = {
        provider: truck.telematicsProvider || null,
        location: loc
          ? {
              lat: num(loc['lat'] ?? loc['latitude']),
              lng: num(loc['lng'] ?? loc['lon'] ?? loc['longitude']),
              text: typeof (loc['text'] ?? loc['address'] ?? loc['formattedLocation']) === 'string' ? String(loc['text'] ?? loc['address'] ?? loc['formattedLocation']) : null,
              at: typeof (loc['at'] ?? loc['time'] ?? loc['updatedAt']) === 'string' ? String(loc['at'] ?? loc['time'] ?? loc['updatedAt']) : null,
            }
          : null,
        syncedAt,
        ageMinutes: age,
        freshness: age === null ? 'none' : age <= FRESH_MINUTES ? 'fresh' : 'stale',
        hos: { available: false, reason: 'Hours of service are not connected to the TMS. Check your ELD.' },
      };
    }
    return {
      driver: {
        id: d.id,
        driverNumber: d.driverNumber,
        name: ctx.driverName,
        firstName: d.firstName,
        lastName: d.lastName,
        status: d.status,
        driverType: d.driverType,
        phone: d.phone || null,
        email: d.email || null,
        homeCity: d.homeCity || null,
        homeState: d.homeState || null,
        preferredLanguage: d.preferredLanguage,
      },
      company: { id: ctx.companyId, name: ctx.companyName, timezone: ctx.companyTimezone },
      truck: truck
        ? { id: truck.id, unitNumber: truck.unitNumber, make: truck.make || null, model: truck.model || null, year: truck.year ?? null, plate: truck.plate ?? null, status: truck.status, odometer: truck.odometer ?? null }
        : null,
      trailer: ctx.trailer ? { id: ctx.trailer.id, unitNumber: ctx.trailer.unitNumber, type: ctx.trailer.type ?? null, plate: ctx.trailer.plate ?? null, status: ctx.trailer.status } : null,
      telematics,
      dispatch: await this.context.dispatchContact(ctx.companyId, d.dispatcherId, d.dispatcherName),
      serverNow: now.toISOString(),
      today: companyDay(ctx.companyTimezone, now),
    };
  }

  private async myLoads(ctx: DriverContext): Promise<StoredLoad[]> {
    const rows = await this.db
      .select({ record: loadsTable.record })
      .from(loadsTable)
      .where(and(eq(loadsTable.companyId, ctx.companyId), eq(loadsTable.driverId, ctx.driverId), eq(loadsTable.isDemo, false)))
      .orderBy(desc(loadsTable.updatedAt));
    return rows.map((r) => r.record as StoredLoad);
  }

  async list(principal: Principal, scope: DriverLoadScope): Promise<DriverLoadsResponse> {
    const ctx = await this.context.resolve(principal);
    const summaries = (await this.myLoads(ctx))
      .map((l) => toDriverSummary(l, ctx.driverId))
      .filter((s): s is NonNullable<typeof s> => s !== null && s.scope === scope)
      .sort((a, b) => scopeSort(scope, a, b));
    return { scope, loads: scope === 'completed' ? summaries.slice(0, 50) : summaries };
  }

  /** One of the driver's loads, by id or number. Any other load is 404, whoever owns it. */
  private async ownLoad(ctx: DriverContext, id: string): Promise<StoredLoad> {
    const [row] = await this.db
      .select({ record: loadsTable.record })
      .from(loadsTable)
      .where(
        and(
          eq(loadsTable.companyId, ctx.companyId),
          eq(loadsTable.driverId, ctx.driverId),
          eq(loadsTable.isDemo, false),
          or(eq(loadsTable.id, id), eq(loadsTable.loadNumber, id)),
        ),
      )
      .limit(1);
    if (!row) throw notFound();
    return row.record as StoredLoad;
  }

  private async detailOf(ctx: DriverContext, load: StoredLoad): Promise<DriverLoadDetail> {
    const summary = toDriverSummary(load, ctx.driverId);
    if (!summary) throw notFound();
    const notes = (load.notes ?? []).filter((n) => n.kind === 'driver');
    return {
      ...summary,
      stops: [...load.stops].sort((a, b) => a.sequence - b.sequence).map(toDriverStop),
      documents: driverDocuments(load, ctx.driverId),
      documentsDue: documentsDue(load),
      dispatch: await this.context.dispatchContact(ctx.companyId, load.dispatcherId || ctx.driver.dispatcherId, load.dispatcherName || ctx.driver.dispatcherName),
      driverNotes: notes.map((n) => ({ id: n.id, body: n.body, authorName: n.authorName, at: n.at })),
      expectedUpdatedAt: load.updatedAt,
    };
  }

  async detail(principal: Principal, id: string): Promise<DriverLoadDetail> {
    const ctx = await this.context.resolve(principal);
    return this.detailOf(ctx, await this.ownLoad(ctx, id));
  }

  async acknowledge(principal: Principal, id: string, expectedUpdatedAt?: string): Promise<DriverLoadDetail> {
    const ctx = await this.context.resolve(principal);
    const load = await this.ownLoad(ctx, id);
    const written = await this.loads.driverAcknowledge(principal, load.id, ctx.driverId, expectedUpdatedAt);
    return this.detailOf(ctx, written.load);
  }

  async stopEvent(principal: Principal, id: string, input: DriverStopEventRequest): Promise<DriverLoadDetail> {
    const ctx = await this.context.resolve(principal);
    const load = await this.ownLoad(ctx, id);
    const at = input.at ?? this.loads.clock().toISOString();
    if (Number.isNaN(Date.parse(at))) throw unprocessable('That time does not parse.');
    const written = await this.loads.driverStopEvent(principal, load.id, ctx.driverId, {
      stopId: input.stopId,
      kind: input.kind,
      at: new Date(at).toISOString(),
      ...(input.note ? { note: input.note } : {}),
      ...(input.delayReason ? { delayReason: input.delayReason } : {}),
      ...(input.expectedUpdatedAt ? { expectedUpdatedAt: input.expectedUpdatedAt } : {}),
    });
    return this.detailOf(ctx, written.load);
  }

  /**
   * A paper from the phone. The bytes are stored (stored_files), then filed on the load as
   * received, source driver_app. The load's status never moves here and nothing is reviewed.
   */
  async uploadDocument(
    principal: Principal,
    id: string,
    bytes: Buffer | null,
    meta: { fileName?: string; docType?: string; stopId?: string; pageCount?: string; replacesId?: string; idempotencyKey?: string },
  ): Promise<DriverDocumentUploadResponse> {
    const ctx = await this.context.resolve(principal);
    const load = await this.ownLoad(ctx, id);
    const type = (meta.docType ?? '').trim().toLowerCase();
    if (!(DRIVER_DOC_TYPES as readonly string[]).includes(type)) throw unprocessable(`x-doc-type must be one of ${DRIVER_DOC_TYPES.join(', ')}.`);
    const stopId = meta.stopId?.trim() || null;
    if (stopId && !load.stops.some((s) => s.id === stopId)) throw unprocessable('That stop is not on this load.');
    const replacesId = meta.replacesId?.trim() || null;
    let pageCount: number | null = null;
    if (meta.pageCount?.trim()) {
      pageCount = Number(meta.pageCount);
      if (!Number.isInteger(pageCount) || pageCount < 1 || pageCount > 200) throw unprocessable('x-page-count must be a whole number from 1 to 200.');
    }
    const stored = await this.storeBytes(principal, bytes, meta.fileName, ['image/jpeg', 'image/png', 'image/heic', 'application/pdf']);
    const label = DRIVER_DOC_TYPE_LABEL[type as DriverDocType];
    const stop = stopId ? load.stops.find((s) => s.id === stopId) : null;
    const written = await this.loads.driverAttachDocument(principal, load.id, ctx.driverId, {
      type: type as DriverDocType,
      fileName: stored.fileName,
      sizeBytes: stored.sizeBytes,
      mimeType: stored.contentType,
      fileUrl: FilesService.urlFor(stored.fileId),
      fileId: stored.fileId,
      fileHash: stored.hash,
      title: stop ? `${label} · ${stop.facilityName || stop.city}` : label,
      stopId,
      replacesId,
      source: 'driver_app',
      uploadedByDriverId: ctx.driverId,
      pageCount: pageCount ?? (stored.contentType.startsWith('image/') ? 1 : null),
      idempotencyKey: meta.idempotencyKey?.trim() || null,
    });
    const doc = written.load.documents.find((d) => d.id === written.documentId);
    if (!doc) throw new AppError({ status: 500, title: 'Internal Server Error', detail: 'The document was not filed.' });
    return { document: toDriverDocument(doc, ctx.driverId), loadUpdatedAt: written.load.updatedAt };
  }

  /**
   * A file a later write attaches by its id: a photo (PTI, breakdown, parked truck), a short video
   * (breakdown, accident), a receipt or a document (photo or PDF). Stored for this driver only.
   * Each write still checks what it accepts (a PTI photo must be an image).
   */
  async uploadFile(principal: Principal, bytes: Buffer | null, fileName: string | undefined): Promise<DriverFileUploadResponse> {
    await this.context.resolve(principal);
    const stored = await this.storeBytes(principal, bytes, fileName, ['image/jpeg', 'image/png', 'image/heic', 'application/pdf', 'video/mp4', 'video/quicktime']);
    return { fileId: stored.fileId, fileName: stored.fileName, contentType: stored.contentType, sizeBytes: stored.sizeBytes };
  }

  private async storeBytes(principal: Principal, bytes: Buffer | null, fileName: string | undefined, allowed: string[]) {
    if (!bytes || bytes.byteLength === 0) throw unprocessable('The file is empty.');
    if (bytes.byteLength > DRIVER_UPLOAD_MAX_BYTES) throw new AppError({ status: 413, title: 'Payload Too Large', detail: 'Files are limited to 25 MB.' });
    // What the file is comes from its bytes, never from the header the phone sent.
    const contentType = sniff(bytes) ?? sniffVideo(bytes);
    if (!contentType || !allowed.includes(contentType)) {
      throw new AppError({ status: 415, title: 'Unsupported Media Type', detail: `Send a ${allowed.map((t) => t.split('/')[1]?.toUpperCase()).join(', ')} file.` });
    }
    let name = 'file';
    try {
      name = decodeURIComponent(fileName ?? '') || 'file';
    } catch {
      name = fileName || 'file';
    }
    const info = await this.files.store(principal.companyId, {
      fileName: cleanFileName(name),
      contentType,
      bytes,
      // The account id, so the uploader check (and the driver's own file link) recognise the driver.
      uploadedBy: principal.userId,
    });
    return { fileId: info.id, fileName: info.fileName, contentType, sizeBytes: info.sizeBytes, hash: createHash('sha256').update(bytes).digest('hex') };
  }

  /**
   * A five-minute link to a file the driver may open: one they uploaded, or one on their own load
   * or their own walk-around. Anything else is 404.
   */
  async fileLink(principal: Principal, fileId: string): Promise<DriverFileLink> {
    const ctx = await this.context.resolve(principal);
    const [file] = await this.db
      .select({ id: storedFiles.id, uploadedBy: storedFiles.uploadedBy })
      .from(storedFiles)
      .where(and(eq(storedFiles.companyId, ctx.companyId), eq(storedFiles.id, fileId), sql`${storedFiles.deletedAt} is null`))
      .limit(1);
    if (!file) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such file.' });
    let mine = file.uploadedBy === principal.userId;
    if (!mine) {
      const [onLoad] = await this.db
        .select({ id: loadsTable.id })
        .from(loadsTable)
        .where(and(eq(loadsTable.companyId, ctx.companyId), eq(loadsTable.driverId, ctx.driverId), sql`strpos(${loadsTable.record}::text, ${fileId}) > 0`))
        .limit(1);
      mine = Boolean(onLoad);
    }
    if (!mine) {
      const [onPti] = await this.db
        .select({ id: ptiInspections.id })
        .from(ptiInspections)
        .where(and(eq(ptiInspections.companyId, ctx.companyId), eq(ptiInspections.driverId, ctx.driverId), sql`strpos(coalesce(${ptiInspections.source}::text, ''), ${fileId}) > 0`))
        .limit(1);
      mine = Boolean(onPti);
    }
    if (!mine) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such file.' });
    const expires = Date.now() + SIGNED_LINK_TTL_MS;
    const token = signFileLink(env.APP_SECRET, { f: file.id, c: ctx.companyId, u: principal.userId, e: expires });
    return { url: FilesService.signedUrlFor(token), expiresAt: new Date(expires).toISOString() };
  }
}

/** ISO base-media brands a phone camera writes for a video: MP4 or QuickTime (MOV). HEIC is an image. */
const MP4_BRANDS = new Set(['isom', 'iso2', 'iso4', 'iso5', 'iso6', 'mp41', 'mp42', 'avc1', 'M4V ', 'MSNV', 'dash', '3gp4', '3gp5', '3g2a']);

/** A video by its first bytes (`....ftyp<brand>`), never by the name or the header. */
export function sniffVideo(bytes: Buffer): 'video/mp4' | 'video/quicktime' | null {
  if (bytes.length < 12 || bytes.subarray(4, 8).toString('latin1') !== 'ftyp') return null;
  const brand = bytes.subarray(8, 12).toString('latin1');
  if (brand === 'qt  ') return 'video/quicktime';
  return MP4_BRANDS.has(brand) ? 'video/mp4' : null;
}
