import { Module } from '@nestjs/common';
import { CompanyScopeGuard } from '../../common/auth/company-scope.guard';
import { PermissionGuard } from '../../common/auth/permission.guard';
import { DocumentStorageService } from '../../common/storage/document-storage.service';
import { ComplianceSeedService } from '../../database/compliance-seed.service';
import { PeopleModule } from '../people/people.module';
import { StateModule } from '../state/state.module';
import { ComplianceAuditService } from './compliance-audit.service';
import { ComplianceController } from './compliance.controller';
import { ComplianceService } from './compliance.service';
import { ConsentsService } from './consents.service';
import { VerificationService } from './verification.service';

/**
 * Safety & compliance: the qualification file, persisted.
 *
 * Imports `PeopleModule` for the one audit trail rather than declaring a second `AuditService`:
 * compliance changes are events in the same stream the workflow engine subscribes to.
 */
@Module({
  // StateModule: a stolen unit's documents and audit lines reach the administrator role only.
  imports: [PeopleModule, StateModule],
  controllers: [ComplianceController],
  providers: [
    ComplianceService,
    ConsentsService,
    VerificationService,
    ComplianceAuditService,
    ComplianceSeedService,
    DocumentStorageService,
    CompanyScopeGuard,
    PermissionGuard,
  ],
  exports: [ComplianceService, ConsentsService, VerificationService, ComplianceSeedService],
})
export class ComplianceModule {
}
