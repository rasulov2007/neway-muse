import { Body, Controller, Get, HttpCode, Param, Patch, Post, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  CandidateCostSchema,
  ConsentEmailSchema,
  ConsentMarkSentSchema,
  CostAgreementSchema,
  CostApprovalSchema,
  CostPaymentSchema,
  CostRefundSchema,
  FullQueryStatusSchema,
  HireCandidateSchema,
  HoldCandidateSchema,
  OnboardingTaskAddSchema,
  OnboardingTaskUpdateSchema,
  SafetyReportReviewSchema,
  SafetyReportUploadSchema,
  SafetyStatusChangeSchema,
  SafetyCheckPendingSchema,
  SafetyCheckRequestSchema,
  SendConsentToSafetySchema,
  SendLinkSchema,
  SmsConsentSchema,
  TravelCancelSchema,
  TravelItemSchema,
  TravelUpdateSchema,
  WithdrawCandidateSchema,
  type CandidateCostRequest,
  type HireCandidateRequest,
  type OnboardingTaskUpdateRequest,
  type SafetyReportUploadRequest,
  type SafetyCheckRequest,
  type SafetyStatusChangeRequest,
  type SendLinkRequest,
  type TravelItemRequest,
} from '@neway/shared';
import { z } from 'zod';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequireAnyPermission, RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { CandidateJourneyService } from './candidate-journey.service';
import { PERSONNEL_DOCUMENT_PERMISSIONS, SignedDownload } from '../../common/auth/signed-download';
import { RedactPersonnelFiles } from '../../common/auth/personnel-redaction.interceptor';

const v = <T extends z.ZodTypeAny>(schema: T) => new ZodValidationPipe(schema);
const revoke = z.object({ reason: z.string().trim().max(300).nullish().transform((x) => x || null) });
const costCreate = CandidateCostSchema.extend({ clientKey: z.string().regex(/^[A-Za-z0-9_-]{8,80}$/).nullish().transform((x) => x ?? null) });

async function sendFile(reply: FastifyReply, file: { fileName: string; contentType: string; bytes: Buffer | Uint8Array }, download = false): Promise<void> {
  const name = file.fileName.replace(/[^\w.-]+/g, '_');
  await reply
    .header('content-type', file.contentType)
    .header('content-disposition', `${download ? 'attachment' : 'inline'}; filename="${name}"`)
    .header('cache-control', 'private, no-store')
    .header('x-content-type-options', 'nosniff')
    .send(file.bytes);
}

/**
 * The candidate journey (owner brief, 2026-10-11): consent, Safety, application review,
 * onboarding, travel, costs and hire, under the candidate key the candidate page already uses.
 * Reads need `recruiting.view`; each write is checked again by its service (recruiting manage,
 * the Safety permission, Accounting's own).
 */
@Controller('hiring/recruiting/candidates/:key/journey')
@UseGuards(CompanyScopeGuard, PermissionGuard)
@RequirePermission('recruiting.view')
export class CandidateJourneyController {
  constructor(private readonly journey: CandidateJourneyService) {}

  @RedactPersonnelFiles()
  @Get()
  read(@CurrentPrincipal() p: Principal, @Param('key') key: string) {
    return this.journey.journey(p, key);
  }

  // ----------------------------------------------------------------------------- consent
  @Post('consent/link')
  consentLink(@CurrentPrincipal() p: Principal, @Param('key') key: string) {
    return this.journey.consentIssue(p, key);
  }
  @Post('consent/copied')
  @HttpCode(200)
  consentCopied(@CurrentPrincipal() p: Principal, @Param('key') key: string) {
    return this.journey.consentCopied(p, key);
  }
  @Post('consent/mark-sent')
  @HttpCode(200)
  consentMarkSent(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body(v(ConsentMarkSentSchema)) body: { channel: string | null }) {
    return this.journey.consentMarkSent(p, key, body.channel);
  }
  @Post('consent/email')
  @HttpCode(200)
  consentEmail(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body(v(ConsentEmailSchema)) body: { to: string | null }) {
    return this.journey.consentEmail(p, key, body.to);
  }
  @Post('consent/revoke')
  @HttpCode(200)
  consentRevoke(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body(v(revoke)) body: { reason: string | null }) {
    return this.journey.consentRevoke(p, key, body.reason);
  }
  @SignedDownload()
  @RequireAnyPermission(...PERSONNEL_DOCUMENT_PERMISSIONS)
  @Get('consent/files/:fileId')
  async consentFile(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Param('fileId') fileId: string, @Res() reply: FastifyReply) {
    await sendFile(reply, await this.journey.consentFile(p, key, fileId));
  }
  @SignedDownload()
  @RequireAnyPermission(...PERSONNEL_DOCUMENT_PERMISSIONS)
  @Get('consent/signature')
  async consentSignature(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Res() reply: FastifyReply) {
    await sendFile(reply, await this.journey.consentSignature(p, key));
  }
  @SignedDownload()
  @RequireAnyPermission(...PERSONNEL_DOCUMENT_PERMISSIONS)
  @Get('consent/documents/:documentId/pdf')
  async consentPdf(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Param('documentId') documentId: string, @Res() reply: FastifyReply) {
    await sendFile(reply, await this.journey.consentDocumentPdf(p, key, documentId));
  }

  // ------------------------------------------------------------- sending links (SMS / email)
  /** Send consent / Send application by SMS or email from the TMS: a new link, recorded either way. */
  @Post('deliveries')
  @HttpCode(200)
  sendLink(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body(v(SendLinkSchema)) body: SendLinkRequest) {
    return this.journey.sendLink(p, key, body);
  }
  @Post('sms-consent')
  @HttpCode(200)
  smsConsent(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body(v(SmsConsentSchema)) body: { action: 'opt_in' | 'opt_out'; source: 'applied_online' | 'verbal' | 'texted_first' | 'written' | null; note: string | null }) {
    return this.journey.smsConsent(p, key, body);
  }
  @Post('deliveries/:id/resend')
  @HttpCode(200)
  resendLink(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Param('id') id: string) {
    return this.journey.resendLink(p, key, id);
  }
  @Post('deliveries/:id/refresh')
  @HttpCode(200)
  refreshLink(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Param('id') id: string) {
    return this.journey.refreshLink(p, key, id);
  }

  // ------------------------------------------------------------------------------ safety
  @Post('safety')
  @HttpCode(200)
  sendToSafety(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body(v(SendConsentToSafetySchema)) body: { note: string | null }) {
    return this.journey.sendToSafety(p, key, body.note);
  }
  @Post('safety/decision')
  @HttpCode(200)
  safetyDecision(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body(v(SafetyStatusChangeSchema)) body: SafetyStatusChangeRequest) {
    return this.journey.safetyDecide(p, key, body);
  }
  @Post('safety/reports')
  safetyUpload(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body(v(SafetyReportUploadSchema)) body: SafetyReportUploadRequest) {
    return this.journey.safetyUpload(p, key, body);
  }
  @Patch('safety/reports/:reportId')
  safetyReview(
    @CurrentPrincipal() p: Principal,
    @Param('key') key: string,
    @Param('reportId') reportId: string,
    @Body(v(SafetyReportReviewSchema)) body: { result: 'pending' | 'clear' | 'findings' | 'prohibited'; note: string | null; version: number },
  ) {
    return this.journey.safetyReviewReport(p, key, reportId, body);
  }
  @Post('safety/full-query')
  @HttpCode(200)
  safetyFullQuery(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body(v(FullQueryStatusSchema)) body: { status: 'not_requested' | 'requested' | 'received' | 'declined'; version: number }) {
    return this.journey.safetyFullQuery(p, key, body.status, body.version);
  }
  /** A check ordered: MVR, PSP or a Clearinghouse query — where, and its order reference. */
  @Post('safety/checks')
  @HttpCode(200)
  safetyCheckRequest(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body(v(SafetyCheckRequestSchema)) body: SafetyCheckRequest) {
    return this.journey.safetyCheckRequest(p, key, body);
  }
  /** The provider has it and the result is outstanding. */
  @Post('safety/checks/:kind/pending')
  @HttpCode(200)
  safetyCheckPending(
    @CurrentPrincipal() p: Principal,
    @Param('key') key: string,
    @Param('kind') kind: string,
    @Body(v(SafetyCheckPendingSchema)) body: { orderRef: string | null; note: string | null; version: number },
  ) {
    return this.journey.safetyCheckPending(p, key, kind, body);
  }
  @SignedDownload()
  @RequireAnyPermission(...PERSONNEL_DOCUMENT_PERMISSIONS)
  @Get('safety/reports/:reportId/file')
  async safetyReportFile(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Param('reportId') reportId: string, @Res() reply: FastifyReply) {
    await sendFile(reply, await this.journey.safetyReportFile(p, key, reportId));
  }

  // ------------------------------------------------------------------------- application
  @Post('application/reviewed')
  @HttpCode(200)
  applicationReviewed(@CurrentPrincipal() p: Principal, @Param('key') key: string) {
    return this.journey.markApplicationReviewed(p, key);
  }

  // -------------------------------------------------------------------------- onboarding
  @Post('onboarding/start')
  @HttpCode(200)
  startOnboarding(@CurrentPrincipal() p: Principal, @Param('key') key: string) {
    return this.journey.startOnboarding(p, key);
  }
  @Post('onboarding/tasks')
  addTask(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body(v(OnboardingTaskAddSchema)) body: { label: string; required: boolean; dueOn: string | null }) {
    return this.journey.addTask(p, key, body);
  }
  @Patch('onboarding/tasks/:taskId')
  updateTask(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Param('taskId') taskId: string, @Body(v(OnboardingTaskUpdateSchema)) body: OnboardingTaskUpdateRequest) {
    return this.journey.updateTask(p, key, taskId, body);
  }

  // ------------------------------------------------------------------------------ travel
  @Post('travel')
  addTravel(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body(v(TravelItemSchema)) body: TravelItemRequest) {
    return this.journey.addTravel(p, key, body);
  }
  @Patch('travel/:id')
  updateTravel(
    @CurrentPrincipal() p: Principal,
    @Param('key') key: string,
    @Param('id') id: string,
    @Body(v(TravelUpdateSchema)) body: Omit<TravelItemRequest, 'kind'> & { status: 'booked' | 'rescheduled'; version: number },
  ) {
    return this.journey.updateTravel(p, key, id, body);
  }
  @Post('travel/:id/cancel')
  @HttpCode(200)
  cancelTravel(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Param('id') id: string, @Body(v(TravelCancelSchema)) body: { reason: string; version: number }) {
    return this.journey.cancelTravel(p, key, id, body.reason, body.version);
  }

  // ------------------------------------------------------------------------------- costs
  @Post('costs')
  addCost(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body(v(costCreate)) body: CandidateCostRequest & { clientKey: string | null }) {
    return this.journey.addCost(p, key, body);
  }
  @Post('costs/:id/decision')
  @HttpCode(200)
  decideCost(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Param('id') id: string, @Body(v(CostApprovalSchema)) body: { decision: 'approved' | 'rejected'; note: string | null; version: number }) {
    return this.journey.decideCost(p, key, id, body);
  }
  @Post('costs/:id/agreement')
  @HttpCode(200)
  costAgreement(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Param('id') id: string, @Body(v(CostAgreementSchema)) body: { note: string; version: number }) {
    return this.journey.costAgreement(p, key, id, body.note, body.version);
  }
  @Post('costs/:id/payment')
  @HttpCode(200)
  costPayment(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Param('id') id: string, @Body(v(CostPaymentSchema)) body: { paidOn: string; note: string | null; version: number }) {
    return this.journey.costPayment(p, key, id, body.paidOn, body.note, body.version);
  }
  @Post('costs/:id/refund')
  @HttpCode(200)
  costRefund(
    @CurrentPrincipal() p: Principal,
    @Param('key') key: string,
    @Param('id') id: string,
    @Body(v(CostRefundSchema)) body: { refundAmount: number; nonrefundableFee: number | null; note: string | null; version: number },
  ) {
    return this.journey.costRefund(p, key, id, body);
  }

  // -------------------------------------------------------------------------------- hire
  @Post('hold')
  @HttpCode(200)
  hold(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body(v(HoldCandidateSchema)) body: { hold: boolean; reason: string | null }) {
    return this.journey.hold(p, key, body.hold, body.reason);
  }
  @Post('withdraw')
  @HttpCode(200)
  withdraw(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body(v(WithdrawCandidateSchema)) body: { reason: string }) {
    return this.journey.withdraw(p, key, body.reason);
  }
  @Post('hire')
  @HttpCode(200)
  hire(@CurrentPrincipal() p: Principal, @Param('key') key: string, @Body(v(HireCandidateSchema)) body: HireCandidateRequest) {
    return this.journey.hireDriver(p, key, body);
  }
}
