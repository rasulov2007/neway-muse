import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { DatabaseModule } from '../../database/database.module';
import { AccountingModule } from '../accounting/accounting.module';
import { PeopleModule } from '../people/people.module';
import { FleetExpensesController } from './fleet-expenses.controller';
import { FleetExpensesService } from './fleet-expenses.service';

/**
 * Fleet Expenses (owner brief, 2026-10-12): manual truck expenses beside the repair orders they
 * never duplicate, linked to the existing Accounting records rather than a ledger of their own.
 */
@Module({
  imports: [DatabaseModule, PeopleModule, AccountingModule],
  controllers: [FleetExpensesController],
  providers: [FleetExpensesService, CompanyScopeGuard, PermissionGuard],
  // The driver app files company-card receipts as draft expenses (mobile M3).
  exports: [FleetExpensesService],
})
export class FleetExpensesModule {}
