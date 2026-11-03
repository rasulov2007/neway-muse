import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PeopleSeedService } from '../../database/people-seed.service';
import { AuditService } from './audit.service';
import { EmployeesController } from './employees.controller';
import { EmployeesService } from './employees.service';
import { SelfProfileController } from './self-profile.controller';
import { SelfProfileService } from './self-profile.service';
import { StateModule } from '../state/state.module';

/**
 * People.
 *
 * The employee is the workforce identity every later workforce module hangs off: recruiting
 * converts a candidate into one, onboarding plans against one, attendance, PTO and performance all
 * key on `employee_id`. None of those exists yet and none is faked here; what exists is the record
 * they will reference and the audit trail they will write into.
 */
@Module({
  // StateModule: the audit timeline asks who may read a stolen unit's lines.
  imports: [StateModule],
  controllers: [EmployeesController, SelfProfileController],
  providers: [
    EmployeesService,
    SelfProfileService,
    AuditService,
    PeopleSeedService,
    CompanyScopeGuard,
  ],
  exports: [EmployeesService, AuditService, PeopleSeedService],
})
export class PeopleModule {
}
