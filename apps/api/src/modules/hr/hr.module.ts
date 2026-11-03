import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PeopleModule } from '../people/people.module';
import { AttendanceService } from './attendance.service';
import { HrController } from './hr.controller';
import { OnboardingService } from './onboarding.service';
import { PerformanceService } from './performance.service';
import { PtoService } from './pto.service';
import { RecruitingService } from './recruiting.service';

/**
 * The workforce lifecycle after Phase 3.
 *
 * Imports PeopleModule rather than reaching into the employees table itself: the hire conversion
 * creates an employee through `EmployeesService`, so a candidate becoming a person goes through the
 * same validation, history and audit as any other new employee.
 */
@Module({
  imports: [PeopleModule],
  controllers: [HrController],
  providers: [
    RecruitingService,
    OnboardingService,
    AttendanceService,
    PtoService,
    PerformanceService,
    CompanyScopeGuard,
  ],
  exports: [RecruitingService, OnboardingService, AttendanceService, PtoService, PerformanceService],
})
export class HrModule {
}
