import { Module } from '@nestjs/common';
import { DocumentStorageService } from '../../common/storage/document-storage.service';
import { HiringModule } from '../hiring/hiring.module';
import { PeopleModule } from '../people/people.module';
import { RosterModule } from '../roster/roster.module';
import { DotApplicationSafetyService } from './dot-application-safety.service';
import { DotApplicationService } from './dot-application.service';
import { ApplicationTemplatesController, RecruiterDotApplicationController, SafetyDotApplicationController } from './internal.controller';
import { PublicDotApplicationController } from './public.controller';
import { DotAppTemplatesService } from './templates.service';

/** The DOT driver application v2 (owner brief 2026-10-27, docs/driver-application). */
@Module({
  imports: [HiringModule, RosterModule, PeopleModule],
  controllers: [PublicDotApplicationController, RecruiterDotApplicationController, SafetyDotApplicationController, ApplicationTemplatesController],
  providers: [DocumentStorageService, DotApplicationService, DotApplicationSafetyService, DotAppTemplatesService],
  exports: [DotApplicationService],
})
export class DotApplicationModule {}
