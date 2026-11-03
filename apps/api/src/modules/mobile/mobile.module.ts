import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { FeatureFlagGuard } from '../../common/flags/feature-flag.guard';
import { DatabaseModule } from '../../database/database.module';
import { AccountingModule } from '../accounting/accounting.module';
import { AdminModule } from '../admin/admin.module';
import { AiAssistantModule } from '../ai-assistant/ai-assistant.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { DriverRelationsModule } from '../driver-relations/driver-relations.module';
import { FilesModule } from '../files/files.module';
import { FleetExpensesModule } from '../fleet-expenses/fleet-expenses.module';
import { FleetModule } from '../fleet/fleet.module';
import { LoadsModule } from '../loads/loads.module';
import { PeopleModule } from '../people/people.module';
import { RosterModule } from '../roster/roster.module';
import { AccidentsV2Module } from '../safety/accidents-v2/accidents-v2.module';
import { SafetyModule } from '../safety/safety.module';
import { AppAccessService } from './app-access.service';
import { BreakdownsService } from './breakdowns.service';
import { DriverAssistantController } from './driver-assistant.controller';
import { DriverAssistantService } from './driver-assistant.service';
import { MetaTranscribeClient } from './meta-transcribe.client';
import { DriverCareService } from './driver-care.service';
import { DriverContextService } from './driver-context.service';
import { DriverDocumentsService } from './driver-documents.service';
import { DriverController } from './driver.controller';
import { DriverLoadsService } from './driver-loads.service';
import { DriverMoneyService } from './driver-money.service';
import { DriverOwnershipService } from './driver-ownership.service';
import { DriverPtiService } from './driver-pti.service';
import { DriverRecordsController } from './driver-records.controller';
import { DriverSafetyReportsService } from './driver-safety-reports.service';
import { DriverVacationsService } from './driver-vacations.service';
import { FleetBreakdownsController } from './fleet-breakdowns.controller';
import { IdempotencyService } from './idempotency.service';
import { AppAccessController, MobileController } from './mobile.controller';
import { MobileHooksService } from './mobile-hooks.service';
import { MobileNotificationsService } from './mobile-notifications.service';
import { PushService } from './push.service';

/**
 * The NeWay mobile app's backend (docs/mobile/PLAN.md, API.md): `/driver/*` for the driver app,
 * `/mobile/*` for devices and the inbox, driver app access on the driver profile, and (M3)
 * Fleet → Breakdowns for the office. Writes go through the existing services (LoadsService,
 * PtiService, ReimbursementsService, FleetExpensesService, CareIntakeService, VacationsService,
 * ComplianceService, AccidentsV2Service, ViolationsService, WorkOrdersService, LoadProblemsService).
 */
@Module({
  imports: [
    DatabaseModule,
    LoadsModule,
    FleetModule,
    FilesModule,
    PeopleModule,
    AccountingModule,
    FleetExpensesModule,
    DriverRelationsModule,
    RosterModule,
    ComplianceModule,
    SafetyModule,
    AccidentsV2Module,
    AdminModule,
    AiAssistantModule,
  ],
  controllers: [DriverController, DriverAssistantController, DriverRecordsController, MobileController, AppAccessController, FleetBreakdownsController],
  providers: [
    AppAccessService,
    BreakdownsService,
    DriverAssistantService,
    MetaTranscribeClient,
    DriverCareService,
    DriverContextService,
    DriverDocumentsService,
    DriverLoadsService,
    DriverMoneyService,
    DriverOwnershipService,
    DriverPtiService,
    DriverSafetyReportsService,
    DriverVacationsService,
    IdempotencyService,
    MobileHooksService,
    MobileNotificationsService,
    PushService,
    FeatureFlagGuard,
    CompanyScopeGuard,
    PermissionGuard,
  ],
  exports: [MobileNotificationsService, PushService],
})
export class MobileModule {}
