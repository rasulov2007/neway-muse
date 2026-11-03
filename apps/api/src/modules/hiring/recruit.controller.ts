import { Body, Controller, Get, HttpCode, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  RecruitBoardQuerySchema,
  type RecruitBoardQuery,
  MarkApplicationSentSchema,
  ReassignCandidateSchema,
  RecruitAddLeadSchema,
  RecruitAnalyticsQuerySchema,
  RecruitCalendarQuerySchema,
  RecruitListQuerySchema,
  RecruitMetricsQuerySchema,
  RecruitDashboardQuerySchema,
  type RecruitDashboardQuery,
  RecruitNoteSchema,
  RenameCandidateSchema,
  RotationExcludeSchema,
  RotationOrderSchema,
  SendToSafetySchema,
  type ReassignCandidateRequest,
  type RecruitAddLeadRequest,
  type RecruitCalendarQuery,
  type RecruitListQuery,
  type RecruitNoteRequest,
  type RenameCandidateRequest,
  type RotationExcludeRequest,
  type RotationOrderRequest,
  type SendToSafetyRequest,
} from '@neway/shared';
import { z } from 'zod';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequireAnyPermission, RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { LeadRotationService } from './lead-rotation.service';
import { RecruitService } from './recruit.service';
import { PERSONNEL_DOCUMENT_PERMISSIONS, SignedDownload } from '../../common/auth/signed-download';
import { RedactPersonnelFiles } from '../../common/auth/personnel-redaction.interceptor';

const pipe = {
  list: new ZodValidationPipe(RecruitListQuerySchema),
  board: new ZodValidationPipe(RecruitBoardQuerySchema),
  dashboard: new ZodValidationPipe(RecruitDashboardQuerySchema),
  metrics: new ZodValidationPipe(RecruitMetricsQuerySchema.extend({ scope: z.enum(['mine', 'all']).default('mine') })),
  note: new ZodValidationPipe(RecruitNoteSchema),
  rename: new ZodValidationPipe(RenameCandidateSchema),
  safety: new ZodValidationPipe(SendToSafetySchema),
  reopen: new ZodValidationPipe(z.object({ note: z.string().trim().min(3, 'Write a short note saying why').max(1000) })),
  addLead: new ZodValidationPipe(RecruitAddLeadSchema),
  reassign: new ZodValidationPipe(ReassignCandidateSchema),
  calendar: new ZodValidationPipe(RecruitCalendarQuerySchema),
  analytics: new ZodValidationPipe(RecruitAnalyticsQuerySchema),
  order: new ZodValidationPipe(RotationOrderSchema),
  exclude: new ZodValidationPipe(RotationExcludeSchema),
  markSent: new ZodValidationPipe(z.object({ channel: z.string().trim().max(40).nullish().transform((v) => v || null) })),
  applicationSent: new ZodValidationPipe(MarkApplicationSentSchema),
} as const;

/** A private file to an authorized reader: never cached, never sniffed. */
async function sendFile(reply: FastifyReply, file: { fileName: string; contentType: string; bytes: Buffer }): Promise<void> {
  const name = file.fileName.replace(/[^\w.-]+/g, '_');
  await reply
    .header('content-type', file.contentType)
    .header('content-disposition', `inline; filename="${name}"`)
    .header('cache-control', 'private, no-store')
    .header('x-content-type-options', 'nosniff')
    .send(file.bytes);
}

/**
 * Recruiting home, candidate page and HR rotation (owner's redesign, 2026-10-08). Every route is
 * company-scoped by the principal; the service applies the scope rule (My leads for everyone, All
 * leads with recruiting.manage) and the per-candidate access rule.
 */
@Controller('hiring/recruiting')
@UseGuards(CompanyScopeGuard, PermissionGuard)
export class RecruitController {
  constructor(
    private readonly recruit: RecruitService,
    private readonly rotation: LeadRotationService,
  ) {}

  @Get('candidates')
  @RequirePermission('recruiting.view')
  list(@CurrentPrincipal() principal: Principal, @Query(pipe.list) query: RecruitListQuery) {
    return this.recruit.list(principal, query);
  }

  /** The candidate pipeline board: every active candidate in scope, once, by column. */
  @Get('board')
  @RequirePermission('recruiting.view')
  board(@CurrentPrincipal() principal: Principal, @Query(pipe.board) query: RecruitBoardQuery) {
    return this.recruit.board(principal, query);
  }

  /** The Recruiting dashboard: one cohort (leads received in the period), counted every way. */
  @Get('dashboard')
  @RequirePermission('recruiting.view')
  dashboard(@CurrentPrincipal() principal: Principal, @Query(pipe.dashboard) query: RecruitDashboardQuery) {
    return this.recruit.dashboard(principal, query);
  }

  /** The candidate a hired driver came from (null when none), for the driver profile. */
  @Get('drivers/:driverId/candidate')
  @RequirePermission('recruiting.view')
  driverCandidate(@CurrentPrincipal() principal: Principal, @Param('driverId') driverId: string) {
    return this.recruit.candidateKeyForDriver(principal, driverId);
  }

  @Get('metrics')
  @RequirePermission('recruiting.view')
  metrics(@CurrentPrincipal() principal: Principal, @Query(pipe.metrics) query: { scope: 'mine' | 'all'; recruiter?: string }) {
    return this.recruit.metrics(principal, query);
  }

  @Get('recruiters')
  @RequirePermission('recruiting.view')
  recruiters(@CurrentPrincipal() principal: Principal) {
    return this.recruit.recruiterOptions(principal);
  }

  @Get('calendar')
  @RequirePermission('recruiting.view')
  calendar(@CurrentPrincipal() principal: Principal, @Query(pipe.calendar) query: RecruitCalendarQuery) {
    return this.recruit.calendar(principal, query);
  }

  @Get('analytics')
  @RequirePermission('recruiting.view')
  analytics(@CurrentPrincipal() principal: Principal, @Query(pipe.analytics) query: { from: string; to: string }) {
    return this.recruit.analytics(principal, query);
  }

  @Post('leads')
  @RequirePermission('recruiting.manage')
  addLead(@CurrentPrincipal() principal: Principal, @Body(pipe.addLead) body: RecruitAddLeadRequest) {
    return this.recruit.addLead(principal, body);
  }

  @Get('candidates/:key')
  @RequirePermission('recruiting.view')
  candidate(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.recruit.candidate(principal, key);
  }

  @Get('candidates/:key/notes')
  @RequirePermission('recruiting.view')
  notes(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.recruit.notes(principal, key);
  }

  @Post('candidates/:key/notes')
  @RequirePermission('recruiting.manage')
  addNote(@CurrentPrincipal() principal: Principal, @Param('key') key: string, @Body(pipe.note) body: RecruitNoteRequest) {
    return this.recruit.addNote(principal, key, body);
  }

  @Post('candidates/:key/follow-up/done')
  @RequirePermission('recruiting.manage')
  async followUpDone(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    await this.recruit.completeFollowUp(principal, key);
    return { ok: true };
  }

  @Post('candidates/:key/application-link')
  @RequirePermission('recruiting.manage')
  applicationLink(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.recruit.applicationLink(principal, key);
  }

  @Post('candidates/:key/application-link/mark-sent')
  @RequirePermission('recruiting.manage')
  markSent(@CurrentPrincipal() principal: Principal, @Param('key') key: string, @Body(pipe.markSent) body: { channel: string | null }) {
    return this.recruit.markLinkSent(principal, key, body.channel);
  }

  // ---------------------------------------------------------- personal driver application

  @RedactPersonnelFiles()
  @Get('candidates/:key/driver-application')
  @RequirePermission('recruiting.view')
  driverApplication(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.recruit.driverApplication(principal, key);
  }

  /** Send application: a new personal link, shown once (a live unused one is turned off). */
  @Post('candidates/:key/driver-application/session')
  @RequirePermission('recruiting.manage')
  issueDriverApplication(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.recruit.issueDriverApplication(principal, key);
  }

  @Post('candidates/:key/driver-application/session/copied')
  @HttpCode(200)
  @RequirePermission('recruiting.manage')
  driverApplicationCopied(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.recruit.driverApplicationCopied(principal, key);
  }

  @Post('candidates/:key/driver-application/session/mark-sent')
  @HttpCode(200)
  @RequirePermission('recruiting.manage')
  driverApplicationSent(
    @CurrentPrincipal() principal: Principal,
    @Param('key') key: string,
    @Body(pipe.applicationSent) body: { channel: string | null },
  ) {
    return this.recruit.driverApplicationSent(principal, key, body.channel);
  }

  @Post('candidates/:key/driver-application/session/revoke')
  @HttpCode(200)
  @RequirePermission('recruiting.manage')
  driverApplicationRevoke(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.recruit.driverApplicationRevoke(principal, key);
  }

  @SignedDownload()
  @RequireAnyPermission(...PERSONNEL_DOCUMENT_PERMISSIONS)
  @Get('candidates/:key/driver-application/files/:fileId')
  @RequirePermission('recruiting.view')
  async driverApplicationFile(
    @CurrentPrincipal() principal: Principal,
    @Param('key') key: string,
    @Param('fileId') fileId: string,
    @Res() reply: FastifyReply,
  ) {
    await sendFile(reply, await this.recruit.driverApplicationFile(principal, key, fileId));
  }

  @SignedDownload()
  @RequireAnyPermission(...PERSONNEL_DOCUMENT_PERMISSIONS)
  @Get('candidates/:key/driver-application/authorizations/:authId/signature')
  @RequirePermission('recruiting.view')
  async driverApplicationSignature(
    @CurrentPrincipal() principal: Principal,
    @Param('key') key: string,
    @Param('authId') authId: string,
    @Res() reply: FastifyReply,
  ) {
    await sendFile(reply, await this.recruit.driverApplicationSignature(principal, key, authId));
  }

  @SignedDownload()
  @RequireAnyPermission(...PERSONNEL_DOCUMENT_PERMISSIONS)
  @Get('candidates/:key/driver-application/authorizations/:authId/pdf')
  @RequirePermission('recruiting.view')
  async driverApplicationAuthorizationPdf(
    @CurrentPrincipal() principal: Principal,
    @Param('key') key: string,
    @Param('authId') authId: string,
    @Res() reply: FastifyReply,
  ) {
    await sendFile(reply, await this.recruit.driverApplicationAuthorizationPdf(principal, key, authId));
  }

  /** The full SSN: restricted-records permission (checked in the service), audited every time. */
  /** The received application as a PDF (SSN masked). */
  @SignedDownload()
  @RequireAnyPermission(...PERSONNEL_DOCUMENT_PERMISSIONS)
  @Get('candidates/:key/driver-application/pdf')
  @RequirePermission('recruiting.view')
  async driverApplicationPdf(@CurrentPrincipal() principal: Principal, @Param('key') key: string, @Res() reply: FastifyReply) {
    await sendFile(reply, await this.recruit.driverApplicationPdf(principal, key));
  }

  @Post('candidates/:key/driver-application/ssn')
  @HttpCode(200)
  @RequirePermission('recruiting.view')
  driverApplicationSsn(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.recruit.driverApplicationSsn(principal, key);
  }

  /** Brings a disqualified candidate back to the step before, with a note (owner, 2026-10-16). */
  @Post('candidates/:key/reopen')
  @RequirePermission('recruiting.manage')
  reopen(@CurrentPrincipal() principal: Principal, @Param('key') key: string, @Body(pipe.reopen) body: { note: string }) {
    return this.recruit.reopen(principal, key, body.note);
  }

  @Post('candidates/:key/send-to-safety')
  @RequirePermission('recruiting.manage')
  sendToSafety(@CurrentPrincipal() principal: Principal, @Param('key') key: string, @Body(pipe.safety) body: SendToSafetyRequest) {
    return this.recruit.sendToSafety(principal, key, body);
  }

  /** Renames the candidate everywhere Recruiting keeps the name (owner, 2026-10-21). */
  @Patch('candidates/:key/name')
  @RequirePermission('recruiting.manage')
  rename(@CurrentPrincipal() principal: Principal, @Param('key') key: string, @Body(pipe.rename) body: RenameCandidateRequest) {
    return this.recruit.rename(principal, key, body);
  }

  @Post('candidates/:key/recruiter')
  @RequirePermission('recruiting.manage')
  reassign(@CurrentPrincipal() principal: Principal, @Param('key') key: string, @Body(pipe.reassign) body: ReassignCandidateRequest) {
    return this.recruit.reassign(principal, key, body.employeeId);
  }

  // ------------------------------------------------------------------------------ HR rotation

  @Get('rotation')
  @RequirePermission('recruiting.view')
  rotationSettings(@CurrentPrincipal() principal: Principal) {
    return this.rotation.settings(principal);
  }

  @Get('rotation/next')
  @RequirePermission('recruiting.view')
  rotationNext(@CurrentPrincipal() principal: Principal) {
    return this.rotation.preview(principal);
  }

  /** Administrators only (checked in the service): the new order, every member once. */
  @Put('rotation/order')
  @RequirePermission('recruiting.view')
  reorder(@CurrentPrincipal() principal: Principal, @Body(pipe.order) body: RotationOrderRequest) {
    return this.rotation.reorder(principal, body.userIds);
  }

  @Post('rotation/members/:userId/excluded')
  @RequirePermission('recruiting.view')
  exclude(
    @CurrentPrincipal() principal: Principal,
    @Param('userId') userId: string,
    @Body(pipe.exclude) body: RotationExcludeRequest,
  ) {
    return this.rotation.setExcluded(principal, userId, body);
  }
}
