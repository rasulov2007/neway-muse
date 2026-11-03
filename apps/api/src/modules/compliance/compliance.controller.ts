import { Body, Controller, Delete, Get, Param, Post, Query, Res, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import type { FastifyReply } from 'fastify';
import {
  ComplianceAuditQuerySchema,
  MAX_DOCUMENT_BYTES,
  ComplianceDocumentQuerySchema,
  ConsentQuerySchema,
  ConsentResponseSchema,
  CreateConsentRequestSchema,
  QualificationItemQuerySchema,
  RecordVerificationDecisionSchema,
  RejectComplianceDocumentSchema,
  UploadComplianceDocumentSchema,
  VerificationQuerySchema,
  WaiveQualificationItemSchema,
  type ComplianceDocumentStatus,
  type ComplianceOwnerType,
  type ComplianceScope,
  type ConsentPurpose,
  type ConsentStatus,
  type DocumentSource,
  type VerificationDecision,
  type VerificationStage,
  DISPATCH_DRIVER_DOCUMENT_CODES,
  readsDriverCdlDocuments,
} from '@neway/shared';
import { AppError } from '../../common/errors/app-error';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { RequireAnyPermission, RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ComplianceAuditService } from './compliance-audit.service';
import { ComplianceService } from './compliance.service';
import { ConsentsService } from './consents.service';
import { W9_PERMISSION, redactDocuments, redactItems, seesRecord } from './sensitive';
import { VerificationService } from './verification.service';
import { StolenUnitsService } from '../state/stolen-units.service';
import { SignedDownload } from '../../common/auth/signed-download';

/** One pipe per request shape, built once at module load. */
const pipe = {
  items: new ZodValidationPipe(QualificationItemQuerySchema),
  documents: new ZodValidationPipe(ComplianceDocumentQuerySchema),
  upload: new ZodValidationPipe(UploadComplianceDocumentSchema),
  reject: new ZodValidationPipe(RejectComplianceDocumentSchema),
  waive: new ZodValidationPipe(WaiveQualificationItemSchema),
  consents: new ZodValidationPipe(ConsentQuerySchema),
  createConsent: new ZodValidationPipe(CreateConsentRequestSchema),
  respond: new ZodValidationPipe(ConsentResponseSchema),
  verification: new ZodValidationPipe(VerificationQuerySchema),
  decision: new ZodValidationPipe(RecordVerificationDecisionSchema),
  audit: new ZodValidationPipe(ComplianceAuditQuerySchema),
  notApplicable: new ZodValidationPipe(
    z.object({
      driverId: z.string().min(1),
      requirementCode: z.string().min(1),
      reason: z.string().trim().min(5, 'Say why it does not apply (at least 5 characters)').max(1000),
    }),
  ),
} as const;

/** Anybody who may open a driver reads its CDL, front and back, on the profile (owner, 2026-10-26). */
function cdlDocumentReader(principal: Principal): boolean {
  return readsDriverCdlDocuments([...principal.permissions]);
}

/**
 * The qualification file over HTTP.
 *
 * Route for route, this is the surface the browser demo layer used to provide in memory. The
 * Safety screens call the same function names against it; what changed is that a decision
 * recorded on Tuesday is still there on Wednesday.
 */
@Controller('compliance')
@UseGuards(CompanyScopeGuard, PermissionGuard)
export class ComplianceController {
  constructor(
    private readonly compliance: ComplianceService,
    private readonly consents: ConsentsService,
    private readonly verification: VerificationService,
    private readonly audit: ComplianceAuditService,
    private readonly stolen: StolenUnitsService,
  ) {}

  @Get('requirements')
  @RequirePermission('compliance.view')
  requirements() {
    return this.compliance.requirements();
  }

  @Get('items')
  @RequirePermission('compliance.view')
  items(
    @CurrentPrincipal() principal: Principal,
    @Query(pipe.items) query: { scope?: ComplianceScope; entityId?: string },
  ) {
    return this.compliance.listItems(principal, query).then((items) => redactItems(principal, items));
  }

  /** Marks a requirement not applicable to a driver, with a reason; only the codes the catalog allows. */
  @Post('items/not-applicable')
  @RequirePermission('compliance.manage')
  async notApplicable(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.notApplicable) body: { driverId: string; requirementCode: string; reason: string },
  ) {
    const name = await this.verification.driverLabel(principal.companyId, body.driverId);
    return this.compliance.markNotApplicable(principal, { ...body, driverName: name });
  }

  @Post('items/:id/waive')
  @RequirePermission('compliance.manage')
  waive(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.waive) body: { until: string; reason: string },
  ) {
    return this.compliance.waiveItem(principal, id, body);
  }

  /**
   * Safety reads every document; the fleet reads a unit's own. A maintenance account could
   * upload a truck's registration (documents.create) and then not see it on the truck's
   * Documents tab (compliance.view) - the card kept saying "Not uploaded" (2026-09-22).
   */
  @RequireAnyPermission('compliance.view', 'trucks.view', 'trailers.view', 'recruiting.manage', W9_PERMISSION, 'drivers.view')
  @Get('documents')
  async documents(
    @CurrentPrincipal() principal: Principal,
    @Query(pipe.documents)
    query: {
      ownerType?: ComplianceOwnerType;
      ownerId?: string;
      requirementCode?: string;
      status?: ComplianceDocumentStatus;
    },
  ) {
    const unitRead =
      (query.ownerType === 'truck' && hasPermission(principal, 'trucks.view')) ||
      (query.ownerType === 'trailer' && hasPermission(principal, 'trailers.view'));
    // HR / recruiting reads the driver files; Accounting reads W-9s only (owner, 2026-10-25).
    const driverRead = query.ownerType === 'driver' && hasPermission(principal, 'recruiting.manage');
    const w9Only = !hasPermission(principal, 'compliance.view') && !unitRead && !driverRead && hasPermission(principal, W9_PERMISSION);
    // Whoever may open a driver reads that driver's CDL, front and back, and nothing else (owner, 2026-10-26).
    const cdlOnly =
      !hasPermission(principal, 'compliance.view') && !unitRead && !driverRead && !w9Only &&
      query.ownerType === 'driver' && Boolean(query.ownerId) && cdlDocumentReader(principal);
    if (!hasPermission(principal, 'compliance.view') && !unitRead && !driverRead && !w9Only && !cdlOnly) {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: 'Reading documents takes compliance.view, or the unit permission for a unit',
      });
    }
    // A stolen unit's documents reach the administrator role only (owner decision).
    const listed = await this.stolen.visibleDocuments(
      principal,
      await this.compliance.listDocuments(principal, w9Only ? { ...query, requirementCode: 'w9' } : query),
    );
    const documents = w9Only
      ? listed.filter((d) => d.requirementCode === 'w9')
      : cdlOnly
        ? listed.filter((d) => d.ownerType === 'driver' && DISPATCH_DRIVER_DOCUMENT_CODES.has(d.requirementCode))
        : listed;
    // The record says the document exists and whether it was accepted; the file name and what was
    // read off it stay with the people who hold compliance_sensitive.view.
    return redactDocuments(principal, documents);
  }

  @Post('documents')
  @RequirePermission('documents.create')
  upload(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.upload)
    body: {
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
      content?: string;
      extracted?: unknown;
    },
  ) {
    // The bytes arrive base64 on the same JSON body. Decoded here, at the edge, so the service
    // keeps taking bytes and knows nothing about transport.
    const { content, ...document } = body;
    const bytes = content ? Buffer.from(content, 'base64') : undefined;
    if (content && (!bytes || bytes.byteLength === 0)) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'The uploaded file could not be decoded',
      });
    }
    if (bytes && bytes.byteLength > MAX_DOCUMENT_BYTES) {
      throw new AppError({
        status: 413,
        title: 'Payload Too Large',
        detail: `A document may be at most ${Math.round(MAX_DOCUMENT_BYTES / (1024 * 1024))} MB`,
      });
    }
    return this.compliance.upload(principal, { ...document, bytes });
  }

  /** The file itself, for the documents whose bytes the system holds. */
  // A unit's own paperwork opens for anybody who may see the unit (owner, 2026-10-10): the list
  // was already readable on the truck and trailer pages, but the file behind it was Safety-only.
  @RequireAnyPermission('compliance.view', 'trucks.view', 'trailers.view', 'recruiting.manage', W9_PERMISSION, 'drivers.view')
  @SignedDownload()
  @Get('documents/:id/file')
  async file(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Res() reply: FastifyReply,
  ) {
    const [owned] = await this.compliance.listDocumentsById(principal, id);
    const unitRead =
      (owned?.ownerType === 'truck' && hasPermission(principal, 'trucks.view')) ||
      (owned?.ownerType === 'trailer' && hasPermission(principal, 'trailers.view'));
    const driverRead = owned?.ownerType === 'driver' && hasPermission(principal, 'recruiting.manage');
    const w9Read = owned?.requirementCode === 'w9' && hasPermission(principal, W9_PERMISSION);
    const cdlRead =
      owned?.ownerType === 'driver' && DISPATCH_DRIVER_DOCUMENT_CODES.has(owned.requirementCode) && cdlDocumentReader(principal);
    if (!hasPermission(principal, 'compliance.view') && !unitRead && !driverRead && !w9Read && !cdlRead) {
      throw new AppError({
        status: 403,
        title: 'Forbidden',
        detail: 'Opening a document takes compliance.view, or the unit permission for a unit',
      });
    }
    if (owned && (await this.stolen.visibleDocuments(principal, [owned])).length === 0) {
      // As if it did not exist: a stolen unit's documents reach the administrator role only.
      throw new AppError({ status: 404, title: 'Not Found', detail: `No document ${id}` });
    }
    // Personnel records (CDL, medical, testing, background, DOT application, W-9): Safety, the
    // HR / recruiting manager, the administrator; Accounting for the W-9 alone.
    if (owned && !cdlRead && !seesRecord(principal, owned.requirementCode)) {
      throw new AppError({ status: 403, title: 'Forbidden', detail: 'This record is restricted to Safety and HR.' });
    }
    const file = await this.compliance.file(principal, id);
    const name = file.fileName.replace(/[^\w.-]+/g, '_');
    await reply
      .header('content-type', file.contentType)
      .header('content-disposition', `inline; filename="${name}"`)
      .header('cache-control', 'private, no-store')
      .send(file.bytes);
  }

  @Post('documents/:id/verify')
  @RequirePermission('compliance.manage')
  verify(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.compliance.verifyDocument(principal, id);
  }

  @Post('documents/:id/reject')
  @RequirePermission('compliance.manage')
  reject(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.reject) body: { reason: string },
  ) {
    return this.compliance.rejectDocument(principal, id, body.reason);
  }

  @Delete('documents/:id')
  @RequirePermission('compliance.manage')
  remove(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.compliance.deleteDocument(principal, id);
  }

  @Get('consents')
  @RequirePermission('compliance.view')
  consentList(
    @CurrentPrincipal() principal: Principal,
    @Query(pipe.consents)
    query: { driverId?: string; status?: ConsentStatus; purpose?: ConsentPurpose },
  ) {
    return this.consents.list(principal, query);
  }

  @Post('consents')
  @RequirePermission('compliance.manage')
  createConsent(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.createConsent)
    body: { driverId: string; purpose: ConsentPurpose; subject?: string | null },
  ) {
    return this.consents.create(principal, body);
  }

  @Post('consents/:id/send')
  @RequirePermission('compliance.manage')
  sendConsent(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.consents.send(principal, id);
  }

  @Post('consents/:id/cancel')
  @RequirePermission('compliance.manage')
  cancelConsent(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.consents.cancel(principal, id);
  }

  /**
   * The driver's side of a consent, recorded from the desk.
   *
   * There is no driver portal yet. Until there is, this is how a signature, a view or a refusal
   * enters the system; the audit trail records the driver as the actor either way.
   */
  @Post('consents/:id/respond')
  @RequirePermission('compliance.manage')
  respondConsent(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.respond) body: { outcome: 'viewed' | 'signed' | 'declined'; signerName?: string },
  ) {
    return this.consents.respond(principal, id, body);
  }

  @Get('verification')
  @RequirePermission('compliance.view')
  verificationList(
    @CurrentPrincipal() principal: Principal,
    @Query(pipe.verification)
    query: { stage?: VerificationStage; ownerId?: string; driverId?: string },
  ) {
    return this.verification.list(principal, query);
  }

  @Get('verification/:id')
  @RequirePermission('compliance.view')
  verificationCase(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.verification.get(principal, id);
  }

  /** Safety picks the case up: the review is in progress (audited). */
  @Post('verification/:id/start-review')
  @RequirePermission('compliance.manage')
  startReview(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.verification.startReview(principal, id);
  }

  @Post('verification/:id/decision')
  @RequirePermission('compliance.manage')
  decision(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.decision)
    body: { decision: VerificationDecision; conditions: string[]; note: string | null },
  ) {
    return this.verification.recordDecision(principal, id, body);
  }

  @Get('audit')
  @RequirePermission('compliance.view')
  auditList(
    @CurrentPrincipal() principal: Principal,
    @Query(pipe.audit) query: { entityId?: string; limit: number },
  ) {
    return this.audit
      .list(principal, query)
      .then((entries) => this.stolen.redactComplianceEntries(principal, entries));
  }
}
