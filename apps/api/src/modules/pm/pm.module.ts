import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { DatabaseModule } from '../../database/database.module';
import { PeopleModule } from '../people/people.module';
import { PmImportService } from './import/pm-import.service';
import { PmRecomputeScheduler } from './pm-recompute.scheduler';
import { PmController } from './pm.controller';
import { PmService } from './pm.service';

/**
 * Oil change / PM (docs/pm-module), behind `pm_module`.
 *
 * Its own module so both the shop (a completion resets the clock) and the integrations (the
 * Samsara sync writes readings) can reach the one calculation without either owning it.
 */
@Module({
  imports: [DatabaseModule, PeopleModule],
  controllers: [PmController],
  providers: [PmService, PmImportService, PmRecomputeScheduler, CompanyScopeGuard, PermissionGuard],
  exports: [PmService, PmImportService],
})
export class PmModule {}
