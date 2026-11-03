import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { DRIVER_DOC_TYPE_LABEL, REIMBURSEMENT_CATEGORY_LABEL, reimbursableCents, type DriverDocType } from '@neway/shared';
import { ReimbursementsService } from '../accounting/reimbursements.service';
import { ComplianceService } from '../compliance/compliance.service';
import { DriverRelationsService } from '../driver-relations/driver-relations.service';
import { VacationsService } from '../roster/vacations.service';
import { DriverCareService } from './driver-care.service';
import { DriverDocumentsService } from './driver-documents.service';
import { DriverVacationsService } from './driver-vacations.service';
import { PtiService } from '../fleet/pti.service';
import { LoadsService } from '../loads/loads.service';
import { MobileNotificationsService } from './mobile-notifications.service';

/**
 * The review loop back to the driver (0081): when the office reviews a paper the driver sent from
 * the app, or Safety reviews / sends back a walk-around, the driver gets a notification (row first,
 * then push). Registered on the services' own hooks so the web routes need no change.
 *
 * M3 adds: a reimbursement approved / rejected / paid, a Driver Care reply or status, a vacation
 * request event (Dispatch, Safety, the driver), a qualification document verified / rejected.
 */
@Injectable()
export class MobileHooksService implements OnModuleInit {
  private readonly logger = new Logger(MobileHooksService.name);

  constructor(
    private readonly loads: LoadsService,
    private readonly pti: PtiService,
    private readonly notifications: MobileNotificationsService,
    private readonly reimbursements: ReimbursementsService,
    private readonly relations: DriverRelationsService,
    private readonly vacations: VacationsService,
    private readonly compliance: ComplianceService,
    private readonly care: DriverCareService,
    private readonly driverVacations: DriverVacationsService,
    private readonly driverDocuments: DriverDocumentsService,
  ) {}

  onModuleInit(): void {
    this.reimbursements.afterDecision.push(async (principal, expense, event) => {
      const b = expense.reimbursement;
      if (!b) return;
      const label = REIMBURSEMENT_CATEGORY_LABEL[b.category] ?? 'Receipt';
      const money = `${(reimbursableCents(b) / 100).toFixed(2)}`;
      try {
        await this.notifications.notifyDriver(principal.companyId, b.payerDriverId, {
          title: event === 'rejected' ? `${label} ${money} rejected: ${b.rejectedReason ?? ''}` : event === 'approved' ? `${label} ${money} approved` : `${label} ${money} paid with ${b.settlementNumber ?? 'your statement'}`,
          body: event === 'approved' ? 'It goes on your next statement.' : null,
          pushTitle: event === 'rejected' ? 'Receipt rejected' : event === 'approved' ? 'Receipt approved' : 'Reimbursement paid',
          pushBody: event === 'rejected' ? 'Accounting rejected a receipt you sent.' : event === 'approved' ? 'Accounting approved a receipt you sent.' : 'A reimbursement was paid.',
          severity: event === 'rejected' ? 'warning' : 'info',
          target: { type: 'reimbursement', id: expense.id },
          dedupeKey: `reimbursement:${expense.id}:${event}`,
        });
      } catch (error) {
        this.logger.warn(`Could not notify the driver about ${expense.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    this.relations.afterChange.push((principal, row, activity) =>
      this.care.onStaffChange(principal, row, activity).catch((error: unknown) => this.logger.warn(`Driver Care notice for ${row.requestNumber} failed: ${String(error)}`)),
    );
    this.vacations.afterRequestEvent.push((principal, event) => this.driverVacations.onEvent(principal, event));
    this.compliance.afterReview.push((principal, document) =>
      this.driverDocuments.onReview(principal, document).catch((error: unknown) => this.logger.warn(`Document notice for ${document.id} failed: ${String(error)}`)),
    );

    this.loads.afterDocumentReview.push(async (principal, load, documentId) => {
      const doc = load.documents.find((d) => d.id === documentId) as (typeof load.documents)[number] & { source?: string; uploadedByDriverId?: string; rejectedReason?: string | null };
      if (!doc || doc.source !== 'driver_app') return;
      const driverId = doc.uploadedByDriverId ?? load.driverId;
      if (!driverId) return;
      const label = DRIVER_DOC_TYPE_LABEL[doc.type as DriverDocType] ?? 'Document';
      const rejected = doc.review === 'rejected';
      try {
        await this.notifications.notifyDriver(principal.companyId, driverId, {
          title: rejected ? `Correction requested: ${label} on ${load.loadNumber}` : `${label} on ${load.loadNumber} reviewed`,
          body: rejected ? `Reason: ${doc.rejectedReason ?? ''}. Send a new file from the load.` : null,
          pushTitle: rejected ? 'Correction requested' : 'Document reviewed',
          pushBody: rejected ? `A document on ${load.loadNumber} needs a correction.` : `A document on ${load.loadNumber} was reviewed.`,
          severity: rejected ? 'warning' : 'info',
          target: { type: 'load', id: load.id },
          dedupeKey: `load_doc_review:${documentId}:${doc.review}`,
        });
      } catch (error) {
        this.logger.warn(`Could not notify the driver about ${documentId}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });

    this.pti.afterDriverEvent.push(async (principal, event) => {
      const submission = event.inspection.driverSubmission;
      if (!submission) return;
      const unit = event.inspection.unitNumber;
      const correction = event.kind === 'correction_requested';
      try {
        await this.notifications.notifyDriver(principal.companyId, submission.driverId, {
          title: correction ? `PTI correction requested for truck ${unit}` : `PTI for truck ${unit} reviewed`,
          body: correction ? `Reason: ${event.inspection.correction?.reason ?? ''}. Redo the walk-around and send it again.` : null,
          pushTitle: correction ? 'PTI correction requested' : 'PTI reviewed',
          pushBody: correction ? `Safety asked you to redo the PTI for truck ${unit}.` : `Safety reviewed your PTI for truck ${unit}.`,
          severity: correction ? 'warning' : 'info',
          target: { type: 'pti', id: event.inspection.id },
          dedupeKey: `pti:${event.kind}:${event.inspection.id}:${event.inspection.version}`,
        });
      } catch (error) {
        this.logger.warn(`Could not notify the driver about PTI ${event.inspection.id}: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }
}
