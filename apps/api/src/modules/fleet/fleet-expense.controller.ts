import { Controller, Get, Header, Query, UseGuards } from '@nestjs/common';
import {
  FleetExpenseQuerySchema,
  type FleetExpenseQuery,
  type FleetExpenseSummary,
} from '@neway/shared';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { CurrentPrincipal } from '../../common/auth/current-principal.decorator';
import { PermissionGuard } from '../../common/auth/permission.guard';
import type { Principal } from '../../common/auth/principal';
import { RequirePermission } from '../../common/auth/require-permission.decorator';
import { ZodValidationPipe } from '../../common/validation/zod-validation.pipe';
import { FleetExpenseService } from './fleet-expense.service';

/** What maintenance spending looks like for whoever may see the maintenance register. */
/*
 * The expense summary is a money report, and is gated as one.
 *
 * It used to require `maintenance.view`, which is the permission a mechanic needs to open a work
 * order — so the role that let somebody work the shop floor also handed them every invoice total
 * in the company. The two readers are now separate permissions.
 */
export const FLEET_EXPENSE_PERMISSION = 'maintenance_costs.view';

@Controller('fleet')
@UseGuards(CompanyScopeGuard, PermissionGuard)
@RequirePermission(FLEET_EXPENSE_PERMISSION)
export class FleetExpenseController {
  constructor(private readonly expenses: FleetExpenseService) {}

  /**
   * The figures change as somebody attaches an invoice or completes an order, and the client
   * refetches on exactly those writes, so nothing is cached between them.
   */
  @Get('expense-summary')
  @Header('Cache-Control', 'private, no-store')
  summary(
    @CurrentPrincipal() principal: Principal,
    @Query(new ZodValidationPipe(FleetExpenseQuerySchema)) params: FleetExpenseQuery,
  ): Promise<FleetExpenseSummary> {
    return this.expenses.summary(principal, params);
  }
}
