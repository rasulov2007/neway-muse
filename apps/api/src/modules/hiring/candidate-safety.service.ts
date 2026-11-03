import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, inArray, isNull, ne, or } from 'drizzle-orm';
import {
  CONSENT_DOCUMENT_LABELS,
  CONSENT_DOCUMENT_TYPES,
  SAFETY_CHECK_KINDS,
  SAFETY_CHECK_LABELS,
  SAFETY_CHECK_STATUS_LABELS,
  SAFETY_REPORT_LABELS,
  type CandidateSafetyStatus,
  type ConsentDocumentType,
  type SafetyDeskList,
  type SafetyDeskRow,
  type SafetyCheckKind,
  type SafetyCheckRequest,
  type SafetyCheckStatus,
  type SafetyCheckView,
  type CandidateSafetyView,
  type FmcsaFullQueryStatus,
  type SafetyReportKind,
  type SafetyReportResult,
  type SafetyReportUploadRequest,
  type SafetyStatusChangeRequest,
  type SafetyReportView,
  type SafetyInsuranceStatus,
  type SafetyInsuranceView,
  validityMonthsFor,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { memberships, membershipRoles, notifications, rolePermissions } from '../../database/schema/admin';
import {
  hiringCases,
  hiringConsentDocuments,
  hiringConsents,
  hiringLeads,
  hiringSafetyChecks,
  hiringSafetyReports,
  hiringSafetyReviews,
  type HiringCaseRow,
  type HiringSafetyCheckRow,
  type HiringSafetyReportRow,
  type HiringSafetyReviewRow,
} from '../../database/schema/hiring';
import { complianceDocuments } from '../../database/schema/compliance';
import { ComplianceService } from '../compliance/compliance.service';
import { seesSensitive } from '../compliance/sensitive';
import { sniff } from '../driver-relations/receipts';
import { AuditService } from '../people/audit.service';
import type { ApplicationSubject } from './driver-application.service';
import { currentDisclosures } from './consent-disclosures';
import { ConsentService } from './consent.service';
import { HiringDocumentsService } from './hiring-documents.service';
import { HiringService } from './hiring.service';

/** Only Safety decides: the same permission that verifies the qualification file. */
export const SAFETY_DECIDE_PERMISSION = 'compliance.manage';

/**
 * The reports "Qualified" needs, each with a recorded result. The pre-employment Clearinghouse full
 * query is its own requirement on the hire checklist (owner, 2026-10-11), not part of this decision.
 */
const REQUIRED_FOR_APPROVAL: readonly SafetyReportKind[] = ['mvr', 'psp'];

/** Where each report is filed in the driver's qualification file. */
const REQUIREMENT_FOR: Record<SafetyReportKind, string> = {
  mvr: 'mvr_review',
  psp: 'psp_review',
  clearinghouse_limited: 'clearinghouse_query',
  clearinghouse_full: 'clearinghouse_query',
  other: 'background_check',
};

/** The signed consent each check runs under; the full query runs under the driver's own FMCSA consent. */
const AUTHORIZED_BY: Record<SafetyCheckKind, 'mvr' | 'psp' | 'clearinghouse' | 'fmcsa'> = {
  mvr: 'mvr',
  psp: 'psp',
  clearinghouse_limited: 'clearinghouse',
  clearinghouse_full: 'fmcsa',
};

const isCheckKind = (k: string): k is SafetyCheckKind => (SAFETY_CHECK_KINDS as readonly string[]).includes(k);

/**
 * The term of each report from the day it was received: the catalog's own (MVR and PSP 6 months
 * since 2026-10-24, Clearinghouse 12), and 12 for an "other" report filed as a background check.
 */
const EXPIRES_MONTHS: Partial<Record<string, number>> = {
  mvr_review: validityMonthsFor('mvr_review') ?? 6,
  psp_review: validityMonthsFor('psp_review') ?? 6,
  clearinghouse_query: validityMonthsFor('clearinghouse_query') ?? 12,
  background_check: 12,
};

function conflict(detail: string, extensions?: Record<string, unknown>): AppError {
  return new AppError({ status: 409, title: 'Conflict', detail, extensions });
}

const addMonths = (iso: string, months: number) => {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCMonth(d.getUTCMonth() + months);
  return d.toISOString().slice(0, 10);
};
const easternToday = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/**
 * The candidate's Safety review (step 4, owner brief 2026-10-11).
 *
 * Recruiting opens it once the consent is signed ("Send to Safety"). Safety uploads the reports it
 * ran — MVR, PSP and the Clearinghouse — into the driver's qualification file, records a result on
 * each, and decides: In review, Needs follow-up, Approved or Declined. Signed authorizations are
 * shown apart from reports: a signature is permission to check, not a result. Nothing here runs an
 * external check, and neither a signature nor an uploaded report approves anybody — only a person
 * with the Safety permission does, and approval needs every required report with a result.
 * A decline closes the candidate; the application invite stays blocked until an approval.
 */
@Injectable()
export class CandidateSafetyService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly hiring: HiringService,
    private readonly documents: HiringDocumentsService,
    private readonly consents: ConsentService,
    private readonly compliance: ComplianceService,
  ) {}

  /**
   * A report Safety reviewed is a reviewed document: the qualification file says so too, instead of
   * "Pending review" beside a result (owner, 2026-10-12). Already verified documents are left alone.
   */
  private async settleDocuments(principal: Principal, reports: { documentId: string | null; result: string }[]): Promise<void> {
    for (const r of reports) {
      if (!r.documentId || r.result === 'pending') continue;
      try {
        const [doc] = await this.db.select({ status: complianceDocuments.status }).from(complianceDocuments).where(and(eq(complianceDocuments.companyId, principal.companyId), eq(complianceDocuments.id, r.documentId))).limit(1);
        if (doc && doc.status !== 'verified') await this.compliance.verifyDocument(principal, r.documentId);
      } catch {
        // The review stands either way; the file catches up on the next review or decision.
      }
    }
  }

  private get db() {
    return this.database.db;
  }

  async reviewFor(companyId: string, caseId: string | null): Promise<HiringSafetyReviewRow | null> {
    if (!caseId) return null;
    const [row] = await this.db
      .select()
      .from(hiringSafetyReviews)
      .where(and(eq(hiringSafetyReviews.companyId, companyId), eq(hiringSafetyReviews.hiringCaseId, caseId)))
      .limit(1);
    return row ?? null;
  }

  /** Review status per case, for the list (one query). */
  async statuses(companyId: string, caseIds: string[]): Promise<Map<string, CandidateSafetyStatus>> {
    const out = new Map<string, CandidateSafetyStatus>();
    if (caseIds.length === 0) return out;
    const rows = await this.db
      .select({ caseId: hiringSafetyReviews.hiringCaseId, status: hiringSafetyReviews.status })
      .from(hiringSafetyReviews)
      .where(and(eq(hiringSafetyReviews.companyId, companyId), inArray(hiringSafetyReviews.hiringCaseId, caseIds)));
    for (const r of rows) out.set(r.caseId, r.status as CandidateSafetyStatus);
    return out;
  }

  private reportView(r: HiringSafetyReportRow): SafetyReportView {
    return {
      id: r.id,
      kind: r.kind as SafetyReportKind,
      label: SAFETY_REPORT_LABELS[r.kind as SafetyReportKind] ?? r.kind,
      result: r.result as SafetyReportResult,
      status: r.status as 'received' | 'reviewed',
      documentId: r.documentId,
      fileName: r.fileName,
      receivedOn: r.receivedOn,
      note: r.note,
      uploadedAt: r.uploadedAt.toISOString(),
      uploadedByName: r.uploadedByName,
      reviewedAt: r.reviewedAt?.toISOString() ?? null,
      reviewedByName: r.reviewedByName,
      reviewNote: r.reviewNote,
      version: r.version,
    };
  }

  async view(principal: Principal, subject: ApplicationSubject): Promise<CandidateSafetyView> {
    const review = await this.reviewFor(principal.companyId, subject.caseId);
    const consent = await this.consents.consentFor(principal.companyId, { caseId: subject.caseId, leadId: subject.leadId });
    const signed = consent
      ? await this.db
          .select({ type: hiringConsentDocuments.documentType, at: hiringConsentDocuments.signedAt, validUntil: hiringConsentDocuments.validUntil })
          .from(hiringConsentDocuments)
          .where(and(eq(hiringConsentDocuments.companyId, principal.companyId), eq(hiringConsentDocuments.consentId, consent.id)))
      : [];
    const reports = review
      ? await this.db
          .select()
          .from(hiringSafetyReports)
          .where(and(eq(hiringSafetyReports.companyId, principal.companyId), eq(hiringSafetyReports.reviewId, review.id), isNull(hiringSafetyReports.voidedAt)))
          .orderBy(asc(hiringSafetyReports.uploadedAt))
      : [];
    const canDecide = hasPermission(principal, SAFETY_DECIDE_PERMISSION);
    const checkRows = review
      ? await this.db
          .select()
          .from(hiringSafetyChecks)
          .where(and(eq(hiringSafetyChecks.companyId, principal.companyId), eq(hiringSafetyChecks.reviewId, review.id)))
      : [];
    const checks = SAFETY_CHECK_KINDS.map((kind) =>
      this.checkView(
        kind,
        checkRows.find((r) => r.kind === kind) ?? null,
        reports.filter((r) => r.kind === kind),
        signed,
        (review?.fmcsaFullQueryStatus as FmcsaFullQueryStatus | undefined) ?? 'not_requested',
      ),
    );
    return {
      review: review
        ? {
            id: review.id,
            status: review.status as CandidateSafetyStatus,
            openedAt: review.openedAt.toISOString(),
            openedByName: review.openedByName,
            requestNote: review.requestNote,
            fmcsaFullQueryStatus: review.fmcsaFullQueryStatus as FmcsaFullQueryStatus,
            fmcsaFullQueryAt: review.fmcsaFullQueryAt?.toISOString() ?? null,
            decidedAt: review.decidedAt?.toISOString() ?? null,
            decidedByName: review.decidedByName,
            decisionNote: review.decisionNote,
            insurance: this.insuranceView(review),
            version: review.version,
          }
        : null,
      authorizations: CONSENT_DOCUMENT_TYPES.map((type) => ({
        type,
        label: CONSENT_DOCUMENT_LABELS[type],
        signedAt: signed.find((s) => s.type === type)?.at.toISOString() ?? null,
      })),
      reports: reports.map((r) => this.reportView(r)),
      checks,
      canDecide,
      canUpload: canDecide || hasPermission(principal, 'recruiting.manage'),
    };
  }

  private insuranceView(review: HiringSafetyReviewRow): SafetyInsuranceView | null {
    if (!review.insuranceStatus) return null;
    return {
      status: review.insuranceStatus as SafetyInsuranceStatus,
      note: review.insuranceNote,
      requestedAt: review.insuranceRequestedAt?.toISOString() ?? null,
      requestedBy: review.insuranceRequestedBy,
      respondedAt: review.insuranceRespondedAt?.toISOString() ?? null,
      respondedBy: review.insuranceRespondedBy,
    };
  }

  /**
   * Insurance check (owner, 2026-10-12): Safety asks the insurer about the candidate, and
   * Recruiting is told the driver is being checked with insurance. Version-checked, audited.
   */
  async requestInsurance(principal: Principal, subject: ApplicationSubject, input: { note: string | null; version: number }): Promise<void> {
    this.assertSafety(principal);
    if (!subject.caseId) throw conflict('This candidate has not been sent to Safety yet.');
    const caseId = subject.caseId;
    await this.hiring.withLock(`candidate-safety:${caseId}`, async () => {
      const review = await this.openReview(principal, caseId);
      if (review.version !== input.version) throw conflict('Someone else changed this review. Reload and try again.');
      if (review.status === 'approved' || review.status === 'declined') throw conflict('The review is already decided.');
      const c = await this.hiring.row(principal, caseId);
      const at = new Date();
      const by = principal.userName ?? principal.userId;
      await this.db
        .update(hiringSafetyReviews)
        .set({ insuranceStatus: 'pending', insuranceNote: input.note, insuranceRequestedAt: at, insuranceRequestedBy: by, insuranceRespondedAt: null, insuranceRespondedBy: null, version: review.version + 1, updatedAt: at })
        .where(and(eq(hiringSafetyReviews.id, review.id), eq(hiringSafetyReviews.version, review.version)));
      await this.audit.write(principal, { action: 'safety_insurance_requested', entityType: 'hiring_case', entityId: caseId, entityLabel: c.candidateName, summary: `Insurance check requested${input.note ? ` — ${input.note}` : ''}`, changes: [{ field: 'insurance', old: review.insuranceStatus, new: 'pending' }] });
      await this.notifyRecruitingText(principal, c, review, {
        key: `insurance_pending:${at.getTime()}`,
        severity: 'info',
        title: `Insurance check — ${c.candidateName}`,
        body: `Safety is checking ${c.candidateName} with insurance${input.note ? `: ${input.note}` : '.'}`,
      }).catch(() => undefined);
    });
  }

  /** The insurer's answer, recorded by Safety; Recruiting hears it too. */
  async recordInsurance(principal: Principal, subject: ApplicationSubject, input: { result: 'approved' | 'declined'; note: string | null; version: number }): Promise<void> {
    this.assertSafety(principal);
    if (!subject.caseId) throw conflict('This candidate has not been sent to Safety yet.');
    const caseId = subject.caseId;
    await this.hiring.withLock(`candidate-safety:${caseId}`, async () => {
      const review = await this.openReview(principal, caseId);
      if (review.version !== input.version) throw conflict('Someone else changed this review. Reload and try again.');
      if (review.status === 'approved' || review.status === 'declined') throw conflict('The review is already decided.');
      if (input.result === 'declined' && !input.note) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'Say what the insurer answered.' });
      const c = await this.hiring.row(principal, caseId);
      const at = new Date();
      const by = principal.userName ?? principal.userId;
      await this.db
        .update(hiringSafetyReviews)
        .set({ insuranceStatus: input.result, insuranceNote: input.note ?? review.insuranceNote, insuranceRequestedAt: review.insuranceRequestedAt ?? at, insuranceRequestedBy: review.insuranceRequestedBy ?? by, insuranceRespondedAt: at, insuranceRespondedBy: by, version: review.version + 1, updatedAt: at })
        .where(and(eq(hiringSafetyReviews.id, review.id), eq(hiringSafetyReviews.version, review.version)));
      await this.audit.write(principal, { action: 'safety_insurance_response', entityType: 'hiring_case', entityId: caseId, entityLabel: c.candidateName, summary: `Insurance ${input.result}${input.note ? ` — ${input.note}` : ''}`, changes: [{ field: 'insurance', old: review.insuranceStatus, new: input.result }] });
      await this.notifyRecruitingText(principal, c, review, {
        key: `insurance_${input.result}:${at.getTime()}`,
        severity: input.result === 'approved' ? 'info' : 'warning',
        title: `Insurance ${input.result} — ${c.candidateName}`,
        body: `The insurer ${input.result === 'approved' ? 'accepted' : 'did not accept'} ${c.candidateName}${input.note ? `: ${input.note}` : '.'}`,
      }).catch(() => undefined);
    });
  }

  /**
   * One check as Safety sees it. Its own row when it was ordered here; otherwise what the reports on
   * file say (received, or reviewed once a result was recorded) — never more than that.
   */
  private checkView(
    kind: SafetyCheckKind,
    row: HiringSafetyCheckRow | null,
    reports: HiringSafetyReportRow[],
    signed: { type: string; at: Date; validUntil: Date | null }[],
    fullQuery: FmcsaFullQueryStatus,
  ): SafetyCheckView {
    const auth = AUTHORIZED_BY[kind];
    const doc = auth === 'fmcsa' ? null : (signed.find((x) => x.type === auth) ?? null);
    const signedAt = doc?.at ?? null;
    // The limited consent's company scope: one query, within its validity (30 days from signing).
    const expired = Boolean(doc?.validUntil && doc.validUntil.getTime() < Date.now());
    const wordingMissing = auth === 'clearinghouse' && currentDisclosures().pending.includes('clearinghouse');
    const authorization =
      auth === 'fmcsa'
        ? {
            label: "Driver's full-query consent in the FMCSA Clearinghouse",
            given: fullQuery === 'received',
            detail: `${fullQuery.replace(/_/g, ' ')} — given by the driver inside the Clearinghouse; the limited-query consent does not replace it`,
          }
        : {
            label: `${auth === 'mvr' ? 'MVR' : auth === 'psp' ? 'PSP' : 'Clearinghouse limited-query'} consent`,
            given: Boolean(signedAt) && !expired,
            detail: signedAt
              ? `Signed ${signedAt.toISOString()}${doc?.validUntil ? ` · one limited query until ${doc.validUntil.toISOString()}${expired ? ' (expired)' : ''}` : ''}`
              : wordingMissing
                ? "Not offered yet: the company's official wording is not on file"
                : 'Not signed',
          };
    const latest = [...reports].sort((a, b) => b.uploadedAt.getTime() - a.uploadedAt.getTime())[0] ?? null;
    const reviewedReport = reports.find((r) => r.status === 'reviewed') ?? null;
    const derived: SafetyCheckStatus = reviewedReport ? 'reviewed' : latest ? 'received' : 'not_requested';
    const iso = (d: Date | null | undefined) => (d ? d.toISOString() : null);
    let blockedReason: string | null = null;
    if (wordingMissing && !signedAt) blockedReason = "The company's Clearinghouse limited-consent wording is not on file, so the candidate could not sign it.";
    else if (auth !== 'fmcsa' && !signedAt) blockedReason = `The ${authorization.label} is not signed.`;
    else if (expired) blockedReason = `The ${authorization.label} was for one query within 30 days of signing; it expired on ${doc?.validUntil?.toISOString().slice(0, 10)}.`;
    return {
      kind,
      label: SAFETY_CHECK_LABELS[kind],
      status: row ? (row.status as SafetyCheckStatus) : derived,
      required: (REQUIRED_FOR_APPROVAL as readonly string[]).includes(kind),
      authorization,
      blockedReason,
      provider: row?.provider ?? 'manual',
      orderRef: row?.orderRef ?? null,
      note: row?.note ?? null,
      requestedAt: iso(row?.requestedAt),
      requestedByName: row?.requestedByName ?? null,
      pendingAt: iso(row?.pendingAt),
      pendingByName: row?.pendingByName ?? null,
      receivedAt: iso(row?.receivedAt ?? latest?.uploadedAt),
      receivedByName: row?.receivedByName ?? latest?.uploadedByName ?? null,
      reportId: row?.reportId ?? latest?.id ?? null,
      reviewedAt: iso(row?.reviewedAt ?? reviewedReport?.reviewedAt),
      reviewedByName: row?.reviewedByName ?? reviewedReport?.reviewedByName ?? null,
      result: (row?.result ?? reviewedReport?.result ?? null) as SafetyReportResult | null,
      version: row?.version ?? 0,
    };
  }

  private async checkRow(companyId: string, reviewId: string, kind: SafetyCheckKind): Promise<HiringSafetyCheckRow | null> {
    const [row] = await this.db
      .select()
      .from(hiringSafetyChecks)
      .where(and(eq(hiringSafetyChecks.companyId, companyId), eq(hiringSafetyChecks.reviewId, reviewId), eq(hiringSafetyChecks.kind, kind)))
      .limit(1);
    return row ?? null;
  }

  /**
   * Requested: Safety ordered the check — in the provider's own site ("manual") or through a vendor
   * — under the candidate's signed authorization. No authorization, no order.
   */
  async requestCheck(principal: Principal, subject: ApplicationSubject, input: SafetyCheckRequest): Promise<SafetyCheckView> {
    this.assertCanFile(principal);
    const review = await this.openReview(principal, subject.caseId, 'filing');
    if (review.status === 'approved' || review.status === 'declined') throw conflict('The review is decided; checks can no longer be ordered.');
    const current = (await this.view(principal, subject)).checks.find((c) => c.kind === input.kind) as SafetyCheckView;
    if (current.blockedReason) throw conflict(`${SAFETY_CHECK_LABELS[input.kind]} cannot be ordered: ${current.blockedReason}`);
    if (current.status !== 'not_requested') throw conflict(`${SAFETY_CHECK_LABELS[input.kind]} is already ${SAFETY_CHECK_STATUS_LABELS[current.status].toLowerCase()}.`);
    const at = new Date();
    const by = principal.userName ?? principal.userId;
    const c = await this.hiring.row(principal, review.hiringCaseId);
    const where = input.provider !== 'manual' ? ` through ${input.provider}` : " (run by Safety in the provider's own site)";
    const event = await this.db.transaction(async (tx) => {
      const [done] = await tx
        .insert(hiringSafetyChecks)
        .values({
          id: `hsc_${crypto.randomUUID()}`,
          companyId: principal.companyId,
          reviewId: review.id,
          hiringCaseId: review.hiringCaseId,
          kind: input.kind,
          status: 'requested',
          provider: input.provider,
          orderRef: input.orderRef,
          note: input.note,
          requestedAt: at,
          requestedByUserId: principal.userId,
          requestedByName: by,
        })
        .onConflictDoNothing()
        .returning({ id: hiringSafetyChecks.id });
      if (!done) throw conflict('Someone else ordered this check. Reload.');
      return this.audit.writeIn(tx, principal, {
        action: 'safety_check_requested',
        entityType: 'hiring_case',
        entityId: review.hiringCaseId,
        entityLabel: c.candidateName,
        summary: `${SAFETY_CHECK_LABELS[input.kind]} requested${where}${input.orderRef ? ` · ref ${input.orderRef}` : ''}`,
        changes: [{ field: `check_${input.kind}`, old: 'not_requested', new: 'requested' }],
        at,
      });
    });
    await this.audit.publish(event);
    return (await this.view(principal, subject)).checks.find((x) => x.kind === input.kind) as SafetyCheckView;
  }

  /** Pending: the provider has the order and the result is outstanding. */
  async markCheckPending(principal: Principal, subject: ApplicationSubject, kind: string, input: { orderRef: string | null; note: string | null; version: number }): Promise<SafetyCheckView> {
    this.assertCanFile(principal);
    if (!isCheckKind(kind)) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such check.' });
    const review = await this.openReview(principal, subject.caseId, 'filing');
    const row = await this.checkRow(principal.companyId, review.id, kind);
    if (!row || row.status !== 'requested') throw conflict(`${SAFETY_CHECK_LABELS[kind]} must be requested before it can be pending.`);
    if (row.version !== input.version) throw conflict('Someone else changed this check. Reload and try again.');
    const at = new Date();
    const by = principal.userName ?? principal.userId;
    const c = await this.hiring.row(principal, review.hiringCaseId);
    const ref = input.orderRef ?? row.orderRef;
    const event = await this.db.transaction(async (tx) => {
      const [done] = await tx
        .update(hiringSafetyChecks)
        .set({ status: 'pending', pendingAt: at, pendingByName: by, orderRef: ref, note: input.note ?? row.note, version: row.version + 1, updatedAt: at })
        .where(and(eq(hiringSafetyChecks.id, row.id), eq(hiringSafetyChecks.version, row.version)))
        .returning({ id: hiringSafetyChecks.id });
      if (!done) throw conflict('Someone else changed this check. Reload and try again.');
      return this.audit.writeIn(tx, principal, {
        action: 'safety_check_pending',
        entityType: 'hiring_case',
        entityId: review.hiringCaseId,
        entityLabel: c.candidateName,
        summary: `${SAFETY_CHECK_LABELS[kind]} pending with the provider${ref ? ` · ref ${ref}` : ''}`,
        changes: [{ field: `check_${kind}`, old: 'requested', new: 'pending' }],
        at,
      });
    });
    await this.audit.publish(event);
    return (await this.view(principal, subject)).checks.find((x) => x.kind === kind) as SafetyCheckView;
  }

  /** A report arrived or was reviewed: the check moves to Received or Reviewed, in the same transaction. */
  private async syncCheck(
    tx: Pick<typeof this.db, 'select' | 'insert' | 'update'>,
    review: HiringSafetyReviewRow,
    kind: string,
    patch: { reportId: string; by: string; at: Date; result: string },
  ): Promise<void> {
    if (!isCheckKind(kind)) return;
    const reviewed = patch.result !== 'pending';
    const [row] = await tx
      .select()
      .from(hiringSafetyChecks)
      .where(and(eq(hiringSafetyChecks.reviewId, review.id), eq(hiringSafetyChecks.kind, kind)))
      .limit(1);
    const fields = {
      status: reviewed ? 'reviewed' : 'received',
      reportId: patch.reportId,
      ...(row?.receivedAt ? {} : { receivedAt: patch.at, receivedByName: patch.by }),
      ...(reviewed ? { reviewedAt: patch.at, reviewedByName: patch.by, result: patch.result } : {}),
      updatedAt: patch.at,
    };
    if (row) {
      await tx.update(hiringSafetyChecks).set({ ...fields, version: row.version + 1 }).where(eq(hiringSafetyChecks.id, row.id));
    } else {
      await tx.insert(hiringSafetyChecks).values({
        id: `hsc_${crypto.randomUUID()}`,
        companyId: review.companyId,
        reviewId: review.id,
        hiringCaseId: review.hiringCaseId,
        kind,
        provider: 'manual',
        ...fields,
      });
    }
  }

  /**
   * Send to Safety (step 3 → 4): once the consent is signed. Opens the review (once), stamps the
   * case's Safety request, and tells the Safety desk in the app.
   */
  async open(principal: Principal, subject: ApplicationSubject, note: string | null): Promise<void> {
    if (!subject.caseId) throw conflict('The consent has not been received yet.');
    const caseId = subject.caseId;
    await this.hiring.withLock(`candidate-safety:${caseId}`, async () => {
      const consent = await this.consents.consentFor(principal.companyId, { caseId, leadId: subject.leadId });
      if (!consent) throw conflict('Send to Safety needs the signed consent first.');
      const existing = await this.reviewFor(principal.companyId, caseId);
      if (existing && existing.status !== 'preparing') throw conflict('This candidate is already with Safety.');
      // Recruiting files the MVR and PSP first; Safety only decides (owner, 2026-10-13).
      const filed = existing
        ? await this.db
            .select({ kind: hiringSafetyReports.kind })
            .from(hiringSafetyReports)
            .where(and(eq(hiringSafetyReports.companyId, principal.companyId), eq(hiringSafetyReports.reviewId, existing.id), isNull(hiringSafetyReports.voidedAt)))
        : [];
      const missing = (['mvr', 'psp'] as const).filter((k) => !filed.some((f) => f.kind === k));
      if (missing.length > 0) throw conflict(`Upload the ${missing.map((k) => k.toUpperCase()).join(' and ')} report${missing.length > 1 ? 's' : ''} first, then send to Safety.`);
      const c = await this.hiring.row(principal, caseId);
      if (['disqualified', 'withdrawn', 'no_show', 'declined_offer', 'hired', 'active_driver'].includes(c.state)) {
        throw conflict('This candidate is no longer in the hiring pipeline.');
      }
      const at = new Date();
      const by = principal.userName ?? principal.userId;
      const event = await this.db.transaction(async (tx) => {
        // The review Recruiting prepared becomes Safety's, dated from the send.
        await tx
          .update(hiringSafetyReviews)
          .set({ status: 'in_review', openedAt: at, openedByUserId: principal.userId, openedByName: by, requestNote: note, version: (existing as HiringSafetyReviewRow).version + 1, updatedAt: at })
          .where(eq(hiringSafetyReviews.id, (existing as HiringSafetyReviewRow).id));
        await tx
          .update(hiringCases)
          .set({ safetyRequestedAt: c.safetyRequestedAt ?? at, safetyRequestedBy: c.safetyRequestedBy ?? by, safetyRequestNote: note, updatedAt: at })
          .where(eq(hiringCases.id, caseId));
        return this.audit.writeIn(tx, principal, {
          action: 'safety_review_requested',
          entityType: 'hiring_case',
          entityId: caseId,
          entityLabel: c.candidateName,
          summary: `Sent to Safety after the consent was signed${note ? `: ${note}` : ''}`,
          at,
        });
      });
      await this.audit.publish(event);
      await this.notifySafety(principal, c).catch(() => undefined);
    });
  }

  private async notifySafety(principal: Principal, c: HiringCaseRow): Promise<void> {
    const recipients = (
      await this.db
        .selectDistinct({ userId: memberships.userId })
        .from(memberships)
        .leftJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
        .leftJoin(rolePermissions, eq(rolePermissions.roleId, membershipRoles.roleId))
        .where(
          and(
            eq(memberships.companyId, principal.companyId),
            eq(memberships.status, 'active'),
            or(eq(rolePermissions.permissionCode, SAFETY_DECIDE_PERMISSION), eq(memberships.isOwner, true)),
          ),
        )
    ).map((r) => r.userId);
    if (recipients.length === 0) return;
    await this.db
      .insert(notifications)
      .values(
        recipients.map((userId) => ({
          id: `ntf_${crypto.randomUUID()}`,
          companyId: principal.companyId,
          recipientUserId: userId,
          severity: 'info',
          title: `Safety decision needed — ${c.candidateName}`,
          body: `${c.candidateName} signed the MVR, PSP and Clearinghouse consents. Review them in Safety › Hiring decisions and mark Qualified or Not qualified.`,
          entityType: 'hiring_safety',
          entityId: c.id,
          source: 'system',
          dedupeKey: `candidate_safety:${c.id}:${userId}`,
        })),
      )
      .onConflictDoNothing();
  }

  // --------------------------------------------------------------------------- Safety's desk

  /** Everyone sent to Safety: waiting (oldest first) and decided (newest first). */
  async desk(principal: Principal): Promise<SafetyDeskList> {
    const reviews = await this.db
      .select({ review: hiringSafetyReviews, c: hiringCases })
      .from(hiringSafetyReviews)
      .innerJoin(hiringCases, eq(hiringCases.id, hiringSafetyReviews.hiringCaseId))
      .where(and(eq(hiringSafetyReviews.companyId, principal.companyId), eq(hiringCases.isTest, false), ne(hiringSafetyReviews.status, 'preparing')))
      .orderBy(asc(hiringSafetyReviews.openedAt));
    const rows = await this.deskRows(principal.companyId, reviews);
    return {
      waiting: rows.filter((r) => r.status !== 'approved' && r.status !== 'declined'),
      decided: rows.filter((r) => r.status === 'approved' || r.status === 'declined').sort((a, b) => (b.decidedAt ?? '').localeCompare(a.decidedAt ?? '')),
    };
  }

  async deskRow(principal: Principal, caseId: string): Promise<SafetyDeskRow> {
    const reviews = await this.db
      .select({ review: hiringSafetyReviews, c: hiringCases })
      .from(hiringSafetyReviews)
      .innerJoin(hiringCases, eq(hiringCases.id, hiringSafetyReviews.hiringCaseId))
      .where(and(eq(hiringSafetyReviews.companyId, principal.companyId), eq(hiringSafetyReviews.hiringCaseId, caseId), ne(hiringSafetyReviews.status, 'preparing')))
      .limit(1);
    if (reviews.length === 0) throw new AppError({ status: 404, title: 'Not Found', detail: 'This candidate has not been sent to Safety.' });
    return (await this.deskRows(principal.companyId, reviews))[0] as SafetyDeskRow;
  }

  private async deskRows(companyId: string, reviews: { review: HiringSafetyReviewRow; c: HiringCaseRow }[]): Promise<SafetyDeskRow[]> {
    if (reviews.length === 0) return [];
    const caseIds = reviews.map((r) => r.c.id);
    const [consents, docs, reports, leads] = await Promise.all([
      this.db.select().from(hiringConsents).where(and(eq(hiringConsents.companyId, companyId), inArray(hiringConsents.hiringCaseId, caseIds))).orderBy(desc(hiringConsents.receivedAt)),
      this.db
        .select({ caseId: hiringConsentDocuments.hiringCaseId, type: hiringConsentDocuments.documentType })
        .from(hiringConsentDocuments)
        .where(and(eq(hiringConsentDocuments.companyId, companyId), inArray(hiringConsentDocuments.hiringCaseId, caseIds))),
      this.db
        .select({ caseId: hiringSafetyReports.hiringCaseId, result: hiringSafetyReports.result })
        .from(hiringSafetyReports)
        .where(and(eq(hiringSafetyReports.companyId, companyId), inArray(hiringSafetyReports.hiringCaseId, caseIds), isNull(hiringSafetyReports.voidedAt))),
      this.db.select({ id: hiringLeads.id, caseId: hiringLeads.hiringCaseId }).from(hiringLeads).where(and(eq(hiringLeads.companyId, companyId), inArray(hiringLeads.hiringCaseId, caseIds))),
    ]);
    return reviews.map(({ review, c }) => {
      const consent = consents.find((x) => x.hiringCaseId === c.id);
      const mine = reports.filter((r) => r.caseId === c.id);
      return {
        caseId: c.id,
        key: c.applicantId ?? leads.find((l) => l.caseId === c.id)?.id ?? c.id,
        name: c.candidateName,
        phone: consent?.phone ?? null,
        email: consent?.email ?? null,
        status: review.status as CandidateSafetyStatus,
        sentAt: review.openedAt.toISOString(),
        sentByName: review.openedByName,
        requestNote: review.requestNote,
        decidedAt: review.decidedAt?.toISOString() ?? null,
        decidedByName: review.decidedByName,
        decisionNote: review.decisionNote,
        insuranceStatus: (review.insuranceStatus as SafetyInsuranceStatus | null) ?? null,
        consentsSigned: docs.filter((d) => d.caseId === c.id).map((d) => d.type as ConsentDocumentType),
        reportsWithResult: mine.filter((r) => r.result !== 'pending').length,
        reportsOnFile: mine.length,
      };
    });
  }

  /** Safety decided: Recruiting hears it in the app (who sent it, and everyone who manages recruiting). */
  private async notifyRecruiting(principal: Principal, c: HiringCaseRow, review: HiringSafetyReviewRow, status: string, note: string | null): Promise<void> {
    const recipients = (
      await this.db
        .selectDistinct({ userId: memberships.userId })
        .from(memberships)
        .leftJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
        .leftJoin(rolePermissions, eq(rolePermissions.roleId, membershipRoles.roleId))
        .where(and(eq(memberships.companyId, principal.companyId), eq(memberships.status, 'active'), eq(rolePermissions.permissionCode, 'recruiting.manage')))
    )
      .map((r) => r.userId)
      .concat(review.openedByUserId);
    const unique = [...new Set(recipients)].filter((u) => u !== principal.userId);
    if (unique.length === 0) return;
    const qualified = status === 'approved';
    await this.db
      .insert(notifications)
      .values(
        unique.map((userId) => ({
          id: `ntf_${crypto.randomUUID()}`,
          companyId: principal.companyId,
          recipientUserId: userId,
          severity: qualified ? 'info' : 'warning',
          title: `${qualified ? 'Qualified by Safety' : 'Not qualified by Safety'} — ${c.candidateName}`,
          body: qualified ? `${c.candidateName} is qualified. Send the application from the candidate page.` : `Safety did not qualify ${c.candidateName}${note ? `: ${note}` : '.'}`,
          entityType: 'applicant',
          entityId: c.applicantId as string,
          source: 'system',
          dedupeKey: `candidate_safety_decision:${c.id}:${status}:${userId}`,
        })),
      )
      .onConflictDoNothing();
  }

  /** Filing reports and ordering checks: Recruiting's work now, Safety may still do it. */
  private assertCanFile(principal: Principal) {
    if (!hasPermission(principal, SAFETY_DECIDE_PERMISSION) && !hasPermission(principal, 'recruiting.manage')) {
      throw new AppError({ status: 403, title: 'Forbidden', detail: 'Only Recruiting or Safety can file screening reports.' });
    }
  }

  /** A message to the recruiter who sent the candidate and everyone who manages recruiting. */
  private async notifyRecruitingText(principal: Principal, c: HiringCaseRow, review: HiringSafetyReviewRow, n: { key: string; severity: 'info' | 'warning'; title: string; body: string }): Promise<void> {
    const recipients = (
      await this.db
        .selectDistinct({ userId: memberships.userId })
        .from(memberships)
        .leftJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
        .leftJoin(rolePermissions, eq(rolePermissions.roleId, membershipRoles.roleId))
        .where(and(eq(memberships.companyId, principal.companyId), eq(memberships.status, 'active'), eq(rolePermissions.permissionCode, 'recruiting.manage')))
    )
      .map((r) => r.userId)
      .concat(review.openedByUserId);
    const unique = [...new Set(recipients)].filter((u) => u !== principal.userId);
    if (unique.length === 0 || !c.applicantId) return;
    await this.db
      .insert(notifications)
      .values(unique.map((userId) => ({ id: `ntf_${crypto.randomUUID()}`, companyId: principal.companyId, recipientUserId: userId, severity: n.severity, title: n.title, body: n.body, entityType: 'applicant', entityId: c.applicantId as string, source: 'system', dedupeKey: `candidate_safety_${n.key}:${c.id}:${userId}` })))
      .onConflictDoNothing();
  }

  private assertSafety(principal: Principal) {
    if (!hasPermission(principal, SAFETY_DECIDE_PERMISSION)) {
      throw new AppError({ status: 403, title: 'Forbidden', detail: 'Only Safety (compliance manage) can do this.' });
    }
  }

  /**
   * The review an action works on. Safety's own actions (`sent`, the default) need a candidate
   * Recruiting has sent; filing a report or a check (`filing`) starts the review in `preparing`
   * when there is none yet (owner, 2026-10-13: the reports go up first, then Send to Safety).
   */
  private async openReview(principal: Principal, caseId: string | null, mode: 'sent' | 'filing' | 'any' = 'sent'): Promise<HiringSafetyReviewRow> {
    const review = await this.reviewFor(principal.companyId, caseId);
    if (review && (mode !== 'sent' || review.status !== 'preparing')) return review;
    if (review) throw conflict('Recruiting has not sent this candidate to Safety yet.');
    if (mode !== 'filing' || !caseId) throw conflict('This candidate has not been sent to Safety yet.');
    const consent = await this.consents.consentFor(principal.companyId, { caseId, leadId: null });
    if (!consent) throw conflict('The reports follow the signed consent: it has not been received yet.');
    const at = new Date();
    await this.db
      .insert(hiringSafetyReviews)
      .values({
        id: `hsr_${crypto.randomUUID()}`,
        companyId: principal.companyId,
        hiringCaseId: caseId,
        status: 'preparing',
        openedAt: at,
        openedByUserId: principal.userId,
        openedByName: principal.userName ?? principal.userId,
        requestNote: null,
      })
      .onConflictDoNothing();
    const made = await this.reviewFor(principal.companyId, caseId);
    if (!made) throw conflict('Could not start the reports; try again.');
    return made;
  }

  /** A report Safety ran, filed in the qualification file, with its result. */
  async upload(principal: Principal, subject: ApplicationSubject, input: SafetyReportUploadRequest): Promise<SafetyReportView> {
    this.assertCanFile(principal);
    const review = await this.openReview(principal, subject.caseId, 'filing');
    if (review.status === 'approved' || review.status === 'declined') throw conflict('The review is decided; reports can no longer be added.');
    const bytes = Buffer.from(input.content, 'base64');
    const type = sniff(bytes);
    if (!type || !['application/pdf', 'image/jpeg', 'image/png'].includes(type)) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'Use a PDF, JPG or PNG file.' });
    }
    const requirementCode = REQUIREMENT_FOR[input.kind];
    const received = input.receivedOn ?? easternToday();
    const months = EXPIRES_MONTHS[requirementCode];
    const document = await this.documents.upload(principal, review.hiringCaseId, {
      requirementCode,
      title: SAFETY_REPORT_LABELS[input.kind],
      fileName: input.fileName,
      contentType: type,
      sizeBytes: bytes.length,
      issuedOn: received,
      expiresOn: months ? addMonths(received, months) : null,
      notes: input.note,
      content: input.content,
    });
    const at = new Date();
    const by = principal.userName ?? principal.userId;
    const id = `hsrp_${crypto.randomUUID()}`;
    const c = await this.hiring.row(principal, review.hiringCaseId);
    const event = await this.db.transaction(async (tx) => {
      await tx.insert(hiringSafetyReports).values({
        id,
        companyId: principal.companyId,
        reviewId: review.id,
        hiringCaseId: review.hiringCaseId,
        kind: input.kind,
        result: input.result,
        status: input.result === 'pending' ? 'received' : 'reviewed',
        documentId: document.id,
        fileName: input.fileName,
        receivedOn: received,
        note: input.note,
        uploadedAt: at,
        uploadedByUserId: principal.userId,
        uploadedByName: by,
        reviewedAt: input.result === 'pending' ? null : at,
        reviewedByName: input.result === 'pending' ? null : by,
      });
      await this.syncCheck(tx, review, input.kind, { reportId: id, by, at, result: input.result });
      if (review.status === 'pending') {
        await tx
          .update(hiringSafetyReviews)
          .set({ status: 'in_review', version: review.version + 1, updatedAt: at })
          .where(and(eq(hiringSafetyReviews.id, review.id), eq(hiringSafetyReviews.version, review.version)));
      }
      return this.audit.writeIn(tx, principal, {
        action: 'safety_report_added',
        entityType: 'hiring_case',
        entityId: review.hiringCaseId,
        entityLabel: c.candidateName,
        summary: `${SAFETY_REPORT_LABELS[input.kind]} added (result: ${input.result})`,
        changes: [{ field: 'safety_report', old: null, new: id }],
        at,
      });
    });
    await this.audit.publish(event);
    await this.settleDocuments(principal, [{ documentId: document.id, result: input.result }]);
    const [row] = await this.db.select().from(hiringSafetyReports).where(eq(hiringSafetyReports.id, id)).limit(1);
    return this.reportView(row as HiringSafetyReportRow);
  }

  /** Records the result of a report already on file. */
  async reviewReport(principal: Principal, subject: ApplicationSubject, reportId: string, input: { result: SafetyReportResult; note: string | null; version: number }): Promise<SafetyReportView> {
    this.assertCanFile(principal);
    const review = await this.openReview(principal, subject.caseId, 'filing');
    if (review.status === 'approved' || review.status === 'declined') throw conflict('The review is decided; results can no longer change.');
    const [r] = await this.db
      .select()
      .from(hiringSafetyReports)
      .where(and(eq(hiringSafetyReports.companyId, principal.companyId), eq(hiringSafetyReports.reviewId, review.id), eq(hiringSafetyReports.id, reportId)))
      .limit(1);
    if (!r) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such report on this review.' });
    if (r.version !== input.version) throw conflict('Someone else changed this report. Reload and try again.');
    const at = new Date();
    const by = principal.userName ?? principal.userId;
    const event = await this.db.transaction(async (tx) => {
      const [done] = await tx
        .update(hiringSafetyReports)
        .set({ result: input.result, status: input.result === 'pending' ? 'received' : 'reviewed', reviewedAt: at, reviewedByName: by, reviewNote: input.note, version: r.version + 1 })
        .where(and(eq(hiringSafetyReports.id, r.id), eq(hiringSafetyReports.version, r.version)))
        .returning({ id: hiringSafetyReports.id });
      if (!done) throw conflict('Someone else changed this report. Reload and try again.');
      await this.syncCheck(tx, review, r.kind, { reportId: r.id, by, at, result: input.result });
      return this.audit.writeIn(tx, principal, {
        action: 'safety_report_reviewed',
        entityType: 'hiring_case',
        entityId: review.hiringCaseId,
        entityLabel: (await this.hiring.row(principal, review.hiringCaseId)).candidateName,
        summary: `${SAFETY_REPORT_LABELS[r.kind as SafetyReportKind]}: result ${input.result}${input.note ? ` — ${input.note}` : ''}`,
        changes: [{ field: 'result', old: r.result, new: input.result }],
        at,
      });
    });
    await this.audit.publish(event);
    await this.settleDocuments(principal, [{ documentId: r.documentId, result: input.result }]);
    const [row] = await this.db.select().from(hiringSafetyReports).where(eq(hiringSafetyReports.id, r.id)).limit(1);
    return this.reportView(row as HiringSafetyReportRow);
  }

  /** The driver's own FMCSA full-query consent, as Safety saw it in the Clearinghouse. */
  async setFullQuery(principal: Principal, subject: ApplicationSubject, status: FmcsaFullQueryStatus, version: number): Promise<void> {
    this.assertCanFile(principal);
    const review = await this.openReview(principal, subject.caseId, 'filing');
    if (review.version !== version) throw conflict('Someone else changed this review. Reload and try again.');
    const at = new Date();
    const event = await this.db.transaction(async (tx) => {
      const [done] = await tx
        .update(hiringSafetyReviews)
        .set({ fmcsaFullQueryStatus: status, fmcsaFullQueryAt: at, version: review.version + 1, updatedAt: at })
        .where(and(eq(hiringSafetyReviews.id, review.id), eq(hiringSafetyReviews.version, review.version)))
        .returning({ id: hiringSafetyReviews.id });
      if (!done) throw conflict('Someone else changed this review. Reload and try again.');
      return this.audit.writeIn(tx, principal, {
        action: 'clearinghouse_full_query_consent',
        entityType: 'hiring_case',
        entityId: review.hiringCaseId,
        entityLabel: (await this.hiring.row(principal, review.hiringCaseId)).candidateName,
        summary: `FMCSA full-query consent (in the Clearinghouse): ${status.replace(/_/g, ' ')}`,
        changes: [{ field: 'fmcsa_full_query_status', old: review.fmcsaFullQueryStatus, new: status }],
        at,
      });
    });
    await this.audit.publish(event);
  }

  /** What an approval still needs, by name; empty when it can be approved. */
  async approvalGaps(principal: Principal, review: HiringSafetyReviewRow): Promise<string[]> {
    const reports = await this.db
      .select()
      .from(hiringSafetyReports)
      .where(and(eq(hiringSafetyReports.companyId, principal.companyId), eq(hiringSafetyReports.reviewId, review.id), isNull(hiringSafetyReports.voidedAt)));
    const gaps: string[] = [];
    for (const kind of REQUIRED_FOR_APPROVAL) {
      const mine = reports.filter((r) => r.kind === kind);
      if (mine.length === 0) gaps.push(`${SAFETY_REPORT_LABELS[kind]}: not on file`);
      else if (mine.every((r) => r.result === 'pending')) gaps.push(`${SAFETY_REPORT_LABELS[kind]}: no result recorded`);
    }
    if (reports.some((r) => r.result === 'prohibited')) gaps.push('A Clearinghouse result shows the driver is prohibited from safety-sensitive work');
    return gaps;
  }

  /**
   * Safety's decision. In review and Needs follow-up keep it open; Approved needs every required
   * report with a result; Declined closes the candidate. Version-checked; every change audited.
   */
  async decide(principal: Principal, subject: ApplicationSubject, input: SafetyStatusChangeRequest): Promise<void> {
    this.assertSafety(principal);
    if (!subject.caseId) throw conflict('This candidate has not been sent to Safety yet.');
    const caseId = subject.caseId;
    await this.hiring.withLock(`candidate-safety:${caseId}`, async () => {
      const review = await this.openReview(principal, caseId);
      if (review.version !== input.version) throw conflict('Someone else changed this review. Reload and try again.');
      if (review.status === 'approved' || review.status === 'declined') throw conflict('The review is already decided.');
      if (input.status === 'approved' && review.insuranceStatus === 'pending') throw conflict('Waiting for the insurance answer: record it first.');
      if (input.status === 'approved' && review.insuranceStatus === 'declined') throw conflict('The insurer declined this driver.');
      if (input.status === 'approved') {
        const gaps = await this.approvalGaps(principal, review);
        if (gaps.length > 0) throw conflict(`Approval needs: ${gaps.join('; ')}`, { missing: gaps });
      }
      if ((input.status === 'declined' || input.status === 'needs_follow_up') && !input.note) {
        throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'Say why.' });
      }
      const c = await this.hiring.row(principal, caseId);
      const at = new Date();
      const by = principal.userName ?? principal.userId;
      const decided = input.status === 'approved' || input.status === 'declined';
      const event = await this.db.transaction(async (tx) => {
        const [done] = await tx
          .update(hiringSafetyReviews)
          .set({
            status: input.status,
            decidedAt: decided ? at : null,
            decidedByUserId: decided ? principal.userId : null,
            decidedByName: decided ? by : null,
            decisionNote: input.note,
            version: review.version + 1,
            updatedAt: at,
          })
          .where(and(eq(hiringSafetyReviews.id, review.id), eq(hiringSafetyReviews.version, review.version)))
          .returning({ id: hiringSafetyReviews.id });
        if (!done) throw conflict('Someone else changed this review. Reload and try again.');
        return this.audit.writeIn(tx, principal, {
          action: 'safety_review_decision',
          entityType: 'hiring_case',
          entityId: caseId,
          entityLabel: c.candidateName,
          summary: `Safety review: ${input.status.replace(/_/g, ' ')}${input.note ? ` — ${input.note}` : ''}`,
          changes: [{ field: 'safety_review', old: review.status, new: input.status }],
          at,
        });
      });
      await this.audit.publish(event);
      if (decided) await this.notifyRecruiting(principal, c, review, input.status, input.note).catch(() => undefined);
      if (input.status === 'approved') {
        const reviewed = await this.db
          .select({ documentId: hiringSafetyReports.documentId, result: hiringSafetyReports.result })
          .from(hiringSafetyReports)
          .where(and(eq(hiringSafetyReports.companyId, principal.companyId), eq(hiringSafetyReports.reviewId, review.id), isNull(hiringSafetyReports.voidedAt)));
        await this.settleDocuments(principal, reviewed);
      }
      // A decline ends the candidacy through the funnel's own audited transition.
      if (input.status === 'declined' && !['disqualified', 'withdrawn', 'hired', 'active_driver'].includes(c.state)) {
        await this.hiring.transition(principal, c, 'disqualified', { reason: 'other', note: `Safety declined${input.note ? `: ${input.note}` : ''}`, at });
      }
    });
  }

  /** A report file for preview: restricted reports need the restricted-records permission. */
  async reportFile(principal: Principal, subject: ApplicationSubject, reportId: string) {
    const review = await this.openReview(principal, subject.caseId, 'any');
    const [r] = await this.db
      .select()
      .from(hiringSafetyReports)
      .where(and(eq(hiringSafetyReports.companyId, principal.companyId), eq(hiringSafetyReports.reviewId, review.id), eq(hiringSafetyReports.id, reportId)))
      .limit(1);
    if (!r?.documentId) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such report.' });
    if (!seesSensitive(principal) && !hasPermission(principal, SAFETY_DECIDE_PERMISSION) && !hasPermission(principal, 'recruiting.manage')) {
      throw new AppError({ status: 403, title: 'Forbidden', detail: 'Safety reports are restricted to Safety and Recruiting.' });
    }
    return this.documents.file(principal, review.hiringCaseId, r.documentId);
  }
}
