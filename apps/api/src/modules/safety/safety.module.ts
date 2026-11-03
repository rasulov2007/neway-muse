import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { FeatureFlagGuard } from '../../common/flags/feature-flag.guard';
import { DatabaseModule } from '../../database/database.module';
import { AccountingModule } from '../accounting/accounting.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { PeopleModule } from '../people/people.module';
import { RosterModule } from '../roster/roster.module';
import { VacationReturnsService } from './vacation-returns.service';
import { AccidentsService } from './accidents.service';
import { ClaimsAlertsScheduler } from './claims-alerts.scheduler';
import { ClaimsService } from './claims.service';
import { DriverChargesService } from './driver-charges.service';
import { ComplianceViewService } from './compliance-view.service';
import { SafetyOverviewService } from './overview.service';
import { SafetyReviewsService } from './reviews.service';
import { SafetyCoreService } from './safety-core.service';
import { SafetyController } from './safety.controller';
import { DrugTestsService } from './tests.service';
import { ViolationsService } from './violations.service';

/**
 * Safety v2: accidents, claims, violations, roadside inspections, safety reviews and drug &
 * alcohol tests on the server (docs/safety/SAFETY-V2.md). Behind `safety_v2`.
 *
 * Imports `PeopleModule` for the one audit trail (every case's timeline is read back from it) and
 * `ComplianceModule` for the qualification file the compliance views read through the engine.
 */
@Module({
  imports: [DatabaseModule, PeopleModule, ComplianceModule, AccountingModule, RosterModule],
  controllers: [SafetyController],
  providers: [
    SafetyCoreService,
    DrugTestsService,
    SafetyReviewsService,
    AccidentsService,
    ClaimsService,
    DriverChargesService,
    ClaimsAlertsScheduler,
    ViolationsService,
    SafetyOverviewService,
    ComplianceViewService,
    VacationReturnsService,
    FeatureFlagGuard,
    CompanyScopeGuard,
    PermissionGuard,
  ],
  // ViolationsService: the driver app files roadside inspections through it (mobile M3).
  exports: [SafetyCoreService, AccidentsService, ClaimsService, DrugTestsService, ViolationsService],
})
export class SafetyModule {}
