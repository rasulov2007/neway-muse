import { TirePositionsController } from './tire-positions.controller';
import { TirePositionsService } from './tire-positions.service';
import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { DatabaseModule } from '../../database/database.module';
import { PeopleModule } from '../people/people.module';
import { PmModule } from '../pm/pm.module';
import { ReportingPeriodModule } from '../reporting/period/reporting-period.module';
import { StateModule } from '../state/state.module';
import { FleetExpenseController } from './fleet-expense.controller';
import { FleetExpenseService } from './fleet-expense.service';
import { FleetTodayService } from './fleet-today.service';
import { PmBoardController } from './pm-board.controller';
import { PmBoardService } from './pm-board.service';
import { PtiController } from './pti.controller';
import { PtiService } from './pti.service';
import { WorkOrdersController } from './work-orders.controller';
import { WorkOrdersService } from './work-orders.service';

/**
 * Fleet analytics served from the workspace's own records: the roster tables plus the operational
 * snapshot in `app_state`, aggregated on the server so a page never downloads every work order to
 * add them up.
 */
@Module({
  imports: [DatabaseModule, StateModule, ReportingPeriodModule, PeopleModule, PmModule],
  controllers: [FleetExpenseController, WorkOrdersController, PtiController, PmBoardController, TirePositionsController],
  providers: [
    FleetExpenseService,
    TirePositionsService,
    WorkOrdersService,
    FleetTodayService,
    PtiService,
    PmBoardService,
    CompanyScopeGuard,
    PermissionGuard,
  ],
  // Accident & Claims v2 (P3) opens and completes accident repairs through Fleet's own service (one writer).
  exports: [WorkOrdersService, PtiService],
})
export class FleetModule {}
