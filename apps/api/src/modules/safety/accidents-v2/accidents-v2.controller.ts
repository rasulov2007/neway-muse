import { Body, Controller, Get, Header, Headers, Param, Patch, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { accidentsV2 as A } from '@neway/shared';
import { AppError } from '../../../common/errors/app-error';
import { CompanyScopeGuard } from '../../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../../common/auth/permission.guard';
import type { Principal } from '../../../common/auth/principal';
import { RequireAnyPermission, RequirePermission } from '../../../common/auth/require-permission.decorator';
import { FeatureFlagGuard } from '../../../common/flags/feature-flag.guard';
import { RequireFlag } from '../../../common/flags/require-flag.decorator';
import { ZodValidationPipe } from '../../../common/validation/zod-validation.pipe';
import { AccidentsV2Service } from './accidents-v2.service';
import { EquipmentV2Service } from './equipment-v2.service';
import { InvestigationV2Service } from './investigation-v2.service';
import { AccidentSettingsService } from './settings-v2.service';
import { TasksV2Service } from './tasks-v2.service';
import { registerCsv } from './views';

const pipe = {
  board: new ZodValidationPipe(A.BoardQuerySchema),
  range: new ZodValidationPipe(A.RangeQuerySchema),
  report: new ZodValidationPipe(A.ReportSchema),
  preview: new ZodValidationPipe(A.ReportPreviewSchema),
  submit: new ZodValidationPipe(A.SubmitDraftSchema),
  patch: new ZodValidationPipe(A.PatchAccidentSchema),
  version: new ZodValidationPipe(A.VersionSchema),
  reason: new ZodValidationPipe(A.ReasonSchema),
  stage: new ZodValidationPipe(A.StageSchema),
  severity: new ZodValidationPipe(A.SeveritySchema),
  owner: new ZodValidationPipe(A.OwnerSchema),
  legalHold: new ZodValidationPipe(A.LegalHoldSchema),
  summary: new ZodValidationPipe(A.SummaryOverrideSchema),
  test: new ZodValidationPipe(A.TestRecordSchema),
  unit: new ZodValidationPipe(A.UnitPatchSchema),
  request: new ZodValidationPipe(A.RequestSchema),
  event: new ZodValidationPipe(A.LogEventSchema),
  taskList: new ZodValidationPipe(A.TaskListQuerySchema),
  settings: new ZodValidationPipe(A.AccidentSettingsSchema),
  createTask: new ZodValidationPipe(A.CreateTaskSchema),
  patchTask: new ZodValidationPipe(A.PatchTaskSchema),
  taskUpdate: new ZodValidationPipe(A.TaskUpdateSchema),
  confirm: new ZodValidationPipe(A.ConfirmRequestSchema),
  claimDecision: new ZodValidationPipe(A.ClaimDecisionSchema),
  createWo: new ZodValidationPipe(A.CreateCaseWorkOrderSchema),
  linkWo: new ZodValidationPipe(A.LinkWorkOrderSchema),
  estimate: new ZodValidationPipe(A.AddEstimateSchema),
  approve: new ZodValidationPipe(A.ApproveEstimateSchema),
  start: new ZodValidationPipe(A.StartRepairSchema),
  complete: new ZodValidationPipe(A.CompleteRepairSchema),
  verify: new ZodValidationPipe(A.VerifyDowntimeSchema),
  downtime: new ZodValidationPipe(A.PatchDowntimeSchema),
  bill: new ZodValidationPipe(A.CaseBillSchema),
  invAction: new ZodValidationPipe(A.InvestigationActionSchema),
  invPatch: new ZodValidationPipe(A.PatchInvestigationSchema),
  fact: new ZodValidationPipe(A.AddFactSchema),
  question: new ZodValidationPipe(A.AddQuestionSchema),
  resolve: new ZodValidationPipe(A.ResolveQuestionSchema),
  statement: new ZodValidationPipe(A.AddStatementSchema),
  factor: new ZodValidationPipe(A.AddFactorSchema),
  factorLevel: new ZodValidationPipe(A.FactorLevelSchema),
  reviewItem: new ZodValidationPipe(A.ReviewItemSchema),
  determination: new ZodValidationPipe(A.DeterminationSchema),
  vehicle: new ZodValidationPipe(A.AddVehicleSchema),
  witness: new ZodValidationPipe(A.AddWitnessSchema),
  createCa: new ZodValidationPipe(A.CreateCorrectiveActionSchema),
  patchCa: new ZodValidationPipe(A.PatchCorrectiveActionSchema),
  upload: new ZodValidationPipe(A.UploadEvidenceSchema),
  evVersion: new ZodValidationPipe(A.EvidenceVersionSchema),
  evRemove: new ZodValidationPipe(A.RemoveEvidenceSchema),
} as const;

/**
 * Accident & Claims v2, phase P1 (docs/accidents/API.md, adapted — see the P1 report in IMPLEMENTATION-PLAN.md).
 *
 * Behind `accidents_v2` (env ACCIDENTS_V2, default off → every route 404s). Served at /safety/accidents-v2 so the
 * Safety v2 endpoints at /safety/accidents keep working unchanged until the cutover.
 * Reads: accidents.view. Writes: accidents.edit (cargo fields also with accidents.edit_cargo). Restricted details,
 * stage override and Dispatch confirmation have their own codes, checked here and in the services.
 */
@Controller('safety/accidents-v2')
@RequireFlag('accidents_v2')
@UseGuards(FeatureFlagGuard, CompanyScopeGuard, PermissionGuard)
export class AccidentsV2Controller {
  constructor(
    private readonly accidents: AccidentsV2Service,
    private readonly tasks: TasksV2Service,
    private readonly equipment: EquipmentV2Service,
    private readonly inv: InvestigationV2Service,
    private readonly settings: AccidentSettingsService,
  ) {}

  // ------------------------------------------------------------------------------------------ board

  @Get()
  @RequirePermission('accidents.view')
  @Header('Cache-Control', 'private, no-store')
  board(@CurrentPrincipal() p: Principal, @Query(pipe.board) q: A.BoardQuery) {
    return this.accidents.board(p, q);
  }

  @Get('summary')
  @RequirePermission('accidents.view')
  @Header('Cache-Control', 'private, no-store')
  summary(@CurrentPrincipal() p: Principal, @Query(pipe.range) q: A.RangeQuery) {
    return this.accidents.summary(p, q);
  }

  @Get('analytics')
  @RequirePermission('accidents.view')
  @Header('Cache-Control', 'private, no-store')
  analytics(@CurrentPrincipal() p: Principal, @Query(pipe.range) q: A.RangeQuery) {
    return this.accidents.analytics(p, q);
  }

  @Get('counts')
  @RequirePermission('accidents.view')
  @Header('Cache-Control', 'private, no-store')
  counts(@CurrentPrincipal() p: Principal) {
    return this.accidents.counts(p);
  }

  /** Accidents settings (go-live §17 item 8): read by anyone who edits cases; saved by Safety Managers and the owner. */
  @Get('settings')
  @RequireAnyPermission('accidents.edit', 'accidents.override')
  @Header('Cache-Control', 'private, no-store')
  getSettings(@CurrentPrincipal() p: Principal) {
    return this.settings.get(p);
  }

  @Put('settings')
  @RequirePermission('accidents.override')
  putSettings(@CurrentPrincipal() p: Principal, @Body(pipe.settings) body: A.AccidentSettingsInput) {
    return this.settings.put(p, body);
  }

  @Get('profiles/:kind/:unitId')
  @RequirePermission('accidents.view')
  @Header('Cache-Control', 'private, no-store')
  profile(@CurrentPrincipal() p: Principal, @Param('kind') kind: string, @Param('unitId') unitId: string) {
    if (kind !== 'truck' && kind !== 'trailer' && kind !== 'driver') throw this.notFound();
    return this.accidents.profile(p, kind, unitId);
  }

  @Get('register')
  @RequirePermission('accidents.view')
  async register(@CurrentPrincipal() p: Principal, @Query(pipe.range) q: A.RangeQuery, @Query('format') format: string | undefined, @Res({ passthrough: true }) res: FastifyReply) {
    const rows = await this.accidents.register(p, q);
    if (format === 'csv') {
      res.header('Content-Type', 'text/csv; charset=utf-8');
      res.header('Content-Disposition', 'attachment; filename="dot-accident-register.csv"');
      return registerCsv(rows);
    }
    return rows;
  }

  // ----------------------------------------------------------------------------------------- report

  @Get('pickers')
  @RequirePermission('accidents.edit')
  pickers(@CurrentPrincipal() p: Principal) {
    return this.accidents.pickers(p);
  }

  @Get('assignment')
  @RequirePermission('accidents.edit')
  assignment(@CurrentPrincipal() p: Principal, @Query('truckId') truckId?: string, @Query('driverId') driverId?: string) {
    return this.accidents.assignment(p, { ...(truckId ? { truckId } : {}), ...(driverId ? { driverId } : {}) });
  }

  @Post('report-preview')
  @RequirePermission('accidents.edit')
  preview(@CurrentPrincipal() p: Principal, @Body(pipe.preview) body: A.ReportPreviewInput) {
    return this.accidents.preview(p, body);
  }

  @Post()
  @RequirePermission('accidents.edit')
  report(@CurrentPrincipal() p: Principal, @Body(pipe.report) body: A.ReportInput, @Headers('idempotency-key') key?: string) {
    return this.accidents.report(p, body, key?.trim() ? key.trim().slice(0, 120) : undefined);
  }

  // ------------------------------------------------------------------------------------------ tasks

  @Get('tasks')
  @RequirePermission('accidents.view')
  @Header('Cache-Control', 'private, no-store')
  listTasks(@CurrentPrincipal() p: Principal, @Query(pipe.taskList) q: A.TaskListQuery) {
    return this.tasks.list(p, q);
  }

  @Post('tasks')
  @RequirePermission('accidents.edit')
  createTask(@CurrentPrincipal() p: Principal, @Body(pipe.createTask) body: A.CreateTaskInput) {
    return this.tasks.create(p, body);
  }

  @Patch('tasks/:taskId')
  @RequirePermission('accidents.view')
  patchTask(@CurrentPrincipal() p: Principal, @Param('taskId') id: string, @Body(pipe.patchTask) body: A.PatchTaskInput) {
    return this.tasks.patch(p, id, body);
  }

  @Post('tasks/:taskId/updates')
  @RequirePermission('accidents.view')
  taskUpdate(@CurrentPrincipal() p: Principal, @Param('taskId') id: string, @Body(pipe.taskUpdate) body: A.TaskUpdateInput) {
    return this.tasks.addUpdate(p, id, body);
  }

  @Post('tasks/:taskId/confirm')
  @RequirePermission('accidents.confirm')
  confirm(@CurrentPrincipal() p: Principal, @Param('taskId') id: string, @Body(pipe.confirm) body: A.ConfirmRequestInput) {
    return this.tasks.confirm(p, id, body);
  }

  // ---------------------------------------------------------------------- equipment, downtime, money (P3)

  @Get('vendors')
  @RequireAnyPermission('accidents.edit', 'accidents.fleet', 'accidents.bills')
  vendors(@CurrentPrincipal() p: Principal) {
    return this.equipment.vendors(p);
  }

  @Get('work-orders/:woId/accident-link')
  @RequirePermission('accidents.view')
  @Header('Cache-Control', 'private, no-store')
  accidentLink(@CurrentPrincipal() p: Principal, @Param('woId') woId: string) {
    return this.equipment.accidentLink(p, woId);
  }

  @Post('work-orders/:woId/link-accident')
  @RequireAnyPermission('accidents.edit', 'accidents.fleet')
  linkWorkOrder(@CurrentPrincipal() p: Principal, @Param('woId') woId: string, @Body(pipe.linkWo) body: A.LinkWorkOrderInput) {
    return this.equipment.linkWorkOrder(p, woId, body);
  }

  @Post('work-orders/:woId/estimates')
  @RequirePermission('accidents.fleet')
  addEstimate(@CurrentPrincipal() p: Principal, @Param('woId') woId: string, @Body(pipe.estimate) body: A.AddEstimateInput) {
    return this.equipment.addEstimate(p, woId, body);
  }

  @Post('work-orders/:woId/approve')
  @RequirePermission('accidents.fleet')
  approve(@CurrentPrincipal() p: Principal, @Param('woId') woId: string, @Body(pipe.approve) body: A.ApproveEstimateInput) {
    return this.equipment.approve(p, woId, body);
  }

  @Post('work-orders/:woId/start')
  @RequirePermission('accidents.fleet')
  start(@CurrentPrincipal() p: Principal, @Param('woId') woId: string, @Body(pipe.start) body: A.StartRepairInput) {
    return this.equipment.start(p, woId, body);
  }

  @Post('work-orders/:woId/complete')
  @RequirePermission('accidents.fleet')
  complete(@CurrentPrincipal() p: Principal, @Param('woId') woId: string, @Body(pipe.complete) body: A.CompleteRepairInput) {
    return this.equipment.complete(p, woId, body);
  }

  @Post('downtime/:downtimeId/verify')
  @RequirePermission('accidents.fleet')
  verifyDowntime(@CurrentPrincipal() p: Principal, @Param('downtimeId') id: string, @Body(pipe.verify) body: A.VerifyDowntimeInput) {
    return this.equipment.verifyDowntime(p, id, body);
  }

  @Patch('downtime/:downtimeId')
  @RequirePermission('accidents.fleet')
  patchDowntime(@CurrentPrincipal() p: Principal, @Param('downtimeId') id: string, @Body(pipe.downtime) body: A.PatchDowntimeInput) {
    return this.equipment.patchDowntime(p, id, body);
  }

  @Post(':id/work-orders')
  @RequirePermission('accidents.fleet')
  createWorkOrder(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.createWo) body: A.CreateCaseWorkOrderInput) {
    return this.equipment.createWorkOrder(p, id, body).then((woId) => ({ id: woId }));
  }

  @Post(':id/ap-bills')
  @RequireAnyPermission('accidents.edit', 'accidents.bills')
  addBill(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.bill) body: A.CaseBillInput) {
    return this.equipment.addBill(p, id, body);
  }

  // ---------------------------------------------------------------- investigation, evidence, restricted (P4)

  @Patch('corrective-actions/:actionId')
  @RequirePermission('accidents.edit')
  patchCorrectiveAction(@CurrentPrincipal() p: Principal, @Param('actionId') actionId: string, @Body(pipe.patchCa) body: A.PatchCorrectiveActionInput) {
    return this.inv.patchCorrectiveAction(p, actionId, body);
  }

  @Post('evidence/:docId/versions')
  @RequireAnyPermission('accidents.edit', 'accidents.edit_units', 'accidents.bills', 'accidents.claim_money')
  evidenceVersion(@CurrentPrincipal() p: Principal, @Param('docId') docId: string, @Body(pipe.evVersion) body: A.EvidenceVersionInput) {
    return this.inv.newVersion(p, docId, body);
  }

  @Post('evidence/:docId/remove')
  @RequirePermission('accidents.edit')
  evidenceRemove(@CurrentPrincipal() p: Principal, @Param('docId') docId: string, @Body(pipe.evRemove) body: A.RemoveEvidenceInput) {
    return this.inv.remove(p, docId, body);
  }

  @Get('evidence/:docId/download')
  @RequirePermission('accidents.view')
  @Header('Cache-Control', 'private, no-store')
  evidenceDownload(@CurrentPrincipal() p: Principal, @Param('docId') docId: string, @Query('version') version?: string) {
    return this.inv.download(p, docId, version ? Number(version) : undefined);
  }

  @Get(':id/evidence')
  @RequirePermission('accidents.view')
  @Header('Cache-Control', 'private, no-store')
  evidenceList(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Query('includeRemoved') includeRemoved?: string) {
    return this.inv.evidence(p, id, includeRemoved === 'true');
  }

  @Post(':id/evidence')
  @RequireAnyPermission('accidents.edit', 'accidents.edit_units', 'accidents.bills', 'accidents.claim_money')
  evidenceUpload(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.upload) body: A.UploadEvidenceInput) {
    return this.inv.upload(p, id, body);
  }

  @Post(':id/investigation/:action')
  @RequireAnyPermission('accidents.edit', 'accidents.approve')
  investigation(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('action') action: string, @Body(pipe.invAction) body: A.InvestigationActionInput) {
    if (!['start', 'submit', 'approve', 'send-back', 'reopen'].includes(action)) throw this.notFound();
    return this.inv.action(p, id, action as 'start' | 'submit' | 'approve' | 'send-back' | 'reopen', body);
  }

  @Patch(':id/investigation')
  @RequirePermission('accidents.edit')
  patchInvestigation(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.invPatch) body: A.PatchInvestigationInput) {
    return this.inv.patch(p, id, body);
  }

  @Post(':id/facts')
  @RequirePermission('accidents.edit')
  addFact(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.fact) body: A.AddFactInput) {
    return this.inv.addFact(p, id, body);
  }

  @Post(':id/questions')
  @RequirePermission('accidents.edit')
  addQuestion(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.question) body: A.AddQuestionInput) {
    return this.inv.addQuestion(p, id, body);
  }

  @Post(':id/questions/:qid/resolve')
  @RequirePermission('accidents.edit')
  resolveQuestion(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('qid') qid: string, @Body(pipe.resolve) body: A.ResolveQuestionInput) {
    return this.inv.resolveQuestion(p, id, qid, body);
  }

  @Post(':id/statements')
  @RequirePermission('accidents.edit')
  addStatement(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.statement) body: A.AddStatementInput) {
    return this.inv.addStatement(p, id, body);
  }

  @Post(':id/factors')
  @RequirePermission('accidents.edit')
  addFactor(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.factor) body: A.AddFactorInput) {
    return this.inv.addFactor(p, id, body);
  }

  @Patch(':id/factors/:fid')
  @RequirePermission('accidents.edit')
  factorLevel(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('fid') fid: string, @Body(pipe.factorLevel) body: A.FactorLevelInput) {
    return this.inv.factorLevel(p, id, fid, body);
  }

  @Put(':id/review-items/:key')
  @RequirePermission('accidents.edit')
  reviewItem(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('key') key: string, @Body(pipe.reviewItem) body: A.ReviewItemInput) {
    return this.inv.reviewItem(p, id, key, body);
  }

  @Put(':id/determinations/:kind')
  @RequireAnyPermission('accidents.determine', 'accidents.legal')
  determination(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('kind') kind: string, @Body(pipe.determination) body: A.DeterminationInput) {
    if (!['fault', 'preventability', 'cpdp', 'legal'].includes(kind)) throw this.notFound();
    return this.inv.determination(p, id, kind as 'fault' | 'preventability' | 'cpdp' | 'legal', body);
  }

  @Post(':id/vehicles')
  @RequirePermission('accidents.edit')
  addVehicle(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.vehicle) body: A.AddVehicleInput) {
    return this.inv.addVehicle(p, id, body);
  }

  @Post(':id/witnesses')
  @RequirePermission('accidents.edit')
  addWitness(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.witness) body: A.AddWitnessInput) {
    return this.inv.addWitness(p, id, body);
  }

  @Post(':id/corrective-actions')
  @RequirePermission('accidents.edit')
  createCorrectiveAction(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.createCa) body: A.CreateCorrectiveActionInput) {
    return this.inv.createCorrectiveAction(p, id, body);
  }

  // ------------------------------------------------------------------------------------------- case

  @Get(':id')
  @RequirePermission('accidents.view')
  @Header('Cache-Control', 'private, no-store')
  detail(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.accidents.detail(p, id);
  }

  @Get(':id/events')
  @RequirePermission('accidents.view')
  @Header('Cache-Control', 'private, no-store')
  events(@CurrentPrincipal() p: Principal, @Param('id') id: string) {
    return this.accidents.events(p, id);
  }

  @Get(':id/tasks')
  @RequirePermission('accidents.view')
  @Header('Cache-Control', 'private, no-store')
  caseTasks(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Query('status') status?: 'open' | 'overdue' | 'done' | 'all') {
    return this.tasks.list(p, { accidentId: id, status: status ?? 'all' });
  }

  @Patch(':id')
  @RequireAnyPermission('accidents.edit', 'accidents.edit_cargo')
  patch(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.patch) body: A.PatchAccidentInput) {
    return this.accidents.patch(p, id, body);
  }

  @Post(':id/submit')
  @RequirePermission('accidents.edit')
  submit(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.submit) body: A.SubmitDraftInput) {
    return this.accidents.submit(p, id, body);
  }

  @Post(':id/discard')
  @RequirePermission('accidents.edit')
  discard(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.version) body: A.VersionInput) {
    return this.accidents.discard(p, id, body);
  }

  @Post(':id/stage')
  @RequirePermission('accidents.edit')
  stage(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.stage) body: A.StageInput) {
    return this.accidents.stage(p, id, body);
  }

  @Post(':id/reopen')
  @RequirePermission('accidents.edit')
  reopen(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.reason) body: A.ReasonInput) {
    return this.accidents.reopen(p, id, body);
  }

  @Post(':id/close-administratively')
  @RequirePermission('accidents.override')
  closeAdministratively(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.reason) body: A.ReasonInput) {
    return this.accidents.closeAdministratively(p, id, body);
  }

  @Post(':id/void')
  @RequirePermission('accidents.edit')
  void(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.reason) body: A.ReasonInput) {
    return this.accidents.void(p, id, body);
  }

  @Post(':id/severity')
  @RequirePermission('accidents.edit')
  severity(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.severity) body: A.SeverityInput) {
    return this.accidents.severity(p, id, body);
  }

  @Post(':id/owner')
  @RequirePermission('accidents.edit')
  owner(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.owner) body: A.OwnerInput) {
    return this.accidents.owner(p, id, body);
  }

  @Post(':id/legal-hold')
  @RequirePermission('accidents.override')
  legalHold(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.legalHold) body: A.LegalHoldInput) {
    return this.accidents.legalHold(p, id, body);
  }

  @Put(':id/summary-override')
  @RequirePermission('accidents.edit')
  summaryOverride(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.summary) body: A.SummaryOverrideInput) {
    return this.accidents.summaryOverride(p, id, body);
  }

  @Put(':id/claim-decision')
  @RequirePermission('accidents.edit')
  claimDecision(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.claimDecision) body: A.ClaimDecisionInput) {
    return this.accidents.claimDecision(p, id, body);
  }

  @Put(':id/tests/:substance')
  @RequirePermission('accidents.edit')
  test(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('substance') substance: string, @Body(pipe.test) body: A.TestRecordInput) {
    if (substance !== 'alcohol' && substance !== 'drug') throw this.notFound();
    return this.accidents.test(p, id, substance, body);
  }

  @Patch(':id/units/:unitId')
  @RequireAnyPermission('accidents.edit', 'accidents.edit_units')
  unit(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Param('unitId') unitId: string, @Body(pipe.unit) body: A.UnitPatchInput) {
    return this.accidents.unit(p, id, unitId, body);
  }

  @Post(':id/requests')
  @RequirePermission('accidents.edit')
  request(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.request) body: A.RequestInput) {
    return this.accidents.request(p, id, body);
  }

  @Post(':id/events')
  @RequirePermission('accidents.edit')
  logEvent(@CurrentPrincipal() p: Principal, @Param('id') id: string, @Body(pipe.event) body: A.LogEventInput) {
    return this.accidents.logEvent(p, id, body);
  }

  private notFound() {
    return new AppError({ status: 404, title: 'Not Found', detail: 'No such accident action.' });
  }
}
