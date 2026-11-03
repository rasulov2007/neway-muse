import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../../common/auth/company-scope.guard';
import { PermissionGuard } from '../../../common/auth/permission.guard';
import { FeatureFlagGuard } from '../../../common/flags/feature-flag.guard';
import { DatabaseModule } from '../../../database/database.module';
import { PeopleModule } from '../../people/people.module';
import { AccountingModule } from '../../accounting/accounting.module';
import { FilesModule } from '../../files/files.module';
import { FleetModule } from '../../fleet/fleet.module';
import { SafetyModule } from '../safety.module';
import { AccidentsV2Controller } from './accidents-v2.controller';
import { AccidentsV2Service } from './accidents-v2.service';
import { ClaimsV2Controller } from './claims-v2.controller';
import { ClaimsV2Service } from './claims-v2.service';
import { EquipmentV2Service } from './equipment-v2.service';
import { InvestigationV2Service } from './investigation-v2.service';
import { AccidentSettingsService } from './settings-v2.service';
import { AccidentsV2StateService } from './state.service';
import { TasksV2Service } from './tasks-v2.service';

/**
 * Accident & Claims v2 (docs/accidents), behind `accidents_v2`. Reuses Safety's core (numbers, clock, lookups) and
 * the one audit trail; the rules come from `@neway/shared` safetyRules.
 */
@Module({
  imports: [DatabaseModule, PeopleModule, SafetyModule, FleetModule, AccountingModule, FilesModule],
  controllers: [AccidentsV2Controller, ClaimsV2Controller],
  providers: [AccidentsV2Service, AccidentsV2StateService, TasksV2Service, ClaimsV2Service, EquipmentV2Service, InvestigationV2Service, AccidentSettingsService, FeatureFlagGuard, CompanyScopeGuard, PermissionGuard],
  exports: [AccidentsV2Service, AccidentsV2StateService, ClaimsV2Service],
})
export class AccidentsV2Module {}
