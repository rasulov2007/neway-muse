import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { RosterModule } from '../roster/roster.module';
import { DatabaseModule } from '../../database/database.module';
import { PeopleModule } from '../people/people.module';
import { StateModule } from '../state/state.module';
import { ClaimsService } from './claims.service';
import { DispatchBoardController } from './dispatch-board.controller';
import { DispatchBoardService } from './dispatch-board.service';
import { PolicyService } from './policy.service';
import { RosterMatchService } from './roster-match.service';
import { RosterService } from './roster.service';
import { PerformanceService } from './performance.service';
import { SalaryService } from './salary.service';
import { TeamOrderService } from './team-order.service';

/** The Daily and Weekly boards, the roster, the commission policy, salary runs and claims. */
@Module({
  imports: [DatabaseModule, StateModule, PeopleModule, RosterModule],
  controllers: [DispatchBoardController],
  providers: [
    DispatchBoardService,
    RosterService,
    RosterMatchService,
    PolicyService,
    SalaryService,
    PerformanceService,
    ClaimsService,
    TeamOrderService,
    CompanyScopeGuard,
    PermissionGuard,
  ],
  exports: [DispatchBoardService, RosterService, RosterMatchService, PolicyService, SalaryService],
})
export class DispatchBoardModule {}
