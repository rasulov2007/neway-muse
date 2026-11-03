import { Body, Controller, Get, Header, Param, Put, Query, UseGuards } from '@nestjs/common';
import { z } from 'zod';
import { FleetExpenseQuerySchema, TireTagInputSchema, type FleetExpenseQuery, type TireTagInput } from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { TirePositionsService } from './tire-positions.service';

const KindSchema = z.enum(['work_order', 'service_record', 'fleet_expense']);

/** The tire position map (owner brief, 2026-10-13): read with the spend, tagged by the shop. */
@Controller('fleet/tire-positions')
@UseGuards(CompanyScopeGuard, PermissionGuard)
export class TirePositionsController {
  constructor(private readonly tires: TirePositionsService) {}

  /** The same query as the expense summary, so the map reads exactly the table's records. */
  @Get()
  @RequirePermission('maintenance_costs.view')
  @Header('Cache-Control', 'private, no-store')
  async list(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(FleetExpenseQuerySchema)) query: FleetExpenseQuery) {
    const { events } = await this.tires.list(principal, query, principal.userName ?? principal.userId);
    return { events };
  }

  /** What the rules would read and write for the period, and how much stays unassigned - the backfill report. */
  @Get('report')
  @RequirePermission('maintenance_costs.view')
  @Header('Cache-Control', 'private, no-store')
  async report(@CurrentPrincipal() principal: Principal, @Query(new ZodValidationPipe(FleetExpenseQuerySchema)) query: FleetExpenseQuery) {
    return (await this.tires.list(principal, query, principal.userName ?? principal.userId)).report;
  }

  @Put(':kind/:recordId')
  @RequirePermission('maintenance.edit')
  tag(
    @CurrentPrincipal() principal: Principal,
    @Param('kind', new ZodValidationPipe(KindSchema)) kind: z.infer<typeof KindSchema>,
    @Param('recordId') recordId: string,
    @Body(new ZodValidationPipe(TireTagInputSchema)) body: TireTagInput,
  ) {
    return this.tires.tag(principal, kind, recordId, body);
  }
}
