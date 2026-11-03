import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PeopleModule } from '../people/people.module';
import { PlatformAdminGuard } from './platform-admin.guard';
import { PlatformController } from './platform.controller';
import { PlatformService } from './platform.service';

/** The platform administrator's Companies page (owner, 2026-10-01). */
@Module({
  imports: [PeopleModule],
  controllers: [PlatformController],
  providers: [PlatformService, PlatformAdminGuard, CompanyScopeGuard],
})
export class PlatformModule {}
