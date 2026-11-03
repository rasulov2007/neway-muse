import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../../database/database.module';
import { StateModule } from '../../state/state.module';
import { REPORTING_DATA_SOURCE } from '../facts';
import { WorkspaceReportingDataSource } from '../workspace/workspace-reporting-data-source';
import { DemoReportingDataSource } from './demo-reporting-data-source';

export { DEMO_COMPANY } from './demo-company';

/**
 * Where reporting facts come from.
 *
 * The workspace source is the one that answers: it reads the operational snapshot the app itself
 * writes, so the dashboard and the registers cannot disagree. It falls back to the deterministic
 * generated book when there is no snapshot — a fresh database, or the API's own tests.
 */
@Module({
  imports: [StateModule, DatabaseModule],
  providers: [
    DemoReportingDataSource,
    { provide: REPORTING_DATA_SOURCE, useClass: WorkspaceReportingDataSource },
    WorkspaceReportingDataSource,
  ],
  exports: [REPORTING_DATA_SOURCE],
})
export class DemoReportingModule {}
