import { UNIT_PICKER_PERMISSIONS } from '../roster/roster-access';
import { canSeparateTeams, SeparateDispatchersSchema, type AtHomeList, SeparateTeamSchema, type DispatchTeamMembers, type SeparateDispatchersInput, type SeparateTeamInput } from '@neway/shared';
import { Body, Controller, Get, Header, Param, Post, Put, Query, Res, UseGuards } from '@nestjs/common';
import type { FastifyReply } from 'fastify';
import { z } from 'zod';
import {
  comparePolicies,
  policyDifferences,
  AddRosterRowSchema,
  AssignDriverToTeamSchema,
  type AssignDriverToTeamInput,
  type OffBoardDriver,
  CommissionPolicySchema,
  PerformanceTargetsSchema,
  CreatePolicyVersionSchema,
  LinkRosterRowSchema,
  RosterImportApplySchema,
  SalaryRunActionSchema,
  UnassignRosterRowSchema,
  UpdateRosterRowSchema,
  WriteAllocationSchema,
  WriteBoardCellsSchema,
  WriteBoardFillSchema,
  WriteClaimSchema,
  WriteSalaryAdjustmentSchema,
  WriteWeekFlagsSchema,
  WriteWeekOverrideSchema,
  WriteTeamOrderSchema,
  type TeamOrderView,
  type WriteTeamOrderInput,
  type AddRosterRowInput,
  type BoardCell,
  type BoardEdit,
  type Claim,
  type CommissionPolicy,
  type PerformanceTargets,
  type CommissionView,
  type CreatePolicyVersionInput,
  type LinkRosterRowInput,
  type MergePreview,
  type DailyBoard,
  type PeriodKind,
  type PolicyVersion,
  type RosterImportApplyInput,
  type RosterImportReport,
  type RosterMatchReport,
  type RosterRow,
  type SalaryAdjustment,
  type SalaryReport,
  type SalaryRunActionInput,
  type UnassignRosterRowInput,
  type UpdateRosterRowInput,
  type WeeklyBoard,
  type WriteAllocationInput,
  type WriteBoardCellsInput,
  type WriteBoardFillInput,
  type WriteClaimInput,
  type WriteSalaryAdjustmentInput,
  type WriteWeekFlagsInput,
  type WriteWeekOverrideInput,
  type DispatcherRotationReport,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequireAnyPermission, RequirePermission } from '../../common/auth/require-permission.decorator';
import { PerformanceService } from './performance.service';
import { companyToday, forbidden, unprocessable } from './ops.helpers';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { ClaimsService } from './claims.service';
import { DispatchBoardService } from './dispatch-board.service';
import { PolicyService } from './policy.service';
import { RosterMatchService } from './roster-match.service';
import { RosterService } from './roster.service';
import { SalaryService } from './salary.service';
import { TeamOrderService } from './team-order.service';

const ReasonSchema = z.object({ reason: z.string().trim().min(3).max(500), expectedVersion: z.number().int().optional() });
/** Activating a draft names the date it takes effect and why; earlier weeks keep their version. */
const ActivateDraftSchema = z.object({ effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), note: z.string().trim().min(3).max(500) });
const RestoreSchema = z.object({ expectedVersion: z.number().int() });

const pipe = {
  cells: new ZodValidationPipe(WriteBoardCellsSchema),
  fills: new ZodValidationPipe(WriteBoardFillSchema),
  override: new ZodValidationPipe(WriteWeekOverrideSchema),
  flags: new ZodValidationPipe(WriteWeekFlagsSchema),
  addRow: new ZodValidationPipe(AddRosterRowSchema),
  updateRow: new ZodValidationPipe(UpdateRosterRowSchema),
  unassign: new ZodValidationPipe(UnassignRosterRowSchema),
  restore: new ZodValidationPipe(RestoreSchema),
  importCsv: new ZodValidationPipe(RosterImportApplySchema),
  policy: new ZodValidationPipe(CreatePolicyVersionSchema),
  activateDraft: new ZodValidationPipe(ActivateDraftSchema),
  policyBody: new ZodValidationPipe(CommissionPolicySchema),
  performanceTargets: new ZodValidationPipe(PerformanceTargetsSchema),
  runAction: new ZodValidationPipe(SalaryRunActionSchema),
  adjustment: new ZodValidationPipe(WriteSalaryAdjustmentSchema),
  allocation: new ZodValidationPipe(WriteAllocationSchema),
  reason: new ZodValidationPipe(ReasonSchema),
  claim: new ZodValidationPipe(WriteClaimSchema),
} as const;

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const KINDS = new Set<PeriodKind>(['week', 'pay_period', 'month']);

/** Today on the company's clock, not UTC's: at 9pm Eastern, UTC is already tomorrow. */
function today(principal: Principal): string {
  return companyToday(principal, new Date());
}

/**
 * The dispatch boards and everything around them. Reads take dispatch.view; board cells and
 * fills take dispatch.edit; the roster, the rules, manual commission, salary and claims take
 * dispatch.manage. Every write is checked again inside the service, never only here.
 */
@Controller('dispatch')
@UseGuards(CompanyScopeGuard, PermissionGuard)
export class DispatchBoardController {
  constructor(
    private readonly board: DispatchBoardService,
    private readonly roster: RosterService,
    private readonly rosterMatchService: RosterMatchService,
    private readonly policies: PolicyService,
    private readonly salary: SalaryService,
    private readonly performanceBoard: PerformanceService,
    private readonly claims: ClaimsService,
    private readonly teamOrder: TeamOrderService,
  ) {}

  // ------------------------------------------------------------------------------ boards

  /**
   * The units whose driver is HOME or on VACATION on today's Daily board (owner, 2026-10-28): the
   * Trucks page counts them under Assigned and marks them beside the status. Open to whoever reads
   * the unit lists; it carries the unit, the word and the driver's name, nothing else.
   */
  @Get('board/units-off')
  @RequireAnyPermission(...UNIT_PICKER_PERMISSIONS, 'board_daily.view')
  @Header('Cache-Control', 'private, no-store')
  async unitsOff(@CurrentPrincipal() principal: Principal): Promise<{ day: string; units: Array<{ truckUnit: string; status: 'HOME' | 'VACATION'; driverName: string }> }> {
    const day = today(principal);
    const board = await this.board.daily(principal, day);
    const units = board.rows
      .filter((r) => r.truckUnit && (r.status === 'HOME' || r.status === 'VACATION'))
      .map((r) => ({ truckUnit: String(r.truckUnit).trim(), status: r.status as 'HOME' | 'VACATION', driverName: r.driverName }));
    return { day, units };
  }

  /** Drivers HOME on today's Daily board, with the day the run began (owner, 2026-10-30). */
  @Get('board/at-home')
  @RequireAnyPermission('dispatch.view', 'board_daily.view')
  @Header('Cache-Control', 'private, no-store')
  atHome(@CurrentPrincipal() principal: Principal): Promise<AtHomeList> {
    return this.board.atHome(principal);
  }

  /** The trailer a driver is on per today's Daily board, for Add load's driver pick (owner, 2026-10-29). */
  @Get('board/driver-trailer')
  @RequireAnyPermission(...UNIT_PICKER_PERMISSIONS, 'board_daily.view')
  @Header('Cache-Control', 'private, no-store')
  driverTrailer(@CurrentPrincipal() principal: Principal, @Query('driverId') driverId?: string): Promise<{ trailerId: string | null; trailerUnit: string | null }> {
    if (!driverId) throw unprocessable('Name the driver.');
    return this.board.driverTrailer(principal, driverId);
  }

  @Get('board/daily')
  @RequireAnyPermission('dispatch.view', 'board_daily.view')
  @Header('Cache-Control', 'private, no-store')
  daily(@CurrentPrincipal() principal: Principal, @Query('day') day?: string): Promise<DailyBoard> {
    return this.board.daily(principal, day && DAY.test(day) ? day : today(principal));
  }

  @Get('board/weekly')
  // The Weekly Report reads this week (owner, 2026-10-26: Accounting reads it with dispatch_pay.view).
  @RequireAnyPermission('dispatch.view', 'board_weekly.view', 'dispatch_pay.view')
  @Header('Cache-Control', 'private, no-store')
  weekly(@CurrentPrincipal() principal: Principal, @Query('week') week?: string): Promise<WeeklyBoard> {
    return this.board.weekly(principal, week && DAY.test(week) ? week : today(principal));
  }

  /** The board order of the teams and their TEAM n badges (owner, 2026-10-26). */
  @Get('board/team-order')
  @RequireAnyPermission('dispatch.view', 'board_daily.view', 'board_weekly.view')
  @Header('Cache-Control', 'private, no-store')
  teamOrderView(@CurrentPrincipal() principal: Principal): Promise<TeamOrderView> {
    return this.teamOrder.view(principal);
  }

  @Put('board/team-order')
  @RequirePermission('dispatch.manage')
  saveTeamOrder(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(WriteTeamOrderSchema)) body: WriteTeamOrderInput): Promise<TeamOrderView> {
    return this.teamOrder.save(principal, body);
  }

  @Get('board/history')
  @RequireAnyPermission('dispatch.view', 'board_daily.view', 'board_weekly.view')
  @Header('Cache-Control', 'private, no-store')
  history(@CurrentPrincipal() principal: Principal, @Query('driverId') driverId: string): Promise<BoardEdit[]> {
    return this.board.history(principal, driverId ?? '');
  }

  @Put('board/cells')
  @RequirePermission('dispatch.edit')
  cells(@CurrentPrincipal() principal: Principal, @Body(pipe.cells) body: WriteBoardCellsInput): Promise<BoardCell[]> {
    return this.board.writeCells(principal, body);
  }

  @Put('board/fills')
  @RequirePermission('dispatch.edit')
  fills(@CurrentPrincipal() principal: Principal, @Body(pipe.fills) body: WriteBoardFillInput): Promise<{ written: number }> {
    return this.board.writeFills(principal, body);
  }

  @Put('board/commission/override')
  @RequirePermission('dispatch_pay.edit')
  override(@CurrentPrincipal() principal: Principal, @Body(pipe.override) body: WriteWeekOverrideInput): Promise<CommissionView | null> {
    return this.board.writeOverride(principal, body);
  }

  @Put('board/commission/flags')
  @RequirePermission('dispatch_pay.edit')
  flags(@CurrentPrincipal() principal: Principal, @Body(pipe.flags) body: WriteWeekFlagsInput): Promise<CommissionView | null> {
    return this.board.writeFlags(principal, body);
  }

  // ------------------------------------------------------------------------------ roster

  /**
   * The board rows that carry no driver file, each with the driver files they might be about.
   * A suggestion only: nothing here is applied until one is confirmed below.
   */
  @Get('roster/match')
  @RequirePermission('dispatch.manage')
  @Header('Cache-Control', 'private, no-store')
  rosterMatch(@CurrentPrincipal() principal: Principal): Promise<RosterMatchReport> {
    return this.rosterMatchService.report(principal);
  }

  /** The two rows side by side, what moves, and every disagreement. Read-only. */
  @Get('roster/:id/merge-preview')
  @RequirePermission('dispatch.manage')
  @Header('Cache-Control', 'private, no-store')
  rosterMergePreview(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Query('driverId') driverId: string,
  ): Promise<MergePreview> {
    return this.rosterMatchService.preview(principal, id, driverId ?? '');
  }

  /** Confirm one match. Merges two board rows when the driver already has one. */
  @Post('roster/:id/link')
  @RequirePermission('dispatch.manage')
  rosterLink(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(LinkRosterRowSchema)) body: LinkRosterRowInput,
  ): Promise<{ survivingRowId: string; movedCells: number; retiredRowId: string | null }> {
    return this.rosterMatchService.link(principal, id, body);
  }

  /** Dispatcher rotation: joined / left per dispatcher between two dates (owner, 2026-10-16). */
  @Get('rotation')
  @RequirePermission('dispatch.manage')
  @Header('Cache-Control', 'private, no-store')
  rotation(@CurrentPrincipal() principal: Principal, @Query('from') from: string, @Query('to') to: string): Promise<DispatcherRotationReport> {
    const day = /^\d{4}-\d{2}-\d{2}$/;
    if (!day.test(from ?? '') || !day.test(to ?? '') || from > to) throw unprocessable('Give from and to as YYYY-MM-DD, from on or before to.');
    return this.roster.rotation(principal, from, to);
  }

  @Get('roster')
  @RequirePermission('dispatch.view')
  @Header('Cache-Control', 'private, no-store')
  rosterList(@CurrentPrincipal() principal: Principal): Promise<RosterRow[]> {
    return this.roster.rows(principal.companyId);
  }

  /** Drivers not on the boards today: driver files without a board row and removed rows (owner, 2026-10-26). */
  @Get('roster/off-board')
  @RequirePermission('dispatch.manage')
  @Header('Cache-Control', 'private, no-store')
  rosterOffBoard(@CurrentPrincipal() principal: Principal): Promise<OffBoardDriver[]> {
    return this.roster.offBoard(principal);
  }

  /** Assign a driver to a dispatcher: creates, restores or moves his board row (owner, 2026-10-26). */
  @Post('roster/assign')
  @RequirePermission('dispatch.manage')
  rosterAssign(@CurrentPrincipal() principal: Principal, @Body(new ZodValidationPipe(AssignDriverToTeamSchema)) body: AssignDriverToTeamInput): Promise<RosterRow> {
    return this.roster.assignToTeam(principal, body);
  }

  @Post('roster')
  @RequirePermission('dispatch.manage')
  rosterAdd(@CurrentPrincipal() principal: Principal, @Body(pipe.addRow) body: AddRosterRowInput): Promise<RosterRow> {
    return this.roster.add(principal, body);
  }

  @Put('roster/:id')
  @RequirePermission('dispatch.manage')
  rosterUpdate(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.updateRow) body: UpdateRosterRowInput): Promise<RosterRow> {
    return this.roster.update(principal, id, body);
  }

  @Post('roster/:id/unassign')
  @RequirePermission('dispatch.manage')
  rosterUnassign(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.unassign) body: UnassignRosterRowInput): Promise<RosterRow> {
    return this.roster.unassign(principal, id, body);
  }

  /** The old Unassign: the row leaves every board from that date (hidden, reversible with Restore). */
  @Post('roster/:id/remove-from-board')
  @RequirePermission('dispatch.manage')
  rosterRemoveFromBoard(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.unassign) body: UnassignRosterRowInput): Promise<RosterRow> {
    return this.roster.removeFromBoard(principal, id, body);
  }

  /** Separate team (owner, 2026-10-28): who stays, solo from which week, why, and the return day. */
  @Post('roster/:id/separate')
  @RequireAnyPermission('dispatch.manage', 'dispatch_pay.edit')
  rosterSeparate(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(SeparateTeamSchema)) body: SeparateTeamInput): Promise<RosterRow> {
    // Administrators and dispatch managers only (owner, 2026-10-29).
    if (!canSeparateTeams(principal.roles)) throw forbidden('Only an administrator or a dispatch manager can separate a team.');
    return this.roster.separateTeam(principal, id, body);
  }

  @Post('roster/:id/restore')
  @RequirePermission('dispatch.manage')
  rosterRestore(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.restore) body: { expectedVersion: number }): Promise<RosterRow> {
    return this.roster.restore(principal, id, body.expectedVersion);
  }

  @Post('roster/import')
  @RequirePermission('dispatch.manage')
  rosterImport(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.importCsv) body: RosterImportApplyInput,
    @Query('dryRun') dryRun?: string,
  ): Promise<RosterImportReport> {
    return this.roster.importCsv(principal, body.csv, dryRun !== 'false');
  }

  // ------------------------------------------------------------------- dispatcher performance

  /*
   * The scoreboard is for the people on it: anyone who dispatches sees where they stand. The
   * targets behind it are a management setting, so changing them takes `dispatch.manage`.
   */
  @Get('performance')
  @RequireAnyPermission('dispatch.view', 'board_performance.view')
  @Header('Cache-Control', 'private, no-store')
  performance(
    @CurrentPrincipal() principal: Principal,
    @Query('kind') kind?: string,
    @Query('date') date?: string,
  ) {
    return this.performanceBoard.board(principal, this.kind(kind), date && DAY.test(date) ? date : today(principal));
  }

  @Get('performance/targets')
  @RequireAnyPermission('dispatch.view', 'board_performance.view')
  performanceTargets(@CurrentPrincipal() principal: Principal) {
    return this.performanceBoard.targets(principal.companyId);
  }

  @Post('performance/targets')
  @RequirePermission('dispatch_pay.edit')
  savePerformanceTargets(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.performanceTargets) body: PerformanceTargets,
  ) {
    return this.performanceBoard.saveTargets(principal.companyId, body);
  }

  // ------------------------------------------------------------------------------ policy

  @Get('policy')
  @RequirePermission('dispatch_pay.view')
  @Header('Cache-Control', 'private, no-store')
  async policy(@CurrentPrincipal() principal: Principal, @Query('date') date?: string): Promise<{ current: PolicyVersion; versions: PolicyVersion[] }> {
    const [current, versions] = await Promise.all([
      this.policies.inForce(principal.companyId, date && DAY.test(date) ? date : today(principal)),
      this.policies.list(principal.companyId),
    ]);
    return { current, versions };
  }

  @Post('policy/preview')
  @RequirePermission('dispatch_pay.view')
  policyPreview(@Body(pipe.policyBody) body: CommissionPolicy) {
    return { problems: this.policies.validate(body), rows: this.policies.preview(body) };
  }

  /**
   * The drafts on file beside the version in force, and what each one changes.
   *
   * A draft never prices a week. This is the screen an administrator reads before deciding, so it
   * is open to anyone who may see dispatcher pay, and the write below is not.
   */
  @Get('policy/drafts')
  @RequirePermission('dispatch_pay.view')
  @Header('Cache-Control', 'private, no-store')
  async policyDrafts(@CurrentPrincipal() principal: Principal) {
    const [active, drafts] = await Promise.all([
      this.policies.inForce(principal.companyId, today(principal)),
      this.policies.drafts(principal.companyId),
    ]);
    return {
      active: { version: active.version, effectiveFrom: active.effectiveFrom, note: active.note },
      drafts: drafts.map((d) => ({
        version: d.version,
        effectiveFrom: d.effectiveFrom,
        note: d.note,
        createdByName: d.createdByName,
        createdAt: d.createdAt,
        differences: policyDifferences(active.policy, d.policy),
        comparison: comparePolicies(active.policy, d.policy),
      })),
    };
  }

  /** Activates a draft from a date forward. Weeks already priced keep the version they used. */
  @Post('policy/drafts/:version/activate')
  @RequirePermission('dispatch_pay.edit')
  activateDraft(
    @CurrentPrincipal() principal: Principal,
    @Param('version') version: string,
    @Body(pipe.activateDraft) body: z.infer<typeof ActivateDraftSchema>,
  ) {
    return this.policies.activateDraft(principal, version, body);
  }

  @Post('policy')
  @RequirePermission('dispatch_pay.edit')
  policyCreate(@CurrentPrincipal() principal: Principal, @Body(pipe.policy) body: CreatePolicyVersionInput): Promise<PolicyVersion> {
    return this.policies.create(principal, body);
  }

  // ------------------------------------------------------------------------------ salary

  private kind(raw?: string): PeriodKind {
    return raw && KINDS.has(raw as PeriodKind) ? (raw as PeriodKind) : 'pay_period';
  }

  @Get('salary')
  @RequirePermission('dispatch_pay.view')
  @Header('Cache-Control', 'private, no-store')
  salaryReport(@CurrentPrincipal() principal: Principal, @Query('kind') kind?: string, @Query('date') date?: string): Promise<SalaryReport> {
    return this.salary.report(principal, this.kind(kind), date && DAY.test(date) ? date : today(principal));
  }

  @Post('salary/run')
  @RequirePermission('dispatch_pay.edit')
  salaryRun(
    @CurrentPrincipal() principal: Principal,
    @Query('kind') kind: string | undefined,
    @Query('date') date: string | undefined,
    @Body(pipe.runAction) body: SalaryRunActionInput,
  ): Promise<SalaryReport> {
    return this.salary.act(principal, this.kind(kind), date && DAY.test(date) ? date : today(principal), body);
  }

  @Get('salary/export.xlsx')
  @RequirePermission('dispatch_pay.view')
  async salaryXlsx(@CurrentPrincipal() principal: Principal, @Query('kind') kind: string | undefined, @Query('date') date: string | undefined, @Res() reply: FastifyReply) {
    const { file, name } = await this.salary.exportXlsx(principal, this.kind(kind), date && DAY.test(date) ? date : today(principal));
    await reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'private, no-store')
      .send(file);
  }

  @Get('salary/export.csv')
  @RequirePermission('dispatch_pay.view')
  async salaryCsv(@CurrentPrincipal() principal: Principal, @Query('kind') kind: string | undefined, @Query('date') date: string | undefined, @Res() reply: FastifyReply) {
    const { file, name } = await this.salary.exportCsv(principal, this.kind(kind), date && DAY.test(date) ? date : today(principal));
    await reply
      .header('content-type', 'text/csv; charset=utf-8')
      .header('content-disposition', `attachment; filename="${name}"`)
      .header('cache-control', 'private, no-store')
      .send(file);
  }

  @Post('salary/adjustments')
  @RequirePermission('dispatch_pay.edit')
  addAdjustment(@CurrentPrincipal() principal: Principal, @Body(pipe.adjustment) body: WriteSalaryAdjustmentInput): Promise<SalaryAdjustment> {
    return this.salary.addAdjustment(principal, body);
  }

  @Post('salary/adjustments/:id/void')
  @RequirePermission('dispatch_pay.edit')
  voidAdjustment(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.reason) body: { reason: string }): Promise<SalaryAdjustment> {
    return this.salary.voidAdjustment(principal, id, body.reason);
  }

  /** The dispatchers behind a team, for Separate dispatchers (owner, 2026-10-28). */
  @Get('teams/:dispatcherId/members')
  @RequirePermission('dispatch.manage')
  @Header('Cache-Control', 'private, no-store')
  teamMembers(@CurrentPrincipal() principal: Principal, @Param('dispatcherId') dispatcherId: string): Promise<DispatchTeamMembers> {
    return this.salary.teamMembers(principal, dispatcherId);
  }

  /** Separate dispatchers: the one who stays is paid 100 % from that week; equal again from the return day. */
  @Post('teams/:dispatcherId/separate')
  @RequireAnyPermission('dispatch.manage', 'dispatch_pay.edit')
  separateDispatchers(@CurrentPrincipal() principal: Principal, @Param('dispatcherId') dispatcherId: string, @Body(new ZodValidationPipe(SeparateDispatchersSchema)) body: SeparateDispatchersInput): Promise<DispatchTeamMembers> {
    // Administrators and dispatch managers only (owner, 2026-10-29).
    if (!canSeparateTeams(principal.roles)) throw forbidden('Only an administrator or a dispatch manager can separate dispatchers.');
    return this.salary.separateDispatchers(principal, dispatcherId, body);
  }

  @Get('salary/allocations')
  @RequirePermission('dispatch_pay.view')
  @Header('Cache-Control', 'private, no-store')
  allocations(@CurrentPrincipal() principal: Principal) {
    return this.salary.allocations(principal);
  }

  @Post('salary/allocations')
  @RequirePermission('dispatch_pay.edit')
  writeAllocation(@CurrentPrincipal() principal: Principal, @Body(pipe.allocation) body: WriteAllocationInput) {
    return this.salary.writeAllocation(principal, body);
  }

  // ------------------------------------------------------------------------------ claims

  @Get('claims')
  @RequireAnyPermission('dispatch.view', 'board_claims.view')
  @Header('Cache-Control', 'private, no-store')
  claimsList(@CurrentPrincipal() principal: Principal): Promise<Claim[]> {
    return this.claims.list(principal);
  }

  @Post('claims')
  @RequirePermission('dispatch.manage')
  claimCreate(@CurrentPrincipal() principal: Principal, @Body(pipe.claim) body: WriteClaimInput): Promise<Claim> {
    return this.claims.write(principal, null, body);
  }

  @Put('claims/:id')
  @RequirePermission('dispatch.manage')
  claimUpdate(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.claim) body: WriteClaimInput): Promise<Claim> {
    return this.claims.write(principal, id, body);
  }

  @Post('claims/:id/void')
  @RequirePermission('dispatch.manage')
  claimVoid(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(pipe.reason) body: { reason: string; expectedVersion?: number }): Promise<Claim> {
    return this.claims.void(principal, id, body.reason, body.expectedVersion ?? -1);
  }
}
