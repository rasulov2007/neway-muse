import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { AdminSeedService } from '../../database/admin-seed.service';
import { PeopleModule } from '../people/people.module';
import { PmModule } from '../pm/pm.module';
import { StateModule } from '../state/state.module';
import { AdminController } from './admin.controller';
import { AdminSystemController } from './admin-system.controller';
import { AuditLogService } from './audit-log.service';
import { DepartmentsService } from './departments.service';
import { SamsaraSyncService } from './connectors/samsara-sync.service';
import { RelaySyncService } from './connectors/relay-sync.service';
import { MotiveSyncService } from './connectors/motive-sync.service';
import { FiveEldSyncService } from './connectors/fiveeld-sync.service';
import { TwilioService } from './connectors/twilio.service';
import { RtsFtpService } from './connectors/rts-ftp.service';
import { AzureSpeechService } from './connectors/azure-speech.service';
import { IntegrationSyncScheduler } from './integration-sync.scheduler';
import { IntegrationsService } from './integrations.service';
import { NotificationsService } from './notifications.service';
import { RolesService } from './roles.service';
import { SettingsService } from './settings.service';
import { UsersService } from './users.service';
import { WorkflowsService } from './workflows.service';

/**
 * Administration: the control plane.
 *
 * Imports `PeopleModule` rather than declaring its own `AuditService`, because there is one audit
 * trail in this product and a second provider would mean a second instance — and the workflow
 * engine subscribes to that instance. Two audit services would mean automation silently listening
 * to half the events.
 */
@Module({
  imports: [PeopleModule, PmModule, StateModule],
  controllers: [AdminController, AdminSystemController],
  providers: [
    UsersService,
    RolesService,
    DepartmentsService,
    SettingsService,
    IntegrationsService,
    SamsaraSyncService,
    RelaySyncService,
    MotiveSyncService,
    FiveEldSyncService,
    TwilioService,
    RtsFtpService,
    AzureSpeechService,
    IntegrationSyncScheduler,
    WorkflowsService,
    AuditLogService,
    NotificationsService,
    AdminSeedService,
    CompanyScopeGuard,
    PermissionGuard,
  ],
  exports: [AdminSeedService, SettingsService, AuditLogService, TwilioService, RtsFtpService, AzureSpeechService],
})
export class AdminModule {
}
