import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { DocumentStorageService } from '../../common/storage/document-storage.service';
import { HiringModule } from '../hiring/hiring.module';
import { PeopleModule } from '../people/people.module';
import { CareIntakeService } from './care-intake.service';
import { DriverRelationsController } from './driver-relations.controller';
import { DriverRelationsService } from './driver-relations.service';
import { DriverRelationsOutboxWorker } from './outbox.worker';
import { PublicCareController } from './public-care.controller';
import { TelegramAdapter } from './telegram.adapter';

/**
 * Driver Relations (owner brief, 2026-10-06): the public Driver Care intake, the staff workspace,
 * and the notification outbox. Hiring is imported for one thing: a referral's HR lead.
 */
@Module({
  imports: [PeopleModule, HiringModule],
  controllers: [DriverRelationsController, PublicCareController],
  providers: [
    DriverRelationsService,
    CareIntakeService,
    TelegramAdapter,
    DocumentStorageService,
    DriverRelationsOutboxWorker,
    CompanyScopeGuard,
    PermissionGuard,
  ],
  // CareIntakeService: the driver app files Driver Care requests and referrals through it (mobile M3).
  exports: [DriverRelationsService, CareIntakeService],
})
export class DriverRelationsModule {}
