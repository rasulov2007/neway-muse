import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { DemoReportingModule } from '../reporting/demo/demo-reporting.module';
import { ReportingPeriodModule } from '../reporting/period/reporting-period.module';
import { env } from '../../config/env';
import { CLOCK, demoClock, systemClock } from './clock';
import { DashboardCache } from './dashboard-cache';
import { DashboardController } from './dashboard.controller';
import { DashboardService } from './dashboard.service';

/**
 * Company dashboard API. The workspace reporting source answers from the saved workspace and the
 * work-orders table; the clock is pinned only while the demo seeds are on.
 */
@Module({
  imports: [ReportingPeriodModule, DemoReportingModule],
  controllers: [DashboardController],
  providers: [
    DashboardService,
    DashboardCache,
    // The pinned demo clock only with the demo seeds: a live company reads its own week, or a
    // repair recorded today lands in a period the dashboard never shows (2026-09-21).
    { provide: CLOCK, useValue: env.SEED_DEMO_DATA ? demoClock : systemClock },
    CompanyScopeGuard,
    PermissionGuard,
  ],
})
export class DashboardModule {
}
