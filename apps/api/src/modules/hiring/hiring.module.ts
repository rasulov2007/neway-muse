import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { AccountingModule } from '../accounting/accounting.module';
import { AdminModule } from '../admin/admin.module';
import { StateModule } from '../state/state.module';
import { ComplianceModule } from '../compliance/compliance.module';
import { HrModule } from '../hr/hr.module';
import { PeopleModule } from '../people/people.module';
import { RosterModule } from '../roster/roster.module';
import { ApplyService } from './apply.service';
import { LeadFollowUpScheduler } from './lead-follow-up.scheduler';
import { LeadTelegramNotifier } from './lead-telegram';
import { CostLedgerService } from './cost-ledger.service';
import { DotApplicationsService } from './dot-applications.service';
import { DotLinksService } from './dot-links.service';
import { DocumentStorageService } from '../../common/storage/document-storage.service';
import { HiringAnalyticsService } from './hiring-analytics.service';
import { HiringDocumentsService } from './hiring-documents.service';
import { HiringActivityService } from './hiring-activity.service';
import { HiringPipelineService } from './hiring-pipeline.service';
import { HiringController } from './hiring.controller';
import { HiringService } from './hiring.service';
import { LeadsService } from './leads.service';
import { LeadRotationService } from './lead-rotation.service';
import { MyLeadsService } from './my-leads.service';
import { PublicApplyController } from './public-apply.controller';
import { PublicDotLinkController } from './public-dot-link.controller';
import { PublicExternalApplicationController } from './public-external-application.controller';
import { RecruitController } from './recruit.controller';
import { RecruitService } from './recruit.service';
import { ExternalApplicationService } from './external-application.service';
import { DriverApplicationService } from './driver-application.service';
import { PublicDriverApplicationController } from './public-driver-application.controller';
import { HiringSeedService } from '../../database/hiring-seed.service';
import { EmailTransport } from '../accounting/email.transport';
import { CandidateHireService } from './candidate-hire.service';
import { CandidateJourneyController } from './candidate-journey.controller';
import { CandidateJourneyService } from './candidate-journey.service';
import { CandidateOnboardingService } from './candidate-onboarding.service';
import { CandidateSafetyService } from './candidate-safety.service';
import { ConsentService } from './consent.service';
import { PublicConsentController } from './public-consent.controller';
import { LinkDeliveryService } from './link-delivery.service';
import { PublicSmsStatusController } from './public-sms-status.controller';
import { SafetyDeskController } from './safety-desk.controller';
import { SmsPreferencesService } from './sms-preferences.service';
import { MuseVisionModule } from '../muse-vision/muse-vision.module';

/** The driver hiring funnel: a wrapper over the verification pipeline, never a copy of it. */
@Module({
  imports: [PeopleModule, ComplianceModule, HrModule, AdminModule, RosterModule, AccountingModule, StateModule, MuseVisionModule],
  controllers: [HiringController, RecruitController, PublicApplyController, PublicDotLinkController, PublicExternalApplicationController, PublicDriverApplicationController, CandidateJourneyController, PublicConsentController, PublicSmsStatusController, SafetyDeskController],
  providers: [
    HiringDocumentsService,
    HiringActivityService,
    HiringService,
    LeadsService,
    LeadRotationService,
    MyLeadsService,
    RecruitService,
    ExternalApplicationService,
    DriverApplicationService,
    DotApplicationsService,
    DotLinksService,
    DocumentStorageService,
    HiringPipelineService,
    CostLedgerService,
    HiringAnalyticsService,
    ApplyService,
    LeadTelegramNotifier,
    LeadFollowUpScheduler,
    HiringSeedService,
    // The recruiting journey (owner brief, 2026-10-11).
    EmailTransport,
    ConsentService,
    LinkDeliveryService,
    SmsPreferencesService,
    CandidateSafetyService,
    CandidateOnboardingService,
    CandidateHireService,
    CandidateJourneyService,
    CompanyScopeGuard,
    PermissionGuard,
  ],
  exports: [
    RecruitService,
    HiringService,
    LeadsService,
    DotApplicationsService,
    HiringPipelineService,
    CostLedgerService,
    HiringSeedService,
    // The office app's Today / My work (mobile M4) read the caller's own leads.
    MyLeadsService,
  ],
})
export class HiringModule {}
