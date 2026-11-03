import { Body, Controller, Delete, Get, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import {
  BookTicketSchema,
  CostQuerySchema,
  CreateApplyLinkSchema,
  CreateCampaignSchema,
  CreateCampaignSpendSchema,
  UpdateCampaignSpendSchema,
  VoidCampaignSpendSchema,
  type CreateCampaignSpendRequest,
  type UpdateCampaignSpendRequest,
  type VoidCampaignSpendRequest,
  CreateCostEntrySchema,
  CreateDriverOfferSchema,
  CreateLeadSchema,
  HiringAnalyticsQuerySchema,
  DisqualifyLeadSchema,
  ReopenLeadSchema,
  DropHiringCaseSchema,
  AssignRecruiterSchema,
  FollowUpSchema,
  LeadNoteSchema,
  MyLeadsQuerySchema,
  type LeadNoteRequest,
  type MyLeadsQuery,
  HiringDocumentUploadSchema,
  ReadCdlRequestSchema,
  HireDriverSchema,
  HiringStateSchema,
  LeadQuerySchema,
  LeadSummaryQuerySchema,
  OFFER_STATUSES,
  VoidCostEntrySchema,
  type LeadSummaryQuery,
  type VoidCostEntryRequest,
  PrequalificationSchema,
  RecordOrientationSchema,
  SaveDotApplicationDraftSchema,
  ReturnDotApplicationSchema,
  UpdateApplyLinkSchema,
  UpdateCampaignSchema,
  UpdateLeadSchema,
  type BookTicketRequest,
  type CostQuery,
  type CreateCampaignRequest,
  type CreateCostEntryRequest,
  type CreateDriverOfferRequest,
  type DropHiringCaseRequest,
  type AssignRecruiterRequest,
  type FollowUpRequest,
  type HiringDocumentUploadRequest,
  type ReadCdlRequest,
  type CdlReadResult,
  type HireDriverRequest,
  type HiringState,
  type LeadQuery,
  type OfferStatus,
  type Prequalification,
  type RecordOrientationRequest,
  type SaveDotApplicationInput,
  type UpdateCampaignRequest,
} from '@neway/shared';
import { z } from 'zod';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequireAnyPermission, RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ApplyService, type ApplyLinkCreateBody, type ApplyLinkUpdateBody } from './apply.service';
import { CostLedgerService } from './cost-ledger.service';
import { DotApplicationsService } from './dot-applications.service';
import { DotLinksService } from './dot-links.service';
import { HiringAnalyticsService } from './hiring-analytics.service';
import { HiringDocumentsService } from './hiring-documents.service';
import { HiringActivityService } from './hiring-activity.service';
import { HiringPipelineService } from './hiring-pipeline.service';
import { HiringService } from './hiring.service';
import { LeadRotationService } from './lead-rotation.service';
import { LeadsService } from './leads.service';
import { MyLeadsService } from './my-leads.service';
import { PERSONNEL_DOCUMENT_PERMISSIONS, SignedDownload } from '../../common/auth/signed-download';
import { RedactPersonnelFiles } from '../../common/auth/personnel-redaction.interceptor';

const pipe = {
  cases: new ZodValidationPipe(
    z.object({ state: HiringStateSchema.optional(), applicantId: z.string().optional() }),
  ),
  saveApplication: new ZodValidationPipe(SaveDotApplicationDraftSchema),
  returnApplication: new ZodValidationPipe(ReturnDotApplicationSchema),
  offer: new ZodValidationPipe(CreateDriverOfferSchema),
  offerStatus: new ZodValidationPipe(z.object({ status: z.enum(OFFER_STATUSES) })),
  ticket: new ZodValidationPipe(BookTicketSchema),
  orientation: new ZodValidationPipe(RecordOrientationSchema),
  hire: new ZodValidationPipe(HireDriverSchema),
  drop: new ZodValidationPipe(DropHiringCaseSchema),
  recruiter: new ZodValidationPipe(AssignRecruiterSchema),
  followUp: new ZodValidationPipe(FollowUpSchema),
  leadNote: new ZodValidationPipe(LeadNoteSchema),
  myLeads: new ZodValidationPipe(MyLeadsQuerySchema),
  document: new ZodValidationPipe(HiringDocumentUploadSchema),
  readCdl: new ZodValidationPipe(ReadCdlRequestSchema),
  calendar: new ZodValidationPipe(
    z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }),
  ),
  campaign: new ZodValidationPipe(CreateCampaignSchema),
  campaignPatch: new ZodValidationPipe(UpdateCampaignSchema),
  spend: new ZodValidationPipe(CreateCampaignSpendSchema),
  spendPatch: new ZodValidationPipe(UpdateCampaignSpendSchema),
  spendVoid: new ZodValidationPipe(VoidCampaignSpendSchema),
  costs: new ZodValidationPipe(CostQuerySchema),
  cost: new ZodValidationPipe(CreateCostEntrySchema),
  analytics: new ZodValidationPipe(HiringAnalyticsQuerySchema),
  leads: new ZodValidationPipe(LeadQuerySchema),
  leadSummary: new ZodValidationPipe(LeadSummaryQuerySchema),
  voidCost: new ZodValidationPipe(VoidCostEntrySchema),
  createLead: new ZodValidationPipe(CreateLeadSchema),
  updateLead: new ZodValidationPipe(UpdateLeadSchema),
  prequalify: new ZodValidationPipe(PrequalificationSchema),
  disqualify: new ZodValidationPipe(DisqualifyLeadSchema),
  reopen: new ZodValidationPipe(ReopenLeadSchema),
  createLink: new ZodValidationPipe(CreateApplyLinkSchema),
  updateLink: new ZodValidationPipe(UpdateApplyLinkSchema),
} as const;

type LeadBody = Parameters<LeadsService['create']>[1];

/**
 * The hiring funnel.
 *
 * Cases are read-only here: every move the middle of the funnel makes is a verification move,
 * recorded through the compliance routes. Leads are written here — they are the one part of the
 * funnel that exists before any other module has a record of the person.
 */
@Controller('hiring')
@UseGuards(CompanyScopeGuard, PermissionGuard)
export class HiringController {
  constructor(
    private readonly hiring: HiringService,
    private readonly leads: LeadsService,
    private readonly applications: DotApplicationsService,
    private readonly pipeline: HiringPipelineService,
    private readonly ledger: CostLedgerService,
    private readonly analytics: HiringAnalyticsService,
    private readonly documentsService: HiringDocumentsService,
    private readonly activityService: HiringActivityService,
    private readonly applyLinks: ApplyService,
    private readonly dotLinks: DotLinksService,
    private readonly rotation: LeadRotationService,
    private readonly myLeadsService: MyLeadsService,
  ) {}

  /** The funnel, days in stage, cost per hire, retention and days to first load, computed on read. */
  @Get('analytics')
  @RequirePermission('recruiting.view')
  analyticsFor(
    @CurrentPrincipal() principal: Principal,
    @Query(pipe.analytics) query: { from?: string; to?: string },
  ) {
    return this.analytics.compute(principal, query);
  }

  // ================================================================== campaigns · cost ledger

  @Get('campaigns')
  @RequirePermission('recruiting.view')
  listCampaigns(@CurrentPrincipal() principal: Principal) {
    return this.ledger.listCampaigns(principal);
  }

  @Post('campaigns')
  @RequirePermission('recruiting.manage')
  createCampaign(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.campaign) body: CreateCampaignRequest,
  ) {
    return this.ledger.createCampaign(principal, body);
  }

  @Patch('campaigns/:id')
  @RequirePermission('recruiting.manage')
  updateCampaign(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.campaignPatch) body: UpdateCampaignRequest,
  ) {
    return this.ledger.updateCampaign(principal, id, body);
  }

  /** A campaign's dated spend entries, voided ones included (kept, struck through). */
  @Get('campaigns/:id/spend')
  @RequirePermission('recruiting.view')
  listSpend(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.ledger.listSpend(principal, id);
  }

  @Post('campaigns/:id/spend')
  @RequirePermission('recruiting.manage')
  addSpend(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.spend) body: CreateCampaignSpendRequest,
  ) {
    return this.ledger.addSpend(principal, id, body);
  }

  /** Corrects one entry; the body names the version it read, and a stale one is a 409. */
  @Patch('campaign-spend/:id')
  @RequirePermission('recruiting.manage')
  updateSpend(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.spendPatch) body: UpdateCampaignSpendRequest,
  ) {
    return this.ledger.updateSpend(principal, id, body);
  }

  @Post('campaign-spend/:id/void')
  @RequirePermission('recruiting.manage')
  voidSpend(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.spendVoid) body: VoidCampaignSpendRequest,
  ) {
    return this.ledger.voidSpend(principal, id, body);
  }

  @Get('costs')
  @RequirePermission('recruiting.view')
  listCosts(@CurrentPrincipal() principal: Principal, @Query(pipe.costs) query: CostQuery) {
    return this.ledger.list(principal, query);
  }

  @Post('costs')
  @RequirePermission('recruiting.manage')
  createCost(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.cost) body: CreateCostEntryRequest,
  ) {
    return this.ledger.create(principal, body);
  }

  /** A mistaken manual entry is voided — kept, out of every total — never deleted. */
  @Post('costs/:id/void')
  @RequirePermission('recruiting.manage')
  voidCost(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.voidCost) body: VoidCostEntryRequest,
  ) {
    return this.ledger.voidEntry(principal, id, body.reason);
  }

  /**
   * Posts a candidate cost to Accounting as an expense, or puts its expense right (a re-priced
   * cost, a voided one). Accounting's own permission: the recruiter who saved the cost may not
   * hold it, and then someone who does presses this.
   */
  @Post('costs/:id/accounting')
  @RequirePermission('accounting.edit')
  postCostToAccounting(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.ledger.postToAccounting(principal, id);
  }

  @Get('cases/:id/costs')
  @RequirePermission('recruiting.view')
  caseCosts(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.ledger.forCase(principal, id);
  }

  @Get('cases')
  @RequirePermission('recruiting.view')
  list(
    @CurrentPrincipal() principal: Principal,
    @Query(pipe.cases) query: { state?: HiringState; applicantId?: string },
  ) {
    return this.hiring.list(principal, query);
  }

  /** Travel, orientation and hires in a date range: the hiring week view. */
  @Get('calendar')
  @RequirePermission('recruiting.view')
  calendar(@CurrentPrincipal() principal: Principal, @Query(pipe.calendar) query: { from: string; to: string }) {
    return this.pipeline.calendar(principal, query.from, query.to);
  }

  @Get('cases/summary')
  @RequirePermission('recruiting.view')
  summary(@CurrentPrincipal() principal: Principal) {
    return this.hiring.summary(principal);
  }

  @Get('cases/:id')
  @RequirePermission('recruiting.view')
  get(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.hiring.get(principal, id);
  }

  // ========================================================================== DOT application

  /** `{ application: null }` until one is started, so the screen can tell "none" from "gone". */
  @RedactPersonnelFiles()
  @Get('cases/:id/dot-application')
  @RequirePermission('recruiting.view')
  async getApplication(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return { application: await this.applications.get(principal, id) };
  }

  @Put('cases/:id/dot-application')
  @RequirePermission('recruiting.manage')
  saveApplication(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.saveApplication) body: SaveDotApplicationInput,
  ) {
    return this.applications.save(principal, id, body);
  }

  @Post('cases/:id/dot-application/submit')
  @RequirePermission('recruiting.manage')
  submitApplication(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.applications.submit(principal, id);
  }

  /** The latest link sent to the driver, without its token: when it was opened, saved, submitted. */
  @Get('cases/:id/dot-application/link')
  @RequirePermission('recruiting.view')
  dotLink(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.dotLinks.status(principal, id);
  }

  /** Makes a new link for the driver (turning off the live one) and returns its address, once. */
  @Post('cases/:id/dot-application/link')
  @RequirePermission('recruiting.manage')
  createDotLink(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.dotLinks.create(principal, id);
  }

  /** Accepts the driver's certified submission: files it, then files the CDL the driver sent. */
  @Post('cases/:id/dot-application/accept')
  @RequirePermission('recruiting.manage')
  acceptDotApplication(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.dotLinks.accept(principal, id);
  }

  /** Sends the driver's submission back with a note; the driver must certify again. */
  @Post('cases/:id/dot-application/return')
  @RequirePermission('recruiting.manage')
  returnDotApplication(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.returnApplication) body: { note: string },
  ) {
    return this.dotLinks.returnToDriver(principal, id, body.note);
  }

  /** The CDL files the driver sent through the link (filed, or waiting for Accept). */
  @RedactPersonnelFiles()
  @Get('cases/:id/dot-application/link/files')
  @RequirePermission('recruiting.view')
  dotLinkFiles(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.dotLinks.stagedFiles(principal, id);
  }

  @SignedDownload()
  @RequireAnyPermission(...PERSONNEL_DOCUMENT_PERMISSIONS)
  @Get('cases/:id/dot-application/link/files/:fileId')
  @RequirePermission('recruiting.view')
  async dotLinkFile(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('fileId') fileId: string,
    @Res() reply: FastifyReply,
  ) {
    const file = await this.dotLinks.stagedFile(principal, id, fileId);
    const name = file.fileName.replace(/[^\w.-]+/g, '_');
    await reply
      .header('content-type', file.contentType)
      .header('content-disposition', `inline; filename="${name}"`)
      .header('cache-control', 'private, no-store')
      .header('x-content-type-options', 'nosniff')
      .send(file.bytes);
  }

  /** Turns the live link off. Kept and audited, never deleted. */
  @Delete('cases/:id/dot-application/link')
  @RequirePermission('recruiting.manage')
  revokeDotLink(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.dotLinks.revoke(principal, id);
  }

  // ============================================================ offer · ticket · orientation · hire

  /** The back of the funnel for one case, in one read. */
  @Get('cases/:id/pipeline')
  @RequirePermission('recruiting.view')
  async pipelineFor(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    const [offer, ticket, orientation] = await Promise.all([
      this.pipeline.offer(principal, id),
      this.pipeline.ticket(principal, id),
      this.pipeline.orientation(principal, id),
    ]);
    return { offer, ticket, orientation };
  }

  @Post('cases/:id/offer')
  @RequirePermission('recruiting.manage')
  createOffer(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.offer) body: CreateDriverOfferRequest,
  ) {
    return this.pipeline.createOffer(principal, id, body);
  }

  @Post('cases/:id/offer/status')
  @RequirePermission('recruiting.manage')
  setOfferStatus(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.offerStatus) body: { status: OfferStatus },
  ) {
    return this.pipeline.setOfferStatus(principal, id, body.status);
  }

  @Post('cases/:id/ticket')
  @RequirePermission('recruiting.manage')
  bookTicket(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.ticket) body: BookTicketRequest,
  ) {
    return this.pipeline.bookTicket(principal, id, body);
  }

  @Put('cases/:id/orientation')
  @RequirePermission('recruiting.manage')
  recordOrientation(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.orientation) body: RecordOrientationRequest,
  ) {
    return this.pipeline.recordOrientation(principal, id, body);
  }

  /** A recruiter ends a case Safety has not: unresponsive, another job, no-show. */
  @Post('cases/:id/drop')
  @RequirePermission('recruiting.manage')
  async drop(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.drop) body: DropHiringCaseRequest,
  ) {
    await this.pipeline.drop(principal, id, body);
    return this.hiring.get(principal, id);
  }

  // ============================================================== recruiter · follow-ups · activity

  /** One recruiter for the lead, the case and the candidate record. */
  @Post('cases/:id/recruiter')
  @RequirePermission('recruiting.manage')
  async assignRecruiter(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.recruiter) body: AssignRecruiterRequest,
  ) {
    await this.activityService.assignRecruiter(principal, id, body);
    return this.hiring.get(principal, id);
  }

  /** Records a contact attempt that already happened; nothing is sent. */
  @Post('cases/:id/follow-ups')
  @RequirePermission('recruiting.manage')
  caseFollowUp(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.followUp) body: FollowUpRequest,
  ) {
    return this.activityService.recordFollowUp(principal, { kind: 'case', id }, body);
  }

  @Post('leads/:id/follow-ups')
  @RequirePermission('recruiting.manage')
  leadFollowUp(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.followUp) body: FollowUpRequest,
  ) {
    return this.activityService.recordFollowUp(principal, { kind: 'lead', id }, body);
  }

  /** A plain note on a lead: free text, no method or outcome (owner, 2026-10-07). */
  @Post('leads/:id/notes')
  @RequirePermission('recruiting.manage')
  addLeadNote(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.leadNote) body: LeadNoteRequest,
  ) {
    return this.activityService.addLeadNote(principal, id, body);
  }

  /** Notes and follow-ups on one lead, newest first. */
  @Get('leads/:id/notes')
  @RequirePermission('recruiting.view')
  leadNotes(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.activityService.notesForLead(principal, id);
  }

  /** The signed-in recruiter's leads; a manager may name another recruiter. */
  @Get('my-leads')
  @RequirePermission('recruiting.view')
  myLeads(@CurrentPrincipal() principal: Principal, @Query(pipe.myLeads) query: MyLeadsQuery) {
    return this.myLeadsService.list(principal, query);
  }

  /** Who takes the next online application, and the turn order (read-only). */
  @Get('lead-rotation')
  @RequirePermission('recruiting.view')
  leadRotation(@CurrentPrincipal() principal: Principal) {
    return this.rotation.describe(principal);
  }

  @Get('follow-ups/latest')
  @RequirePermission('recruiting.view')
  latestFollowUps(@CurrentPrincipal() principal: Principal) {
    return this.activityService.latestFollowUps(principal);
  }

  @Get('cases/:id/activity')
  @RequirePermission('recruiting.view')
  activity(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.activityService.activity(principal, id);
  }

  // ===================================================================== candidate documents

  /** The candidate's papers in their driver file, with Safety's answer on each. */
  @RedactPersonnelFiles()
  @Get('cases/:id/documents')
  @RequirePermission('recruiting.view')
  documents(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.documentsService.list(principal, id);
  }

  /** HR uploads; the document arrives in Safety's review queue as pending. */
  @Post('cases/:id/documents')
  @RequirePermission('recruiting.manage')
  uploadDocument(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.document) body: HiringDocumentUploadRequest,
  ) {
    return this.documentsService.upload(principal, id, body);
  }

  /**
   * Reads a licence with Meta Muse before upload (hackathon, 2026-11-03): a proposal with a
   * confidence per field and warnings against the DOT application. Writes nothing.
   */
  @Post('cases/:id/documents/read-cdl')
  @RequirePermission('recruiting.manage')
  readCdl(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.readCdl) body: ReadCdlRequest,
  ): Promise<CdlReadResult> {
    return this.documentsService.readCdl(principal, id, body);
  }

  @SignedDownload()
  @RequireAnyPermission(...PERSONNEL_DOCUMENT_PERMISSIONS)
  @Get('cases/:id/documents/:documentId/file')
  @RequirePermission('recruiting.view')
  async documentFile(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Param('documentId') documentId: string,
    @Res() reply: FastifyReply,
  ) {
    const file = await this.documentsService.file(principal, id, documentId);
    const name = file.fileName.replace(/[^\w.-]+/g, '_');
    await reply
      .header('content-type', file.contentType)
      .header('content-disposition', `inline; filename="${name}"`)
      .header('cache-control', 'private, no-store')
      .send(file.bytes);
  }

  @Post('cases/:id/hire')
  @RequirePermission('recruiting.manage')
  hire(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.hire) body: HireDriverRequest,
  ) {
    return this.pipeline.hire(principal, id, body);
  }

  // ==================================================================================== leads

  @Get('leads')
  @RequirePermission('recruiting.view')
  listLeads(@CurrentPrincipal() principal: Principal, @Query(pipe.leads) query: LeadQuery) {
    return this.leads.list(principal, query);
  }

  @Get('leads/summary')
  @RequirePermission('recruiting.view')
  leadSummary(
    @CurrentPrincipal() principal: Principal,
    @Query(pipe.leadSummary) query: LeadSummaryQuery,
  ) {
    return this.leads.summary(principal, query);
  }

  /** The rules in force, so the prequalification form can show what it will be judged against. */
  @Get('leads/rules')
  @RequirePermission('recruiting.view')
  leadRules(@CurrentPrincipal() principal: Principal) {
    return this.leads.rules(principal.companyId);
  }

  /** The online applications behind one lead: answers, link, campaign, UTM and consent. */
  @RedactPersonnelFiles()
  @Get('leads/:id/applications')
  @RequirePermission('recruiting.view')
  leadApplications(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.leads.applications(principal, id);
  }

  @Get('leads/:id')
  @RequirePermission('recruiting.view')
  getLead(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.leads.get(principal, id);
  }

  @Post('leads')
  @RequirePermission('recruiting.manage')
  createLead(@CurrentPrincipal() principal: Principal, @Body(pipe.createLead) body: LeadBody) {
    return this.leads.create(principal, body);
  }

  @Patch('leads/:id')
  @RequirePermission('recruiting.manage')
  updateLead(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.updateLead) body: Partial<LeadBody>,
  ) {
    return this.leads.update(principal, id, body);
  }

  @Post('leads/:id/no-answer')
  @RequirePermission('recruiting.manage')
  markNoAnswer(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.leads.markNoAnswer(principal, id);
  }

  @Post('leads/:id/contacted')
  @RequirePermission('recruiting.manage')
  markContacted(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.leads.markContacted(principal, id);
  }

  @Post('leads/:id/prequalify')
  @RequirePermission('recruiting.manage')
  prequalify(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.prequalify) body: Prequalification,
  ) {
    return this.leads.prequalify(principal, id, body);
  }

  @Post('leads/:id/reopen')
  @RequirePermission('recruiting.manage')
  reopenLead(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.reopen) body: { note: string },
  ) {
    return this.leads.reopen(principal, id, body.note);
  }

  @Post('leads/:id/disqualify')
  @RequirePermission('recruiting.manage')
  disqualify(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.disqualify) body: { reason: string },
  ) {
    return this.leads.disqualify(principal, id, body.reason);
  }

  @Post('leads/:id/convert')
  @RequirePermission('recruiting.manage')
  convert(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.leads.convert(principal, id);
  }

  // ======================================================================= application links

  @Get('apply-links')
  @RequirePermission('recruiting.view')
  listApplyLinks(@CurrentPrincipal() principal: Principal) {
    return this.applyLinks.listLinks(principal);
  }

  @Post('apply-links')
  @RequirePermission('recruiting.manage')
  createApplyLink(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.createLink) body: ApplyLinkCreateBody,
  ) {
    return this.applyLinks.createLink(principal, body);
  }

  @Patch('apply-links/:id')
  @RequirePermission('recruiting.manage')
  updateApplyLink(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.updateLink) body: ApplyLinkUpdateBody,
  ) {
    return this.applyLinks.updateLink(principal, id, body);
  }
}
