import { Body, Controller, Get, Header, Param, Post, Query, UseGuards } from '@nestjs/common';
import {
  CreateReadingSchema,
  SetPmPlanSchema,
  SetUnitGroupSchema,
  VoidPmPlanSchema,
  type CreateReadingInput,
  type OdometerReading,
  type PmPlan,
  type PmService as PmServiceRecord,
  type PmStatus,
  type SetPmPlanInput,
  type SetUnitGroupInput,
  type VoidPmPlanInput,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { FeatureFlagGuard } from '../../common/flags/feature-flag.guard';
import { RequireFlag } from '../../common/flags/require-flag.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { PmService } from './pm.service';

const pipe = {
  setPlan: new ZodValidationPipe(SetPmPlanSchema),
  voidPlan: new ZodValidationPipe(VoidPmPlanSchema),
  unitGroup: new ZodValidationPipe(SetUnitGroupSchema),
  reading: new ZodValidationPipe(CreateReadingSchema),
} as const;

/**
 * Oil change / PM (Phase 1A): the engine's API, behind `pm_module`.
 *
 * Reads take `maintenance.view`. Writes are checked in the service, where the spec's permission
 * table lives (§9): a group default is a fleet manager's; a unit interval or a manual reading is
 * the coordinator's or the shop's. No screen yet - the board is Phase 1C - but everything the
 * board will show is readable here, and `status/:unitId` is what the CLI prints.
 */
@Controller('fleet/pm')
@RequireFlag('pm_module')
@UseGuards(FeatureFlagGuard, CompanyScopeGuard, PermissionGuard)
export class PmController {
  constructor(private readonly pm: PmService) {}

  @Get('services')
  @RequirePermission('maintenance.view')
  services(@CurrentPrincipal() principal: Principal): Promise<PmServiceRecord[]> {
    return this.pm.services(principal);
  }

  @Get('status')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  statuses(@CurrentPrincipal() principal: Principal): Promise<PmStatus[]> {
    return this.pm.statuses(principal);
  }

  @Get('status/:unitId')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  status(
    @CurrentPrincipal() principal: Principal,
    @Param('unitId') unitId: string,
  ): Promise<PmStatus> {
    return this.pm.status(principal, unitId);
  }

  /** C9: the data-health numbers behind "No usable reading". */
  @Get('coverage')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  coverage(@CurrentPrincipal() principal: Principal) {
    return this.pm.coverage(principal);
  }

  @Get('plans')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  plans(
    @CurrentPrincipal() principal: Principal,
    @Query('unitId') unitId?: string,
    @Query('includeVoided') includeVoided?: string,
  ): Promise<PmPlan[]> {
    return this.pm.plans(principal, {
      unitId: unitId || undefined,
      includeVoided: includeVoided === 'true',
    });
  }

  @Post('plans')
  @RequirePermission('maintenance.view')
  setPlan(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.setPlan) body: SetPmPlanInput,
  ): Promise<PmPlan> {
    return this.pm.setPlan(principal, body);
  }

  @Post('plans/:id/void')
  @RequirePermission('maintenance.view')
  voidPlan(
    @CurrentPrincipal() principal: Principal,
    @Param('id') id: string,
    @Body(pipe.voidPlan) body: VoidPmPlanInput,
  ): Promise<PmPlan> {
    return this.pm.voidPlan(principal, id, body);
  }

  /** A unit's truck type (its PM group); the interval follows the type. */
  @Post('units/:unitId/group')
  @RequirePermission('maintenance.view')
  setUnitGroup(
    @CurrentPrincipal() principal: Principal,
    @Param('unitId') unitId: string,
    @Body(pipe.unitGroup) body: SetUnitGroupInput,
  ): Promise<{ unitId: string; groupName: string | null }> {
    return this.pm.setUnitGroup(principal, unitId, body);
  }

  @Get('readings')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  readings(
    @CurrentPrincipal() principal: Principal,
    @Query('unitId') unitId: string,
    @Query('limit') limit?: string,
  ): Promise<OdometerReading[]> {
    return this.pm.readings(
      principal,
      unitId,
      limit ? Math.min(200, Math.max(1, Number(limit) || 20)) : 20,
    );
  }

  @Get('readings/conflicts')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  conflicts(@CurrentPrincipal() principal: Principal): Promise<OdometerReading[]> {
    return this.pm.conflicts(principal);
  }

  @Post('readings')
  @RequirePermission('maintenance.view')
  addReading(
    @CurrentPrincipal() principal: Principal,
    @Body(pipe.reading) body: CreateReadingInput,
  ): Promise<OdometerReading> {
    return this.pm.addReading(principal, body);
  }

  /** Recomputes every unit's verdict now, as the nightly job would. */
  @Post('recompute')
  @RequirePermission('maintenance.edit')
  recompute(@CurrentPrincipal() principal: Principal): Promise<{ computed: number }> {
    return this.pm.recompute(principal.companyId);
  }
}
