import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { PeopleModule } from '../people/people.module';
import { DemoReportingModule } from '../reporting/demo/demo-reporting.module';
import { ReportingPeriodModule } from '../reporting/period/reporting-period.module';
import { AnalyticsService } from './analytics.service';
import { ReportRunnerService } from './report-runner.service';
import { ReportsController } from './reports.controller';
import { SavedReportsService } from './saved-reports.service';

/**
 * Reports and analytics.
 *
 * Imports the same reporting period service and the same data source the dashboard uses, so all
 * three read one definition of a reporting week and one set of facts. Nothing in this module
 * computes a financial figure of its own — that is the whole reason it depends on the reporting
 * module rather than the database directly.
 */
@Module({
  imports: [ReportingPeriodModule, DemoReportingModule, PeopleModule],
  controllers: [ReportsController],
  providers: [
    ReportRunnerService,
    SavedReportsService,
    AnalyticsService,
    CompanyScopeGuard,
    PermissionGuard,
  ],
  exports: [ReportRunnerService, AnalyticsService],
})
export class ReportsModule {
}
