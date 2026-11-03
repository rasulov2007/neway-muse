import { Body, Controller, Get, Header, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  CompletePmSchema,
  CorrectPmSchema,
  SchedulePmSchema,
  VoidPmCompletionSchema,
  type CompletePmInput,
  type CorrectPmInput,
  type PmBoard,
  type PmShop,
  CreatePmShopSchema,
  RenamePmShopSchema,
  type RenamePmShopInput,
  type CreatePmShopInput,
  type PmStatus,
  type PmUnitDetail,
  type SchedulePmInput,
  type VoidPmCompletionInput,
  type WorkOrder,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { FeatureFlagGuard } from '../../common/flags/feature-flag.guard';
import { RequireFlag } from '../../common/flags/require-flag.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { PmBoardService } from './pm-board.service';

const pipe = {
  schedule: new ZodValidationPipe(SchedulePmSchema),
  complete: new ZodValidationPipe(CompletePmSchema),
  correct: new ZodValidationPipe(CorrectPmSchema),
  void: new ZodValidationPipe(VoidPmCompletionSchema),
} as const;

/**
 * The Oil change / PM board (Phase 1C) and its two sheets (1D Schedule, 1E Record completion),
 * behind `pm_module`. Lives in the Fleet module because a completion closes a work order and the
 * walk-around defects on it, which is PTI's business.
 *
 * Reads take `maintenance.view`; the two writes take `maintenance.edit`. Money (last price,
 * average cost, estimated cost) is dropped from every answer unless the caller also holds
 * `maintenance_costs.view` - the service does that, not the screen.
 */
@Controller('fleet/pm')
@RequireFlag('pm_module')
@UseGuards(FeatureFlagGuard, CompanyScopeGuard, PermissionGuard)
export class PmBoardController {
  constructor(private readonly board: PmBoardService) {}

  @Get('board')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentPrincipal() principal: Principal): Promise<PmBoard> {
    return this.board.board(principal);
  }

  @Get('shops')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  shops(@CurrentPrincipal() principal: Principal): Promise<PmShop[]> {
    return this.board.shops(principal);
  }

  /** A shop added from the sheet itself (owner's ask, 2026-09-21): name, city and state. */
  @Post('shops')
  @RequirePermission('maintenance.edit')
  addShop(
    @CurrentPrincipal() principal: Principal,
    @Body(new ZodValidationPipe(CreatePmShopSchema)) body: CreatePmShopInput,
  ): Promise<PmShop> {
    return this.board.addShop(principal, body);
  }

  /** Names a shop that only had its address; its work orders follow (owner, 2026-10-19). */
  @Patch('shops/:id')
  @RequirePermission('maintenance.edit')
  renameShop(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(new ZodValidationPipe(RenamePmShopSchema)) body: RenamePmShopInput,
  ): Promise<PmShop[]> {
    return this.board.renameShop(principal, id, body);
  }

  @Get('units/:unitId')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  unit(
    @CurrentPrincipal() principal: Principal,
    @Param('unitId') unitId: string,
  ): Promise<PmUnitDetail> {
    return this.board.unitDetail(principal, unitId);
  }

  /** The ELD's reading nearest a moment, for the completion sheet's odometer line. */
  @Get('units/:unitId/reading-near')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  async readingNear(
    @CurrentPrincipal() principal: Principal,
    @Param('unitId') unitId: string,
    @Query('at') at?: string,
  ): Promise<{ odometerMiles: number; readingAt: string; source: string } | null> {
    const when = at ? new Date(at) : new Date();
    const found = await this.board.nearestReading(
      principal.companyId,
      unitId,
      Number.isNaN(when.getTime()) ? new Date() : when,
    );
    return found
      ? {
          odometerMiles: found.odometerMiles,
          readingAt: found.readingAt.toISOString(),
          source: found.source,
        }
      : null;
  }

  @Post('appointments')
  @RequirePermission('maintenance.edit')
  schedule(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.schedule) body: SchedulePmInput,
  ): Promise<WorkOrder> {
    return this.board.schedule(principal, body);
  }

  @Post('completions')
  @RequirePermission('maintenance.edit')
  complete(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.complete) body: CompletePmInput,
  ): Promise<{ workOrder: WorkOrder; status: PmStatus }> {
    return this.board.complete(principal, body);
  }

  @Post('completions/:id/correct')
  @RequirePermission('maintenance.edit')
  correct(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.correct) body: CorrectPmInput,
  ): Promise<PmStatus> {
    return this.board.correct(principal, id, body);
  }

  @Post('completions/:id/void')
  @RequirePermission('maintenance.edit')
  void(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.void) body: VoidPmCompletionInput,
  ): Promise<PmStatus> {
    return this.board.void(principal, id, body);
  }
}
