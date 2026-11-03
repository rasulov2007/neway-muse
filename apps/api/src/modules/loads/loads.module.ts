import { Module } from '@nestjs/common';
import { MuseVisionModule } from '../muse-vision/muse-vision.module';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { PeopleModule } from '../people/people.module';
import { DatabaseModule } from '../../database/database.module';
import { StateModule } from '../state/state.module';
import { LoadsController } from './loads.controller';
import { LoadsService } from './loads.service';
import { RouteOptionsService } from './route-options.service';
import { LoadProblemsController } from './load-problems.controller';
import { LoadProblemsService } from './load-problems.service';
import { RateConfirmationReaderController } from './rate-confirmation-reader.controller';
import { RateConfirmationReaderService } from './rate-confirmation-reader.service';

/**
 * Loads, one record at a time, while the collection still lives in the workspace blob. The
 * module that replaces the blob with a table (the cutover before dispatch Phase 2) keeps these
 * routes and swaps what is under them.
 */
@Module({
  imports: [StateModule, PeopleModule, DatabaseModule, MuseVisionModule],
  controllers: [LoadsController, LoadProblemsController, RateConfirmationReaderController],
  providers: [LoadsService, LoadProblemsService, RateConfirmationReaderService, RouteOptionsService, CompanyScopeGuard, PermissionGuard],
  exports: [LoadsService, LoadProblemsService],
})
export class LoadsModule {}
