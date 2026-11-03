import { Body, Controller, Get, HttpCode, Param, Patch, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  FullQueryStatusSchema,
  SafetyCheckPendingSchema,
  SafetyCheckRequestSchema,
  SafetyReportReviewSchema,
  SafetyReportUploadSchema,
  SafetyStatusChangeSchema,
  type SafetyCheckRequest,
  type SafetyDeskDetail,
  type SafetyReportUploadRequest,
  type SafetyStatusChangeRequest,
  SafetyInsuranceRequestSchema,
  SafetyInsuranceResponseSchema,
} from '@neway/shared';
import { z } from 'zod';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CandidateSafetyService, SAFETY_DECIDE_PERMISSION } from './candidate-safety.service';
import { ConsentService } from './consent.service';
import { RecruitService } from './recruit.service';
import { SignedDownload } from '../../common/auth/signed-download';

const v = <T extends z.ZodTypeAny>(schema: T) => new ZodValidationPipe(schema);

async function sendFile(reply: FastifyReply, file: { fileName: string; contentType: string; bytes: Buffer | Uint8Array }): Promise<void> {
  await reply
    .header('content-type', file.contentType)
    .header('content-disposition', `inline; filename="${file.fileName.replace(/[^\w.-]+/g, '_')}"`)
    .header('cache-control', 'private, no-store')
    .header('x-content-type-options', 'nosniff')
    .send(file.bytes);
}

/**
 * Safety › Hiring decisions (owner, 2026-10-11): the candidates Recruiting sent to Safety, the
 * consents they signed, the reports Safety adds, and the one decision — Qualified or Not qualified.
 * Safety's own permission is enough; nobody here needs the recruiting permissions. Keyed by the
 * hiring case.
 */
@Controller('hiring/safety-desk')
@UseGuards(CompanyScopeGuard, PermissionGuard)
@RequirePermission(SAFETY_DECIDE_PERMISSION)
export class SafetyDeskController {
  constructor(
    private readonly safety: CandidateSafetyService,
    private readonly consents: ConsentService,
    private readonly recruit: RecruitService,
  ) {}

  private subject(p: Principal, caseId: string) {
    return this.recruit.subjectFor(p, caseId);
  }

  @Get()
  list(@CurrentPrincipal() p: Principal) {
    return this.safety.desk(p);
  }

  @Get(':caseId')
  async detail(@CurrentPrincipal() p: Principal, @Param('caseId') caseId: string): Promise<SafetyDeskDetail> {
    const row = await this.safety.deskRow(p, caseId);
    const subject = await this.subject(p, caseId);
    const [consent, safety] = await Promise.all([this.consents.view(p, subject), this.safety.view(p, subject)]);
    return { row, consent, safety };
  }

  @SignedDownload()
  @Get(':caseId/consent/documents/:documentId/pdf')
  async consentPdf(@CurrentPrincipal() p: Principal, @Param('caseId') caseId: string, @Param('documentId') documentId: string, @Res() reply: FastifyReply) {
    await sendFile(reply, await this.consents.documentPdf(p, await this.subject(p, caseId), documentId));
  }

  @SignedDownload()
  @Get(':caseId/consent/files/:fileId')
  async consentFile(@CurrentPrincipal() p: Principal, @Param('caseId') caseId: string, @Param('fileId') fileId: string, @Res() reply: FastifyReply) {
    await sendFile(reply, await this.consents.fileBytes(p, await this.subject(p, caseId), fileId));
  }

  @SignedDownload()
  @Get(':caseId/reports/:reportId/file')
  async reportFile(@CurrentPrincipal() p: Principal, @Param('caseId') caseId: string, @Param('reportId') reportId: string, @Res() reply: FastifyReply) {
    await sendFile(reply, await this.safety.reportFile(p, await this.subject(p, caseId), reportId));
  }

  @Post(':caseId/reports')
  async upload(@CurrentPrincipal() p: Principal, @Param('caseId') caseId: string, @Body(v(SafetyReportUploadSchema)) body: SafetyReportUploadRequest) {
    return this.safety.upload(p, await this.subject(p, caseId), body);
  }

  @Patch(':caseId/reports/:reportId')
  async review(@CurrentPrincipal() p: Principal, @Param('caseId') caseId: string, @Param('reportId') reportId: string, @Body(v(SafetyReportReviewSchema)) body: { result: 'pending' | 'clear' | 'findings' | 'prohibited'; note: string | null; version: number }) {
    return this.safety.reviewReport(p, await this.subject(p, caseId), reportId, body);
  }

  @Post(':caseId/checks')
  @HttpCode(200)
  async requestCheck(@CurrentPrincipal() p: Principal, @Param('caseId') caseId: string, @Body(v(SafetyCheckRequestSchema)) body: SafetyCheckRequest) {
    return this.safety.requestCheck(p, await this.subject(p, caseId), body);
  }

  @Post(':caseId/checks/:kind/pending')
  @HttpCode(200)
  async pending(@CurrentPrincipal() p: Principal, @Param('caseId') caseId: string, @Param('kind') kind: string, @Body(v(SafetyCheckPendingSchema)) body: { orderRef: string | null; note: string | null; version: number }) {
    return this.safety.markCheckPending(p, await this.subject(p, caseId), kind, body);
  }

  @Post(':caseId/full-query')
  @HttpCode(200)
  async fullQuery(@CurrentPrincipal() p: Principal, @Param('caseId') caseId: string, @Body(v(FullQueryStatusSchema)) body: { status: 'not_requested' | 'requested' | 'received' | 'declined'; version: number }) {
    await this.safety.setFullQuery(p, await this.subject(p, caseId), body.status, body.version);
    return { ok: true };
  }

  /** Insurance check (owner, 2026-10-12): ask the insurer; Recruiting is told. */
  @Post(':caseId/insurance')
  @HttpCode(200)
  async insurance(@CurrentPrincipal() p: Principal, @Param('caseId') caseId: string, @Body(v(SafetyInsuranceRequestSchema)) body: { note: string | null; version: number }) {
    await this.safety.requestInsurance(p, await this.subject(p, caseId), body);
    return this.safety.deskRow(p, caseId);
  }

  /** The insurer's answer. */
  @Post(':caseId/insurance/response')
  @HttpCode(200)
  async insuranceResponse(@CurrentPrincipal() p: Principal, @Param('caseId') caseId: string, @Body(v(SafetyInsuranceResponseSchema)) body: { result: 'approved' | 'declined'; note: string | null; version: number }) {
    await this.safety.recordInsurance(p, await this.subject(p, caseId), body);
    return this.safety.deskRow(p, caseId);
  }

  /** Qualified (approved) or Not qualified (declined, with the reason). */
  @Post(':caseId/decision')
  @HttpCode(200)
  async decide(@CurrentPrincipal() p: Principal, @Param('caseId') caseId: string, @Body(v(SafetyStatusChangeSchema)) body: SafetyStatusChangeRequest) {
    await this.safety.decide(p, await this.subject(p, caseId), body);
    return this.safety.deskRow(p, caseId);
  }
}
