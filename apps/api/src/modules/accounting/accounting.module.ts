import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { DatabaseModule } from '../../database/database.module';
import { DispatchBoardModule } from '../dispatch-board/dispatch-board.module';
import { LoadsModule } from '../loads/loads.module';
import { PeopleModule } from '../people/people.module';
import { StateModule } from '../state/state.module';
import { AdminModule } from '../admin/admin.module';
import { PmModule } from '../pm/pm.module';
import { AccountingController } from './accounting.controller';
import { DriverAccountsService } from './driver-accounts.service';
import { ExportsService } from './exports.service';
import { InvoicesService } from './invoices.service';
import { LedgerService } from './ledger.service';
import { PayablesService } from './payables.service';
import { ReimbursementsService } from './reimbursements.service';
import { RtsBatchesService } from './rts-batches.service';
import { FilesModule } from '../files/files.module';
import { PayeesService } from './payees.service';
import { PayrollService } from './payroll.service';
import { SettlementsService } from './settlements.service';
import { AccountingStore } from './store.service';
import { CompletionsService } from './completions.service';
import { ProfitabilityService } from './profitability.service';
import { EmailAdminController } from './email-admin.controller';
import { EmailTransport } from './email.transport';
import { StatementEmailService } from './statement-email.service';
import { StatementPdfService } from './statement-pdf.service';

/**
 * Accounting on the server (owner brief 2026-09-27): the ledger, billing and invoices, payables
 * and expenses, driver financial accounts, settlement batches, payees and payment batches,
 * staff payroll, exports. Every record lives in the `acct_*` tables (migration 0035) and every
 * write goes through a service here.
 */
@Module({
  imports: [DatabaseModule, PeopleModule, StateModule, LoadsModule, DispatchBoardModule, FilesModule, AdminModule, PmModule],
  controllers: [AccountingController, EmailAdminController],
  providers: [AccountingStore, LedgerService, InvoicesService, PayablesService, DriverAccountsService, ReimbursementsService, RtsBatchesService, SettlementsService, PayrollService, PayeesService, ExportsService, EmailTransport, CompletionsService, ProfitabilityService, StatementEmailService, StatementPdfService, CompanyScopeGuard, PermissionGuard],
  exports: [InvoicesService, SettlementsService, DriverAccountsService, PayablesService, ReimbursementsService, RtsBatchesService, StatementPdfService],
})
export class AccountingModule {}
