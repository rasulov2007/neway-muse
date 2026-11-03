import { Module } from '@nestjs/common';
import { DatabaseModule } from '../../database/database.module';
import { AccountingModule } from '../accounting/accounting.module';
import { AuthModule } from '../auth/auth.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { FleetModule } from '../fleet/fleet.module';
import { HiringModule } from '../hiring/hiring.module';
import { HrModule } from '../hr/hr.module';
import { LoadsModule } from '../loads/loads.module';
import { MessagesModule } from '../messages/messages.module';
import { ReportsModule } from '../reports/reports.module';
import { RosterModule } from '../roster/roster.module';
import { AccidentsV2Module } from '../safety/accidents-v2/accidents-v2.module';
import { SafetyModule } from '../safety/safety.module';
import { StateModule } from '../state/state.module';
import { OfficeController } from './office.controller';
import { OfficeService } from './office.service';

/** The office app's /office/* aggregations (mobile M4). Reads through the services that own the records. */
@Module({
  imports: [
    DatabaseModule,
    AuthModule,
    LoadsModule,
    RosterModule,
    FleetModule,
    ComplianceModule,
    SafetyModule,
    AccidentsV2Module,
    AccountingModule,
    HrModule,
    HiringModule,
    ReportsModule,
    StateModule,
    MessagesModule,
  ],
  controllers: [OfficeController],
  providers: [OfficeService],
})
export class OfficeModule {}
