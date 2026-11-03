import {
  Body,
  Controller,
  Get,
  Header,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import {
  CreateDefectSchema,
  DispatchOverrideSchema,
  LockSchema,
  ptiWeekStartOf,
  ReceiptSchema,
  RequestPtiCorrectionSchema,
  ReviewSchema,
  type RequestPtiCorrectionInput,
  TransitionDefectSchema,
  UpdateDefectSchema,
  type CreateDefectInput,
  type DispatchOverrideInput,
  type DispatchOverrideResult,
  type PtiBoard,
  type PtiDefect,
  type PtiDefectState,
  type PtiInspection,
  type PtiUnitHistoryEntry,
  type PtiUnitIssues,
  type ReceiptInput,
  type ReviewInput,
  type TransitionDefectInput,
  type UpdateDefectInput,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { FeatureFlagGuard } from '../../common/flags/feature-flag.guard';
import { RequireFlag } from '../../common/flags/require-flag.decorator';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { PtiService } from './pti.service';

const pipe = {
  receipt: new ZodValidationPipe(ReceiptSchema),
  review: new ZodValidationPipe(ReviewSchema),
  lock: new ZodValidationPipe(LockSchema),
  createDefect: new ZodValidationPipe(CreateDefectSchema),
  updateDefect: new ZodValidationPipe(UpdateDefectSchema),
  transition: new ZodValidationPipe(TransitionDefectSchema),
  dispatchOverride: new ZodValidationPipe(DispatchOverrideSchema),
} as const;

/**
 * The weekly walk-around's API.
 *
 * Reads need `maintenance.view`. Writes need `maintenance.edit` or `safety.manage`, checked in
 * the service, because the shop and safety both work this board; verifying a repair needs
 * `safety.manage` alone. Every rule the board relies on is enforced here rather than in the
 * screen, so the same rule holds for a script with a session.
 */
@Controller('fleet/pti')
@RequireFlag('fleet_v2')
@UseGuards(FeatureFlagGuard, CompanyScopeGuard, PermissionGuard)
export class PtiController {
  constructor(private readonly pti: PtiService) {}

  /** The board for a week: every row, every open defect, every verdict, and counts that reconcile. */
  @Get('board')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  board(@CurrentPrincipal() principal: Principal, @Query('week') week?: string): Promise<PtiBoard> {
    const today = companyToday(principal);
    const weekStart =
      week && /^\d{4}-\d{2}-\d{2}$/.test(week) ? ptiWeekStartOf(week) : ptiWeekStartOf(today);
    return this.pti.board(principal, weekStart, today);
  }

  @Get('inspections/:id')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  inspection(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<PtiInspection> {
    return this.pti.inspection(principal, id);
  }

  @Post('inspections/:id/receipt')
  @RequirePermission('maintenance.view')
  receive(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.receipt) body: ReceiptInput,
  ): Promise<PtiInspection> {
    return this.pti.receive(principal, id, body, companyToday(principal));
  }

  @Post('inspections/:id/lock')
  @RequirePermission('maintenance.view')
  lock(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.lock) _body: unknown,
  ): Promise<PtiInspection> {
    void _body;
    return this.pti.lock(principal, id, true);
  }

  @Post('inspections/:id/unlock')
  @RequirePermission('maintenance.view')
  unlock(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
  ): Promise<PtiInspection> {
    return this.pti.lock(principal, id, false);
  }

  /** The drawer's save. A clean review changes no defect; an issue found creates one per card. */
  @Post('inspections/:id/review')
  @RequirePermission('maintenance.view')
  review(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.review) body: ReviewInput,
  ): Promise<{ inspection: PtiInspection; defects: PtiDefect[] }> {
    return this.pti.review(principal, id, body, companyToday(principal));
  }

  /**
   * Request correction (0081): send a walk-around the driver sent from the app back to them, with
   * a reason. The submission stays in the history; the driver is notified and may resubmit.
   */
  @Post('inspections/:id/request-correction')
  @RequirePermission('maintenance.view')
  requestCorrection(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RequestPtiCorrectionSchema)) body: RequestPtiCorrectionInput,
  ): Promise<PtiInspection> {
    return this.pti.requestCorrection(principal, id, body);
  }

  /** Who a defect can be given to. */
  @Get('assignees')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  assignees(
    @CurrentPrincipal() principal: Principal,
  ): Promise<{ id: string; name: string; roles: string[] }[]> {
    return this.pti.assignees(principal);
  }

  @Get('defects')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  defects(
    @CurrentPrincipal() principal: Principal,
    @Query('unitId') unitId?: string,
    @Query('state') state?: string,
    @Query('open') open?: string,
  ): Promise<PtiDefect[]> {
    return this.pti.listDefects(principal, {
      unitId: unitId || undefined,
      state: (state as PtiDefectState) || undefined,
      open: open === 'true',
    });
  }

  @Get('defects/:id')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  defect(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<PtiDefect> {
    return this.pti.defect(principal, id);
  }

  /**
   * The unit's verdict and the defects behind it, for the truck header, Truck Health and the
   * dispatch check. `trucks.view` rather than `maintenance.view`: a dispatcher has to see the hold
   * to be stopped by it.
   */
  /** The unit's last few weeks for the review's history card. */
  @Get('units/:unitId/inspections')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  unitHistory(
    @CurrentPrincipal() principal: Principal,
    @Param('unitId') unitId: string,
    @Query('weeks') weeks?: string,
  ): Promise<PtiUnitHistoryEntry[]> {
    return this.pti.unitHistory(principal, unitId, Math.min(12, Math.max(1, Number(weeks) || 4)));
  }

  /**
   * Every unit's PTI issues, keyed by unit id: the sign beside a unit's status on the Trucks list
   * and the dispatch board (owner, 2026-10-21). `trucks.view`, like the verdict: dispatch has to
   * see the problem to be warned by it.
   */
  @Get('unit-issues')
  @RequirePermission('trucks.view')
  @Header('Cache-Control', 'private, no-store')
  unitIssues(@CurrentPrincipal() principal: Principal): Promise<Record<string, PtiUnitIssues>> {
    return this.pti.unitIssues(principal);
  }

  @Get('units/:unitId/status')
  @RequirePermission('trucks.view')
  @Header('Cache-Control', 'private, no-store')
  unitStatus(@CurrentPrincipal() principal: Principal, @Param('unitId') unitId: string) {
    return this.pti.unitStatus(principal, unitId);
  }

  /** A load assigned over a hold: logged on the defects and in the audit trail, released nowhere. */
  @Post('units/:unitId/dispatch-override')
  @RequirePermission('trucks.view')
  dispatchOverride(
    @CurrentPrincipal() principal: Principal,
    @Param('unitId') unitId: string,
    @Body(pipe.dispatchOverride) body: DispatchOverrideInput,
  ): Promise<DispatchOverrideResult> {
    return this.pti.dispatchOverride(principal, unitId, body);
  }

  @Post('defects')
  @RequirePermission('maintenance.view')
  createDefect(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.createDefect) body: CreateDefectInput,
  ): Promise<PtiDefect> {
    return this.pti.createDefect(principal, body);
  }

  @Patch('defects/:id')
  @RequirePermission('maintenance.view')
  updateDefect(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.updateDefect) body: UpdateDefectInput,
  ): Promise<PtiDefect> {
    return this.pti.updateDefect(principal, id, body);
  }

  /** Moves a defect through its life. `verified` is the only transition that lifts a hold. */
  @Post('defects/:id/transition')
  @RequirePermission('maintenance.view')
  transition(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.transition) body: TransitionDefectInput,
  ): Promise<PtiDefect> {
    return this.pti.transition(principal, id, body);
  }

  /** A work order closed. Its defects move to awaiting-verify; nothing is released. */
  @Post('work-orders/:workOrderId/closed')
  @RequirePermission('maintenance.view')
  workOrderClosed(
    @CurrentPrincipal() principal: Principal,
    @Param('workOrderId') workOrderId: string,
  ): Promise<PtiDefect[]> {
    return this.pti.workOrderClosed(principal, workOrderId);
  }
}

/** Today in the company's timezone, which is the only day a due date is judged against. */
function companyToday(principal: Principal): string {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: principal.companyTimezone || 'America/New_York',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}
