import { Injectable } from '@nestjs/common';
import { and, eq } from 'drizzle-orm';
import type {
  CandidateCostRequest,
  CandidateJourney,
  HireCandidateRequest,
  OnboardingTaskUpdateRequest,
  SafetyReportUploadRequest,
  SafetyCheckRequest,
  SafetyStatusChangeRequest,
  SendLinkRequest,
  SmsOptInSource,
  TravelItemRequest,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { hiringCases, hiringConsents } from '../../database/schema/hiring';
import { AuditService } from '../people/audit.service';
import { CandidateHireService } from './candidate-hire.service';
import { CandidateOnboardingService } from './candidate-onboarding.service';
import { LinkDeliveryService } from './link-delivery.service';
import { SmsPreferencesService } from './sms-preferences.service';
import { CandidateSafetyService, SAFETY_DECIDE_PERMISSION } from './candidate-safety.service';
import { ConsentService } from './consent.service';
import { DriverApplicationService } from './driver-application.service';
import { HiringService } from './hiring.service';
import { RecruitService } from './recruit.service';

const forbidden = (detail: string) => new AppError({ status: 403, title: 'Forbidden', detail });

/**
 * The candidate journey's one read and its actions (owner brief, 2026-10-11), behind the same
 * candidate key and scope as the candidate page: the person is resolved (and scope-checked) once
 * by RecruitService, then each step's own service does the work. Recruiting actions need
 * `recruiting.manage`; Safety's need the Safety permission; Accounting stays Accounting's.
 */
@Injectable()
export class CandidateJourneyService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly hiring: HiringService,
    private readonly recruit: RecruitService,
    private readonly consents: ConsentService,
    private readonly safety: CandidateSafetyService,
    private readonly onboarding: CandidateOnboardingService,
    private readonly hire: CandidateHireService,
    private readonly driverApps: DriverApplicationService,
    private readonly deliveries: LinkDeliveryService,
    private readonly smsPrefs: SmsPreferencesService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private manage(principal: Principal) {
    if (!hasPermission(principal, 'recruiting.manage')) throw forbidden('This needs the recruiting manage permission.');
  }

  private subject(principal: Principal, key: string) {
    return this.recruit.subjectFor(principal, key);
  }

  async journey(principal: Principal, key: string): Promise<CandidateJourney> {
    const subject = await this.subject(principal, key);
    const caseRow = subject.caseId ? await this.hiring.row(principal, subject.caseId) : null;
    const [consent, deliveries, safety, gate, tasks, travel, costs, hire] = await Promise.all([
      this.consents.view(principal, subject),
      this.recruit.candidate(principal, key).then((c) => this.deliveries.list(principal, subject, c.phone)),
      this.safety.view(principal, subject),
      this.recruit.applicationGate(principal, key),
      this.onboarding.tasks(principal.companyId, subject.caseId),
      this.onboarding.travel(principal.companyId, subject.caseId),
      this.onboarding.costs(principal.companyId, subject.caseId),
      this.hire.checklist(principal, subject.caseId),
    ]);
    return {
      consent,
      deliveries,
      safety,
      application: {
        canSend: gate.canSend,
        blockedReason: gate.blockedReason,
        reviewedAt: caseRow?.applicationReviewedAt?.toISOString() ?? null,
        reviewedBy: caseRow?.applicationReviewedBy ?? null,
        inheritedFromConsent: Boolean(consent.submission),
      },
      onboarding: {
        startedAt: caseRow?.onboardingStartedAt?.toISOString() ?? null,
        startedBy: caseRow?.onboardingStartedBy ?? null,
        tasks,
      },
      travel,
      costs,
      hire,
      permissions: {
        canManage: hasPermission(principal, 'recruiting.manage'),
        canSafety: hasPermission(principal, SAFETY_DECIDE_PERMISSION),
        canAccounting: hasPermission(principal, 'accounting.edit'),
        canSeeSensitive: hasPermission(principal, 'compliance_sensitive.view'),
      },
    };
  }

  // ------------------------------------------------------------------------------- consent

  async consentIssue(principal: Principal, key: string) {
    this.manage(principal);
    return this.consents.issue(principal, await this.subject(principal, key));
  }
  async consentCopied(principal: Principal, key: string) {
    this.manage(principal);
    return this.consents.markCopied(principal, await this.subject(principal, key));
  }
  async consentMarkSent(principal: Principal, key: string, channel: string | null) {
    this.manage(principal);
    return this.consents.markSent(principal, await this.subject(principal, key), channel);
  }
  /** Kept for the earlier screen: emails the consent link through the delivery service. */
  async consentEmail(principal: Principal, key: string, to: string | null) {
    return this.deliveries.send(principal, key, { link: 'consent', channel: 'email', to });
  }

  // ----------------------------------------------------------------- sending links (SMS / email)

  async sendLink(principal: Principal, key: string, input: SendLinkRequest) {
    return this.deliveries.send(principal, key, input);
  }
  async resendLink(principal: Principal, key: string, id: string) {
    return this.deliveries.resend(principal, key, id);
  }
  async refreshLink(principal: Principal, key: string, id: string) {
    return this.deliveries.refresh(principal, key, id);
  }
  /** Texting consent for the candidate's phone: staff record the opt-in, or turn texts off. */
  async smsConsent(principal: Principal, key: string, input: { action: 'opt_in' | 'opt_out'; source: SmsOptInSource | null; note: string | null }) {
    this.manage(principal);
    const c = await this.recruit.candidate(principal, key);
    if (!c.phone) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'This candidate has no phone number.' });
    await this.smsPrefs.setByStaff(principal, c.phone, input);
    return this.smsPrefs.view(principal.companyId, c.phone);
  }
  async consentRevoke(principal: Principal, key: string, reason: string | null) {
    this.manage(principal);
    return this.consents.revoke(principal, await this.subject(principal, key), reason);
  }
  async consentFile(principal: Principal, key: string, fileId: string) {
    return this.consents.fileBytes(principal, await this.subject(principal, key), fileId);
  }
  async consentSignature(principal: Principal, key: string) {
    return this.consents.signatureImage(principal, await this.subject(principal, key));
  }
  async consentDocumentPdf(principal: Principal, key: string, documentId: string) {
    return this.consents.documentPdf(principal, await this.subject(principal, key), documentId);
  }

  // -------------------------------------------------------------------------------- safety

  async sendToSafety(principal: Principal, key: string, note: string | null) {
    this.manage(principal);
    const subject = await this.subject(principal, key);
    // Any Yes on the consent's safety questions disqualifies under the company hiring policy, so the
    // file does not go to Safety even with MVR and PSP on file (owner, 2026-10-16).
    const consent = await this.consents.view(principal, subject);
    // safetyDisqualified is lifted when Recruiting reopened the candidate after this consent.
    if (consent.submission?.safetyDisqualified) {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'Any Yes on the safety questions disqualifies this driver per company hiring policy; the file is not sent to Safety.' });
    }
    await this.safety.open(principal, subject, note);
  }
  async safetyDecide(principal: Principal, key: string, input: SafetyStatusChangeRequest) {
    await this.safety.decide(principal, await this.subject(principal, key), input);
  }
  async safetyUpload(principal: Principal, key: string, input: SafetyReportUploadRequest) {
    return this.safety.upload(principal, await this.subject(principal, key), input);
  }
  async safetyReviewReport(principal: Principal, key: string, reportId: string, input: { result: 'pending' | 'clear' | 'findings' | 'prohibited'; note: string | null; version: number }) {
    return this.safety.reviewReport(principal, await this.subject(principal, key), reportId, input);
  }
  async safetyFullQuery(principal: Principal, key: string, status: 'not_requested' | 'requested' | 'received' | 'declined', version: number) {
    await this.safety.setFullQuery(principal, await this.subject(principal, key), status, version);
  }
  async safetyCheckRequest(principal: Principal, key: string, input: SafetyCheckRequest) {
    return this.safety.requestCheck(principal, await this.subject(principal, key), input);
  }
  async safetyCheckPending(principal: Principal, key: string, kind: string, input: { orderRef: string | null; note: string | null; version: number }) {
    return this.safety.markCheckPending(principal, await this.subject(principal, key), kind, input);
  }
  async safetyReportFile(principal: Principal, key: string, reportId: string) {
    return this.safety.reportFile(principal, await this.subject(principal, key), reportId);
  }

  // --------------------------------------------------------------------------- application

  /** Review application (step 6): a recruiter read the received application. Once; audited. */
  async markApplicationReviewed(principal: Principal, key: string) {
    this.manage(principal);
    const subject = await this.subject(principal, key);
    const view = await this.driverApps.view(principal, subject);
    if (!view.submission || !subject.caseId) throw new AppError({ status: 409, title: 'Conflict', detail: 'No application has been received yet.' });
    const c = await this.hiring.row(principal, subject.caseId);
    if (c.applicationReviewedAt) return;
    const at = new Date();
    const by = principal.userName ?? principal.userId;
    const event = await this.db.transaction(async (tx) => {
      await tx.update(hiringCases).set({ applicationReviewedAt: at, applicationReviewedBy: by, updatedAt: at }).where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.id, c.id)));
      return this.audit.writeIn(tx, principal, {
        action: 'application_reviewed',
        entityType: 'hiring_case',
        entityId: c.id,
        entityLabel: c.candidateName,
        summary: `Application ${view.submission?.reference ?? ''} reviewed`.trim(),
        at,
      });
    });
    await this.audit.publish(event);
  }

  // ------------------------------------------------------------------- onboarding and costs

  async startOnboarding(principal: Principal, key: string) {
    this.manage(principal);
    await this.onboarding.start(principal, (await this.subject(principal, key)).caseId);
  }
  async addTask(principal: Principal, key: string, input: { label: string; required: boolean; dueOn: string | null }) {
    this.manage(principal);
    return this.onboarding.addTask(principal, (await this.subject(principal, key)).caseId, input);
  }
  async updateTask(principal: Principal, key: string, taskId: string, input: OnboardingTaskUpdateRequest) {
    this.manage(principal);
    return this.onboarding.updateTask(principal, (await this.subject(principal, key)).caseId, taskId, input);
  }
  async addTravel(principal: Principal, key: string, input: TravelItemRequest) {
    this.manage(principal);
    return this.onboarding.addTravel(principal, (await this.subject(principal, key)).caseId, input);
  }
  async updateTravel(principal: Principal, key: string, id: string, input: Omit<TravelItemRequest, 'kind'> & { status: 'booked' | 'rescheduled'; version: number }) {
    this.manage(principal);
    return this.onboarding.updateTravel(principal, (await this.subject(principal, key)).caseId, id, input);
  }
  async cancelTravel(principal: Principal, key: string, id: string, reason: string, version: number) {
    this.manage(principal);
    return this.onboarding.cancelTravel(principal, (await this.subject(principal, key)).caseId, id, reason, version);
  }
  async addCost(principal: Principal, key: string, input: CandidateCostRequest & { clientKey?: string | null }) {
    this.manage(principal);
    return this.onboarding.addCost(principal, (await this.subject(principal, key)).caseId, input);
  }
  async decideCost(principal: Principal, key: string, id: string, input: { decision: 'approved' | 'rejected'; note: string | null; version: number }) {
    this.manage(principal);
    return this.onboarding.decideCost(principal, (await this.subject(principal, key)).caseId, id, input);
  }
  async costAgreement(principal: Principal, key: string, id: string, note: string, version: number) {
    this.manage(principal);
    return this.onboarding.recordAgreement(principal, (await this.subject(principal, key)).caseId, id, note, version);
  }
  async costPayment(principal: Principal, key: string, id: string, paidOn: string, note: string | null, version: number) {
    if (!hasPermission(principal, 'accounting.edit') && !hasPermission(principal, 'recruiting.manage')) throw forbidden('Recording a payment needs recruiting or accounting.');
    return this.onboarding.recordPayment(principal, (await this.subject(principal, key)).caseId, id, paidOn, note, version);
  }
  async costRefund(principal: Principal, key: string, id: string, input: { refundAmount: number; nonrefundableFee: number | null; note: string | null; version: number }) {
    this.manage(principal);
    return this.onboarding.recordRefund(principal, (await this.subject(principal, key)).caseId, id, input);
  }

  // ------------------------------------------------------------------------------------ hire

  async hold(principal: Principal, key: string, hold: boolean, reason: string | null) {
    this.manage(principal);
    await this.hire.hold(principal, (await this.subject(principal, key)).caseId, hold, reason);
  }
  async withdraw(principal: Principal, key: string, reason: string) {
    this.manage(principal);
    await this.hire.withdraw(principal, (await this.subject(principal, key)).caseId, reason);
  }
  async hireDriver(principal: Principal, key: string, input: HireCandidateRequest) {
    this.manage(principal);
    return this.hire.hire(principal, (await this.subject(principal, key)).caseId, input);
  }

  /** The consent behind an application session, for the application page's inheritance. */
  async consentForCase(companyId: string, caseId: string) {
    const [row] = await this.db.select().from(hiringConsents).where(and(eq(hiringConsents.companyId, companyId), eq(hiringConsents.hiringCaseId, caseId))).limit(1);
    return row ?? null;
  }
}
