import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  SYSTEM_REQUIREMENTS,
  evaluateItem,
  type CandidateHireChecklist,
  type HireCandidateRequest,
  type HireChecklistItem,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { qualificationItems } from '../../database/schema/compliance';
import { hiringCases, hiringConsents, hiringDriverApplications, hiringOnboardingTasks, hiringSafetyReports, type HiringCaseRow } from '../../database/schema/hiring';
import { employees } from '../../database/schema/people';
import { drivers } from '../../database/schema/roster';
import { ComplianceService } from '../compliance/compliance.service';
import { RecruitingService } from '../hr/recruiting.service';
import { AuditService } from '../people/audit.service';
import { DriversService } from '../roster/drivers.service';
import { CandidateOnboardingService } from './candidate-onboarding.service';
import { CandidateSafetyService } from './candidate-safety.service';
import { HiringService } from './hiring.service';

const conflict = (detail: string, extensions?: Record<string, unknown>) => new AppError({ status: 409, title: 'Conflict', detail, extensions });
const CLOSED = ['disqualified', 'withdrawn', 'no_show', 'declined_offer'];
/** The driver documents a hire needs verified, by their qualification-file codes. */
const REQUIRED_DOCUMENTS: readonly { code: string; label: string }[] = [
  { code: 'cdl', label: 'CDL (front)' },
  { code: 'cdl_back', label: 'CDL (back)' },
  { code: 'medical_card', label: 'Medical card' },
];
const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });

/** The same lock the funnel's own hire takes, so the two can never run on one case at once. */
const caseLock = (principal: Principal, caseId: string) => `hiring-case:${principal.companyId}:${caseId}`;

/**
 * Ready to hire and the hire itself (steps 8-9, owner brief 2026-10-11).
 *
 * The checklist is read from the records, never ticked by hand: Safety approved, the application
 * reviewed, the driver documents verified in the qualification file, the drug test result, every
 * other required onboarding task, orientation and arrival — and not on hold. Hire is refused while
 * any of them is missing, and the refusal names them.
 *
 * Hiring reuses what the funnel already does — the employee record (the parent identity; drivers
 * are left out of the Employees list), the roster row under the driver id reserved when the consent
 * arrived, the case's audited transition — under the same case lock. It is safe to retry: a step
 * that already happened (an employee made, a roster row opened) is found and reused, never made
 * twice. Documents, signatures, the audit trail and costs stay where they are, keyed by the same
 * driver id, so nothing has to be uploaded again.
 */
@Injectable()
export class CandidateHireService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly hiring: HiringService,
    private readonly compliance: ComplianceService,
    private readonly recruiting: RecruitingService,
    private readonly driversService: DriversService,
    private readonly safety: CandidateSafetyService,
    private readonly onboarding: CandidateOnboardingService,
  ) {}

  private get db() {
    return this.database.db;
  }

  /** The verified state of the driver documents, by code. */
  private async documentStates(companyId: string, driverId: string | null): Promise<Map<string, { status: string; expiresOn: string | null }>> {
    const out = new Map<string, { status: string; expiresOn: string | null }>();
    if (!driverId) return out;
    const rows = await this.db
      .select()
      .from(qualificationItems)
      .where(and(eq(qualificationItems.companyId, companyId), eq(qualificationItems.scope, 'driver'), eq(qualificationItems.entityId, driverId)));
    for (const r of rows) {
      const requirement = SYSTEM_REQUIREMENTS.find((x) => x.code === r.requirementCode);
      if (!requirement) continue;
      const v = evaluateItem(requirement, this.compliance.toItem(r), { id: driverId, label: driverId }, { today: today() });
      out.set(r.requirementCode, { status: v.status, expiresOn: r.expiresOn });
    }
    return out;
  }

  async checklist(principal: Principal, caseId: string | null): Promise<CandidateHireChecklist> {
    const empty: CandidateHireChecklist = { ready: false, items: [], onHold: null, hired: null };
    if (!caseId) return empty;
    const c = await this.hiring.row(principal, caseId);
    if (c.hiredAt && c.driverId) {
      const [d] = await this.db.select({ number: drivers.driverNumber }).from(drivers).where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, c.driverId))).limit(1);
      return { ...empty, hired: { at: c.hiredAt.toISOString(), driverId: c.driverId, driverNumber: d?.number ?? null, employeeId: c.employeeId } };
    }
    const review = await this.safety.reviewFor(principal.companyId, caseId);
    const [app] = await this.db
      .select({ at: hiringDriverApplications.receivedAt })
      .from(hiringDriverApplications)
      .where(and(eq(hiringDriverApplications.companyId, principal.companyId), eq(hiringDriverApplications.hiringCaseId, caseId)))
      .orderBy(desc(hiringDriverApplications.receivedAt))
      .limit(1);
    const tasks = await this.db
      .select()
      .from(hiringOnboardingTasks)
      .where(and(eq(hiringOnboardingTasks.companyId, principal.companyId), eq(hiringOnboardingTasks.hiringCaseId, caseId)));
    const docs = await this.documentStates(principal.companyId, c.driverId);
    const accepted = new Set(['verified', 'valid', 'expiring']);
    const task = (code: string) => tasks.find((t) => t.code === code);
    const doneTask = (code: string) => {
      const t = task(code);
      return Boolean(t && (t.status === 'done' || (!t.required && t.status === 'waived') || t.status === 'waived'));
    };
    const items: HireChecklistItem[] = [];
    items.push({
      code: 'safety',
      label: 'Safety cleared',
      ok: review?.status === 'approved',
      detail: review ? (review.status === 'approved' ? `Approved by ${review.decidedByName ?? 'Safety'}` : `Safety review: ${review.status.replace(/_/g, ' ')}`) : 'Not sent to Safety yet',
      at: review?.decidedAt?.toISOString() ?? null,
    });
    // Pre-employment full query (49 CFR 382.701(a)): its own requirement. A limited query never stands
    // in for it; it needs the driver's consent inside the Clearinghouse and a full-query report Safety reviewed.
    const fullReports = review
      ? await this.db
          .select({ result: hiringSafetyReports.result, status: hiringSafetyReports.status, reviewedAt: hiringSafetyReports.reviewedAt })
          .from(hiringSafetyReports)
          .where(and(eq(hiringSafetyReports.companyId, principal.companyId), eq(hiringSafetyReports.reviewId, review.id), eq(hiringSafetyReports.kind, 'clearinghouse_full'), isNull(hiringSafetyReports.voidedAt)))
      : [];
    const fullClear = fullReports.find((r) => r.status === 'reviewed' && r.result === 'clear') ?? null;
    const fullConsent = review?.fmcsaFullQueryStatus === 'received';
    // Optional since 2026-10-12 (owner): it no longer holds a hire; a prohibited result still does.
    const fullProhibited = fullReports.some((r) => r.result === 'prohibited');
    items.push({
      code: 'clearinghouse_full',
      label: 'Pre-employment Clearinghouse full query (optional)',
      ok: !fullProhibited,
      detail: fullProhibited
        ? 'The full query shows the driver is prohibited from safety-sensitive work'
        : !fullConsent
        ? "The driver's full-query consent in the Clearinghouse is not recorded as received (the limited consent does not count)"
        : fullClear
          ? 'Full query reviewed by Safety: no prohibition'
          : fullReports.length > 0
            ? 'Full-query report received; Safety has not reviewed it as clear'
            : 'No full-query report on file',
      at: fullClear?.reviewedAt?.toISOString() ?? null,
    });
    items.push({
      code: 'application',
      label: 'Application reviewed',
      ok: Boolean(app && c.applicationReviewedAt),
      detail: !app ? 'No application received yet' : c.applicationReviewedAt ? `Reviewed by ${c.applicationReviewedBy ?? 'recruiting'}` : 'Received; not reviewed yet',
      at: c.applicationReviewedAt?.toISOString() ?? null,
    });
    const missingDocs = REQUIRED_DOCUMENTS.filter((d) => !accepted.has(docs.get(d.code)?.status ?? 'missing'));
    items.push({
      code: 'documents',
      label: 'Required documents verified',
      ok: missingDocs.length === 0,
      detail: missingDocs.length === 0 ? 'CDL front and back, medical card verified' : `Not verified: ${missingDocs.map((d) => `${d.label} (${(docs.get(d.code)?.status ?? 'missing').replace(/_/g, ' ')})`).join(', ')}`,
      at: null,
    });
    const drug = task('drug_test');
    items.push({
      code: 'drug_test',
      label: 'Drug test result verified',
      ok: drug?.status === 'done' && Boolean(drug.result),
      detail: drug?.status === 'done' ? `Result: ${drug.result ?? 'not recorded'}` : drug?.status === 'failed' ? `Failed${drug.result ? `: ${drug.result}` : ''}` : 'Pending',
      at: drug?.completedAt?.toISOString() ?? null,
    });
    const otherRequired = tasks.filter((t) => t.required && !['drug_test', 'orientation', 'arrival'].includes(t.code));
    const openChecks = otherRequired.filter((t) => t.status !== 'done' && t.status !== 'waived');
    items.push({
      code: 'checks',
      label: 'Other required checks completed',
      ok: c.onboardingStartedAt !== null && openChecks.length === 0,
      detail: !c.onboardingStartedAt ? 'Onboarding not started' : openChecks.length === 0 ? 'All done' : `Open: ${openChecks.map((t) => `${t.label} (${t.status.replace(/_/g, ' ')})`).join(', ')}`,
      at: null,
    });
    const travel = ['orientation', 'arrival'].filter((code) => !doneTask(code));
    items.push({
      code: 'orientation',
      label: 'Orientation and arrival completed',
      ok: c.onboardingStartedAt !== null && travel.length === 0,
      detail: travel.length === 0 ? 'Arrived and oriented' : `Pending: ${travel.join(' and ')}`,
      at: task('orientation')?.completedAt?.toISOString() ?? null,
    });
    if (c.onHoldAt) items.push({ code: 'hold', label: 'Not on hold', ok: false, detail: `On hold${c.onHoldReason ? `: ${c.onHoldReason}` : ''}`, at: c.onHoldAt.toISOString() });
    return {
      ready: items.every((i) => i.ok) && !CLOSED.includes(c.state),
      items,
      onHold: c.onHoldAt ? { at: c.onHoldAt.toISOString(), by: c.onHoldBy, reason: c.onHoldReason } : null,
      hired: null,
    };
  }

  async hold(principal: Principal, caseId: string | null, hold: boolean, reason: string | null): Promise<void> {
    if (!caseId) throw conflict('This candidate has no hiring record yet.');
    const c = await this.hiring.row(principal, caseId);
    if (c.hiredAt) throw conflict('A hired driver is not on hold in hiring.');
    if (hold === Boolean(c.onHoldAt)) return;
    if (hold && !reason) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'Say why the candidate is on hold.' });
    const at = new Date();
    const by = principal.userName ?? principal.userId;
    const event = await this.db.transaction(async (tx) => {
      await tx
        .update(hiringCases)
        .set(hold ? { onHoldAt: at, onHoldBy: by, onHoldReason: reason, updatedAt: at } : { onHoldAt: null, onHoldBy: null, onHoldReason: null, updatedAt: at })
        .where(eq(hiringCases.id, c.id));
      return this.audit.writeIn(tx, principal, {
        action: hold ? 'hiring_hold' : 'hiring_hold_released',
        entityType: 'hiring_case',
        entityId: c.id,
        entityLabel: c.candidateName,
        summary: hold ? `Put on hold: ${reason}` : 'Hold released',
        at,
      });
    });
    await this.audit.publish(event);
  }

  /** The candidate withdraws (or is withdrawn): kept, audited, costs untouched. */
  async withdraw(principal: Principal, caseId: string | null, reason: string): Promise<void> {
    if (!caseId) throw conflict('This candidate has no hiring record yet.');
    await this.hiring.withLock(caseLock(principal, caseId), async () => {
      const c = await this.hiring.row(principal, caseId);
      if (c.hiredAt || c.state === 'hired' || c.state === 'active_driver') throw conflict('A hired driver leaves through the roster, not hiring.');
      if (CLOSED.includes(c.state)) return;
      await this.hiring.transition(principal, c, 'withdrawn', { reason: 'other', note: reason });
      await this.audit.write(principal, {
        action: 'status_change',
        entityType: 'hiring_case',
        entityId: c.id,
        entityLabel: c.candidateName,
        summary: `Withdrawn from hiring: ${reason}. Costs and documents are kept.`,
        changes: [{ field: 'state', old: c.state, new: 'withdrawn' }],
      });
    });
  }

  async hire(principal: Principal, caseId: string | null, input: HireCandidateRequest): Promise<{ driverId: string; driverNumber: string; employeeId: string; employeeNumber: string }> {
    if (!caseId) throw conflict('This candidate has no hiring record yet.');
    return this.hiring.withLock(caseLock(principal, caseId), () => this.hireLocked(principal, caseId, input));
  }

  private async hireLocked(principal: Principal, caseId: string, input: HireCandidateRequest) {
    const c = await this.hiring.row(principal, caseId);
    // A second Hire (a double click, a retry) returns the hire that already happened.
    if (c.hiredAt && c.employeeId && c.driverId) {
      const [d] = await this.db.select({ number: drivers.driverNumber }).from(drivers).where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, c.driverId))).limit(1);
      const [e] = await this.db.select({ number: employees.employeeNumber }).from(employees).where(and(eq(employees.companyId, principal.companyId), eq(employees.id, c.employeeId))).limit(1);
      if (d && e) return { driverId: c.driverId, driverNumber: d.number, employeeId: c.employeeId, employeeNumber: e.number };
    }
    if (CLOSED.includes(c.state)) throw conflict('This candidate is no longer in the hiring pipeline.');
    const checklist = await this.checklist(principal, caseId);
    if (!checklist.ready) {
      const missing = checklist.items.filter((i) => !i.ok).map((i) => `${i.label}: ${i.detail}`);
      throw conflict(`Not ready to hire. ${missing.join('; ')}`, { missing });
    }
    if (!c.applicantId || !c.driverId) throw conflict('The candidate record or the reserved driver id is missing.');
    const [consent] = await this.db
      .select()
      .from(hiringConsents)
      .where(and(eq(hiringConsents.companyId, principal.companyId), eq(hiringConsents.hiringCaseId, caseId)))
      .orderBy(desc(hiringConsents.receivedAt))
      .limit(1);
    const [app] = await this.db
      .select()
      .from(hiringDriverApplications)
      .where(and(eq(hiringDriverApplications.companyId, principal.companyId), eq(hiringDriverApplications.hiringCaseId, caseId)))
      .orderBy(desc(hiringDriverApplications.receivedAt))
      .limit(1);
    if (!app) throw conflict('No application on file to hire from.');
    const answers = (app.answers ?? {}) as Record<string, string | null>;
    const docs = await this.documentStates(principal.companyId, c.driverId);
    const cdlExpires = docs.get('cdl')?.expiresOn ?? answers.cdlExpiration ?? null;
    const medicalExpires = docs.get('medical_card')?.expiresOn ?? answers.medicalExpiration ?? null;
    if (!cdlExpires || !medicalExpires) throw conflict('The CDL or medical card expiry is not on file; the roster cannot be opened without them.');
    const stateZip = (answers.stateZip ?? '').trim();
    const homeState = (stateZip.match(/^[A-Za-z]{2}/)?.[0] ?? '').toUpperCase();
    const cdlState = (answers.cdlState ?? '').trim().slice(0, 2).toUpperCase();
    if (homeState.length !== 2 || cdlState.length !== 2) throw conflict('The application has no two-letter state for the address or the CDL; correct the application first.');
    const applicant = await this.recruiting.getApplicant(principal, c.applicantId);
    const at = new Date();

    // The employee: reused when an earlier attempt already made it.
    let employeeId = applicant.hiredEmployeeId;
    let employeeNumber: string;
    if (employeeId) {
      const [e] = await this.db.select({ number: employees.employeeNumber }).from(employees).where(and(eq(employees.companyId, principal.companyId), eq(employees.id, employeeId))).limit(1);
      employeeNumber = e?.number ?? employeeId;
    } else {
      const hired = await this.recruiting.hire(principal, c.applicantId, {
        hireDate: input.hireDate,
        position: 'Driver',
        department: 'dispatch',
        employmentType: input.driverType === 'company' ? 'full_time' : 'contractor',
        managerEmployeeId: input.managerEmployeeId,
        location: `${answers.city ?? ''}, ${homeState}`.trim(),
        payType: null,
        payRate: null,
        startOnboarding: false,
        onboardingTemplateId: null,
      });
      employeeId = hired.employeeId;
      employeeNumber = hired.employeeNumber;
    }

    // The roster row under the reserved id: reused when an earlier attempt already opened it.
    const [existing] = await this.db.select().from(drivers).where(and(eq(drivers.companyId, principal.companyId), eq(drivers.id, c.driverId))).limit(1);
    let driverNumber: string;
    if (existing) {
      if (existing.employeeId && existing.employeeId !== employeeId) throw conflict(`Driver ${existing.driverNumber} already belongs to someone else.`);
      driverNumber = existing.driverNumber;
    } else {
      const driver = await this.driversService.createForHire(principal, {
        reserved: { id: c.driverId, driverNumber: `D-${c.driverId.replace(/^drv_/, '')}` },
        employeeId,
        firstName: consent?.firstName ?? applicant.firstName,
        lastName: consent?.lastName ?? applicant.lastName,
        phone: consent?.phone ?? applicant.phone,
        email: consent?.email ?? applicant.email,
        driverType: input.driverType,
        cdlState,
        cdlClass: /\bB\b|Class B/i.test(answers.cdlClass ?? '') ? 'B' : 'A',
        cdlEndorsements: [],
        cdlExpiresOn: cdlExpires,
        medicalCardExpiresOn: medicalExpires,
        hireDate: input.hireDate,
        dispatcherId: input.dispatcherId,
        homeCity: (answers.city ?? '').trim() || 'Unknown',
        homeState,
        payPlan: { kind: input.payPlanKind, rate: input.payPlanRate },
        preferredLanguage: input.preferredLanguage,
      });
      driverNumber = driver.driverNumber;
    }

    await this.db.update(hiringCases).set({ employeeId, hiredAt: at, onHoldAt: null, onHoldBy: null, onHoldReason: null, updatedAt: at }).where(eq(hiringCases.id, caseId));
    const fresh = await this.hiring.row(principal, caseId);
    if (fresh.state !== 'hired' && fresh.state !== 'active_driver') {
      await this.hiring.transition(principal, fresh, 'hired', { note: `${employeeNumber} · ${driverNumber}`, at });
    }
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'driver',
      entityId: c.driverId,
      entityLabel: c.candidateName,
      summary: `Hired from candidate ${applicant.applicantNumber}: roster row ${driverNumber} under the reserved id; documents, signatures and costs stay with the driver`,
      at,
    });
    // Agreed driver charges that waited for the roster.
    await this.onboarding.chargePendingAtHire(principal, caseId).catch(() => undefined);
    return { driverId: c.driverId, driverNumber, employeeId, employeeNumber };
  }

  /** For the progress of a case at orientation-like steps: ready or not, cheaply enough for a page. */
  async isReady(principal: Principal, c: HiringCaseRow): Promise<boolean> {
    return (await this.checklist(principal, c.id)).ready;
  }
}
