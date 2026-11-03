import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PeopleModule } from '../people/people.module';
import { RosterSeedService } from '../../database/roster-seed.service';
import { ComplianceModule } from '../compliance/compliance.module';
import { HrModule } from '../hr/hr.module';
import { StateModule } from '../state/state.module';
import { FilesModule } from '../files/files.module';
import { AssignmentsService } from './assignments.service';
import { DriverPaymentService } from './payment.service';
import { DriversService } from './drivers.service';
import { RosterController } from './roster.controller';
import { TrailersService } from './trailers.service';
import { TrucksService } from './trucks.service';
import { VacationsService } from './vacations.service';
import { TeamsService } from './teams.service';
import { DrizzleTeamStore, TEAM_STORE } from './teams.data';

/**
 * Trucks and drivers: the two records every other module points at.
 *
 * The demo principal middleware is scoped to these routes the same way it is to the dashboard's.
 * Phase 3 authentication replaces that middleware and nothing else here — the company a request
 * reads and writes under already comes from the principal and from nowhere else.
 */
@Module({
  // HrModule for the onboarding plan a new driver opens with. It imports PeopleModule and not
  // this one, so the graph stays a tree.
  // StateModule: a stolen truck's location reaches the administrator role only.
  // FilesModule: pickup and drop photos of an assignment are stored files (0047).
  imports: [ComplianceModule, PeopleModule, HrModule, StateModule, FilesModule],
  controllers: [RosterController],
  providers: [TrucksService, TrailersService, DriversService, VacationsService, TeamsService, { provide: TEAM_STORE, useClass: DrizzleTeamStore }, AssignmentsService, DriverPaymentService, RosterSeedService, CompanyScopeGuard],
  exports: [TrucksService, TrailersService, DriversService, VacationsService, TeamsService, AssignmentsService, RosterSeedService],
})
export class RosterModule {}
