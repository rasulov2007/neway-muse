import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, isNull, ne, sql } from 'drizzle-orm';
import {
  SAFETY_DOCUMENT_KIND_LABEL,
  addDaysIso,
  easternDate,
  formatCaseNumber,
  type AttachSafetyDocumentInput,
  type SafetyCaseType,
  type SafetyDocument,
  type SafetyDocumentKind,
  type SafetyPerson,
  type SafetyPickers,
  type SafetyTimelineEntry,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { memberships, users } from '../../database/schema/admin';
import { storedFiles } from '../../database/schema/files';
import { trailers, workOrders } from '../../database/schema/fleet';
import { loads } from '../../database/schema/loads';
import { drivers, trucks } from '../../database/schema/roster';
import { safetyCaseDocuments, safetyCounters, type SafetyCaseDocumentRow } from '../../database/schema/safety';
import { AuditService, type AuditChange } from '../people/audit.service';

/** The audit `entity_type` of each case, which is also how its timeline is read back. */
export const AUDIT_ENTITY: Record<SafetyCaseType, string> = {
  accident: 'safety_accident',
  claim: 'safety_claim',
  violation: 'safety_violation',
  roadside_inspection: 'safety_roadside_inspection',
  safety_review: 'safety_review',
  drug_test: 'drug_alcohol_test',
};

/**
 * What every Safety service shares: numbers, the clock, the lookups that keep a link honest, the
 * version rule, documents and the timeline.
 *
 * "Now" is the server's clock and "today" is the Eastern date of it (owner, 2026-09-25): every
 * due date and business date in Safety is computed here, never in the browser.
 */
@Injectable()
export class SafetyCoreService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  /** The clock every write stamps; a test replaces it. */
  clock: () => Date = () => new Date();

  get db() {
    return this.database.db;
  }

  now(): Date {
    return this.clock();
  }

  today(): string {
    return easternDate(this.clock());
  }

  dueIn(days: number): string {
    return addDaysIso(this.today(), days);
  }

  actor(principal: Principal): string {
    return principal.userName ?? principal.userId;
  }

  newId(prefix: string): string {
    return `${prefix}_${crypto.randomUUID()}`;
  }

  /** The next human number for this company and kind: ACC-001, ACC-002, … Never reused. */
  async nextNumber(companyId: string, type: SafetyCaseType): Promise<string> {
    const rows = await this.db
      .insert(safetyCounters)
      .values({ companyId, kind: type, last: 1 })
      .onConflictDoUpdate({
        target: [safetyCounters.companyId, safetyCounters.kind],
        set: { last: sql`${safetyCounters.last} + 1` },
      })
      .returning({ last: safetyCounters.last });
    return formatCaseNumber(type, rows[0]?.last ?? 1);
  }

  // ------------------------------------------------------------------------------------ errors

  notFound(what: string): AppError {
    return new AppError({ status: 404, title: 'Not Found', detail: `${what} is not in this company.` });
  }

  /** A stale write: the record moved on since the caller read it. Never silently overwritten. */
  stale(label: string, current: { version: number; updatedAt: Date }): AppError {
    return new AppError({
      status: 409,
      title: 'Conflict',
      detail: `${label} was changed by someone else at ${current.updatedAt.toISOString()}. Reload it and make your change again.`,
      extensions: { currentVersion: current.version },
    });
  }

  refused(detail: string, missing?: string[]): AppError {
    return new AppError({
      status: 409,
      title: 'Conflict',
      detail: missing && missing.length > 0 ? `${detail}: ${missing.join('; ')}` : detail,
      extensions: missing ? { missing } : undefined,
    });
  }

  invalid(detail: string): AppError {
    return new AppError({ status: 422, title: 'Unprocessable Entity', detail });
  }

  forbidden(detail: string): AppError {
    return new AppError({ status: 403, title: 'Forbidden', detail });
  }

  /** Refuses a write against a voided record, or with a version that is not the stored one. */
  checkWritable(label: string, row: { version: number; updatedAt: Date; voidedAt: Date | null }, version: number): void {
    if (row.voidedAt) throw this.refused(`${label} is void and cannot be changed`);
    if (row.version !== version) throw this.stale(label, row);
  }

  // ----------------------------------------------------------------------------------- lookups

  async driver(companyId: string, id: string | null | undefined): Promise<{ id: string; name: string } | null> {
    if (!id) return null;
    const [row] = await this.db
      .select({ id: drivers.id, first: drivers.firstName, last: drivers.lastName })
      .from(drivers)
      .where(and(eq(drivers.companyId, companyId), eq(drivers.id, id)))
      .limit(1);
    if (!row) throw this.invalid('That driver is not in this company');
    return { id: row.id, name: `${row.first} ${row.last}`.trim() };
  }

  async truck(companyId: string, id: string | null | undefined): Promise<{ id: string; number: string } | null> {
    if (!id) return null;
    const [row] = await this.db
      .select({ id: trucks.id, number: trucks.unitNumber })
      .from(trucks)
      .where(and(eq(trucks.companyId, companyId), eq(trucks.id, id)))
      .limit(1);
    if (!row) throw this.invalid('That truck is not in this company');
    return row;
  }

  async trailer(companyId: string, id: string | null | undefined): Promise<{ id: string; number: string } | null> {
    if (!id) return null;
    const [row] = await this.db
      .select({ id: trailers.id, number: trailers.unitNumber })
      .from(trailers)
      .where(and(eq(trailers.companyId, companyId), eq(trailers.id, id)))
      .limit(1);
    if (!row) throw this.invalid('That trailer is not in this company');
    return row;
  }

  async load(companyId: string, id: string | null | undefined): Promise<{ id: string; number: string } | null> {
    if (!id) return null;
    const [row] = await this.db
      .select({ id: loads.id, number: loads.loadNumber })
      .from(loads)
      .where(and(eq(loads.companyId, companyId), eq(loads.id, id)))
      .limit(1);
    if (!row) throw this.invalid('That load is not in this company');
    return row;
  }

  async workOrder(companyId: string, id: string): Promise<{ id: string; number: string; unitId: string }> {
    const [row] = await this.db
      .select({ id: workOrders.id, number: workOrders.number, unitId: workOrders.unitId, voidedAt: workOrders.voidedAt })
      .from(workOrders)
      .where(and(eq(workOrders.companyId, companyId), eq(workOrders.id, id)))
      .limit(1);
    if (!row) throw this.invalid('That work order is not in this company');
    if (row.voidedAt) throw this.invalid(`Work order ${row.number} is void`);
    return { id: row.id, number: row.number, unitId: row.unitId };
  }

  /** The person who owns a case: an active account in this company. */
  async person(companyId: string, userId: string | null | undefined): Promise<{ id: string; name: string } | null> {
    if (!userId) return null;
    const [row] = await this.db
      .select({ id: users.id, first: users.firstName, last: users.lastName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.companyId, companyId), eq(memberships.userId, userId)))
      .limit(1);
    if (!row) throw this.invalid('That owner is not a member of this company');
    return { id: row.id, name: `${row.first} ${row.last}`.trim() };
  }

  /** Who can own a case: every active account in the company, by name. */
  async people(principal: Principal): Promise<SafetyPerson[]> {
    const rows = await this.db
      .select({ id: users.id, first: users.firstName, last: users.lastName })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(eq(memberships.companyId, principal.companyId), eq(memberships.status, 'active')))
      .orderBy(asc(users.firstName), asc(users.lastName));
    return rows.map((r) => ({ id: r.id, name: `${r.first} ${r.last}`.trim() }));
  }

  /**
   * What a Safety form picks from: drivers, units, recent loads and live work orders of this
   * company, by name. Readable with `safety.view`, so a Safety Manager does not need the fleet's
   * own read permissions to name the truck an accident happened in.
   */
  async pickers(principal: Principal): Promise<SafetyPickers> {
    const c = principal.companyId;
    const [driverRows, truckRows, trailerRows, loadRows, orderRows] = await Promise.all([
      this.db
        .select({ id: drivers.id, first: drivers.firstName, last: drivers.lastName, truckId: drivers.currentTruckId })
        .from(drivers)
        .where(and(eq(drivers.companyId, c), isNull(drivers.archivedAt)))
        .orderBy(asc(drivers.firstName), asc(drivers.lastName)),
      // Archived trucks (owner, 2026-10-05) are not offered in a picker.
      this.db.select({ id: trucks.id, number: trucks.unitNumber, driverId: trucks.currentDriverId }).from(trucks).where(and(eq(trucks.companyId, c), ne(trucks.status, 'archived'))).orderBy(asc(trucks.unitNumber)),
      this.db.select({ id: trailers.id, number: trailers.unitNumber }).from(trailers).where(eq(trailers.companyId, c)).orderBy(asc(trailers.unitNumber)),
      this.db.select({ id: loads.id, number: loads.loadNumber, driverId: loads.driverId, truckId: loads.truckId }).from(loads).where(eq(loads.companyId, c)).orderBy(desc(loads.createdAt)).limit(300),
      this.db
        .select({ id: workOrders.id, number: workOrders.number, unitId: workOrders.unitId, unitNumber: workOrders.unitNumber, status: workOrders.status })
        .from(workOrders)
        .where(and(eq(workOrders.companyId, c), isNull(workOrders.voidedAt)))
        .orderBy(desc(workOrders.shopInAt))
        .limit(300),
    ]);
    return {
      drivers: driverRows.map((d) => ({ id: d.id, name: `${d.first} ${d.last}`.trim(), truckId: d.truckId })),
      trucks: truckRows,
      trailers: trailerRows,
      loads: loadRows,
      workOrders: orderRows,
    };
  }

  /** The default owner of a new case: whoever opened it. */
  ownerOf(principal: Principal, chosen: { id: string; name: string } | null): { ownerId: string; ownerName: string } {
    return chosen
      ? { ownerId: chosen.id, ownerName: chosen.name }
      : { ownerId: principal.userId, ownerName: this.actor(principal) };
  }

  // ------------------------------------------------------------------------------------- audit

  async write(
    principal: Principal,
    type: SafetyCaseType,
    entity: { id: string; number: string },
    action: string,
    summary: string,
    options: { changes?: AuditChange[]; reason?: string | null; at?: Date } = {},
  ): Promise<void> {
    await this.audit.write(principal, {
      action,
      entityType: AUDIT_ENTITY[type],
      entityId: entity.id,
      entityLabel: entity.number,
      summary,
      changes: options.changes ?? [],
      reason: options.reason ?? null,
      at: options.at ?? this.clock(),
    });
  }

  async timeline(principal: Principal, type: SafetyCaseType, id: string): Promise<SafetyTimelineEntry[]> {
    const rows = await this.audit.forEntity(principal, AUDIT_ENTITY[type], id, 200);
    return rows.map((r) => ({
      id: r.id,
      at: r.at.toISOString(),
      actorName: r.actorName,
      action: r.action,
      summary: r.summary,
      reason: r.reason,
    }));
  }

  // --------------------------------------------------------------------------------- documents

  async documents(companyId: string, type: SafetyCaseType, caseId: string): Promise<SafetyDocument[]> {
    const rows = await this.db
      .select()
      .from(safetyCaseDocuments)
      .where(
        and(
          eq(safetyCaseDocuments.companyId, companyId),
          eq(safetyCaseDocuments.caseType, type),
          eq(safetyCaseDocuments.caseId, caseId),
          isNull(safetyCaseDocuments.voidedAt),
        ),
      )
      .orderBy(asc(safetyCaseDocuments.uploadedAt));
    return rows.map(toDocument);
  }

  /**
   * Attaches an uploaded file to a case. The bytes went to `POST /files` first; this is the
   * link, its label, and an audit line on the case.
   */
  async attach(
    principal: Principal,
    input: AttachSafetyDocumentInput,
    caseRef: { id: string; number: string },
  ): Promise<SafetyDocument> {
    const [file] = await this.db
      .select()
      .from(storedFiles)
      .where(and(eq(storedFiles.companyId, principal.companyId), eq(storedFiles.id, input.fileId)))
      .limit(1);
    if (!file) throw this.invalid('That file is not in this company; upload it again');
    const at = this.clock();
    const kind = input.kind as SafetyDocumentKind;
    const row: typeof safetyCaseDocuments.$inferInsert = {
      id: this.newId('sdoc'),
      companyId: principal.companyId,
      caseType: input.caseType,
      caseId: input.caseId,
      fileId: file.id,
      fileName: file.fileName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      title: input.title?.trim() || SAFETY_DOCUMENT_KIND_LABEL[kind],
      kind,
      uploadedBy: this.actor(principal),
      uploadedAt: at,
    };
    await this.db.insert(safetyCaseDocuments).values(row);
    await this.write(principal, input.caseType, caseRef, 'safety_document_attached', `Attached ${row.title} (${file.fileName})`, {
      changes: [{ field: 'documents', old: null, new: row.id }],
      at,
    });
    const [stored] = await this.db.select().from(safetyCaseDocuments).where(eq(safetyCaseDocuments.id, row.id)).limit(1);
    return toDocument(stored as SafetyCaseDocumentRow);
  }

  async voidDocument(
    principal: Principal,
    id: string,
    reason: string,
    resolveCase: (type: SafetyCaseType, caseId: string) => Promise<{ id: string; number: string }>,
  ): Promise<void> {
    const [row] = await this.db
      .select()
      .from(safetyCaseDocuments)
      .where(and(eq(safetyCaseDocuments.companyId, principal.companyId), eq(safetyCaseDocuments.id, id)))
      .limit(1);
    if (!row) throw this.notFound('That document');
    if (row.voidedAt) return;
    const at = this.clock();
    await this.db
      .update(safetyCaseDocuments)
      .set({ voidedAt: at, voidedBy: this.actor(principal), voidReason: reason })
      .where(and(eq(safetyCaseDocuments.id, id), isNull(safetyCaseDocuments.voidedAt)));
    const caseRef = await resolveCase(row.caseType as SafetyCaseType, row.caseId);
    await this.write(principal, row.caseType as SafetyCaseType, caseRef, 'safety_document_removed', `Removed ${row.title} (${row.fileName})`, {
      changes: [{ field: 'documents', old: row.id, new: null }],
      reason,
      at,
    });
  }
}

function toDocument(row: SafetyCaseDocumentRow): SafetyDocument {
  return {
    id: row.id,
    caseType: row.caseType as SafetyCaseType,
    caseId: row.caseId,
    fileId: row.fileId,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    title: row.title,
    kind: row.kind as SafetyDocumentKind,
    uploadedAt: row.uploadedAt.toISOString(),
    uploadedBy: row.uploadedBy,
  };
}

/** ISO string or null. */
export function iso(d: Date | null | undefined): string | null {
  return d ? d.toISOString() : null;
}

/** Turns an ISO string into a Date, or null. */
export function toDate(v: string | null | undefined): Date | null {
  return v ? new Date(v) : null;
}

/** The base fields every case row maps the same way. */
export function baseOf(row: {
  id: string;
  number: string;
  ownerId: string | null;
  ownerName: string | null;
  nextAction: string | null;
  nextActionDueOn: string | null;
  isTest: boolean;
  createdAt: Date;
  createdBy: string;
  updatedAt: Date;
  version: number;
  voidedAt: Date | null;
  voidedBy: string | null;
  voidReason: string | null;
}) {
  return {
    id: row.id,
    number: row.number,
    ownerId: row.ownerId,
    ownerName: row.ownerName,
    nextAction: row.nextAction,
    nextActionDueOn: row.nextActionDueOn,
    isTest: row.isTest,
    createdAt: row.createdAt.toISOString(),
    createdBy: row.createdBy,
    updatedAt: row.updatedAt.toISOString(),
    version: row.version,
    voidedAt: iso(row.voidedAt),
    voidedBy: row.voidedBy,
    voidReason: row.voidReason,
  };
}

/** `changes` for an audit line, from the fields a patch actually moved. */
export function changesOf(before: Record<string, unknown>, patch: Record<string, unknown>): AuditChange[] {
  const out: AuditChange[] = [];
  for (const [field, next] of Object.entries(patch)) {
    if (next === undefined || field === 'version' || field === 'updatedAt') continue;
    const prev = before[field];
    const a = prev instanceof Date ? prev.toISOString() : prev === null || prev === undefined ? null : String(prev);
    const b = next instanceof Date ? next.toISOString() : next === null ? null : String(next);
    if (a === b) continue;
    out.push({ field, old: a, new: b });
  }
  return out;
}
