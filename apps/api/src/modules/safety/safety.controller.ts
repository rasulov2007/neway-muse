import { Body, Controller, Get, Header, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import {
  ACCOUNTING_ENTRY_STATES,
  AttachSafetyDocumentSchema,
  CLAIM_KINDS,
  CLAIM_STAGES,
  CloseAccidentSchema,
  CompleteSafetyReviewSchema,
  CreateAccidentSchema,
  CreateClaimSchema,
  CreateDrugTestSchema,
  RecordRandomDrugTestSchema,
  CreateRoadsideInspectionSchema,
  CreateSafetyReviewSchema,
  CreateViolationCaseSchema,
  VoidViolationCaseSchema,
  VoidViolationSchema,
  CreateViolationSchema,
  LinkWorkOrderSchema,
  RecordClaimPaymentSchema,
  ReviewAccountingEntrySchema,
  ReviewTestExceptionSchema,
  RoadsideStageSchema,
  RoadsideViolationSchema,
  SAFETY_REVIEW_KINDS,
  UpdateAccidentSchema,
  UpdateClaimSchema,
  UpdateDrugTestSchema,
  UpdateRoadsideInspectionSchema,
  UpdateSafetyReviewSchema,
  UpdateViolationSchema,
  VersionOnlySchema,
  VoidClaimPaymentSchema,
  VoidDocumentSchema,
  VoidSchema,
  type AccountingEntryState,
  type AttachSafetyDocumentInput,
  type ClaimStage,
  type CloseAccidentInput,
  type CompleteSafetyReviewInput,
  type CreateAccidentInput,
  type CreateClaimInput,
  type CreateDrugTestInput,
  type RecordRandomDrugTestInput,
  type CreateRoadsideInspectionInput,
  type CreateSafetyReviewInput,
  type CreateViolationCaseInput,
  type VoidViolationCaseInput,
  type VoidViolationInput,
  type CreateViolationInput,
  type LinkWorkOrderInput,
  type RecordClaimPaymentInput,
  type ReviewAccountingEntryInput,
  type ReviewTestExceptionInput,
  type RoadsideStageInput,
  type RoadsideViolationInput,
  type SafetyCaseType,
  type SafetyReviewKind,
  type UpdateAccidentInput,
  type UpdateClaimInput,
  type UpdateDrugTestInput,
  type UpdateRoadsideInspectionInput,
  type UpdateSafetyReviewInput,
  type UpdateViolationInput,
  type VersionOnlyInput,
  type VoidInput,
  ViolationMoneySchema,
  ViolationNoteSchema,
  ViolationStatusSchema,
  ViolationTrainingSchema,
  type ViolationMoneyInput,
  type ViolationNoteInput,
  type ViolationStatusInput,
  type ViolationTrainingInput,
  ApplyDriverChargeSchema,
  ApproveDriverChargeSchema,
  ChangeRequestSchema,
  DisputeDriverChargeSchema,
  DriverChargePaymentSchema,
  DriverChargeReasonSchema,
  LogClaimUpdateSchema,
  NotifyDriverSchema,
  RejectDriverChargeSchema,
  ResolveDriverChargeSchema,
  SetLiabilitySchema,
  VersionOnlyChargeSchema,
  type ApplyDriverChargeInput,
  type ApproveDriverChargeInput,
  type ChangeRequestInput,
  type DisputeDriverChargeInput,
  type DriverChargePaymentInput,
  type DriverChargeReasonInput,
  type LogClaimUpdateInput,
  type NotifyDriverInput,
  type RejectDriverChargeInput,
  type ResolveDriverChargeInput,
  type SetLiabilityInput,
  type VersionOnlyChargeInput,
  ScheduleVacationTestSchema,
  ApproveVacationReturnSchema,
  AttributeVacationExpenseSchema,
  type ScheduleVacationTestInput,
  type ApproveVacationReturnInput,
  type AttributeVacationExpenseInput,
  type VacationReturnDetail,
  type VacationReturnList,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { RequireAnyPermission, RequirePermission } from '../../common/auth/require-permission.decorator';
import { FeatureFlagGuard } from '../../common/flags/feature-flag.guard';
import { RequireFlag } from '../../common/flags/require-flag.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { AccidentsService } from './accidents.service';
import { ClaimsService } from './claims.service';
import { LegacyAccidentWriterGuard } from './legacy-writer.guard';
import { ComplianceViewService } from './compliance-view.service';
import { SafetyOverviewService } from './overview.service';
import { SafetyReviewsService } from './reviews.service';
import { SafetyCoreService } from './safety-core.service';
import { DriverChargesService } from './driver-charges.service';
import { DrugTestsService } from './tests.service';
import { VacationReturnsService } from './vacation-returns.service';
import { ViolationsService } from './violations.service';

const pipe = {
  attach: new ZodValidationPipe(AttachSafetyDocumentSchema),
  voidDocument: new ZodValidationPipe(VoidDocumentSchema),
  version: new ZodValidationPipe(VersionOnlySchema),
  void: new ZodValidationPipe(VoidSchema),
  createAccident: new ZodValidationPipe(CreateAccidentSchema),
  updateAccident: new ZodValidationPipe(UpdateAccidentSchema),
  closeAccident: new ZodValidationPipe(CloseAccidentSchema),
  linkWorkOrder: new ZodValidationPipe(LinkWorkOrderSchema),
  accidentClaim: new ZodValidationPipe(z.object({ kind: z.enum(CLAIM_KINDS).default('physical_damage') })),
  createTest: new ZodValidationPipe(CreateDrugTestSchema),
  recordRandomTest: new ZodValidationPipe(RecordRandomDrugTestSchema),
  updateTest: new ZodValidationPipe(UpdateDrugTestSchema),
  reviewException: new ZodValidationPipe(ReviewTestExceptionSchema),
  createClaim: new ZodValidationPipe(CreateClaimSchema),
  updateClaim: new ZodValidationPipe(UpdateClaimSchema),
  closeClaim: new ZodValidationPipe(z.object({ version: z.number().int().min(1), reason: z.string().trim().min(3, 'Say why the claim is closed').max(1000) })),
  payment: new ZodValidationPipe(RecordClaimPaymentSchema),
  voidPayment: new ZodValidationPipe(VoidClaimPaymentSchema),
  reviewEntry: new ZodValidationPipe(ReviewAccountingEntrySchema),
  createViolation: new ZodValidationPipe(CreateViolationSchema),
  updateViolation: new ZodValidationPipe(UpdateViolationSchema),
  createRoadside: new ZodValidationPipe(CreateRoadsideInspectionSchema),
  updateRoadside: new ZodValidationPipe(UpdateRoadsideInspectionSchema),
  roadsideStage: new ZodValidationPipe(RoadsideStageSchema),
  roadsideViolation: new ZodValidationPipe(RoadsideViolationSchema),
  createReview: new ZodValidationPipe(CreateSafetyReviewSchema),
  updateReview: new ZodValidationPipe(UpdateSafetyReviewSchema),
  completeReview: new ZodValidationPipe(CompleteSafetyReviewSchema),
  liability: new ZodValidationPipe(SetLiabilitySchema),
  logUpdate: new ZodValidationPipe(LogClaimUpdateSchema),
  applyCharge: new ZodValidationPipe(ApplyDriverChargeSchema),
  notifyCharge: new ZodValidationPipe(NotifyDriverSchema),
  chargeVersion: new ZodValidationPipe(VersionOnlyChargeSchema),
  approveCharge: new ZodValidationPipe(ApproveDriverChargeSchema),
  rejectCharge: new ZodValidationPipe(RejectDriverChargeSchema),
  chargePayment: new ZodValidationPipe(DriverChargePaymentSchema),
  chargeReason: new ZodValidationPipe(DriverChargeReasonSchema),
  disputeCharge: new ZodValidationPipe(DisputeDriverChargeSchema),
  resolveCharge: new ZodValidationPipe(ResolveDriverChargeSchema),
  changeRequest: new ZodValidationPipe(ChangeRequestSchema),
} as const;

/** Every charge write: the service checks the exact role (Safety, Accounting or Management). */
const CHARGE_WRITERS = ['safety.manage', 'accounting.edit', 'claims.approve_exceptions'] as const;

/**
 * Safety v2 over HTTP (docs/safety/SAFETY-V2.md), behind `safety_v2`.
 *
 * Reads take `safety.view`, writes `safety.manage`. Drug & alcohol results are redacted by the
 * services for anybody without `safety_testing.view`; recording them takes `safety_testing.manage`.
 * Every write names the version it read and is refused with 409 when the record moved on.
 */
/**
 * Truck and trailer inspections (roadside and annual) are read by everybody who works the fleet,
 * not only Safety (owner, 2026-10-10). Writing them still takes safety.manage.
 */
const INSPECTION_READERS = ['safety.view', 'trucks.view', 'trailers.view'];

@Controller('safety')
@RequireFlag('safety_v2')
@UseGuards(FeatureFlagGuard, CompanyScopeGuard, PermissionGuard)
export class SafetyController {
  constructor(
    private readonly core: SafetyCoreService,
    private readonly overviewService: SafetyOverviewService,
    private readonly charges: DriverChargesService,
    private readonly accidents: AccidentsService,
    private readonly tests: DrugTestsService,
    private readonly claims: ClaimsService,
    private readonly violations: ViolationsService,
    private readonly reviews: SafetyReviewsService,
    private readonly compliance: ComplianceViewService,
    private readonly vacationReturns: VacationReturnsService,
  ) {}

  // ---------------------------------------------------------------------------------- overview

  @Get('overview')
  @RequirePermission('safety.view')
  @Header('Cache-Control', 'private, no-store')
  overview(@CurrentPrincipal() principal: Principal) {
    return this.overviewService.overview(principal);
  }

  @Get('pickers')
  @RequireAnyPermission(...INSPECTION_READERS)
  pickers(@CurrentPrincipal() principal: Principal) {
    return this.core.pickers(principal);
  }

  @Get('inspections/pretrip')
  @RequirePermission('safety.view')
  @Header('Cache-Control', 'private, no-store')
  pretrip(@CurrentPrincipal() principal: Principal) {
    return this.overviewService.pretrip(principal);
  }

  @Get('people')
  @RequirePermission('safety.view')
  people(@CurrentPrincipal() principal: Principal) {
    return this.core.people(principal);
  }

  // --------------------------------------------------------------------------------- documents

  @Post('documents')
  @RequirePermission('safety.manage')
  async attach(@CurrentPrincipal() principal: Principal, @Body(pipe.attach) body: AttachSafetyDocumentInput) {
    if (body.caseType === 'drug_test' && !hasPermission(principal, 'safety_testing.manage')) {
      throw this.core.forbidden('Attaching a test record takes safety_testing.manage');
    }
    const caseRef = await this.resolveCase(principal, body.caseType, body.caseId);
    return this.core.attach(principal, body, caseRef);
  }

  @Post('documents/:id/void')
  @RequirePermission('safety.manage')
  async voidDocument(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.voidDocument) body: { reason: string }) {
    await this.core.voidDocument(principal, id, body.reason, (type, caseId) => this.resolveCase(principal, type, caseId));
    return { id, voided: true };
  }

  private async resolveCase(principal: Principal, type: SafetyCaseType, id: string): Promise<{ id: string; number: string }> {
    const c = principal.companyId;
    switch (type) {
      case 'accident':
        return this.accidents.row(c, id);
      case 'claim':
        return this.claims.row(c, id);
      case 'violation':
        return this.violations.violationRow(c, id);
      case 'roadside_inspection':
        return this.violations.inspectionRow(c, id);
      case 'safety_review':
        return this.reviews.row(c, id);
      case 'drug_test':
        return this.tests.row(c, id);
    }
  }

  // --------------------------------------------------------------------------------- accidents

  @Get('accidents')
  @RequirePermission('safety.view')
  @Header('Cache-Control', 'private, no-store')
  listAccidents(@CurrentPrincipal() principal: Principal, @Query('includeVoided') includeVoided?: string) {
    return this.accidents.list(principal, { includeVoided: includeVoided === 'true' });
  }

  @Get('accidents/:id')
  @RequirePermission('safety.view')
  @Header('Cache-Control', 'private, no-store')
  accident(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.accidents.detail(principal, id);
  }

  @Post('accidents')
  @UseGuards(LegacyAccidentWriterGuard)
  @RequirePermission('safety.manage')
  createAccident(@CurrentPrincipal() principal: Principal, @Body(pipe.createAccident) body: CreateAccidentInput) {
    return this.accidents.create(principal, body);
  }

  @Patch('accidents/:id')
  @UseGuards(LegacyAccidentWriterGuard)
  @RequirePermission('safety.manage')
  updateAccident(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.updateAccident) body: UpdateAccidentInput) {
    return this.accidents.update(principal, id, body);
  }

  @Post('accidents/:id/advance')
  @UseGuards(LegacyAccidentWriterGuard)
  @RequirePermission('safety.manage')
  advanceAccident(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.version) body: VersionOnlyInput) {
    return this.accidents.advance(principal, id, body);
  }

  @Post('accidents/:id/close')
  @UseGuards(LegacyAccidentWriterGuard)
  @RequirePermission('safety.manage')
  closeAccident(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.closeAccident) body: CloseAccidentInput) {
    return this.accidents.close(principal, id, body);
  }

  @Post('accidents/:id/void')
  @UseGuards(LegacyAccidentWriterGuard)
  @RequirePermission('safety.manage')
  voidAccident(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.void) body: VoidInput) {
    return this.accidents.void(principal, id, body);
  }

  /** Opens the accident's claim, or answers with the one already open. Never two. */
  @Post('accidents/:id/claim')
  @UseGuards(LegacyAccidentWriterGuard)
  @RequirePermission('safety.manage')
  accidentClaim(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.accidentClaim) body: { kind: CreateClaimInput['kind'] }) {
    return this.claims.create(principal, { kind: body.kind, accidentId: id, description: '' });
  }

  @Post('accidents/:id/work-order')
  @UseGuards(LegacyAccidentWriterGuard)
  @RequirePermission('safety.manage')
  accidentWorkOrder(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.linkWorkOrder) body: LinkWorkOrderInput) {
    return this.accidents.linkWorkOrder(principal, id, body);
  }

  // ----------------------------------------------------------- vacation return reviews (2026-10-17)

  /** Drivers back (or still away) after 30+ days, with where the company's return check stands. */
  @Get('vacation-returns')
  @RequirePermission('safety.view')
  @Header('Cache-Control', 'private, no-store')
  vacationReturnList(@CurrentPrincipal() p: Principal): Promise<VacationReturnList> {
    return this.vacationReturns.list(p);
  }

  @Get('vacation-returns/:vacationId')
  @RequirePermission('safety.view')
  @Header('Cache-Control', 'private, no-store')
  vacationReturnDetail(@CurrentPrincipal() p: Principal, @Param('vacationId') id: string): Promise<VacationReturnDetail> {
    return this.vacationReturns.detail(p, id);
  }

  @Post('vacation-returns/:vacationId/test')
  @RequirePermission('safety.manage', 'safety_testing.manage')
  vacationReturnTest(@CurrentPrincipal() p: Principal, @Param('vacationId') id: string, @Body(new ZodValidationPipe(ScheduleVacationTestSchema)) body: ScheduleVacationTestInput): Promise<VacationReturnDetail> {
    return this.vacationReturns.scheduleTest(p, id, body);
  }

  @Post('vacation-returns/:vacationId/approve')
  @RequirePermission('safety.manage')
  vacationReturnApprove(@CurrentPrincipal() p: Principal, @Param('vacationId') id: string, @Body(new ZodValidationPipe(ApproveVacationReturnSchema)) body: ApproveVacationReturnInput): Promise<VacationReturnDetail> {
    return this.vacationReturns.approve(p, id, body);
  }

  @Post('vacation-returns/:vacationId/expense')
  @RequirePermission('safety.manage', 'accounting.view')
  vacationReturnExpense(@CurrentPrincipal() p: Principal, @Param('vacationId') id: string, @Body(new ZodValidationPipe(AttributeVacationExpenseSchema)) body: AttributeVacationExpenseInput): Promise<VacationReturnDetail> {
    return this.vacationReturns.attributeExpense(p, id, body);
  }

  // ------------------------------------------------------------------------------------- tests

  @Get('tests')
  @RequirePermission('safety.view')
  @Header('Cache-Control', 'private, no-store')
  listTests(@CurrentPrincipal() principal: Principal, @Query('driverId') driverId?: string) {
    return this.tests.list(principal, { driverId });
  }

  @Get('tests/:id')
  @RequirePermission('safety.view')
  @Header('Cache-Control', 'private, no-store')
  test(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.tests.detail(principal, id);
  }

  @Post('tests')
  @RequirePermission('safety.manage', 'safety_testing.manage')
  createTest(@CurrentPrincipal() principal: Principal, @Body(pipe.createTest) body: CreateDrugTestInput) {
    return this.tests.create(principal, body);
  }

  /** A random test result and its paper, from the driver's Documents tab (owner, 2026-10-24). */
  @Post('tests/random')
  @RequirePermission('safety.manage', 'safety_testing.manage')
  recordRandomTest(@CurrentPrincipal() principal: Principal, @Body(pipe.recordRandomTest) body: RecordRandomDrugTestInput) {
    return this.tests.recordRandom(principal, body);
  }

  @Patch('tests/:id')
  @RequirePermission('safety.manage')
  updateTest(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.updateTest) body: UpdateDrugTestInput) {
    return this.tests.update(principal, id, body);
  }

  @Post('tests/:id/exception-review')
  @RequirePermission('safety.manage', 'safety_testing.manage')
  reviewTestException(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.reviewException) body: ReviewTestExceptionInput) {
    return this.tests.reviewException(principal, id, body);
  }

  @Post('tests/:id/void')
  @RequirePermission('safety.manage', 'safety_testing.manage')
  voidTest(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.void) body: VoidInput) {
    return this.tests.void(principal, id, body);
  }

  // ------------------------------------------------------------------------------------ claims

  @Get('claims')
  @RequirePermission('safety.view')
  @Header('Cache-Control', 'private, no-store')
  listClaims(@CurrentPrincipal() principal: Principal, @Query('stage') stage?: string, @Query('includeVoided') includeVoided?: string) {
    const s = (CLAIM_STAGES as readonly string[]).includes(stage ?? '') ? (stage as ClaimStage) : undefined;
    return this.claims.list(principal, { stage: s, includeVoided: includeVoided === 'true' });
  }

  @Get('claims/:id')
  @RequirePermission('safety.view')
  @Header('Cache-Control', 'private, no-store')
  claim(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.claims.detail(principal, id);
  }

  @Post('claims')
  @UseGuards(LegacyAccidentWriterGuard)
  @RequirePermission('safety.manage')
  createClaim(@CurrentPrincipal() principal: Principal, @Body(pipe.createClaim) body: CreateClaimInput) {
    return this.claims.create(principal, body);
  }

  @Patch('claims/:id')
  @UseGuards(LegacyAccidentWriterGuard)
  @RequirePermission('safety.manage')
  updateClaim(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.updateClaim) body: UpdateClaimInput) {
    return this.claims.update(principal, id, body);
  }

  @Post('claims/:id/advance')
  @UseGuards(LegacyAccidentWriterGuard)
  @RequirePermission('safety.manage')
  advanceClaim(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.version) body: VersionOnlyInput) {
    return this.claims.advance(principal, id, body);
  }

  @Post('claims/:id/close')
  @UseGuards(LegacyAccidentWriterGuard)
  @RequirePermission('safety.manage')
  closeClaim(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.closeClaim) body: { version: number; reason: string }) {
    return this.claims.close(principal, id, body);
  }

  @Post('claims/:id/payments')
  @UseGuards(LegacyAccidentWriterGuard)
  @RequirePermission('safety.manage')
  recordPayment(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.payment) body: RecordClaimPaymentInput) {
    return this.claims.recordPayment(principal, id, body);
  }

  @Post('claims/:id/payments/:paymentId/void')
  @UseGuards(LegacyAccidentWriterGuard)
  @RequirePermission('safety.manage')
  voidPayment(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Param('paymentId') paymentId: string, @Body(pipe.voidPayment) body: VoidInput) {
    return this.claims.voidPayment(principal, id, paymentId, body);
  }

  @Post('claims/:id/void')
  @UseGuards(LegacyAccidentWriterGuard)
  @RequirePermission('safety.manage')
  voidClaim(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.void) body: VoidInput) {
    return this.claims.void(principal, id, body);
  }

  @Post('claims/:id/liability')
  @RequirePermission('safety.manage')
  setLiability(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.liability) body: SetLiabilityInput) {
    return this.claims.setLiability(principal, id, body);
  }

  @Post('claims/:id/updates')
  @UseGuards(LegacyAccidentWriterGuard)
  @RequirePermission('safety.manage')
  logUpdate(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.logUpdate) body: LogClaimUpdateInput) {
    return this.claims.logUpdate(principal, id, body);
  }

  // -------------------------------------------------------------------- driver charges (v2)

  @Get('driver-charges')
  @RequireAnyPermission('safety.view', 'accounting.view')
  @Header('Cache-Control', 'private, no-store')
  listCharges(@CurrentPrincipal() principal: Principal, @Query('claimId') claimId?: string, @Query('driverId') driverId?: string) {
    return this.charges.list(principal, { claimId: claimId || undefined, driverId: driverId || undefined });
  }

  @Get('driver-charges/:id')
  @RequireAnyPermission('safety.view', 'accounting.view')
  @Header('Cache-Control', 'private, no-store')
  charge(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.charges.get(principal, id);
  }

  @Post('claims/:id/driver-charges')
  @RequireAnyPermission('claims.apply_charges', 'claims.approve_exceptions')
  applyCharge(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.applyCharge) body: ApplyDriverChargeInput) {
    return this.charges.apply(principal, id, body);
  }

  @Post('driver-charges/:id/notify')
  @RequireAnyPermission(...CHARGE_WRITERS)
  notifyCharge(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.notifyCharge) body: NotifyDriverInput) {
    return this.charges.notify(principal, id, body);
  }

  @Post('driver-charges/:id/send-to-accounting')
  @RequireAnyPermission(...CHARGE_WRITERS)
  sendCharge(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.chargeVersion) body: VersionOnlyChargeInput) {
    return this.charges.sendToAccounting(principal, id, body);
  }

  @Post('driver-charges/:id/approve')
  @RequireAnyPermission('accounting.edit', 'claims.approve_exceptions')
  approveCharge(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.approveCharge) body: ApproveDriverChargeInput) {
    return this.charges.approve(principal, id, body);
  }

  @Post('driver-charges/:id/reject')
  @RequireAnyPermission('accounting.edit', 'claims.approve_exceptions')
  rejectCharge(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.rejectCharge) body: RejectDriverChargeInput) {
    return this.charges.reject(principal, id, body);
  }

  @Post('driver-charges/:id/payments')
  @RequireAnyPermission('accounting.edit', 'claims.approve_exceptions')
  chargePayment(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.chargePayment) body: DriverChargePaymentInput) {
    return this.charges.payment(principal, id, body);
  }

  @Post('driver-charges/:id/pause')
  @RequireAnyPermission(...CHARGE_WRITERS)
  pauseCharge(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.chargeReason) body: DriverChargeReasonInput) {
    return this.charges.pause(principal, id, body);
  }

  @Post('driver-charges/:id/resume')
  @RequireAnyPermission(...CHARGE_WRITERS)
  resumeCharge(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.chargeReason) body: DriverChargeReasonInput) {
    return this.charges.resume(principal, id, body);
  }

  @Post('driver-charges/:id/dispute')
  @RequireAnyPermission(...CHARGE_WRITERS)
  disputeCharge(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.disputeCharge) body: DisputeDriverChargeInput) {
    return this.charges.dispute(principal, id, body);
  }

  @Post('driver-charges/:id/resolve')
  @RequirePermission('claims.approve_exceptions')
  resolveCharge(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.resolveCharge) body: ResolveDriverChargeInput) {
    return this.charges.resolve(principal, id, body);
  }

  @Post('driver-charges/:id/change-request')
  @RequireAnyPermission(...CHARGE_WRITERS)
  changeRequest(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.changeRequest) body: ChangeRequestInput) {
    return this.charges.changeRequest(principal, id, body);
  }

  @Post('driver-charges/:id/change-request/approve')
  @RequirePermission('claims.approve_exceptions')
  approveChange(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.chargeVersion) body: VersionOnlyChargeInput) {
    return this.charges.decideChange(principal, id, true, body);
  }

  @Post('driver-charges/:id/change-request/decline')
  @RequirePermission('claims.approve_exceptions')
  declineChange(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.chargeVersion) body: VersionOnlyChargeInput) {
    return this.charges.decideChange(principal, id, false, body);
  }

  // ----------------------------------------------------------------------- accounting entries

  /** The suggestions waiting for Accounting. Safety sees them; Accounting decides them. */
  @Get('accounting-entries')
  @RequireAnyPermission('accounting.view', 'safety.view')
  @Header('Cache-Control', 'private, no-store')
  accountingEntries(@CurrentPrincipal() principal: Principal, @Query('state') state?: string) {
    const s = (ACCOUNTING_ENTRY_STATES as readonly string[]).includes(state ?? '') ? (state as AccountingEntryState) : undefined;
    return this.claims.accountingEntries(principal, { state: s });
  }

  @Post('accounting-entries/:id/confirm')
  @RequirePermission('accounting.edit')
  confirmEntry(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.reviewEntry) body: ReviewAccountingEntryInput) {
    return this.claims.reviewEntry(principal, id, 'confirmed', body);
  }

  @Post('accounting-entries/:id/reject')
  @RequirePermission('accounting.edit')
  rejectEntry(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.reviewEntry) body: ReviewAccountingEntryInput) {
    return this.claims.reviewEntry(principal, id, 'rejected', body);
  }

  // -------------------------------------------------------------------------------- violations

  @Get('violations')
  @RequirePermission('safety.view')
  @Header('Cache-Control', 'private, no-store')
  listViolations(@CurrentPrincipal() principal: Principal, @Query('includeVoided') includeVoided?: string) {
    return this.violations.listViolations(principal, { includeVoided: includeVoided === 'true' });
  }

  // One paper, one case (owner, 2026-10-21): the list shows cases; each case holds its violations.
  @Get('violation-cases')
  @RequirePermission('safety.view')
  @Header('Cache-Control', 'private, no-store')
  listViolationCases(@CurrentPrincipal() principal: Principal, @Query('includeVoided') includeVoided?: string) {
    return this.violations.listViolationCases(principal, { includeVoided: includeVoided === 'true' });
  }

  // Delete = void (owner, 2026-10-21): every live violation on the paper, kept on record, audited.
  @Post('violation-cases/:key/void')
  @RequirePermission('safety.manage')
  voidViolationCase(@CurrentPrincipal() principal: Principal, @Param('key') key: string, @Body(new ZodValidationPipe(VoidViolationCaseSchema)) body: VoidViolationCaseInput) {
    return this.violations.voidViolationCase(principal, key, body);
  }

  @Get('violation-cases/:key')
  @RequirePermission('safety.view')
  @Header('Cache-Control', 'private, no-store')
  violationCase(@CurrentPrincipal() principal: Principal, @Param('key') key: string) {
    return this.violations.violationCase(principal, key);
  }

  @Post('violation-cases')
  @RequirePermission('safety.manage')
  createViolationCase(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(CreateViolationCaseSchema)) body: CreateViolationCaseInput) {
    return this.violations.createViolationCase(principal, body);
  }

  @Get('violations/:id')
  @RequirePermission('safety.view')
  @Header('Cache-Control', 'private, no-store')
  violation(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.violations.violationDetail(principal, id);
  }

  @Post('violations')
  @RequirePermission('safety.manage')
  createViolation(@CurrentPrincipal() principal: Principal, @Body(pipe.createViolation) body: CreateViolationInput) {
    return this.violations.createViolation(principal, body);
  }

  @Patch('violations/:id')
  @RequirePermission('safety.manage')
  updateViolation(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.updateViolation) body: UpdateViolationInput) {
    return this.violations.updateViolation(principal, id, body);
  }

  @Post('violations/:id/close')
  @RequirePermission('safety.manage')
  closeViolation(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.version) body: VersionOnlyInput) {
    return this.violations.closeViolation(principal, id, body);
  }

  // Follow-up on the row (owner, 2026-10-13): training, status, charge / bonus, notes.
  @Post('violations/:id/training')
  @RequirePermission('safety.manage')
  violationTraining(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(ViolationTrainingSchema)) body: ViolationTrainingInput) {
    return this.violations.setTraining(principal, id, body);
  }

  @Post('violations/:id/status')
  @RequirePermission('safety.manage')
  violationStatus(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(ViolationStatusSchema)) body: ViolationStatusInput) {
    return this.violations.setStatus(principal, id, body);
  }

  @Post('violations/:id/money')
  @RequirePermission('safety.manage')
  violationMoney(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(ViolationMoneySchema)) body: ViolationMoneyInput) {
    return this.violations.sendMoney(principal, id, body);
  }

  @Post('violations/:id/notes')
  @RequirePermission('safety.manage')
  violationNote(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(ViolationNoteSchema)) body: ViolationNoteInput) {
    return this.violations.addNote(principal, id, body);
  }

  @Post('violations/:id/void')
  @RequirePermission('safety.manage')
  voidViolation(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(VoidViolationSchema)) body: VoidViolationInput) {
    return this.violations.voidViolation(principal, id, body);
  }

  // ---------------------------------------------------------------------- roadside inspections

  @Get('roadside')
  @RequireAnyPermission(...INSPECTION_READERS)
  @Header('Cache-Control', 'private, no-store')
  listRoadside(@CurrentPrincipal() principal: Principal, @Query('includeVoided') includeVoided?: string) {
    return this.violations.listInspections(principal, { includeVoided: includeVoided === 'true' });
  }

  @Get('roadside/:id')
  @RequireAnyPermission(...INSPECTION_READERS)
  @Header('Cache-Control', 'private, no-store')
  roadside(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.violations.inspectionDetail(principal, id);
  }

  @Post('roadside')
  @RequirePermission('safety.manage')
  createRoadside(@CurrentPrincipal() principal: Principal, @Body(pipe.createRoadside) body: CreateRoadsideInspectionInput) {
    return this.violations.createInspection(principal, body);
  }

  @Patch('roadside/:id')
  @RequirePermission('safety.manage')
  updateRoadside(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.updateRoadside) body: UpdateRoadsideInspectionInput) {
    return this.violations.updateInspection(principal, id, body);
  }

  @Post('roadside/:id/stage')
  @RequirePermission('safety.manage')
  roadsideStage(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.roadsideStage) body: RoadsideStageInput) {
    return this.violations.setStage(principal, id, body);
  }

  @Post('roadside/:id/violations')
  @RequirePermission('safety.manage')
  roadsideViolation(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.roadsideViolation) body: RoadsideViolationInput) {
    return this.violations.addViolation(principal, id, body);
  }

  @Post('roadside/:id/work-order')
  @RequirePermission('safety.manage')
  roadsideWorkOrder(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.linkWorkOrder) body: LinkWorkOrderInput) {
    return this.violations.linkWorkOrder(principal, id, body);
  }

  @Post('roadside/:id/void')
  @RequirePermission('safety.manage')
  voidRoadside(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.void) body: VoidInput) {
    return this.violations.voidInspection(principal, id, body);
  }

  // ----------------------------------------------------------------------------------- reviews

  @Get('reviews')
  @RequirePermission('safety.view')
  @Header('Cache-Control', 'private, no-store')
  listReviews(@CurrentPrincipal() principal: Principal, @Query('kind') kind?: string, @Query('driverId') driverId?: string) {
    const k = (SAFETY_REVIEW_KINDS as readonly string[]).includes(kind ?? '') ? (kind as SafetyReviewKind) : undefined;
    return this.reviews.list(principal, { kind: k, driverId });
  }

  @Get('reviews/:id')
  @RequirePermission('safety.view')
  @Header('Cache-Control', 'private, no-store')
  review(@CurrentPrincipal() principal: Principal, @Param('id') id: string) {
    return this.reviews.detail(principal, id);
  }

  @Post('reviews')
  @RequirePermission('safety.manage')
  createReview(@CurrentPrincipal() principal: Principal, @Body(pipe.createReview) body: CreateSafetyReviewInput) {
    return this.reviews.create(principal, body);
  }

  @Patch('reviews/:id')
  @RequirePermission('safety.manage')
  updateReview(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.updateReview) body: UpdateSafetyReviewInput) {
    return this.reviews.update(principal, id, body);
  }

  @Post('reviews/:id/complete')
  @RequirePermission('safety.manage')
  completeReview(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.completeReview) body: CompleteSafetyReviewInput) {
    return this.reviews.complete(principal, id, body);
  }

  @Post('reviews/:id/void')
  @RequirePermission('safety.manage')
  voidReview(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.void) body: VoidInput) {
    return this.reviews.void(principal, id, body);
  }

  // -------------------------------------------------------------------------------- compliance

  @Get('compliance/drivers')
  @RequirePermission('safety.view', 'compliance.view')
  @Header('Cache-Control', 'private, no-store')
  complianceDrivers(@CurrentPrincipal() principal: Principal) {
    return this.compliance.drivers(principal);
  }

  @Get('compliance/vehicles')
  @RequireAnyPermission('compliance.view', ...INSPECTION_READERS)
  @Header('Cache-Control', 'private, no-store')
  complianceVehicles(@CurrentPrincipal() principal: Principal) {
    return this.compliance.vehicles(principal);
  }

  @Get('compliance/company')
  @RequirePermission('safety.view', 'compliance.view')
  @Header('Cache-Control', 'private, no-store')
  complianceCompany(@CurrentPrincipal() principal: Principal) {
    return this.compliance.company(principal);
  }

  @Get('compliance/testing')
  @RequirePermission('safety.view')
  @Header('Cache-Control', 'private, no-store')
  complianceTesting(@CurrentPrincipal() principal: Principal) {
    return this.compliance.testing(principal);
  }
}
