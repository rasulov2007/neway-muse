import { Injectable } from '@nestjs/common';
import { and, desc, eq, ne, type SQL } from 'drizzle-orm';
import {
  NOT_APPLICABLE_ALLOWED,
  addMonthsClamped,
  easternDate,
  SYSTEM_REQUIREMENTS,
  type ComplianceDocument,
  type ComplianceDocumentStatus,
  type ComplianceOwnerType,
  type ComplianceScope,
  type DocumentSource,
  type QualificationItem,
  type QualificationRequirement,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DocumentStorageService } from '../../common/storage/document-storage.service';
import { DatabaseService } from '../../database/database.service';
import {
  complianceDocuments,
  qualificationItems,
  type ComplianceDocumentRow,
  type QualificationItemRow,
} from '../../database/schema/compliance';
import { ComplianceAuditService } from './compliance-audit.service';

const isoDate = (d: Date | string | null): string | null =>
  d === null ? null : typeof d === 'string' ? d.slice(0, 10) : d.toISOString().slice(0, 10);
const isoTime = (d: Date | null): string | null => (d === null ? null : d.toISOString());

/**
 * The qualification file: requirements, items and the documents that evidence them.
 *
 * Status is never stored. An item carries dates and verification facts; the shared engine derives
 * everything else against the clock, on the client and on the server alike. This service therefore
 * has no "set status" method and never will — it has upload, verify, reject and waive, which are
 * the four things a person actually does to a qualification file.
 */
@Injectable()
export class ComplianceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: ComplianceAuditService,
    private readonly storage: DocumentStorageService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** The catalog. Company-specific requirements are a later phase; today it is the system set. */
  requirements(): QualificationRequirement[] {
    return [...SYSTEM_REQUIREMENTS];
  }

  /**
   * `receivedAt` is when the document on file was uploaded, for the fixed-term reviews that carry
   * no report date (owner, 2026-10-24: an MVR or PSP is good for 6 months from its date, else from
   * the day it arrived). Readers that do not join the document leave it out.
   */
  toItem(row: QualificationItemRow, receivedAt?: Date | null): QualificationItem {
    return {
      id: row.id,
      requirementCode: row.requirementCode,
      scope: row.scope as ComplianceScope,
      entityId: row.entityId,
      entityLabel: row.entityLabel,
      documentId: row.documentId,
      issuedOn: isoDate(row.issuedOn),
      expiresOn: isoDate(row.expiresOn),
      verifiedAt: isoTime(row.verifiedAt),
      verifiedBy: row.verifiedBy,
      verificationFailed: row.verificationFailed,
      verificationNote: row.verificationNote,
      waivedUntil: isoDate(row.waivedUntil),
      waivedReason: row.waivedReason,
      notApplicable: row.notApplicable,
      notes: row.notes,
      ...(receivedAt ? { receivedOn: easternDate(receivedAt) } : {}),
    };
  }

  /** Items matching `where`, each with the upload time of the document it points at. */
  async itemsWhere(where: SQL | undefined): Promise<QualificationItem[]> {
    const rows = await this.db
      .select({ item: qualificationItems, receivedAt: complianceDocuments.uploadedAt })
      .from(qualificationItems)
      .leftJoin(
        complianceDocuments,
        and(
          eq(complianceDocuments.id, qualificationItems.documentId),
          eq(complianceDocuments.companyId, qualificationItems.companyId),
        ),
      )
      .where(where)
      .orderBy(qualificationItems.id);
    return rows.map((r) => this.toItem(r.item, r.receivedAt));
  }

  toDocument(row: ComplianceDocumentRow): ComplianceDocument {
    return {
      id: row.id,
      ownerType: row.ownerType as ComplianceOwnerType,
      ownerId: row.ownerId,
      ownerLabel: row.ownerLabel,
      extracted: (row.extracted as ComplianceDocument['extracted']) ?? null,
      requirementCode: row.requirementCode,
      title: row.title,
      fileName: row.fileName,
      contentType: row.contentType,
      sizeBytes: row.sizeBytes,
      issuedOn: isoDate(row.issuedOn),
      expiresOn: isoDate(row.expiresOn),
      status: row.status as ComplianceDocumentStatus,
      source: row.source as DocumentSource,
      uploadedAt: row.uploadedAt.toISOString(),
      uploadedBy: row.uploadedBy,
      verifiedAt: isoTime(row.verifiedAt),
      verifiedBy: row.verifiedBy,
      rejectionReason: row.rejectionReason,
      version: row.version,
      supersedesDocumentId: row.supersedesDocumentId,
      containsPii: row.containsPii,
      hasFile: row.storageKey !== null,
    };
  }

  async listItems(
    principal: Principal,
    query: { scope?: ComplianceScope; entityId?: string },
  ): Promise<QualificationItem[]> {
    const parts = [eq(qualificationItems.companyId, principal.companyId)];
    if (query.scope) parts.push(eq(qualificationItems.scope, query.scope));
    if (query.entityId) parts.push(eq(qualificationItems.entityId, query.entityId));
    return this.itemsWhere(and(...parts));
  }

  /** Items for one driver, for the verification derivation. */
  async itemsForEntity(companyId: string, scope: string, entityId: string) {
    return this.itemsWhere(
      and(
        eq(qualificationItems.companyId, companyId),
        eq(qualificationItems.scope, scope),
        eq(qualificationItems.entityId, entityId),
      ),
    );
  }

  async listDocuments(
    principal: Principal,
    query: {
      ownerType?: ComplianceOwnerType;
      ownerId?: string;
      requirementCode?: string;
      status?: ComplianceDocumentStatus;
    },
  ): Promise<ComplianceDocument[]> {
    const parts = [eq(complianceDocuments.companyId, principal.companyId)];
    if (query.ownerType) parts.push(eq(complianceDocuments.ownerType, query.ownerType));
    if (query.ownerId) parts.push(eq(complianceDocuments.ownerId, query.ownerId));
    if (query.requirementCode)
      parts.push(eq(complianceDocuments.requirementCode, query.requirementCode));
    if (query.status) parts.push(eq(complianceDocuments.status, query.status));
    const rows = await this.db
      .select()
      .from(complianceDocuments)
      .where(and(...parts))
      .orderBy(desc(complianceDocuments.uploadedAt));
    return rows.map((row) => this.toDocument(row));
  }

  /**
   * Attaches a document to a requirement.
   *
   * This writes **two** records, and both are necessary. The document is the evidence; the
   * qualification item is what the engine actually reads. Writing only the document would leave
   * the requirement reading `missing` with a file sitting next to it.
   *
   * The upload does **not** satisfy the requirement on its own. It moves the item to
   * `pending_verification`: a human still has to check the document against the rule. A dispatch
   * hold therefore stays in place until somebody verifies it, by design.
   *
   * Re-uploading against a requirement that already has a document supersedes it and keeps the
   * version chain, because a renewal must not erase what it replaced.
   *
   * The bytes are stored only when the caller has them: a document the system rendered itself
   * arrives with `bytes` and gets a storage key. An upload registered from the screen still has
   * none — the row records that a document exists and what it evidences, and `hasFile` says so.
   */
  async upload(
    principal: Principal,
    input: {
      ownerType: ComplianceOwnerType;
      ownerId: string;
      ownerLabel: string;
      requirementCode: string;
      title: string;
      fileName: string;
      contentType: string;
      sizeBytes: number;
      issuedOn: string | null;
      expiresOn: string | null;
      source: DocumentSource;
      notes?: string | null;
      /** What was read off the card, as the person confirmed it. */
      extracted?: unknown;
      /** The file itself, when the system produced it. */
      bytes?: Uint8Array;
      /** When the upload happened, if not now — the seed files history with its real timestamps. */
      at?: Date;
    },
  ): Promise<{ document: ComplianceDocument; item: QualificationItem }> {
    const requirement = SYSTEM_REQUIREMENTS.find((r) => r.code === input.requirementCode);
    if (!requirement) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `No requirement with code ${input.requirementCode}`,
      });
    }
    // A fixed-term type (MVR, PSP: 6 months; inspections, Clearinghouse: 12) falls due from its
    // date, so an upload without a typed expiry takes the term from the report date, else from
    // today (Eastern). Every intake path files through here, so none of them is refused for it.
    if (requirement.hasExpiry && !input.expiresOn && requirement.validityMonths) {
      input = {
        ...input,
        expiresOn: addMonthsClamped(input.issuedOn ?? easternDate(input.at ?? new Date()), requirement.validityMonths),
      };
    }
    if (requirement.hasExpiry && !input.expiresOn) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `${requirement.name} expires, so an expiry date is required`,
      });
    }

    const by = principal.userName ?? principal.userId;
    const at = input.at ?? new Date();

    const [previous] = await this.db
      .select()
      .from(complianceDocuments)
      .where(
        and(
          eq(complianceDocuments.companyId, principal.companyId),
          eq(complianceDocuments.ownerId, input.ownerId),
          eq(complianceDocuments.requirementCode, input.requirementCode),
          ne(complianceDocuments.status, 'expired'),
        ),
      )
      .orderBy(desc(complianceDocuments.version))
      .limit(1);

    const documentId = `doc_${crypto.randomUUID()}`;
    const stored = input.bytes
      ? await this.storage.put(
          `compliance/${principal.companyId}/${documentId}${extensionFor(input.contentType)}`,
          input.bytes,
        )
      : null;
    const [existing] = await this.db
      .select()
      .from(qualificationItems)
      .where(
        and(
          eq(qualificationItems.companyId, principal.companyId),
          eq(qualificationItems.scope, requirement.scope),
          eq(qualificationItems.entityId, input.ownerId),
          eq(qualificationItems.requirementCode, input.requirementCode),
        ),
      )
      .limit(1);

    const [document] = await this.db
      .insert(complianceDocuments)
      .values({
        id: documentId,
        companyId: principal.companyId,
        ownerType: input.ownerType,
        ownerId: input.ownerId,
        ownerLabel: input.ownerLabel,
        requirementCode: input.requirementCode,
        title: input.title.trim(),
        fileName: input.fileName,
        contentType: input.contentType,
        sizeBytes: stored?.sizeBytes ?? input.sizeBytes,
        storageKey: stored?.key ?? null,
        // Stored beside the bytes it was read from, so the two cannot drift apart.
        extracted: (input.extracted as never) ?? null,
        issuedOn: input.issuedOn,
        expiresOn: input.expiresOn,
        // Uploading is collecting evidence, not approving it. A reviewer decides next.
        status: 'pending_review',
        source: input.source,
        uploadedAt: at,
        uploadedBy: by,
        version: previous ? previous.version + 1 : 1,
        supersedesDocumentId: previous?.id ?? null,
        containsPii: requirement.code !== 'annual_inspection' && requirement.scope === 'driver',
      })
      .returning();

    const itemValues = {
      documentId,
      issuedOn: input.issuedOn,
      expiresOn: input.expiresOn,
      // A fresh document clears any earlier rejection: the reviewer is looking at a new file.
      verifiedAt: null,
      verifiedBy: null,
      verificationFailed: false,
      verificationNote: null,
      notes: input.notes === undefined ? undefined : input.notes,
      updatedAt: at,
    };
    let itemRow: QualificationItemRow;
    if (existing) {
      [itemRow] = (await this.db
        .update(qualificationItems)
        .set(itemValues)
        .where(eq(qualificationItems.id, existing.id))
        .returning()) as [QualificationItemRow];
    } else {
      [itemRow] = (await this.db
        .insert(qualificationItems)
        .values({
          id: `qi_${crypto.randomUUID()}`,
          companyId: principal.companyId,
          requirementCode: input.requirementCode,
          scope: requirement.scope,
          entityId: input.ownerId,
          entityLabel: input.ownerLabel,
          ...itemValues,
          notes: input.notes ?? null,
        })
        .returning()) as [QualificationItemRow];
    }

    await this.audit.write(principal, {
      action: 'document_uploaded',
      entity: { type: input.ownerType, id: input.ownerId, label: input.ownerLabel },
      subject: input.requirementCode,
      before: existing?.documentId ? 'Superseded' : 'Missing',
      after: 'Pending review',
      reason: previous
        ? `${input.title.trim()} uploaded, superseding version ${previous.version}`
        : `${input.title.trim()} uploaded`,
      at,
    });

    return {
      document: this.toDocument(document as ComplianceDocumentRow),
      item: this.toItem(itemRow),
    };
  }

  /**
   * Opens the qualification file for a driver the roster just created.
   *
   * The recruiter typed two expiry dates into the form. Both items start **unverified**: a date
   * typed into a form is a claim, not a checked document, so each reads `pending_verification`
   * until somebody attaches and verifies the file. This is the behaviour the browser demo had and
   * the API keeps now that it owns the rows.
   */
  async openItemsForNewDriver(
    principal: Principal,
    driver: { id: string; name: string; cdlExpiresOn: string; medicalCardExpiresOn: string | null },
  ): Promise<void> {
    const at = new Date();
    const rows = (
      [
        ['cdl', driver.cdlExpiresOn],
        ['medical_card', driver.medicalCardExpiresOn],
      ] as const
    ).map(([code, expiresOn]) => ({
      id: `qi_${crypto.randomUUID()}`,
      companyId: principal.companyId,
      requirementCode: code,
      scope: 'driver',
      entityId: driver.id,
      entityLabel: driver.name,
      documentId: null,
      issuedOn: null,
      expiresOn,
      createdAt: at,
      updatedAt: at,
    }));
    await this.db.insert(qualificationItems).values(rows).onConflictDoNothing();
    await this.audit.write(principal, {
      action: 'item_updated',
      entity: { type: 'driver', id: driver.id, label: driver.name },
      subject: 'Driver qualification file',
      before: null,
      after: 'Opened with CDL and medical certificate dates; both await documents',
      reason: null,
      at,
    });
  }

  /** Marks a document verified and clears any earlier rejection on the item it evidences. */
  async verifyDocument(
    principal: Principal,
    id: string,
    options: { at?: Date } = {},
  ): Promise<ComplianceDocument> {
    const doc = await this.document(principal, id);
    const by = principal.userName ?? principal.userId;
    const at = options.at ?? new Date();
    const [updated] = await this.db
      .update(complianceDocuments)
      .set({ status: 'verified', verifiedAt: at, verifiedBy: by, rejectionReason: null })
      .where(eq(complianceDocuments.id, id))
      .returning();
    await this.db
      .update(qualificationItems)
      .set({
        verifiedAt: at,
        verifiedBy: by,
        verificationFailed: false,
        verificationNote: null,
        updatedAt: at,
      })
      .where(
        and(
          eq(qualificationItems.companyId, principal.companyId),
          eq(qualificationItems.documentId, id),
        ),
      );
    await this.audit.write(principal, {
      action: 'document_verified',
      entity: { type: doc.ownerType, id: doc.ownerId, label: doc.ownerLabel },
      subject: doc.requirementCode,
      before: doc.status,
      after: 'verified',
      reason: null,
      at,
    });
    const view = this.toDocument(updated as ComplianceDocumentRow);
    await this.announceReview(principal, view);
    return view;
  }

  /** Rejects a document; the item it evidences reads `verification_failed` until re-collected. */
  async rejectDocument(
    principal: Principal,
    id: string,
    reason: string,
  ): Promise<ComplianceDocument> {
    const doc = await this.document(principal, id);
    const at = new Date();
    const [updated] = await this.db
      .update(complianceDocuments)
      .set({ status: 'rejected', rejectionReason: reason, verifiedAt: null, verifiedBy: null })
      .where(eq(complianceDocuments.id, id))
      .returning();
    await this.db
      .update(qualificationItems)
      .set({
        verifiedAt: null,
        verifiedBy: null,
        verificationFailed: true,
        verificationNote: reason,
        updatedAt: at,
      })
      .where(
        and(
          eq(qualificationItems.companyId, principal.companyId),
          eq(qualificationItems.documentId, id),
        ),
      );
    await this.audit.write(principal, {
      action: 'document_rejected',
      entity: { type: doc.ownerType, id: doc.ownerId, label: doc.ownerLabel },
      subject: doc.requirementCode,
      before: doc.status,
      after: 'rejected',
      reason,
      at,
    });
    const view = this.toDocument(updated as ComplianceDocumentRow);
    await this.announceReview(principal, view);
    return view;
  }

  /**
   * Called after a document is verified or rejected (mobile M3): the mobile module tells the driver
   * who sent it from the app. A listener's failure never fails the review.
   */
  readonly afterReview: Array<(principal: Principal, document: ComplianceDocument) => Promise<void>> = [];

  private async announceReview(principal: Principal, document: ComplianceDocument): Promise<void> {
    for (const listener of this.afterReview) {
      try {
        await listener(principal, document);
      } catch {
        // The listener records its own failure.
      }
    }
  }

  /**
   * Removes a document and its file. The qualification item it backed is pointed at nothing, so
   * the requirement reads as missing again rather than as satisfied by a file that is gone. The
   * audit entry is the record that it existed.
   */
  async deleteDocument(principal: Principal, id: string): Promise<{ id: string }> {
    const doc = await this.document(principal, id);
    const [row] = await this.db
      .select({ storageKey: complianceDocuments.storageKey })
      .from(complianceDocuments)
      .where(eq(complianceDocuments.id, id))
      .limit(1);
    const at = new Date();
    await this.db
      .update(qualificationItems)
      .set({ documentId: null, updatedAt: at })
      .where(
        and(
          eq(qualificationItems.companyId, principal.companyId),
          eq(qualificationItems.documentId, id),
        ),
      );
    await this.db
      .update(complianceDocuments)
      .set({ supersedesDocumentId: null })
      .where(
        and(
          eq(complianceDocuments.companyId, principal.companyId),
          eq(complianceDocuments.supersedesDocumentId, id),
        ),
      );
    await this.db.delete(complianceDocuments).where(eq(complianceDocuments.id, id));
    if (row?.storageKey) await this.storage.remove(row.storageKey);
    await this.audit.write(principal, {
      action: 'document_deleted',
      entity: { type: doc.ownerType, id: doc.ownerId, label: doc.ownerLabel },
      subject: doc.requirementCode,
      before: doc.status,
      after: null,
      reason: doc.fileName,
      at,
    });
    return { id };
  }

  /** One document's record (not its bytes), as a list of zero or one. */
  async listDocumentsById(principal: Principal, id: string): Promise<ComplianceDocument[]> {
    const rows = await this.db
      .select()
      .from(complianceDocuments)
      .where(and(eq(complianceDocuments.companyId, principal.companyId), eq(complianceDocuments.id, id)))
      .limit(1);
    return rows.map((row) => this.toDocument(row));
  }

  /**
   * A reviewer decides a requirement does not apply to this driver (a first-time CDL holder has no
   * previous DOT employer to verify). Only the codes the catalog allows, always with a reason, and
   * audited with who and when — the item then reads `not_applicable` until somebody evidences it.
   */
  async markNotApplicable(
    principal: Principal,
    input: { driverId: string; driverName: string; requirementCode: string; reason: string },
  ): Promise<QualificationItem> {
    if (!NOT_APPLICABLE_ALLOWED.has(input.requirementCode)) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `${input.requirementCode.replace(/_/g, ' ')} cannot be marked not applicable; it must be evidenced`,
      });
    }
    const at = new Date();
    const [existing] = await this.db
      .select()
      .from(qualificationItems)
      .where(
        and(
          eq(qualificationItems.companyId, principal.companyId),
          eq(qualificationItems.scope, 'driver'),
          eq(qualificationItems.entityId, input.driverId),
          eq(qualificationItems.requirementCode, input.requirementCode),
        ),
      )
      .limit(1);
    let row: QualificationItemRow;
    if (existing) {
      const [updated] = await this.db
        .update(qualificationItems)
        .set({ notApplicable: true, notes: input.reason, updatedAt: at })
        .where(eq(qualificationItems.id, existing.id))
        .returning();
      row = updated as QualificationItemRow;
    } else {
      const [inserted] = await this.db
        .insert(qualificationItems)
        .values({
          id: `qi_${crypto.randomUUID()}`,
          companyId: principal.companyId,
          requirementCode: input.requirementCode,
          scope: 'driver',
          entityId: input.driverId,
          entityLabel: input.driverName,
          notApplicable: true,
          notes: input.reason,
          createdAt: at,
          updatedAt: at,
        })
        .returning();
      row = inserted as QualificationItemRow;
    }
    await this.audit.write(principal, {
      action: 'item_updated',
      entity: { type: 'driver', id: input.driverId, label: input.driverName },
      subject: input.requirementCode,
      before: existing ? (existing.notApplicable ? 'Not applicable' : 'Required') : 'Required',
      after: 'Not applicable',
      reason: input.reason,
      at,
    });
    return this.toItem(row);
  }

  /** Management accepts the gap knowingly, until a date, for a recorded reason. */
  async waiveItem(
    principal: Principal,
    id: string,
    input: { until: string; reason: string },
  ): Promise<QualificationItem> {
    const [row] = await this.db
      .select()
      .from(qualificationItems)
      .where(
        and(eq(qualificationItems.companyId, principal.companyId), eq(qualificationItems.id, id)),
      )
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No item ${id}` });
    const item = this.toItem(row);
    const before = item.waivedUntil
      ? `Waived until ${item.waivedUntil}`
      : item.expiresOn
        ? `Expires ${item.expiresOn}`
        : null;
    const at = new Date();
    const [updated] = await this.db
      .update(qualificationItems)
      .set({ waivedUntil: input.until, waivedReason: input.reason, updatedAt: at })
      .where(eq(qualificationItems.id, id))
      .returning();
    await this.audit.write(principal, {
      action: 'item_waived',
      entity: {
        type: item.scope as ComplianceOwnerType,
        id: item.entityId,
        label: item.entityLabel,
      },
      subject: item.requirementCode,
      before,
      after: `Waived until ${input.until}`,
      reason: input.reason,
      at,
    });
    return this.toItem(updated as QualificationItemRow);
  }

  private async document(principal: Principal, id: string): Promise<ComplianceDocument> {
    const [row] = await this.db
      .select()
      .from(complianceDocuments)
      .where(
        and(eq(complianceDocuments.companyId, principal.companyId), eq(complianceDocuments.id, id)),
      )
      .limit(1);
    if (!row) {
      throw new AppError({ status: 404, title: 'Not Found', detail: `No document ${id}` });
    }
    return this.toDocument(row);
  }

  /** The bytes of a stored document. 404 when only the record exists, which the row says up front. */
  async file(
    principal: Principal,
    id: string,
  ): Promise<{ bytes: Buffer; contentType: string; fileName: string }> {
    const [row] = await this.db
      .select()
      .from(complianceDocuments)
      .where(
        and(eq(complianceDocuments.companyId, principal.companyId), eq(complianceDocuments.id, id)),
      )
      .limit(1);
    if (!row) {
      throw new AppError({ status: 404, title: 'Not Found', detail: `No document ${id}` });
    }
    if (!row.storageKey) {
      throw new AppError({
        status: 404,
        title: 'Not Found',
        detail: `${row.title} is recorded but its file is not held by this system`,
      });
    }
    return {
      bytes: await this.storage.get(row.storageKey),
      contentType: row.contentType,
      fileName: row.fileName,
    };
  }
}

function extensionFor(contentType: string): string {
  switch (contentType) {
    case 'application/pdf':
      return '.pdf';
    case 'image/jpeg':
      return '.jpg';
    case 'image/png':
      return '.png';
    default:
      return '';
  }
}
