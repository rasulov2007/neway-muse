import { Body, Controller, Get, Header, Param, Patch, Post, Query, UseGuards } from '@nestjs/common';
import {
  BreakdownAssignSchema,
  BreakdownNoteSchema,
  BreakdownShopSchema,
  BreakdownStatusSchema,
  BreakdownWorkOrderSchema,
  type BreakdownAssignInput,
  type BreakdownNoteInput,
  type BreakdownShopInput,
  type BreakdownStatusInput,
  type BreakdownWorkOrderInput,
  type FleetBreakdown,
  type FleetBreakdownList,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { FeatureFlagGuard } from '../../common/flags/feature-flag.guard';
import { RequireFlag } from '../../common/flags/require-flag.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { BreakdownsService } from './breakdowns.service';

/**
 * Fleet → Breakdowns (mobile M3, API.md §7): the cases drivers report from the road, worked by
 * Fleet. Reads need maintenance.view, every action maintenance.edit; behind `fleet_v2` like the
 * rest of the new Fleet. Each action is version-checked (a stale save is a 409) and audited.
 */
@Controller('fleet/breakdowns')
@RequireFlag('fleet_v2')
@UseGuards(FeatureFlagGuard, CompanyScopeGuard, PermissionGuard)
export class FleetBreakdownsController {
  constructor(private readonly breakdowns: BreakdownsService) {}

  @Get()
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  list(@CurrentPrincipal() principal: Principal, @Query('status') status?: string, @Query('open') open?: string): Promise<FleetBreakdownList> {
    return this.breakdowns.list(principal, { status: status || undefined, open: open === 'true' || open === '1' });
  }

  /** The vendors a shop can be arranged with. */
  @Get('shops')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  shops(@CurrentPrincipal() principal: Principal) {
    return this.breakdowns.shops(principal);
  }

  /** The Fleet people a case can be assigned to. */
  @Get('people')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  people(@CurrentPrincipal() principal: Principal) {
    return this.breakdowns.people(principal);
  }

  @Get(':id')
  @RequirePermission('maintenance.view')
  @Header('Cache-Control', 'private, no-store')
  detail(@CurrentPrincipal() principal: Principal, @Param('id') id: string): Promise<FleetBreakdown> {
    return this.breakdowns.detail(principal, id);
  }

  @Post(':id/assign')
  @RequirePermission('maintenance.edit')
  assign(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(BreakdownAssignSchema)) body: BreakdownAssignInput): Promise<FleetBreakdown> {
    return this.breakdowns.assign(principal, id, body);
  }

  @Post(':id/shop')
  @RequirePermission('maintenance.edit')
  shop(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(BreakdownShopSchema)) body: BreakdownShopInput): Promise<FleetBreakdown> {
    return this.breakdowns.arrangeShop(principal, id, body);
  }

  @Post(':id/work-order')
  @RequirePermission('maintenance.edit')
  workOrder(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(BreakdownWorkOrderSchema)) body: BreakdownWorkOrderInput): Promise<FleetBreakdown> {
    return this.breakdowns.workOrder(principal, id, body);
  }

  @Patch(':id/status')
  @RequirePermission('maintenance.edit')
  status(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(BreakdownStatusSchema)) body: BreakdownStatusInput): Promise<FleetBreakdown> {
    return this.breakdowns.setStatus(principal, id, body);
  }

  @Post(':id/notes')
  @RequirePermission('maintenance.edit')
  note(@CurrentPrincipal() principal: Principal, @Param('id') id: string, @Body(new ZodValidationPipe(BreakdownNoteSchema)) body: BreakdownNoteInput): Promise<FleetBreakdown> {
    return this.breakdowns.addNote(principal, id, body);
  }
}
