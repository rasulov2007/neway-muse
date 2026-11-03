import { Injectable, Logger } from '@nestjs/common';
import { and, desc, eq, inArray } from 'drizzle-orm';
import {
  DRIVER_APP_DOCUMENT_CODES,
  DRIVER_APP_DOCUMENT_LABEL,
  DRIVER_DOCUMENT_REMINDER_DAYS,
  DRIVER_QUAL_DOC_STATE_LABEL,
  SYSTEM_REQUIREMENTS,
  type ComplianceDocument,
  type DriverAppDocumentCode,
  type DriverDocumentCreateInput,
  type DriverDocumentList,
  type DriverDocumentReminder,
  type DriverQualDocState,
  type DriverQualificationDocument,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { complianceDocuments } from '../../database/schema/compliance';
import { ComplianceService } from '../compliance/compliance.service';
import { FilesService } from '../files/files.service';
import { companyDay, DriverContextService, type DriverContext } from './driver-context.service';
import { DriverOwnershipService, isImageOrPdf } from './driver-ownership.service';
import { MobileNotificationsService } from './mobile-notifications.service';

const unprocessable = (detail: string) => new AppError({ status: 422, title: 'Unprocessable Entity', detail });

const daysBetween = (from: string, to: string) => Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86_400_000);

/**
 * The driver's own qualification papers (mobile M3, API.md §13): read from `compliance_documents`
 * and filed through `ComplianceService.upload` (pending review, source driver_portal, the previous
 * version kept), so Safety reviews them in the existing qualification-file screens. Reminders are
 * computed from the stored expiry dates on every read; there is no reminder job.
 */
@Injectable()
export class DriverDocumentsService {
  private readonly logger = new Logger(DriverDocumentsService.name);

  constructor(
    private readonly database: DatabaseService,
    private readonly context: DriverContextService,
    private readonly ownership: DriverOwnershipService,
    private readonly compliance: ComplianceService,
    private readonly files: FilesService,
    private readonly notifications: MobileNotificationsService,
  ) {}

  async mine(principal: Principal): Promise<DriverDocumentList> {
    const ctx = await this.context.resolve(principal);
    return this.list(ctx);
  }

  async upload(principal: Principal, input: DriverDocumentCreateInput): Promise<DriverDocumentList> {
    const ctx = await this.context.resolve(principal);
    const own = await this.ownership.ownFiles(principal, [input.fileId], isImageOrPdf);
    const file = own.get(input.fileId)!;
    const requirement = SYSTEM_REQUIREMENTS.find((r) => r.code === input.type);
    if (!requirement) throw unprocessable(`${input.type} is not a document the app takes.`);
    const today = companyDay(ctx.companyTimezone, new Date());
    if (input.expiresOn && input.expiresOn < today) throw unprocessable('That expiry date has already passed. Send the renewed document.');
    if (requirement.hasExpiry && !input.expiresOn && !requirement.validityMonths) throw unprocessable(`${requirement.name} expires: enter the expiry date printed on it.`);
    const { bytes } = await this.files.read(ctx.companyId, file.id);
    const { document } = await this.compliance.upload(principal, {
      ownerType: 'driver',
      ownerId: ctx.driverId,
      ownerLabel: ctx.driverName,
      requirementCode: input.type,
      title: DRIVER_APP_DOCUMENT_LABEL[input.type],
      fileName: file.fileName,
      contentType: file.contentType,
      sizeBytes: file.sizeBytes,
      issuedOn: input.issuedOn ?? null,
      expiresOn: input.expiresOn ?? null,
      source: 'driver_portal',
      notes: input.note?.trim() ? `From the driver app: ${input.note.trim()}` : 'From the driver app',
      bytes,
    });
    const safety = await this.notifications.teamUserIds(ctx.companyId, ['compliance.manage', 'safety.manage']);
    await this.notifications
      .notifyUsers(ctx.companyId, safety, {
        title: `${DRIVER_APP_DOCUMENT_LABEL[input.type]} to review: ${ctx.driverName}`,
        body: `Sent from the driver app${document.version > 1 ? ` (version ${document.version}, replaces the earlier one)` : ''}.`,
        pushTitle: 'Document to review',
        pushBody: 'A driver sent a document from the app.',
        target: { type: 'driver_document', id: document.id },
        dedupeKey: `driver_document:${document.id}`,
      })
      .catch((error: unknown) => this.logger.warn(`Notifying Safety about ${document.id} failed: ${String(error)}`));
    return this.list(ctx);
  }

  private async list(ctx: DriverContext): Promise<DriverDocumentList> {
    const today = companyDay(ctx.companyTimezone, new Date());
    const rows = await this.database.db
      .select()
      .from(complianceDocuments)
      .where(and(eq(complianceDocuments.companyId, ctx.companyId), eq(complianceDocuments.ownerType, 'driver'), eq(complianceDocuments.ownerId, ctx.driverId), inArray(complianceDocuments.requirementCode, [...DRIVER_APP_DOCUMENT_CODES])))
      .orderBy(desc(complianceDocuments.version));
    const fallbackExpiry: Partial<Record<DriverAppDocumentCode, string | null>> = {
      cdl: ctx.driver.cdlExpiresOn ?? null,
      medical_card: ctx.driver.medicalCardExpiresOn ?? null,
    };
    const documents: DriverQualificationDocument[] = DRIVER_APP_DOCUMENT_CODES.map((code) => {
      const versions = rows.filter((r) => r.requirementCode === code);
      const current = versions[0];
      const expiresOn = current?.expiresOn ? String(current.expiresOn) : (fallbackExpiry[code] ?? null);
      let state: DriverQualDocState = current ? (current.status as DriverQualDocState) : 'missing';
      if (current && expiresOn && expiresOn < today && state !== 'rejected') state = 'expired';
      return {
        type: code,
        label: DRIVER_APP_DOCUMENT_LABEL[code],
        state,
        stateLabel: DRIVER_QUAL_DOC_STATE_LABEL[state],
        documentId: current?.id ?? null,
        fileName: current?.fileName ?? null,
        version: current?.version ?? null,
        uploadedAt: current?.uploadedAt.toISOString() ?? null,
        source: current?.source ?? null,
        expiresOn,
        rejectionReason: current?.status === 'rejected' ? current.rejectionReason : null,
        reminder: reminderFor(DRIVER_APP_DOCUMENT_LABEL[code], expiresOn, today),
        previous: versions.slice(1).map((v) => ({ documentId: v.id, version: v.version, status: v.status, uploadedAt: v.uploadedAt.toISOString() })),
      };
    });
    return {
      today,
      documents,
      reminders: documents.filter((d) => d.reminder).map((d) => ({ ...d.reminder!, type: d.type, label: d.label })),
    };
  }

  /** Hook on ComplianceService.afterReview: Safety verified or rejected a paper the driver sent. */
  async onReview(principal: Principal, document: ComplianceDocument): Promise<void> {
    if (document.ownerType !== 'driver' || document.source !== 'driver_portal') return;
    if (!(DRIVER_APP_DOCUMENT_CODES as readonly string[]).includes(document.requirementCode)) return;
    const label = DRIVER_APP_DOCUMENT_LABEL[document.requirementCode as DriverAppDocumentCode];
    const rejected = document.status === 'rejected';
    await this.notifications.notifyDriver(principal.companyId, document.ownerId, {
      title: rejected ? `${label} rejected: ${document.rejectionReason ?? ''}` : `${label} verified`,
      body: rejected ? 'Send a new photo of the document from the app.' : null,
      pushTitle: rejected ? 'Document rejected' : 'Document verified',
      pushBody: rejected ? `Safety asked for a new ${label}.` : `Safety verified your ${label}.`,
      severity: rejected ? 'warning' : 'info',
      target: { type: 'driver_document', id: document.id },
      dedupeKey: `driver_document:${document.id}:${document.status}`,
    });
  }
}

export function reminderFor(label: string, expiresOn: string | null, today: string): DriverDocumentReminder | null {
  if (!expiresOn) return null;
  const daysLeft = daysBetween(today, expiresOn);
  if (daysLeft < 0) return { kind: 'expired', daysLeft, text: `${label} expired on ${expiresOn}. Send the renewed one.` };
  if (daysLeft <= DRIVER_DOCUMENT_REMINDER_DAYS) return { kind: 'expiring', daysLeft, text: `${label} expires on ${expiresOn} (${daysLeft} day${daysLeft === 1 ? '' : 's'} left).` };
  return null;
}
