import { Module } from '@nestjs/common';
import { ReportingPeriodService } from './reporting-period.service';

/** Provides the single source of dashboard date logic to the reporting and dashboard modules. */
@Module({
  providers: [ReportingPeriodService],
  exports: [ReportingPeriodService],
})
export class ReportingPeriodModule {}
