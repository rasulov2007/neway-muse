import { Body, Controller, Get, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  AddOnboardingItemSchema,
  AdjustPtoBalanceSchema,
  AttendanceQuerySchema,
  ChangeReviewStatusSchema,
  CreateActionPlanSchema,
  CreateApplicantSchema,
  CreateAttendanceEntrySchema,
  CreateFeedbackSchema,
  CreateInterviewSchema,
  CreateJobOpeningSchema,
  CreateOfferSchema,
  CreateOnboardingChecklistSchema,
  CreatePerformanceCycleSchema,
  CreatePerformanceGoalSchema,
  CreatePerformanceReviewSchema,
  CreatePtoPolicySchema,
  CreatePtoRequestSchema,
  DecidePtoRequestSchema,
  HireApplicantSchema,
  JOB_OPENING_STATUSES,
  MoveApplicantStageSchema,
  OFFER_STATUSES,
  OnboardingQuerySchema,
  PerformanceQuerySchema,
  PtoQuerySchema,
  RecordInterviewOutcomeSchema,
  RecruitingQuerySchema,
  ResolveAttendanceExceptionSchema,
  UpdateActionPlanSchema,
  UpdateApplicantSchema,
  UpdateAttendanceEntrySchema,
  UpdateGoalProgressSchema,
  UpdateOnboardingItemSchema,
  UpdatePerformanceReviewSchema,
} from '@neway/shared';
import { z } from 'zod';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { SignedInOnly } from '../../common/auth/signed-in-only.decorator';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import type { Principal } from '../../common/auth/principal';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AttendanceService } from './attendance.service';
import { OnboardingService } from './onboarding.service';
import { PerformanceService } from './performance.service';
import { PtoService } from './pto.service';
import { RecruitingService } from './recruiting.service';
import { RequirePermission } from '../../common/auth/require-permission.decorator';

const p = <T extends z.ZodType>(schema: T) => new ZodValidationPipe(schema);

const pipes = {
  recruitingQuery: p(RecruitingQuerySchema),
  createJob: p(CreateJobOpeningSchema),
  jobStatus: p(z.object({ status: z.enum(JOB_OPENING_STATUSES) })),
  createApplicant: p(CreateApplicantSchema),
  updateApplicant: p(UpdateApplicantSchema),
  moveStage: p(MoveApplicantStageSchema),
  hire: p(HireApplicantSchema),
  createInterview: p(CreateInterviewSchema),
  interviewOutcome: p(RecordInterviewOutcomeSchema),
  createOffer: p(CreateOfferSchema),
  offerStatus: p(z.object({ status: z.enum(OFFER_STATUSES) })),
  onboardingQuery: p(OnboardingQuerySchema),
  createChecklist: p(CreateOnboardingChecklistSchema),
  addItem: p(AddOnboardingItemSchema),
  updateItem: p(UpdateOnboardingItemSchema),
  attendanceQuery: p(AttendanceQuerySchema),
  createAttendance: p(CreateAttendanceEntrySchema),
  updateAttendance: p(UpdateAttendanceEntrySchema),
  resolveException: p(ResolveAttendanceExceptionSchema),
  ptoQuery: p(PtoQuerySchema),
  createPolicy: p(CreatePtoPolicySchema),
  createRequest: p(CreatePtoRequestSchema),
  decideRequest: p(DecidePtoRequestSchema),
  adjustBalance: p(AdjustPtoBalanceSchema),
  performanceQuery: p(PerformanceQuerySchema),
  createCycle: p(CreatePerformanceCycleSchema),
  createGoal: p(CreatePerformanceGoalSchema),
  updateGoal: p(UpdateGoalProgressSchema),
  createReview: p(CreatePerformanceReviewSchema),
  updateReview: p(UpdatePerformanceReviewSchema),
  reviewStatus: p(ChangeReviewStatusSchema),
  createFeedback: p(CreateFeedbackSchema),
  createPlan: p(CreateActionPlanSchema),
  updatePlan: p(UpdateActionPlanSchema),
} as const;

/**
 * The workforce lifecycle after hiring: recruiting, onboarding, attendance, PTO, performance.
 *
 * One controller because these are one lifecycle rather than five products, and because every route
 * on it shares the same company scoping. Each module keeps its own service; nothing here holds
 * business logic.
 */
@Controller('hr')
@UseGuards(CompanyScopeGuard)
export class HrController {
  constructor(
    private readonly recruiting: RecruitingService,
    private readonly onboarding: OnboardingService,
    private readonly attendance: AttendanceService,
    private readonly pto: PtoService,
    private readonly performance: PerformanceService,
  ) {}

  // ------------------------------------------------------------------------------- recruiting

  @RequirePermission('recruiting.view')
  @Get('recruiting/summary')
  recruitingSummary(@CurrentPrincipal() principal: Principal) {
    return this.recruiting.summary(principal);
  }

  @RequirePermission('recruiting.view')
  @Get('recruiting/jobs')
  listJobs(@CurrentPrincipal() principal: Principal, @Query('status') status?: string) {
    return this.recruiting.listJobOpenings(principal, status);
  }

  @RequirePermission('recruiting.manage')
  @Post('recruiting/jobs')
  createJob(
    @CurrentPrincipal() principal: Principal,
    @Body(pipes.createJob) body: z.infer<typeof CreateJobOpeningSchema>,
  ) {
    return this.recruiting.createJobOpening(principal, body);
  }

  @RequirePermission('recruiting.manage')
  @Post('recruiting/jobs/:id/status')
  setJobStatus(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipes.jobStatus) body: { status: (typeof JOB_OPENING_STATUSES)[number] },
  ) {
    return this.recruiting.setJobOpeningStatus(principal, id, body.status);
  }

  @RequirePermission('recruiting.view')
  @Get('recruiting/candidates')
  listCandidates(
    @CurrentPrincipal() principal: Principal,
    @Query(pipes.recruitingQuery) query: z.infer<typeof RecruitingQuerySchema>,
  ) {
    return this.recruiting.listApplicants(principal, query);
  }

  @RequirePermission('recruiting.manage')
  @Post('recruiting/candidates')
  createCandidate(
    @CurrentPrincipal() principal: Principal,
    @Body(pipes.createApplicant) body: z.infer<typeof CreateApplicantSchema>,
  ) {
    return this.recruiting.createApplicant(principal, body);
  }

  @RequirePermission('recruiting.view')
  @Get('recruiting/candidates/:id')
  getCandidate(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.recruiting.getApplicant(principal, id);
  }

  @RequirePermission('recruiting.manage')
  @Patch('recruiting/candidates/:id')
  updateCandidate(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipes.updateApplicant) body: z.infer<typeof UpdateApplicantSchema>,
  ) {
    return this.recruiting.updateApplicant(principal, id, body);
  }

  @RequirePermission('recruiting.manage')
  @Post('recruiting/candidates/:id/stage')
  async moveStage(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipes.moveStage) body: z.infer<typeof MoveApplicantStageSchema>,
  ) {
    await this.recruiting.assertOfficeTrack(principal, id, 'Moving an office stage');
    return this.recruiting.moveStage(principal, id, body);
  }

  /** Creates the employee. The one place a candidate becomes a person. */
  @RequirePermission('recruiting.manage', 'employees.create')
  @Post('recruiting/candidates/:id/hire')
  async hire(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipes.hire) body: z.infer<typeof HireApplicantSchema>,
  ) {
    // A driver is hired only through their hiring case: after Safety approval and orientation.
    await this.recruiting.assertOfficeTrack(principal, id, 'The office hire');
    return this.recruiting.hire(principal, id, body);
  }

  @RequirePermission('recruiting.view')
  @Get('recruiting/candidates/:id/interviews')
  listInterviews(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.recruiting.listInterviews(principal, id);
  }

  @RequirePermission('recruiting.manage')
  @Post('recruiting/candidates/:id/interviews')
  scheduleInterview(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipes.createInterview) body: z.infer<typeof CreateInterviewSchema>,
  ) {
    return this.recruiting.scheduleInterview(principal, id, body);
  }

  @RequirePermission('recruiting.manage')
  @Post('recruiting/interviews/:id/outcome')
  recordOutcome(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipes.interviewOutcome) body: z.infer<typeof RecordInterviewOutcomeSchema>,
  ) {
    return this.recruiting.recordInterviewOutcome(principal, id, body);
  }

  @RequirePermission('recruiting.view')
  @Get('recruiting/candidates/:id/offers')
  listOffers(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.recruiting.listOffers(principal, id);
  }

  @RequirePermission('recruiting.manage')
  @Post('recruiting/candidates/:id/offers')
  async createOffer(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipes.createOffer) body: z.infer<typeof CreateOfferSchema>,
  ) {
    await this.recruiting.assertOfficeTrack(principal, id, 'An office offer');
    return this.recruiting.createOffer(principal, id, body);
  }

  @RequirePermission('recruiting.manage')
  @Post('recruiting/offers/:id/status')
  async setOfferStatus(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipes.offerStatus) body: { status: (typeof OFFER_STATUSES)[number] },
  ) {
    await this.recruiting.assertOfficeOffer(principal, id);
    return this.recruiting.setOfferStatus(principal, id, body.status);
  }

  // ------------------------------------------------------------------------------- onboarding

  @RequirePermission('onboarding.view')
  @Get('onboarding/summary')
  onboardingSummary(@CurrentPrincipal() principal: Principal) {
    return this.onboarding.summary(principal);
  }

  @RequirePermission('onboarding.view')
  @Get('onboarding')
  listOnboarding(
    @CurrentPrincipal() principal: Principal,
    @Query(pipes.onboardingQuery) query: z.infer<typeof OnboardingQuerySchema>,
  ) {
    return this.onboarding.list(principal, query);
  }

  @RequirePermission('onboarding.manage')
  @Post('onboarding')
  createOnboarding(
    @CurrentPrincipal() principal: Principal,
    @Body(pipes.createChecklist) body: z.infer<typeof CreateOnboardingChecklistSchema>,
  ) {
    return this.onboarding.create(principal, body);
  }

  /** The plans a hire can get. Declared before `onboarding/:id` so the word is not read as an id. */
  @RequirePermission('onboarding.view')
  @Get('onboarding/templates')
  onboardingTemplates(@CurrentPrincipal() principal: Principal) {
    return this.onboarding.listTemplates(principal);
  }

  @RequirePermission('onboarding.view')
  @Get('onboarding/:id')
  getOnboarding(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.onboarding.get(principal, id);
  }

  @RequirePermission('onboarding.view')
  @Get('onboarding/:id/items')
  onboardingItems(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.onboarding.items(principal, id);
  }

  @RequirePermission('onboarding.manage')
  @Post('onboarding/:id/items')
  addOnboardingItem(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipes.addItem) body: z.infer<typeof AddOnboardingItemSchema>,
  ) {
    return this.onboarding.addItem(principal, id, body);
  }

  @RequirePermission('onboarding.manage')
  @Patch('onboarding/items/:itemId')
  updateOnboardingItem(
    @CurrentPrincipal() principal: Principal,
    @Param('itemId') itemId: string,
    @Body(pipes.updateItem) body: z.infer<typeof UpdateOnboardingItemSchema>,
  ) {
    return this.onboarding.updateItem(principal, itemId, body);
  }

  // ------------------------------------------------------------------------------- attendance

  @RequirePermission('attendance.view')
  @Get('attendance/summary')
  attendanceSummary(@CurrentPrincipal() principal: Principal, @Query('onDate') onDate?: string) {
    return this.attendance.summary(principal, onDate);
  }

  @RequirePermission('attendance.view')
  @Get('attendance')
  listAttendance(
    @CurrentPrincipal() principal: Principal,
    @Query(pipes.attendanceQuery) query: z.infer<typeof AttendanceQuerySchema>,
  ) {
    return this.attendance.list(principal, query);
  }

  @RequirePermission('attendance.manage')
  @Post('attendance')
  createAttendance(
    @CurrentPrincipal() principal: Principal,
    @Body(pipes.createAttendance) body: z.infer<typeof CreateAttendanceEntrySchema>,
  ) {
    return this.attendance.create(principal, body);
  }

  @RequirePermission('attendance.manage')
  @Patch('attendance/:id')
  updateAttendance(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipes.updateAttendance) body: z.infer<typeof UpdateAttendanceEntrySchema>,
  ) {
    return this.attendance.update(principal, id, body);
  }

  @RequirePermission('attendance.approve')
  @Post('attendance/:id/approve')
  approveAttendance(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.attendance.approve(principal, id);
  }

  @RequirePermission('attendance.manage')
  @Post('attendance/:id/resolve')
  resolveAttendance(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipes.resolveException) body: z.infer<typeof ResolveAttendanceExceptionSchema>,
  ) {
    return this.attendance.resolveException(principal, id, body);
  }

  // -------------------------------------------------------------------------------------- pto

  @RequirePermission('pto.view')
  @Get('pto/summary')
  ptoSummary(@CurrentPrincipal() principal: Principal) {
    return this.pto.summary(principal);
  }

  @RequirePermission('pto.view')
  @Get('pto/policies')
  listPolicies(@CurrentPrincipal() principal: Principal) {
    return this.pto.listPolicies(principal);
  }

  @RequirePermission('pto.manage')
  @Post('pto/policies')
  createPolicy(
    @CurrentPrincipal() principal: Principal,
    @Body(pipes.createPolicy) body: z.infer<typeof CreatePtoPolicySchema>,
  ) {
    return this.pto.createPolicy(principal, body);
  }

  @RequirePermission('pto.view')
  @Get('pto/requests')
  listPto(
    @CurrentPrincipal() principal: Principal,
    @Query(pipes.ptoQuery) query: z.infer<typeof PtoQuerySchema>,
  ) {
    return this.pto.list(principal, query);
  }

  @RequirePermission('pto.create')
  @Post('pto/requests')
  createPto(
    @CurrentPrincipal() principal: Principal,
    @Body(pipes.createRequest) body: z.infer<typeof CreatePtoRequestSchema>,
  ) {
    return this.pto.create(principal, body);
  }

  @RequirePermission('pto.view')
  @Get('pto/requests/:id')
  getPto(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.pto.get(principal, id);
  }

  @RequirePermission('pto.approve')
  @Post('pto/requests/:id/decide')
  decidePto(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipes.decideRequest) body: z.infer<typeof DecidePtoRequestSchema>,
  ) {
    return this.pto.decide(principal, id, body);
  }

  /** Mobile M4 (My work): the caller's own PTO balance, own employee only. */
  @SignedInOnly('own employee only: the employee linked to the session; no id is read from the request')
  @Get('pto/me')
  ptoMine(@CurrentPrincipal() principal: Principal) {
    return this.pto.myBalances(principal);
  }

  @RequirePermission('pto.view')
  @Get('pto/balances/:employeeId')
  ptoBalances(@CurrentPrincipal() principal: Principal, @Param('employeeId') employeeId: string) {
    return this.pto.balances(principal, employeeId);
  }

  @RequirePermission('pto.view')
  @Get('pto/transactions/:employeeId')
  ptoTransactions(
    @CurrentPrincipal() principal: Principal,
    @Param('employeeId') employeeId: string,
  ) {
    return this.pto.transactions(principal, employeeId);
  }

  @RequirePermission('pto.manage')
  @Post('pto/balances/adjust')
  adjustPto(
    @CurrentPrincipal() principal: Principal,
    @Body(pipes.adjustBalance) body: z.infer<typeof AdjustPtoBalanceSchema>,
  ) {
    return this.pto.adjustBalance(principal, body);
  }

  // ------------------------------------------------------------------------------ performance

  @RequirePermission('performance.view')
  @Get('performance/summary')
  performanceSummary(@CurrentPrincipal() principal: Principal) {
    return this.performance.summary(principal);
  }

  @RequirePermission('performance.view')
  @Get('performance/cycles')
  listCycles(@CurrentPrincipal() principal: Principal) {
    return this.performance.listCycles(principal);
  }

  @RequirePermission('performance.manage')
  @Post('performance/cycles')
  createCycle(
    @CurrentPrincipal() principal: Principal,
    @Body(pipes.createCycle) body: z.infer<typeof CreatePerformanceCycleSchema>,
  ) {
    return this.performance.createCycle(principal, body);
  }

  @RequirePermission('performance.view')
  @Get('performance/goals')
  listGoals(
    @CurrentPrincipal() principal: Principal,
    @Query(pipes.performanceQuery) query: z.infer<typeof PerformanceQuerySchema>,
  ) {
    return this.performance.listGoals(principal, query);
  }

  @RequirePermission('performance.manage')
  @Post('performance/goals')
  createGoal(
    @CurrentPrincipal() principal: Principal,
    @Body(pipes.createGoal) body: z.infer<typeof CreatePerformanceGoalSchema>,
  ) {
    return this.performance.createGoal(principal, body);
  }

  @RequirePermission('performance.manage')
  @Patch('performance/goals/:id')
  updateGoal(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipes.updateGoal) body: z.infer<typeof UpdateGoalProgressSchema>,
  ) {
    return this.performance.updateGoal(principal, id, body);
  }

  @RequirePermission('performance.view')
  @Get('performance/reviews')
  listReviews(
    @CurrentPrincipal() principal: Principal,
    @Query(pipes.performanceQuery) query: z.infer<typeof PerformanceQuerySchema>,
  ) {
    return this.performance.listReviews(principal, query);
  }

  @RequirePermission('performance.manage')
  @Post('performance/reviews')
  createReview(
    @CurrentPrincipal() principal: Principal,
    @Body(pipes.createReview) body: z.infer<typeof CreatePerformanceReviewSchema>,
  ) {
    return this.performance.createReview(principal, body);
  }

  @RequirePermission('performance.view')
  @Get('performance/reviews/:id')
  getReview(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.performance.getReview(principal, id);
  }

  @RequirePermission('performance.manage')
  @Patch('performance/reviews/:id')
  updateReview(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipes.updateReview) body: z.infer<typeof UpdatePerformanceReviewSchema>,
  ) {
    return this.performance.updateReview(principal, id, body);
  }

  @RequirePermission('performance.manage')
  @Post('performance/reviews/:id/status')
  changeReviewStatus(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipes.reviewStatus) body: z.infer<typeof ChangeReviewStatusSchema>,
  ) {
    return this.performance.changeReviewStatus(principal, id, body);
  }

  @RequirePermission('performance.view')
  @Get('performance/feedback/:employeeId')
  listFeedback(@CurrentPrincipal() principal: Principal, @Param('employeeId') employeeId: string) {
    // Manager-only notes are filtered server-side by permission, not hidden in the client.
    const canSeePrivate = principal.permissions.has('performance.manage');
    return this.performance.listFeedback(principal, employeeId, canSeePrivate);
  }

  @RequirePermission('performance.manage')
  @Post('performance/feedback')
  addFeedback(
    @CurrentPrincipal() principal: Principal,
    @Body(pipes.createFeedback) body: z.infer<typeof CreateFeedbackSchema>,
  ) {
    return this.performance.addFeedback(principal, body);
  }

  @RequirePermission('performance.view')
  @Get('performance/action-plans')
  listActionPlans(
    @CurrentPrincipal() principal: Principal,
    @Query('employeeId') employeeId?: string,
  ) {
    return this.performance.listActionPlans(principal, employeeId);
  }

  @RequirePermission('performance.manage')
  @Post('performance/action-plans')
  createActionPlan(
    @CurrentPrincipal() principal: Principal,
    @Body(pipes.createPlan) body: z.infer<typeof CreateActionPlanSchema>,
  ) {
    return this.performance.createActionPlan(principal, body);
  }

  @RequirePermission('performance.manage')
  @Patch('performance/action-plans/:id')
  updateActionPlan(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipes.updatePlan) body: z.infer<typeof UpdateActionPlanSchema>,
  ) {
    return this.performance.updateActionPlan(principal, id, body);
  }
}
