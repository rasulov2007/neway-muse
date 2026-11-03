import { Inject, Injectable } from '@nestjs/common';
import { and, asc, desc, eq, ilike, inArray, isNotNull, isNull, ne, or, sql, type SQL } from 'drizzle-orm';
import {
  DotApplicationDraftFormSchema,
  HIRING_DOCUMENTS,
  LEAD_SOURCE_LABELS,
  RECRUIT_FILTERS,
  type RecruitConsentState,
  type CandidateSafetyStatus,
  RECRUIT_STAGES,
  RECRUIT_STAGE_LABELS,
  recruitStageOf,
  type RecruitStage,
  type RecruitDashboard,
  type RecruitDashboardQuery,
  RECRUIT_PROGRESS,
  followUpStateOf,
  hiringDocumentState,
  isActiveProgress,
  matchesRecruitFilter,
  phoneMatchKey,
  recruitFilterOf,
  recruitNextStep,
  recruitProgressOf,
  splitFullName,
  type DotApplicationState,
  type HiringState,
  type Lead,
  type RecruitAddLeadRequest,
  type RecruitAnalytics,
  type RecruitApplicationSummary,
  type RecruitCalendarEvent,
  type RecruitCalendarQuery,
  type RecruitCandidate,
  type RecruitFilter,
  type RecruitList,
  type RecruitListQuery,
  type RecruitMetrics,
  type RecruitNote,
  type RecruitNoteRequest,
  type RecruitProgressInput,
  type RecruitRecruiter,
  type RecruitRow,
  type RecruitScopeInfo,
  type RenameCandidateRequest,
  type RenameCandidateResult,
  type SendToSafetyReadiness,
  type SendToSafetyRequest,
  recruitBoardColumnOf,
  type RecruitBoard,
  type RecruitBoardCard,
  type RecruitBoardQuery,
  DOT_APP_DOCUMENTS,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { memberships, membershipRoles, notifications, rolePermissions } from '../../database/schema/admin';
import { complianceDocuments, verificationCases } from '../../database/schema/compliance';
import {
  hiringCases,
  hiringConsents,
  hiringCostEntries,
  hiringDotApplications,
  hiringDotLinkFiles,
  hiringDotLinks,
  hiringExternalApplications,
  hiringLeads,
  hiringStageEvents,
  type HiringCaseRow,
  type HiringLeadRow,
} from '../../database/schema/hiring';
import { applicants } from '../../database/schema/hr';
import { auditLogs, employees } from '../../database/schema/people';
import { CLOCK, type Clock } from '../dashboard/clock';
import { VerificationService } from '../compliance/verification.service';
import { AuditService } from '../people/audit.service';
import { DotLinksService } from './dot-links.service';
import { DriverApplicationService, type ApplicationSubject } from './driver-application.service';
import { CandidateHireService } from './candidate-hire.service';
import { CandidateSafetyService } from './candidate-safety.service';
import { ConsentService } from './consent.service';
import { SettingsService } from '../admin/settings.service';
import { StateService } from '../state/state.service';
import { ExternalApplicationService } from './external-application.service';
import { HiringActivityService } from './hiring-activity.service';
import { HiringPipelineService } from './hiring-pipeline.service';
import { LeadRotationService } from './lead-rotation.service';
import { HiringService } from './hiring.service';
import { LeadsService } from './leads.service';

const EASTERN = 'America/New_York';
const easternDate = (d: Date) => d.toLocaleDateString('en-CA', { timeZone: EASTERN });
const sourceLabel = (s: string) => (s === 'unknown' ? 'Unknown' : (LEAD_SOURCE_LABELS[s] ?? s.replace(/_/g, ' ')));
/** The next calendar day of an ISO date. */
const addDay = (iso: string) => new Date(Date.parse(`${iso}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** The documents Recruiting collects before asking Safety (Safety's own reports are not asked for). */
const INTAKE_DOCUMENTS = ['cdl', 'medical_card'] as const;

interface Scope {
  info: RecruitScopeInfo;
  /** Employee ids whose candidates are in scope; null = everyone; 'none' = unassigned only. */
  recruiters: string[] | 'none' | null;
  empty: boolean;
}

/** Server-kept: when each candidate entered the board step it is on, by candidate key. */
const STAGE_MARKS_KEY = 'srv-recruit-stage-marks';

interface Person {
  lead: HiringLeadRow | null;
  hiringCase: HiringCaseRow | null;
  application: DotApplicationState;
  linkLive: boolean;
  externalReceived: boolean;
  phone: string | null;
  email: string | null;
  /** Journey v2 (owner brief, 2026-10-11). */
  consent: RecruitConsentState;
  safety: CandidateSafetyStatus | null;
}

function forbidden(detail: string): AppError {
  return new AppError({ status: 403, title: 'Forbidden', detail });
}

function notFound(): AppError {
  return new AppError({ status: 404, title: 'Not Found', detail: 'That candidate is not on file.' });
}

/**
 * Recruiting's home list, the candidate page and their actions (owner's redesign, 2026-10-08).
 *
 * A candidate is a lead, the hiring case it became, or a case opened for an applicant — one person,
 * one row, keyed by the applicant id once there is one and the lead id before. Progress is read
 * from the stored records on every request (`recruitProgressOf`); nothing here stores a copy.
 *
 * Scope: "My leads" is the signed-in account's own recruiter employee, resolved on the server.
 * "All leads" and the recruiter filter need `recruiting.manage`; without it a recruiter can open
 * only the candidates assigned to them.
 */
@Injectable()
export class RecruitService {
  constructor(
    private readonly database: DatabaseService,
    private readonly rotation: LeadRotationService,
    private readonly leads: LeadsService,
    private readonly dotLinks: DotLinksService,
    private readonly pipeline: HiringPipelineService,
    private readonly verification: VerificationService,
    private readonly audit: AuditService,
    private readonly activityService: HiringActivityService,
    private readonly external: ExternalApplicationService,
    private readonly driverApps: DriverApplicationService,
    private readonly consents: ConsentService,
    private readonly candidateSafety: CandidateSafetyService,
    private readonly candidateHire: CandidateHireService,
    private readonly settings: SettingsService,
    private readonly state: StateService,
    private readonly hiringCases: HiringService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private get db() {
    return this.database.db;
  }

  private today(): string {
    return easternDate(this.clock());
  }

  // ================================================================================== scope

  private async scope(principal: Principal, query: { scope: 'mine' | 'all'; recruiter?: string }): Promise<Scope> {
    const own = await this.rotation.ownEmployee(principal);
    const canSeeAll = principal.permissions.has('recruiting.manage');
    const ownRec: RecruitRecruiter | null = own ? { employeeId: own.employeeId, name: own.name } : null;
    if (query.scope === 'mine') {
      return {
        info: { scope: 'mine', label: own ? `Assigned to ${own.name}` : 'Your account is not linked to a recruiter', own: ownRec, canSeeAll },
        recruiters: own ? [own.employeeId] : [],
        empty: !own,
      };
    }
    if (!canSeeAll) throw forbidden('All leads needs the recruiting manage permission.');
    if (!query.recruiter) {
      return { info: { scope: 'all', label: 'All recruiters', own: ownRec, canSeeAll }, recruiters: null, empty: false };
    }
    if (query.recruiter === 'none') {
      return { info: { scope: 'all', label: 'Unassigned', own: ownRec, canSeeAll }, recruiters: 'none', empty: false };
    }
    const [person] = await this.db
      .select({ id: employees.id, first: employees.firstName, last: employees.lastName })
      .from(employees)
      .where(and(eq(employees.companyId, principal.companyId), eq(employees.id, query.recruiter)))
      .limit(1);
    if (!person) throw new AppError({ status: 404, title: 'Not Found', detail: 'No such recruiter in this company' });
    return {
      info: { scope: 'all', label: `Assigned to ${person.first} ${person.last}`.trim(), own: ownRec, canSeeAll },
      recruiters: [person.id],
      empty: false,
    };
  }

  // ================================================================================= people

  /** Every candidate in scope, with what their progress is read from. */
  private async people(companyId: string, scope: Scope, q?: string): Promise<Person[]> {
    if (scope.empty) return [];
    const leadParts: SQL[] = [eq(hiringLeads.companyId, companyId), eq(hiringLeads.isTest, false)];
    if (scope.recruiters === 'none') leadParts.push(isNull(hiringLeads.recruiterEmployeeId));
    else if (scope.recruiters) leadParts.push(inArray(hiringLeads.recruiterEmployeeId, scope.recruiters.length ? scope.recruiters : ['-']));
    const term = q?.trim();
    // Phone matching by digits only when the term looks like a phone number, never inside a name.
    const digits = term && /^[\d\s()+.-]+$/.test(term) ? term.replace(/\D/g, '') : '';
    if (term) {
      const like = `%${term}%`;
      const parts = [
        ilike(hiringLeads.firstName, like),
        ilike(hiringLeads.lastName, like),
        sql`(${hiringLeads.firstName} || ' ' || ${hiringLeads.lastName}) ilike ${like}`,
        ilike(hiringLeads.email, like),
        ilike(hiringLeads.phone, like),
      ];
      if (digits.length >= 3) parts.push(sql`regexp_replace(${hiringLeads.phone}, '\\D', '', 'g') like ${`%${digits}%`}`);
      leadParts.push(or(...parts) as SQL);
    }
    const leadRows = await this.db.select().from(hiringLeads).where(and(...leadParts)).limit(5000);

    // Cases a lead already stands for are read through the lead; the rest stand alone.
    const caseParts: SQL[] = [
      eq(hiringCases.companyId, companyId),
      eq(hiringCases.isTest, false),
      isNotNull(hiringCases.applicantId),
      sql`not exists (select 1 from ${hiringLeads} l where l.hiring_case_id = ${hiringCases.id} and l.company_id = ${companyId})`,
    ];
    if (scope.recruiters === 'none') caseParts.push(isNull(hiringCases.recruiterId));
    else if (scope.recruiters) caseParts.push(inArray(hiringCases.recruiterId, scope.recruiters.length ? scope.recruiters : ['-']));
    if (term) {
      const like = `%${term}%`;
      const parts = [ilike(hiringCases.candidateName, like), ilike(applicants.email, like), ilike(applicants.phone, like)];
      if (digits.length >= 3) parts.push(sql`regexp_replace(${applicants.phone}, '\\D', '', 'g') like ${`%${digits}%`}`);
      caseParts.push(or(...parts) as SQL);
    }
    const loneCases = await this.db
      .select({ hiringCase: hiringCases, phone: applicants.phone, email: applicants.email })
      .from(hiringCases)
      .leftJoin(applicants, eq(applicants.id, hiringCases.applicantId))
      .where(and(...caseParts))
      .limit(5000);

    const linkedCaseIds = leadRows.map((l) => l.hiringCaseId).filter((v): v is string => !!v);
    const linkedCases = linkedCaseIds.length
      ? await this.db.select().from(hiringCases).where(and(eq(hiringCases.companyId, companyId), inArray(hiringCases.id, linkedCaseIds)))
      : [];
    const caseById = new Map<string, HiringCaseRow>([...linkedCases, ...loneCases.map((c) => c.hiringCase)].map((c) => [c.id, c]));
    const caseIds = [...caseById.keys()];
    const facts = await this.caseFacts(companyId, caseIds);

    const liveLeads = await this.driverApps.liveLeadIds(
      companyId,
      leadRows.filter((l) => !l.hiringCaseId).map((l) => l.id),
    );
    const consentFacts = await this.consents.states(companyId, leadRows.map((l) => l.id), caseIds);
    const safetyFacts = await this.candidateSafety.statuses(companyId, caseIds);
    const consentOf = (leadId: string | null, caseId: string | null): RecruitConsentState =>
      (leadId && consentFacts.received.has(leadId)) || (caseId && consentFacts.received.has(caseId))
        ? 'received'
        : (leadId && consentFacts.live.has(leadId)) || (caseId && consentFacts.live.has(caseId))
          ? 'sent'
          : 'none';
    const out: Person[] = [];
    for (const lead of leadRows) {
      const c = lead.hiringCaseId ? (caseById.get(lead.hiringCaseId) ?? null) : null;
      // A lead whose case was marked as test data is test data too.
      if (c?.isTest) continue;
      const f = c ? facts.get(c.id) : undefined;
      out.push({
        lead,
        hiringCase: c,
        application: f?.application ?? 'none',
        linkLive: f?.linkLive ?? liveLeads.has(lead.id),
        externalReceived: f?.external ?? false,
        phone: lead.phone,
        email: lead.email,
        consent: consentOf(lead.id, c?.id ?? null),
        safety: c ? (safetyFacts.get(c.id) ?? null) : null,
      });
    }
    for (const { hiringCase, phone, email } of loneCases) {
      const f = facts.get(hiringCase.id);
      out.push({
        lead: null,
        hiringCase,
        application: f?.application ?? 'none',
        linkLive: f?.linkLive ?? false,
        externalReceived: f?.external ?? false,
        phone: phone ?? null,
        email: email && !email.endsWith('.lead') ? email : null,
        consent: consentOf(null, hiringCase.id),
        safety: safetyFacts.get(hiringCase.id) ?? null,
      });
    }
    return out;
  }

  /** DOT application state, live link and external receipt per case, in three queries. */
  private async caseFacts(companyId: string, caseIds: string[]) {
    const out = new Map<string, { application: DotApplicationState; linkLive: boolean; external: boolean }>();
    if (caseIds.length === 0) return out;
    for (const id of caseIds) out.set(id, { application: 'none', linkLive: false, external: false });
    const apps = await this.db
      .select({ caseId: hiringDotApplications.hiringCaseId, status: hiringDotApplications.status, snapshot: hiringDotApplications.certifiedSnapshot })
      .from(hiringDotApplications)
      .where(and(eq(hiringDotApplications.companyId, companyId), inArray(hiringDotApplications.hiringCaseId, caseIds)));
    for (const a of apps) {
      const f = out.get(a.caseId);
      if (!f) continue;
      f.application =
        a.status === 'submitted'
          ? 'submitted'
          : a.status === 'driver_submitted' || (a.status === 'submitting' && a.snapshot)
            ? 'driver_submitted'
            : 'draft';
    }
    const now = this.clock();
    const links = await this.db
      .select({ caseId: hiringDotLinks.hiringCaseId })
      .from(hiringDotLinks)
      .where(
        and(
          eq(hiringDotLinks.companyId, companyId),
          inArray(hiringDotLinks.hiringCaseId, caseIds),
          isNull(hiringDotLinks.revokedAt),
          sql`${hiringDotLinks.expiresAt} > ${now.toISOString()}`,
        ),
      );
    for (const l of links) {
      const f = out.get(l.caseId);
      if (f) f.linkLive = true;
    }
    const ext = await this.db
      .select({ caseId: hiringExternalApplications.hiringCaseId })
      .from(hiringExternalApplications)
      .where(and(eq(hiringExternalApplications.companyId, companyId), inArray(hiringExternalApplications.hiringCaseId, caseIds)));
    for (const e of ext) {
      const f = out.get(e.caseId);
      if (f) f.external = true;
    }
    // The personal driver application (/application/#token=…), received and committed.
    for (const caseId of await this.driverApps.receivedCaseIds(companyId, caseIds)) {
      const f = out.get(caseId);
      if (f) f.external = true;
    }
    // The DOT driver application v2 (owner brief 2026-10-27): submitted counts as received, a live
    // link as sent. Read by SQL so this module does not depend on the v2 module.
    const v2 = await this.db.execute<{ case_id: string; status: string; live: boolean }>(sql`
      select a.hiring_case_id as case_id, a.status,
        exists (select 1 from dot_application_links l where l.application_id = a.id and l.revoked_at is null and l.expires_at > ${now.toISOString()}) as live
      from dot_driver_applications a
      where a.company_id = ${companyId} and a.hiring_case_id in ${sql`(${sql.join(caseIds.map((id) => sql`${id}`), sql`, `)})`}`);
    for (const r of v2 as unknown as { case_id: string; status: string; live: boolean }[]) {
      const f = out.get(r.case_id);
      if (!f) continue;
      if (['submitted', 'under_review', 'approved', 'hired'].includes(r.status)) f.application = 'driver_submitted';
      else if (r.live) f.linkLive = true;
    }
    return out;
  }

  private progressInput(p: Person): RecruitProgressInput {
    return {
      lead: p.lead ? { status: p.lead.status } : null,
      hiringCase: p.hiringCase
        ? { state: p.hiringCase.state as HiringState, safetyRequestedAt: p.hiringCase.safetyRequestedAt?.toISOString() ?? null }
        : null,
      application: p.application,
      externalReceived: p.externalReceived,
      linkLive: p.linkLive,
      consent: p.consent,
      safety: p.safety,
      applicationReviewed: Boolean(p.hiringCase?.applicationReviewedAt),
      onboardingStarted: Boolean(p.hiringCase?.onboardingStartedAt),
    };
  }

  private async recruiterNames(companyId: string, ids: string[]): Promise<Map<string, string>> {
    const unique = [...new Set(ids)];
    if (unique.length === 0) return new Map();
    const rows = await this.db
      .select({ id: employees.id, first: employees.firstName, last: employees.lastName })
      .from(employees)
      .where(and(eq(employees.companyId, companyId), inArray(employees.id, unique)));
    return new Map(rows.map((r) => [r.id, `${r.first} ${r.last}`.trim()]));
  }

  private recruiterOf(p: Person): string | null {
    return p.lead?.recruiterEmployeeId ?? p.hiringCase?.recruiterId ?? null;
  }

  private followUpOf(p: Person): string | null {
    return p.lead ? (p.lead.nextFollowUpOn ?? p.hiringCase?.nextFollowUpOn ?? null) : (p.hiringCase?.nextFollowUpOn ?? null);
  }

  private keyOf(p: Person): string {
    return p.hiringCase?.applicantId ?? p.lead?.applicantId ?? p.lead?.id ?? (p.hiringCase?.id as string);
  }

  /** Where the lead came from; a missing source counts as Unknown (owner's brief, 2026-10-11). */
  private sourceOf(p: Person): string {
    return p.lead?.source?.trim() || 'unknown';
  }

  /** The Eastern day the lead was received, which is what the dashboard's period selects on. */
  private receivedOn(p: Person): string {
    return easternDate(p.lead?.createdAt ?? p.hiringCase?.openedAt ?? new Date(0));
  }

  /** The dashboard's cuts (period, stage, source), shared by the list so the numbers reconcile. */
  private inCut(p: Person, row: RecruitRow, cut: { from?: string; to?: string; stage?: RecruitStage; source?: string }): boolean {
    const on = this.receivedOn(p);
    if (cut.from && on < cut.from) return false;
    if (cut.to && on > cut.to) return false;
    if (cut.stage && row.stage !== cut.stage) return false;
    if (cut.source && row.source !== cut.source) return false;
    return true;
  }

  private nameOf(p: Person): string {
    if (p.lead) return `${p.lead.firstName} ${p.lead.lastName}`.trim();
    return p.hiringCase?.candidateName ?? '';
  }

  private row(p: Person, today: string, names: Map<string, string>): RecruitRow {
    const input = this.progressInput(p);
    const progress = recruitProgressOf(input);
    const recruiterId = this.recruiterOf(p);
    const followUpOn = isActiveProgress(progress) ? this.followUpOf(p) : null;
    const source = this.sourceOf(p);
    return {
      key: this.keyOf(p),
      leadId: p.lead?.id ?? null,
      caseId: p.hiringCase?.id ?? null,
      applicantId: p.hiringCase?.applicantId ?? p.lead?.applicantId ?? null,
      name: this.nameOf(p),
      source,
      sourceLabel: sourceLabel(source),
      progress,
      stage: recruitStageOf(progress),
      nextStep: recruitNextStep(input),
      followUpOn,
      followUpState: followUpStateOf(followUpOn, today),
      recruiter: recruiterId ? { employeeId: recruiterId, name: names.get(recruiterId) ?? recruiterId } : null,
      createdAt: (p.lead?.createdAt ?? p.hiringCase?.openedAt ?? new Date(0)).toISOString(),
      lastNote: null,
    };
  }

  /**
   * The newest written note (a note or a logged call with text) of each shown person, in one query
   * for the page: notes are audit entries on the lead, the case or the applicant.
   */
  private async attachLastNotes(companyId: string, rows: RecruitRow[], byKey: Map<string, Person>): Promise<void> {
    const owner = new Map<string, RecruitRow>();
    for (const r of rows) {
      const p = byKey.get(r.key);
      for (const id of [p?.lead?.id, p?.hiringCase?.id, p?.hiringCase?.applicantId]) if (id) owner.set(id, r);
    }
    if (owner.size === 0) return;
    const notes = await this.db
      .select({ entityId: auditLogs.entityId, at: auditLogs.at, by: auditLogs.actorName, text: auditLogs.reason })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, companyId),
          inArray(auditLogs.entityId, [...owner.keys()]),
          inArray(auditLogs.entityType, ['hiring_lead', 'hiring_case']),
          inArray(auditLogs.action, ['note', 'follow_up']),
        ),
      )
      .orderBy(desc(auditLogs.at), desc(auditLogs.id));
    for (const n of notes) {
      const r = owner.get(n.entityId);
      const text = n.text?.trim();
      if (!r || r.lastNote || !text) continue;
      r.lastNote = { text, byName: n.by, at: n.at.toISOString() };
    }
  }

  // =================================================================================== list

  async list(principal: Principal, query: RecruitListQuery): Promise<RecruitList> {
    const scope = await this.scope(principal, query);
    const people = await this.people(principal.companyId, scope, query.q);
    const today = this.today();
    const names = await this.recruiterNames(principal.companyId, people.map((p) => this.recruiterOf(p)).filter((v): v is string => !!v));
    const cut = { from: query.from, to: query.to, stage: query.stage, source: query.source };
    const kept = people.filter((p) => this.inCut(p, this.row(p, today, names), cut));
    const rows = kept.map((p) => this.row(p, today, names));
    const counts = Object.fromEntries(RECRUIT_FILTERS.map((f) => [f, 0])) as Record<RecruitFilter, number>;
    let followUpDue = 0;
    for (const r of rows) {
      if (r.progress !== 'closed') counts.all += 1;
      counts[recruitFilterOf(r.progress)] += 1;
      if (isActiveProgress(r.progress)) counts.active += 1;
      if (r.followUpState === 'overdue' || r.followUpState === 'today') followUpDue += 1;
    }
    const due = (r: RecruitRow) => r.followUpState === 'overdue' || r.followUpState === 'today';
    // From the dashboard (a period or a stage), "All" is the whole cohort, Closed included, so the
    // list's total is the number that was clicked.
    const cohort = Boolean(query.stage || query.from || query.to || query.source);
    const filtered = rows
      .filter((r) => (cohort && query.filter === 'all' ? true : matchesRecruitFilter(r.progress, query.filter)))
      .filter((r) => (query.followUp === 'due' ? due(r) : true))
      .sort((a, b) => {
        // Grouped by step in funnel order - New, Contacted, Awaiting application, ... (owner,
        // 2026-10-09); inside a step, due follow-ups first (oldest due first), then the newest.
        const pa = RECRUIT_PROGRESS.indexOf(a.progress);
        const pb = RECRUIT_PROGRESS.indexOf(b.progress);
        if (pa !== pb) return pa - pb;
        const da = due(a) ? 0 : 1;
        const dbb = due(b) ? 0 : 1;
        if (da !== dbb) return da - dbb;
        if (da === 0 && a.followUpOn !== b.followUpOn) return (a.followUpOn ?? '').localeCompare(b.followUpOn ?? '');
        return b.createdAt.localeCompare(a.createdAt) || a.key.localeCompare(b.key);
      });
    const start = (query.page - 1) * query.pageSize;
    const pageRows = filtered.slice(start, start + query.pageSize);
    // "Hire" is the next step only when the hire's prerequisites are really met; checked for the
    // shown page's candidates at orientation (the only stage a hire can happen from).
    const byKey = new Map(people.map((p) => [this.keyOf(p), p]));
    for (const r of pageRows) {
      const p = byKey.get(r.key);
      if (!p?.hiringCase) continue;
      const journeyOnboarding = Boolean(p.hiringCase.onboardingStartedAt) && !p.hiringCase.hiredAt;
      if (p.hiringCase.state !== 'orientation' && !journeyOnboarding) continue;
      const ready = journeyOnboarding
        ? await this.candidateHire.isReady(principal, p.hiringCase)
        : (await this.hireReadiness(principal, p.hiringCase)).ready;
      const input = { ...this.progressInput(p), hireReady: ready };
      r.progress = recruitProgressOf(input);
      r.stage = recruitStageOf(r.progress);
      r.nextStep = recruitNextStep(input);
    }
    await this.attachLastNotes(principal.companyId, pageRows, byKey);
    return {
      rows: pageRows,
      total: filtered.length,
      page: query.page,
      pageSize: query.pageSize,
      counts,
      followUpDue,
      scope: scope.info,
      today,
    };
  }

  // ================================================================================== board

  /**
   * The candidate pipeline board (owner mockup, 2026-10-15): every active candidate in scope, once,
   * in the column its derived progress falls in - the same people, progress and readiness as the
   * list, with the few facts a card shows. Hired and closed stay on the list.
   */
  async board(principal: Principal, query: RecruitBoardQuery): Promise<RecruitBoard> {
    const scope = await this.scope(principal, query);
    const people = await this.people(principal.companyId, scope, query.q);
    const today = this.today();
    const names = await this.recruiterNames(principal.companyId, people.map((p) => this.recruiterOf(p)).filter((v): v is string => !!v));
    // Disqualified people stay on the board in their own column (owner, 2026-10-16): a disqualified
    // case, Safety's Not qualified, or a lead marked dead. Withdrawn and no-shows still leave it.
    const disqualified = (p: Person) =>
      p.hiringCase?.state === 'disqualified' || p.safety === 'declined' || (!p.hiringCase && p.lead?.status === 'dead');
    const active = people.filter((p) => isActiveProgress(recruitProgressOf(this.progressInput(p))) || disqualified(p));

    // Saved hiring cost records per person (case or lead), voided ones left out of every total.
    const caseIds = active.map((p) => p.hiringCase?.id).filter((v): v is string => !!v);
    const leadIds = active.map((p) => p.lead?.id).filter((v): v is string => !!v);
    const costByOwner = new Map<string, number>();
    if (caseIds.length || leadIds.length) {
      const owners: SQL[] = [];
      if (caseIds.length) owners.push(inArray(hiringCostEntries.hiringCaseId, caseIds));
      if (leadIds.length) owners.push(inArray(hiringCostEntries.leadId, leadIds));
      const costs = await this.db
        .select({ caseId: hiringCostEntries.hiringCaseId, leadId: hiringCostEntries.leadId, amount: hiringCostEntries.amount })
        .from(hiringCostEntries)
        .where(and(eq(hiringCostEntries.companyId, principal.companyId), isNull(hiringCostEntries.voidedAt), or(...owners)));
      for (const c of costs) {
        const owner = c.caseId ?? c.leadId;
        if (owner) costByOwner.set(owner, (costByOwner.get(owner) ?? 0) + Math.round(Number(c.amount) * 100));
      }
    }

    // When each card entered the step it is on (owner, 2026-10-19: every column shows how long).
    const marksRow = await this.state.getFor(principal.companyId, STAGE_MARKS_KEY);
    let marks: Record<string, { p: string; at: string }> = {};
    try {
      marks = marksRow ? (JSON.parse(marksRow.value) as typeof marks) : {};
    } catch {
      marks = {};
    }
    let marksChanged = false;
    const nowIso = new Date().toISOString();

    const cards: RecruitBoardCard[] = [];
    for (const p of active) {
      const row = this.row(p, today, names);
      // Ready to hire only when the hire's prerequisites are really met, as on the list.
      if (p.hiringCase) {
        const journeyOnboarding = Boolean(p.hiringCase.onboardingStartedAt) && !p.hiringCase.hiredAt;
        if (p.hiringCase.state === 'orientation' || journeyOnboarding) {
          const ready = journeyOnboarding
            ? await this.candidateHire.isReady(principal, p.hiringCase)
            : (await this.hireReadiness(principal, p.hiringCase)).ready;
          const input = { ...this.progressInput(p), hireReady: ready };
          row.progress = recruitProgressOf(input);
          row.stage = recruitStageOf(row.progress);
          row.nextStep = recruitNextStep(input);
        }
      }
      const column = disqualified(p) ? 'disqualified' : recruitBoardColumnOf(row.progress);
      if (!column) continue;
      const prequal = (p.lead?.prequalification ?? null) as { payTypePreference?: unknown } | null;
      const pay = prequal?.payTypePreference;
      const caseCost = p.hiringCase ? costByOwner.get(p.hiringCase.id) : undefined;
      const leadCost = p.lead ? costByOwner.get(p.lead.id) : undefined;
      cards.push({
        ...row,
        column,
        phone: p.phone,
        driverType: pay === 'company' || pay === 'owner_operator' || pay === 'lease_operator' ? pay : null,
        consent: p.consent,
        safety: p.safety,
        stageSince: (() => {
          const step = column === 'disqualified' ? 'disqualified' : row.progress;
          const known = marks[row.key];
          if (known && known.p === step) return known.at;
          // A stored time that marks the step, else the last change to the record - the moment the
          // card most likely moved; from now on the mark keeps it.
          const stamped =
            step === 'new'
              ? row.createdAt
              : (step === 'onboarding' || step === 'ready_to_hire') && p.hiringCase?.onboardingStartedAt
                ? p.hiringCase.onboardingStartedAt.toISOString()
                : [p.lead?.updatedAt, p.hiringCase?.updatedAt, p.hiringCase?.safetyRequestedAt]
                    .filter((d): d is Date => d instanceof Date)
                    .map((d) => d.toISOString())
                    .sort()
                    .pop() ?? row.createdAt;
          const at = known ? nowIso : stamped < nowIso ? stamped : nowIso;
          marks[row.key] = { p: step, at };
          marksChanged = true;
          return at;
        })(),
        costCents: caseCost === undefined && leadCost === undefined ? null : (caseCost ?? 0) + (leadCost ?? 0),
      });
    }
    if (marksChanged) {
      await this.state.putFor(principal.companyId, STAGE_MARKS_KEY, JSON.stringify(marks)).catch(() => undefined);
    }
    return { cards, scope: scope.info, today };
  }

  /**
   * The Recruiting dashboard (owner's brief, 2026-10-11): the leads received in the period, read
   * from the same rows as the list, so each number opens the list it was counted from. Hired counts
   * that cohort's hires, conversion is hired / leads, and the stages add up to the total.
   */
  async dashboard(principal: Principal, query: RecruitDashboardQuery): Promise<RecruitDashboard> {
    if (query.from > query.to) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'The period ends before it starts.' });
    }
    // Without recruiting.manage the dashboard is the recruiter's own leads.
    const scopeQuery = principal.permissions.has('recruiting.manage')
      ? { scope: query.scope, recruiter: query.recruiter }
      : { scope: 'mine' as const };
    const scope = await this.scope(principal, scopeQuery);
    const people = await this.people(principal.companyId, scope);
    const today = this.today();
    const names = await this.recruiterNames(principal.companyId, people.map((p) => this.recruiterOf(p)).filter((v): v is string => !!v));
    const cohort = people
      .map((p) => ({ p, row: this.row(p, today, names) }))
      .filter(({ p, row }) => this.inCut(p, row, { from: query.from, to: query.to }));

    const total = cohort.length;
    const hired = cohort.filter(({ row }) => row.progress === 'hired').length;
    const inProgress = cohort.filter(({ row }) => isActiveProgress(row.progress)).length;

    const sources = new Map<string, { key: string; label: string; leads: number; hired: number }>();
    for (const { row } of cohort) {
      const s = sources.get(row.source) ?? { key: row.source, label: row.sourceLabel, leads: 0, hired: 0 };
      s.leads += 1;
      if (row.progress === 'hired') s.hired += 1;
      sources.set(row.source, s);
    }
    const stageCount = new Map<RecruitStage, number>(RECRUIT_STAGES.map((st) => [st, 0]));
    for (const { row } of cohort) stageCount.set(row.stage, (stageCount.get(row.stage) ?? 0) + 1);

    const perDay = new Map<string, number>();
    for (const { p } of cohort) {
      const on = this.receivedOn(p);
      perDay.set(on, (perDay.get(on) ?? 0) + 1);
    }
    const trend: { date: string; leads: number }[] = [];
    // Every day of the period, zero days included, capped so a careless range stays cheap.
    for (let d = query.from, n = 0; d <= query.to && n < 400; d = addDay(d), n += 1) trend.push({ date: d, leads: perDay.get(d) ?? 0 });

    const recent = [...cohort]
      .sort((a, b) => b.row.createdAt.localeCompare(a.row.createdAt))
      .slice(0, 6)
      .map(({ row }) => ({
        key: row.key,
        name: row.name,
        sourceLabel: row.sourceLabel,
        stage: row.stage,
        stageLabel: RECRUIT_STAGE_LABELS[row.stage],
        recruiter: row.recruiter?.name ?? null,
        receivedAt: row.createdAt,
      }));

    return {
      period: { from: query.from, to: query.to },
      scope: scope.info,
      total,
      hired,
      conversion: total > 0 ? hired / total : null,
      inProgress,
      sources: [...sources.values()].sort((a, b) => b.leads - a.leads || a.label.localeCompare(b.label)),
      stages: RECRUIT_STAGES.map((stage) => ({ stage, label: RECRUIT_STAGE_LABELS[stage], count: stageCount.get(stage) ?? 0 })),
      trend,
      nextActions: [
        { key: 'consent', label: 'Waiting for consent', count: stageCount.get('consent_pending') ?? 0, stage: 'consent_pending' },
        { key: 'safety', label: 'Awaiting Safety review', count: stageCount.get('safety_review') ?? 0, stage: 'safety_review' },
        { key: 'onboarding', label: 'In onboarding', count: stageCount.get('onboarding') ?? 0, stage: 'onboarding' },
      ],
      recent,
      today,
    };
  }

  async metrics(principal: Principal, query: { scope: 'mine' | 'all'; recruiter?: string }): Promise<RecruitMetrics> {
    const scope = await this.scope(principal, query);
    const people = await this.people(principal.companyId, scope);
    const today = this.today();
    const month = today.slice(0, 7);
    let active = 0;
    let followUpDue = 0;
    let hiredThisMonth = 0;
    for (const p of people) {
      const progress = recruitProgressOf(this.progressInput(p));
      if (isActiveProgress(progress)) {
        active += 1;
        const state = followUpStateOf(this.followUpOf(p), today);
        if (state === 'overdue' || state === 'today') followUpDue += 1;
      }
      // The hire event itself, on the company (Eastern) calendar.
      const hiredAt = p.hiringCase?.hiredAt;
      if (hiredAt && easternDate(hiredAt).slice(0, 7) === month) hiredThisMonth += 1;
    }
    return { active, followUpDue, hiredThisMonth, month, today, scope: scope.info };
  }

  // ============================================================================== candidate

  /** The person behind a route key, company-scoped, with the access rule applied. */
  /**
   * The candidate a hired driver came from (step 9): the driver profile reads the signed consents,
   * Safety reports, onboarding and costs through the same journey, by this key. Null when the driver
   * did not come through hiring.
   */
  async candidateKeyForDriver(principal: Principal, driverId: string): Promise<{ key: string } | null> {
    const [c] = await this.db
      .select()
      .from(hiringCases)
      .where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.driverId, driverId)))
      .limit(1);
    if (!c || c.isTest) return null;
    const [lead] = await this.db.select({ id: hiringLeads.id }).from(hiringLeads).where(and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.hiringCaseId, c.id))).limit(1);
    return { key: c.applicantId ?? lead?.id ?? c.id };
  }

  /** The candidate behind a route key, as the journey's actions act on it (scope-checked). */
  async subjectFor(principal: Principal, key: string): Promise<ApplicationSubject> {
    return this.subjectOf(principal, await this.person(principal, key));
  }

  private async person(principal: Principal, key: string): Promise<Person> {
    let lead: HiringLeadRow | null;
    let hiringCase: HiringCaseRow | null = null;
    if (key.startsWith('lead_')) {
      [lead = null] = await this.db
        .select()
        .from(hiringLeads)
        .where(and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.id, key)))
        .limit(1);
      if (!lead) throw notFound();
      if (lead.hiringCaseId) {
        [hiringCase = null] = await this.db
          .select()
          .from(hiringCases)
          .where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.id, lead.hiringCaseId)))
          .limit(1);
      }
    } else {
      [hiringCase = null] = await this.db
        .select()
        .from(hiringCases)
        .where(and(eq(hiringCases.companyId, principal.companyId), or(eq(hiringCases.applicantId, key), eq(hiringCases.id, key))))
        .limit(1);
      if (!hiringCase) throw notFound();
      [lead = null] = await this.db
        .select()
        .from(hiringLeads)
        .where(and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.hiringCaseId, hiringCase.id)))
        .limit(1);
    }
    if (lead?.isTest || hiringCase?.isTest) throw notFound();
    const facts = hiringCase ? (await this.caseFacts(principal.companyId, [hiringCase.id])).get(hiringCase.id) : undefined;
    let phone = lead?.phone ?? null;
    let email = lead?.email ?? null;
    if (hiringCase?.applicantId) {
      const [a] = await this.db
        .select({ phone: applicants.phone, email: applicants.email })
        .from(applicants)
        .where(and(eq(applicants.companyId, principal.companyId), eq(applicants.id, hiringCase.applicantId)))
        .limit(1);
      phone = phone ?? a?.phone ?? null;
      email = email ?? (a?.email && !a.email.endsWith('.lead') ? a.email : null);
    }
    const leadLive = lead && !hiringCase ? (await this.driverApps.liveLeadIds(principal.companyId, [lead.id])).has(lead.id) : false;
    const cf = await this.consents.states(principal.companyId, lead ? [lead.id] : [], hiringCase ? [hiringCase.id] : []);
    const consent: RecruitConsentState =
      (lead && cf.received.has(lead.id)) || (hiringCase && cf.received.has(hiringCase.id))
        ? 'received'
        : (lead && cf.live.has(lead.id)) || (hiringCase && cf.live.has(hiringCase.id))
          ? 'sent'
          : 'none';
    const safety = hiringCase ? ((await this.candidateSafety.statuses(principal.companyId, [hiringCase.id])).get(hiringCase.id) ?? null) : null;
    const p: Person = {
      lead,
      hiringCase,
      application: facts?.application ?? 'none',
      linkLive: facts?.linkLive ?? leadLive,
      externalReceived: facts?.external ?? false,
      phone,
      email,
      consent,
      safety,
    };
    await this.assertCanOpen(principal, p);
    return p;
  }

  /** A recruiter without recruiting.manage opens only the candidates assigned to them. */
  private async assertCanOpen(principal: Principal, p: Person): Promise<void> {
    if (principal.permissions.has('recruiting.manage')) return;
    const own = await this.rotation.ownEmployee(principal);
    const assigned = this.recruiterOf(p);
    if (!own || assigned !== own.employeeId) {
      throw forbidden('This candidate is assigned to another recruiter.');
    }
  }

  private assertManage(principal: Principal) {
    if (!principal.permissions.has('recruiting.manage')) {
      throw forbidden('This needs the recruiting manage permission.');
    }
  }

  async candidate(principal: Principal, key: string): Promise<RecruitCandidate> {
    const p = await this.person(principal, key);
    const today = this.today();
    const input = this.progressInput(p);
    const c = p.hiringCase;
    const recruiterId = this.recruiterOf(p);
    const names = await this.recruiterNames(principal.companyId, recruiterId ? [recruiterId] : []);
    const canManage = principal.permissions.has('recruiting.manage');

    let applicantNumber: string | null = null;
    let location: string | null = p.lead?.state ?? null;
    let nameParts = p.lead ? { firstName: p.lead.firstName, lastName: p.lead.lastName } : splitFullName(c?.candidateName ?? '');
    if (c?.applicantId) {
      const [a] = await this.db
        .select({ number: applicants.applicantNumber, location: applicants.location, firstName: applicants.firstName, lastName: applicants.lastName })
        .from(applicants)
        .where(and(eq(applicants.companyId, principal.companyId), eq(applicants.id, c.applicantId)))
        .limit(1);
      applicantNumber = a?.number ?? null;
      location = a?.location ?? location;
      if (!p.lead && a) nameParts = { firstName: a.firstName, lastName: a.lastName };
    }

    const application = await this.applicationOf(principal, c, canManage);
    // No location on the lead or the candidate record: the city and state the application gives.
    const current = application.summary?.personal.currentAddress;
    if (!location && current) location = current.split(', ').slice(-2).join(', ');
    const safety = await this.safetyOf(principal, c);
    const readiness = await this.readiness(principal, c, p.application);
    const hire = await this.hireReadiness(principal, c);
    // The journey's own Ready-to-hire checklist once onboarding started (owner brief, 2026-10-11).
    const journeyReady = c?.onboardingStartedAt && !c.hiredAt ? await this.candidateHire.isReady(principal, c) : null;
    const hireReady = journeyReady ?? hire.ready;
    const followUpOn = this.followUpOf(p);
    const fState = followUpStateOf(followUpOn, today);
    const progress = recruitProgressOf({ ...input, hireReady });
    const driverApplication = await this.driverApps.view(principal, this.subjectOf(principal, p));
    const answer = (k: string) => driverApplication.submission?.answers.find((a) => a.key === k)?.value || null;
    const prequal = p.lead?.prequalResult as { qualifies: boolean; failed: { label: string }[] } | null | undefined;

    return {
      key: this.keyOf(p),
      leadId: p.lead?.id ?? null,
      caseId: c?.id ?? null,
      applicantId: c?.applicantId ?? p.lead?.applicantId ?? null,
      leadNumber: p.lead?.leadNumber ?? null,
      applicantNumber,
      name: this.nameOf(p),
      firstName: nameParts.firstName,
      lastName: nameParts.lastName,
      version: this.versionOf(p),
      phone: p.phone ?? answer('phone'),
      // No email on the lead: the one the driver gave on the application.
      email: p.email ?? answer('email'),
      location,
      source: p.lead?.source ?? 'unknown',
      sourceLabel: sourceLabel(p.lead?.source ?? 'unknown'),
      createdAt: (p.lead?.createdAt ?? c?.openedAt ?? new Date(0)).toISOString(),
      recruiter: recruiterId ? { employeeId: recruiterId, name: names.get(recruiterId) ?? recruiterId } : null,
      progress,
      nextStep: recruitNextStep({ ...input, hireReady }),
      followUp:
        followUpOn && fState && isActiveProgress(progress)
          ? {
              on: followUpOn,
              state: fState,
              setBy: (p.lead?.nextFollowUpOn ? p.lead.followUpSetBy : c?.followUpSetBy) ?? null,
              setAt: ((p.lead?.nextFollowUpOn ? p.lead.followUpSetAt : c?.followUpSetAt) ?? null)?.toISOString() ?? null,
            }
          : null,
      lead: p.lead
        ? {
            status: p.lead.status,
            prequalified: p.lead.status === 'prequalified' || p.lead.status === 'converted',
            prequalFailed: prequal && !prequal.qualifies ? prequal.failed.map((f) => f.label) : null,
            deadReason: p.lead.deadReason,
          }
        : null,
      caseState: (c?.state as HiringState | undefined) ?? null,
      driverId: c?.driverId ?? null,
      application,
      driverApplication,
      safety,
      sendToSafety: readiness,
      hire,
      journeyState: {
        consent: p.consent,
        safety: p.safety,
        applicationReviewed: Boolean(c?.applicationReviewedAt),
        onboardingStarted: Boolean(c?.onboardingStartedAt),
        hireReady,
        onHold: Boolean(c?.onHoldAt),
        consentFirst: (await this.settings.valuesFor(principal.companyId, ['hiring.consent_first']))['hiring.consent_first'] !== false,
      },
      permissions: {
        canManage,
        canSeeSensitive: canManage,
        canReassign: canManage,
      },
    };
  }

  private async applicationOf(principal: Principal, c: HiringCaseRow | null, canSeeSensitive: boolean): Promise<RecruitCandidate['application']> {
    const empty: RecruitCandidate['application'] = {
      state: 'none',
      submittedAt: null,
      certifiedAt: null,
      certifiedName: null,
      submittedVia: null,
      reviewedAt: null,
      reviewedBy: null,
      returnedAt: null,
      returnNote: null,
      documentId: null,
      link: null,
      markedSentAt: null,
      markedSentBy: null,
      external: null,
      summary: null,
    };
    if (!c) return empty;
    const [app] = await this.db.select().from(hiringDotApplications).where(eq(hiringDotApplications.hiringCaseId, c.id)).limit(1);
    const [link] = await this.db
      .select()
      .from(hiringDotLinks)
      .where(and(eq(hiringDotLinks.companyId, principal.companyId), eq(hiringDotLinks.hiringCaseId, c.id)))
      .orderBy(desc(hiringDotLinks.createdAt))
      .limit(1);
    const [ext] = await this.db
      .select()
      .from(hiringExternalApplications)
      .where(and(eq(hiringExternalApplications.companyId, principal.companyId), eq(hiringExternalApplications.hiringCaseId, c.id)))
      .orderBy(desc(hiringExternalApplications.receivedAt))
      .limit(1);
    const [sent] = c.applicantId
      ? await this.db
          .select({ at: auditLogs.at, by: auditLogs.actorName })
          .from(auditLogs)
          .where(
            and(
              eq(auditLogs.companyId, principal.companyId),
              eq(auditLogs.entityId, c.applicantId),
              eq(auditLogs.action, 'application_link_marked_sent'),
            ),
          )
          .orderBy(desc(auditLogs.at))
          .limit(1)
      : [];
    const now = this.clock();
    const state: DotApplicationState = !app
      ? 'none'
      : app.status === 'submitted'
        ? 'submitted'
        : app.status === 'driver_submitted' || (app.status === 'submitting' && app.certifiedSnapshot)
          ? 'driver_submitted'
          : 'draft';
    // The summary shows what the driver certified (or what was filed); a draft shows nothing yet.
    const formSource = state === 'driver_submitted' ? (app?.certifiedSnapshot ?? app?.form) : state === 'submitted' ? app?.form : null;
    const summary = formSource ? this.summarize(formSource, app?.ssnLast4 ?? null, app?.consentIds, canSeeSensitive) : null;
    return {
      state,
      submittedAt: app?.submittedAt?.toISOString() ?? null,
      certifiedAt: app?.certifiedAt?.toISOString() ?? null,
      certifiedName: app?.certifiedName ?? null,
      submittedVia: app?.submittedVia ?? null,
      reviewedAt: app?.reviewedAt?.toISOString() ?? null,
      reviewedBy: app?.reviewedBy ?? null,
      returnedAt: app?.returnedAt?.toISOString() ?? null,
      returnNote: app?.returnNote ?? null,
      documentId: app?.documentId ?? null,
      link: link
        ? {
            state: link.revokedAt ? 'revoked' : link.expiresAt.getTime() <= now.getTime() ? 'expired' : 'live',
            createdAt: link.createdAt.toISOString(),
            expiresAt: link.expiresAt.toISOString(),
            firstOpenedAt: link.firstOpenedAt?.toISOString() ?? null,
            lastSavedAt: link.lastSavedAt?.toISOString() ?? null,
            submittedAt: link.submittedAt?.toISOString() ?? null,
          }
        : null,
      markedSentAt: sent?.at.toISOString() ?? null,
      markedSentBy: sent?.by ?? null,
      external: ext ? await this.externalView(ext) : null,
      summary,
    };
  }

  /** An external submission for review: the answers as given (never the SSN), and its files. */
  private async externalView(ext: typeof hiringExternalApplications.$inferSelect) {
    const a = (ext.answers ?? {}) as Record<string, unknown>;
    const labels: [string, string][] = [
      ['firstName', 'First name'], ['lastName', 'Last name'], ['phone', 'Phone'], ['email', 'Email'],
      ['address', 'Address'], ['city', 'City'], ['stateZip', 'State / ZIP'],
      ['cdlClass', 'CDL class'], ['cdlState', 'CDL state'], ['cdlExpiration', 'CDL expires'],
      ['medicalExpiration', 'Medical card expires'], ['experience', 'Experience'], ['endorsements', 'Endorsements'],
      ['position', 'Position'], ['preference', 'Preference'], ['startDate', 'Earliest start'], ['routes', 'Routes'],
      ['employer', 'Most recent employer'], ['employmentStart', 'Employed from'], ['employmentEnd', 'Employed to'],
      ['leavingReason', 'Reason for leaving'], ['accidents', 'Accidents (3 yrs)'], ['violations', 'Violations (3 yrs)'],
      ['suspended', 'Licence suspended (3 yrs)'], ['source', 'How they found us'],
    ];
    const answers = labels
      .map(([k, label]) => ({ label, value: a[k] === null || a[k] === undefined ? '' : String(a[k]) }))
      .filter((x) => x.value !== '');
    if (ext.ssnLast4) answers.push({ label: 'SSN', value: `•••-••-${ext.ssnLast4}` });
    const ids = Array.isArray(ext.fileIds) ? (ext.fileIds as string[]) : [];
    const files = ids.length
      ? await this.db
          .select({ code: hiringDotLinkFiles.code, fileName: hiringDotLinkFiles.fileName })
          .from(hiringDotLinkFiles)
          .where(inArray(hiringDotLinkFiles.id, ids))
      : [];
    return { receivedAt: ext.receivedAt.toISOString(), provider: ext.provider, reference: ext.reference, answers, files };
  }

  /** The application, masked: never the SSN, the full licence number, or (without manage) the birth date. */
  private summarize(raw: unknown, ssnLast4: string | null, consentIds: unknown, canSeeSensitive: boolean): RecruitApplicationSummary {
    const form = DotApplicationDraftFormSchema.parse(raw);
    const current = form.addresses.find((a) => a.to === null) ?? form.addresses[0];
    const license = form.licenses[0];
    const employers = form.employment.filter((e) => e.kind === 'employer');
    const recent = [...employers].sort((a, b) => (b.from ?? '').localeCompare(a.from ?? ''))[0];
    const dob = form.dateOfBirth ?? null;
    return {
      personal: {
        legalName: [form.legalFirstName, form.legalMiddleName, form.legalLastName].filter(Boolean).join(' '),
        // No part of the birth date without the sensitive codes - not even the year (owner, 2026-10-25).
        dateOfBirth: dob ? (canSeeSensitive ? dob : '••••-••-••') : null,
        dateOfBirthMasked: !canSeeSensitive,
        currentAddress: current ? [current.street, current.city, `${current.state ?? ''} ${current.zip ?? ''}`.trim()].filter(Boolean).join(', ') : null,
        addressCount: form.addresses.length,
        ssnMasked: ssnLast4 ? `•••-••-${ssnLast4}` : null,
      },
      cdl: {
        licenseClass: license?.licenseClass ?? null,
        numberMasked: license?.number ? `•••••${license.number.slice(-4)}` : null,
        state: license?.state ?? null,
        expiresOn: license?.expiresOn ?? null,
        endorsements: license?.endorsements ?? [],
        licenseCount: form.licenses.length,
      },
      experience: {
        employers: employers.length,
        cmvEmployers: employers.filter((e) => e.kind === 'employer' && e.droveCmv).length,
        gaps: form.employment.filter((e) => e.kind === 'gap').length,
        mostRecent:
          recent && recent.kind === 'employer'
            ? { employer: recent.employer ?? '', position: recent.position ?? '', from: recent.from ?? '', to: recent.to ?? null }
            : null,
      },
      drivingHistory: {
        accidents: form.accidents.map((a) => ({ date: a.date ?? '', location: a.location ?? '', nature: a.nature ?? '' })),
        convictions: form.convictions.map((c) => ({ date: c.date ?? '', location: c.location ?? '', offense: c.offense ?? '' })),
        licenseDeniedOrRevoked: form.licenseDeniedOrRevoked ?? false,
      },
      consents: { count: Array.isArray(consentIds) ? consentIds.length : 0 },
      certifiedName: form.certifiedName ?? null,
      certifiedOn: form.certifiedOn ?? null,
    };
  }

  private async safetyOf(principal: Principal, c: HiringCaseRow | null): Promise<RecruitCandidate['safety']> {
    const base = {
      requestedAt: c?.safetyRequestedAt?.toISOString() ?? null,
      requestedBy: c?.safetyRequestedBy ?? null,
      requestNote: c?.safetyRequestNote ?? null,
      verification: null,
    };
    if (!c?.verificationCaseId) return base;
    const [vc] = await this.db
      .select()
      .from(verificationCases)
      .where(and(eq(verificationCases.companyId, principal.companyId), eq(verificationCases.id, c.verificationCaseId)))
      .limit(1);
    if (!vc) return base;
    const v = await this.verification.derive(principal.companyId, vc);
    return {
      ...base,
      verification: {
        id: v.id,
        stage: v.stage,
        safetyReviewStatus: v.safetyReviewStatus,
        safetyReviewBy: v.safetyReviewBy,
        safetyReviewAt: v.safetyReviewAt,
        decision: v.decision,
        decisionAt: v.decisionAt,
        decisionBy: v.decisionBy,
        decisionNote: v.decisionNote,
        steps: v.steps.map((s) => ({ label: s.label, status: s.status, blocker: s.blocker })),
      },
    };
  }

  /** What Send to Safety needs: the application on file and the documents Recruiting collects. */
  private async readiness(principal: Principal, c: HiringCaseRow | null, application: DotApplicationState): Promise<SendToSafetyReadiness> {
    const checks: SendToSafetyReadiness['checks'] = [];
    checks.push({
      code: 'application',
      label: 'Application received',
      ok: application === 'submitted',
      detail:
        application === 'submitted'
          ? 'On file'
          : application === 'driver_submitted'
            ? 'The driver submitted it — review and accept it first (Application tab)'
            : 'Not submitted yet',
    });
    let docs: { requirementCode: string; status: string; uploadedAt: string }[] = [];
    if (c?.driverId) {
      docs = (
        await this.db
          .select({ requirementCode: complianceDocuments.requirementCode, status: complianceDocuments.status, uploadedAt: complianceDocuments.uploadedAt })
          .from(complianceDocuments)
          .where(and(eq(complianceDocuments.companyId, principal.companyId), eq(complianceDocuments.ownerId, c.driverId)))
      ).map((d) => ({ ...d, uploadedAt: d.uploadedAt.toISOString() }));
    }
    for (const code of INTAKE_DOCUMENTS) {
      const label = HIRING_DOCUMENTS.find((d) => d.code === code)?.label ?? code;
      const state = hiringDocumentState(docs, code);
      const ok = state === 'waiting_for_safety' || state === 'approved';
      checks.push({
        code,
        label,
        ok,
        detail:
          state === 'missing'
            ? 'Not uploaded — upload it on the Documents tab'
            : state === 'rejected'
              ? 'Rejected by Safety — upload a new one'
              : state === 'expired'
                ? 'Expired — upload a current one'
                : state === 'approved'
                  ? 'Received · approved by Safety'
                  : 'Received · waiting for Safety',
      });
    }
    return { ready: checks.every((x) => x.ok), alreadyRequested: Boolean(c?.safetyRequestedAt), checks };
  }

  private async hireReadiness(principal: Principal, c: HiringCaseRow | null): Promise<RecruitCandidate['hire']> {
    const base = { hiredAt: c?.hiredAt?.toISOString() ?? null, driverId: c?.driverId ?? null, employeeId: c?.employeeId ?? null };
    if (!c) return { ready: false, missing: ['Not a candidate yet'], ...base };
    if (c.state === 'hired' || c.state === 'active_driver') return { ready: false, missing: [], ...base };
    const missing: string[] = [];
    if (c.state !== 'orientation') missing.push(c.state === 'offer' || c.state === 'ticketed' ? 'Offer accepted, travel and orientation recorded (Offer & onboarding)' : 'Safety approval');
    if (!c.offerId) missing.push('A driver offer');
    if (c.state === 'orientation') {
      const o = await this.pipeline.orientation(principal, c.id);
      if (o?.attendance !== 'attended') missing.push('Orientation attended');
      if (o?.roadTest?.result !== 'pass') missing.push('Road test passed');
    }
    if (c.driverId && (c.state === 'orientation' || c.state === 'offer' || c.state === 'ticketed')) {
      missing.push(...(await this.pipeline.missingMandatoryChecks(principal, c.driverId)));
    }
    return { ready: missing.length === 0, missing, ...base };
  }

  // ================================================================================== notes

  async notes(principal: Principal, key: string): Promise<RecruitNote[]> {
    const p = await this.person(principal, key);
    const ids = [p.lead?.id, p.hiringCase?.id, p.hiringCase?.applicantId].filter((v): v is string => !!v);
    const rows = await this.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, principal.companyId),
          inArray(auditLogs.entityId, ids),
          inArray(auditLogs.entityType, ['hiring_lead', 'hiring_case']),
          inArray(auditLogs.action, ['note', 'follow_up', 'follow_up_done']),
        ),
      )
      .orderBy(desc(auditLogs.at), desc(auditLogs.id))
      .limit(500);
    return rows.map((r) => {
      const changes = (r.changes as { field: string; new: string | null }[] | null) ?? [];
      return {
        id: r.id,
        at: r.at.toISOString(),
        byName: r.actorName,
        kind: r.action as RecruitNote['kind'],
        text: r.reason,
        summary: r.action === 'note' ? null : r.summary.replace(/^Follow-up: /, ''),
        followUpOn: changes.find((c) => c.field === 'followUpOn')?.new ?? null,
      };
    });
  }

  /**
   * Saves a note — an append-only audit entry — and, with a date, makes it the candidate's current
   * follow-up, in one transaction: the note and the date commit together or not at all.
   */
  async addNote(principal: Principal, key: string, input: RecruitNoteRequest): Promise<RecruitNote> {
    this.assertManage(principal);
    const p = await this.person(principal, key);
    if (input.followUpOn && input.followUpOn < this.today()) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'Pick today or a later date for the follow-up.',
        extensions: { errors: [{ path: 'followUpOn', message: 'Pick today or a later date', code: 'custom' }] },
      });
    }
    const at = new Date();
    const by = principal.userName ?? principal.userId;
    const target = p.lead ? { type: 'hiring_lead', id: p.lead.id } : { type: 'hiring_case', id: (p.hiringCase as HiringCaseRow).id };
    const event = await this.db.transaction(async (tx) => {
      const e = await this.audit.writeIn(tx, principal, {
        action: 'note',
        entityType: target.type,
        entityId: target.id,
        entityLabel: this.nameOf(p),
        summary: input.followUpOn ? `Note added; follow-up ${input.followUpOn}` : 'Note added',
        reason: input.note,
        changes: input.followUpOn ? [{ field: 'followUpOn', old: this.followUpOf(p), new: input.followUpOn }] : [],
        at,
      });
      if (input.followUpOn) {
        if (p.lead) {
          await tx
            .update(hiringLeads)
            .set({ nextFollowUpOn: input.followUpOn, followUpSetAt: at, followUpSetBy: by, updatedAt: at })
            .where(and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.id, p.lead.id)));
        } else if (p.hiringCase) {
          await tx
            .update(hiringCases)
            .set({ nextFollowUpOn: input.followUpOn, followUpSetAt: at, followUpSetBy: by, updatedAt: at })
            .where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.id, p.hiringCase.id)));
        }
      }
      return e;
    });
    await this.audit.publish(event);
    return { id: event.id, at: at.toISOString(), byName: by, kind: 'note', text: input.note, summary: null, followUpOn: input.followUpOn };
  }

  /** Marks the current follow-up done: the date clears, the entry says who and when. */
  async completeFollowUp(principal: Principal, key: string): Promise<void> {
    this.assertManage(principal);
    const p = await this.person(principal, key);
    const current = this.followUpOf(p);
    if (!current) return;
    const at = new Date();
    const target = p.lead ? { type: 'hiring_lead', id: p.lead.id } : { type: 'hiring_case', id: (p.hiringCase as HiringCaseRow).id };
    const event = await this.db.transaction(async (tx) => {
      if (p.lead) {
        await tx
          .update(hiringLeads)
          .set({ nextFollowUpOn: null, updatedAt: at })
          .where(and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.id, p.lead.id)));
      }
      if (p.hiringCase) {
        await tx
          .update(hiringCases)
          .set({ nextFollowUpOn: null, updatedAt: at })
          .where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.id, p.hiringCase.id)));
      }
      return this.audit.writeIn(tx, principal, {
        action: 'follow_up_done',
        entityType: target.type,
        entityId: target.id,
        entityLabel: this.nameOf(p),
        summary: `Follow-up for ${current} done`,
        changes: [{ field: 'followUpOn', old: current, new: null }],
        at,
      });
    });
    await this.audit.publish(event);
  }

  // ============================================================== personal driver application

  private subjectOf(principal: Principal, p: Person): ApplicationSubject {
    return {
      companyId: principal.companyId,
      leadId: p.lead?.id ?? null,
      caseId: p.hiringCase?.id ?? null,
      subjectKey: p.lead?.id ?? (p.hiringCase as HiringCaseRow).id,
      name: this.nameOf(p),
      applicantId: p.hiringCase?.applicantId ?? p.lead?.applicantId ?? null,
      leadStatus: p.lead?.status ?? null,
      caseState: p.hiringCase?.state ?? null,
      key: this.keyOf(p),
    };
  }

  /** Send application: issue this person's personal link (recruiting.manage; the open rule applies). */
  async issueDriverApplication(principal: Principal, key: string, opts: { deferred?: boolean } = {}) {
    this.assertManage(principal);
    const p = await this.person(principal, key);
    const subject = this.subjectOf(principal, p);
    await this.refuseWhenDotAppV2(principal);
    await this.assertApplicationAllowed(principal, p, subject);
    return this.driverApps.issue(principal, subject, opts);
  }

  /**
   * The DOT driver application v2 (owner brief 2026-10-27) reads the candidate through here: who
   * they are, where their application belongs, and why it may not be sent yet (the same open rule
   * as the earlier application: consent signed, then Safety's approval).
   */
  async dotAppSubject(
    principal: Principal,
    key: string,
  ): Promise<{ subject: ApplicationSubject; email: string | null; phone: string | null; blockedReason: string | null; driverId: string | null }> {
    const p = await this.person(principal, key);
    const subject = this.subjectOf(principal, p);
    let blockedReason: string | null = null;
    try {
      await this.assertApplicationAllowed(principal, p, subject);
    } catch (error) {
      if (error instanceof AppError && error.status === 409) blockedReason = error.detail ?? 'Not yet';
      else throw error;
    }
    return { subject, email: p.email, phone: p.phone, blockedReason, driverId: p.hiringCase?.driverId ?? null };
  }

  /** Once a company's approved documents are complete, its candidates get the new application only. */
  private async refuseWhenDotAppV2(principal: Principal): Promise<void> {
    const needed = DOT_APP_DOCUMENTS.filter((d) => d.signer !== 'employer').map((d) => d.key);
    const rows = await this.db.execute<{ n: number }>(
      sql`select count(distinct doc_key)::int as n from application_document_templates where company_id = ${principal.companyId} and status = 'approved' and doc_key in ${sql`(${sql.join(needed.map((k) => sql`${k}`), sql`, `)})`}`,
    );
    const n = Number((rows as unknown as { n: number }[])[0]?.n ?? 0);
    if (n >= needed.length) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'This company uses the new DOT driver application: send it from the application card.',
        extensions: { code: 'dot_app_v2' },
      });
    }
  }

  /**
   * The application invite waits for Safety (owner brief, 2026-10-11): consent, then Safety's
   * approval, then the application. A candidate already sent an application link under the earlier
   * order (application first) may still be sent a fresh one, so nobody in flight is stranded.
   */
  async assertApplicationAllowed(principal: Principal, p: Person, subject: ApplicationSubject): Promise<void> {
    if (p.safety === 'approved') return;
    // The company can keep the earlier order (application first) with this setting.
    const order = await this.settings.valuesFor(principal.companyId, ['hiring.consent_first']);
    if (order['hiring.consent_first'] === false) return;
    const earlier = (await this.driverApps.view(principal, subject)).session;
    if (p.consent === 'none' && earlier) return;
    throw new AppError({
      status: 409,
      title: 'Conflict',
      detail:
        p.consent !== 'received'
          ? 'The application is sent after the consent is signed and Safety approves it.'
          : 'The application is sent after Safety approves the candidate.',
      extensions: { code: 'safety_first' },
    });
  }

  /** Whether the application invite may go out now, and if not, why (for the candidate page). */
  async applicationGate(principal: Principal, key: string): Promise<{ canSend: boolean; blockedReason: string | null }> {
    const p = await this.person(principal, key);
    try {
      await this.assertApplicationAllowed(principal, p, this.subjectOf(principal, p));
      return { canSend: true, blockedReason: null };
    } catch (error) {
      if (error instanceof AppError && error.status === 409) return { canSend: false, blockedReason: error.detail ?? null };
      throw error;
    }
  }

  async driverApplication(principal: Principal, key: string) {
    const p = await this.person(principal, key);
    return this.driverApps.view(principal, this.subjectOf(principal, p));
  }

  async driverApplicationCopied(principal: Principal, key: string) {
    this.assertManage(principal);
    const p = await this.person(principal, key);
    return this.driverApps.markCopied(principal, this.subjectOf(principal, p));
  }

  async driverApplicationSent(principal: Principal, key: string, channel: string | null) {
    this.assertManage(principal);
    const p = await this.person(principal, key);
    return this.driverApps.markSent(principal, this.subjectOf(principal, p), channel);
  }

  async driverApplicationRevoke(principal: Principal, key: string) {
    this.assertManage(principal);
    const p = await this.person(principal, key);
    return this.driverApps.revoke(principal, this.subjectOf(principal, p));
  }

  async driverApplicationFile(principal: Principal, key: string, fileId: string) {
    const p = await this.person(principal, key);
    return this.driverApps.fileBytes(principal, this.subjectOf(principal, p), fileId);
  }

  async driverApplicationSignature(principal: Principal, key: string, authId: string) {
    const p = await this.person(principal, key);
    return this.driverApps.signatureImage(principal, this.subjectOf(principal, p), authId);
  }

  async driverApplicationAuthorizationPdf(principal: Principal, key: string, authId: string) {
    const p = await this.person(principal, key);
    return this.driverApps.authorizationPdf(principal, this.subjectOf(principal, p), authId);
  }

  async driverApplicationPdf(principal: Principal, key: string) {
    const p = await this.person(principal, key);
    return this.driverApps.applicationPdf(principal, this.subjectOf(principal, p));
  }

  async driverApplicationSsn(principal: Principal, key: string) {
    const p = await this.person(principal, key);
    return this.driverApps.revealSsn(principal, this.subjectOf(principal, p));
  }

  // ======================================================================== application link

  /**
   * The candidate's private application link (the TMS's own DOT application, /dot/<token>). A lead
   * becomes a candidate first, through the existing conversion — which needs the lead
   * prequalified, as it always has. Making a link turns the previous one off; the address is
   * returned once and only its digest is kept.
   */
  async applicationLink(principal: Principal, key: string) {
    this.assertManage(principal);
    const p = await this.person(principal, key);
    let caseId = p.hiringCase?.id ?? null;
    if (!caseId && p.lead) {
      if (p.lead.status === 'dead') {
        throw new AppError({ status: 409, title: 'Conflict', detail: 'This lead was disqualified; reopen it before sending an application.' });
      }
      if (p.lead.status !== 'prequalified') {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          detail: 'Prequalify the lead first: the application link opens a candidate record, and that needs the prequalification answers.',
          extensions: { code: 'prequalify_first' },
        });
      }
      const converted: Lead = await this.leads.convert(principal, p.lead.id);
      caseId = converted.hiringCaseId;
    }
    if (!caseId) throw notFound();
    const created = await this.dotLinks.create(principal, caseId);
    const [c] = await this.db.select({ applicantId: hiringCases.applicantId }).from(hiringCases).where(eq(hiringCases.id, caseId)).limit(1);
    // The external application is offered only when its intake is switched on for this company;
    // until then the TMS's own application (/dot/<token>) is the working link.
    const token = created.url.split('/dot/')[1] ?? '';
    const externalUrl = this.external.candidateUrl(principal.companyId, token);
    return { ...created, key: c?.applicantId ?? key, externalUrl };
  }

  /** "Mark as sent": the recruiter says they sent the link by hand. Nothing is sent from here. */
  async markLinkSent(principal: Principal, key: string, channel: string | null): Promise<{ at: string }> {
    this.assertManage(principal);
    const p = await this.person(principal, key);
    const c = p.hiringCase;
    if (!c?.applicantId) {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'Create the application link first.' });
    }
    const [live] = await this.db
      .select({ id: hiringDotLinks.id })
      .from(hiringDotLinks)
      .where(and(eq(hiringDotLinks.companyId, principal.companyId), eq(hiringDotLinks.hiringCaseId, c.id), isNull(hiringDotLinks.revokedAt)))
      .limit(1);
    if (!live) throw new AppError({ status: 409, title: 'Conflict', detail: 'There is no live application link to mark as sent.' });
    const at = new Date();
    await this.audit.write(principal, {
      action: 'application_link_marked_sent',
      entityType: 'applicant',
      entityId: c.applicantId,
      entityLabel: c.candidateName,
      summary: `Recruiter recorded sending the application link by hand${channel ? ` (${channel})` : ''}`,
      changes: [{ field: 'dot_link', old: null, new: live.id }],
      at,
    });
    return { at: at.toISOString() };
  }

  // ========================================================================= reopen

  /**
   * Brings a disqualified candidate back (owner, 2026-10-16): the case returns to the step it was
   * at before it was disqualified, or a dead lead reopens. Needs a note; kept with who and when.
   * Reopening after the consent's safety questions lifts that consent's automatic hold.
   */
  async reopen(principal: Principal, key: string, note: string): Promise<RecruitCandidate> {
    this.assertManage(principal);
    const p = await this.person(principal, key);
    const c = p.hiringCase;
    if (c && c.state === 'disqualified') {
      const [last] = await this.db
        .select({ from: hiringStageEvents.fromState })
        .from(hiringStageEvents)
        .where(and(eq(hiringStageEvents.companyId, principal.companyId), eq(hiringStageEvents.caseId, c.id), eq(hiringStageEvents.toState, 'disqualified')))
        .orderBy(desc(hiringStageEvents.at))
        .limit(1);
      const back = (last?.from && last.from !== 'disqualified' ? last.from : 'application') as HiringState;
      await this.hiringCases.transition(principal, c, back, { note: `Reopened: ${note}` });
      await this.audit.write(principal, {
        action: 'status_change',
        entityType: 'applicant',
        entityId: c.applicantId ?? c.id,
        entityLabel: c.candidateName,
        summary: `Reopened (was disqualified): ${note}`,
        changes: [{ field: 'state', old: 'disqualified', new: back }],
      });
    } else if (!c && p.lead?.status === 'dead') {
      await this.leads.reopen(principal, p.lead.id, note);
    } else {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'Only a disqualified candidate can be reopened.' });
    }
    return this.candidate(principal, key);
  }

  // ========================================================================= send to Safety

  /**
   * Asks Safety to review the file. Needs the application on file and the documents Recruiting
   * collects (CDL, medical card); Safety's own reports (MVR, PSP, Clearinghouse, drug test) are not
   * asked for. Once only: a second request answers with the first. Uploading is never approval.
   */
  async sendToSafety(principal: Principal, key: string, input: SendToSafetyRequest): Promise<RecruitCandidate> {
    this.assertManage(principal);
    const p = await this.person(principal, key);
    const c = p.hiringCase;
    if (!c) throw new AppError({ status: 409, title: 'Conflict', detail: 'This lead has no application yet.' });
    if (c.safetyRequestedAt) return this.candidate(principal, key);
    // Any Yes on the latest signed consent's safety questions disqualifies per company hiring
    // policy: the file is not sent to Safety (owner, 2026-10-16).
    const [consent] = await this.db
      .select({ answers: hiringConsents.safetyAnswers, receivedAt: hiringConsents.receivedAt })
      .from(hiringConsents)
      .where(and(eq(hiringConsents.companyId, principal.companyId), eq(hiringConsents.hiringCaseId, c.id)))
      .orderBy(desc(hiringConsents.receivedAt))
      .limit(1);
    if (Array.isArray(consent?.answers) && (consent.answers as Array<{ answer?: boolean }>).some((a) => a.answer === true) && !(await this.consents.reopenedSince(principal.companyId, c.id, consent.receivedAt))) {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'Any Yes on the safety questions disqualifies this driver per company hiring policy; the file is not sent to Safety.' });
    }
    const readiness = await this.readiness(principal, c, p.application);
    if (!readiness.ready) {
      const missing = readiness.checks.filter((x) => !x.ok).map((x) => `${x.label}: ${x.detail}`);
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `Not ready for Safety: ${missing.join('; ')}`,
        extensions: { missing },
      });
    }
    const at = new Date();
    const by = principal.userName ?? principal.userId;
    const event = await this.db.transaction(async (tx) => {
      const [claimed] = await tx
        .update(hiringCases)
        .set({ safetyRequestedAt: at, safetyRequestedBy: by, safetyRequestNote: input.note, updatedAt: at })
        .where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.id, c.id), isNull(hiringCases.safetyRequestedAt)))
        .returning({ id: hiringCases.id });
      if (!claimed) return null;
      return this.audit.writeIn(tx, principal, {
        action: 'safety_review_requested',
        entityType: 'hiring_case',
        entityId: c.id,
        entityLabel: c.candidateName,
        summary: 'Sent to Safety for review',
        reason: input.note,
        changes: [{ field: 'safetyRequestedAt', old: null, new: at.toISOString() }],
        at,
      });
    });
    if (event) {
      await this.audit.publish(event);
      await this.notifySafety(principal, c).catch(() => undefined);
    }
    return this.candidate(principal, key);
  }

  /** The bell for whoever reviews driver files (compliance.manage), once per request. */
  private async notifySafety(principal: Principal, c: HiringCaseRow): Promise<void> {
    const recipients = (
      await this.db
        .selectDistinct({ userId: memberships.userId })
        .from(memberships)
        .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
        .innerJoin(rolePermissions, eq(rolePermissions.roleId, membershipRoles.roleId))
        .where(
          and(
            eq(memberships.companyId, principal.companyId),
            eq(memberships.status, 'active'),
            eq(rolePermissions.permissionCode, 'compliance.manage'),
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
          title: `${c.candidateName} sent to Safety for review`,
          body: `${principal.userName ?? 'Recruiting'} asked Safety to review ${c.candidateName}'s file.`,
          entityType: 'driver',
          entityId: c.driverId ?? c.id,
          source: 'system',
          dedupeKey: `safety_requested:${c.id}:${userId}`,
        })),
      )
      .onConflictDoNothing();
  }

  // ============================================================================== add lead

  /**
   * Add lead: automatic (the next turn in the rotation) unless a recruiter is named, which needs
   * recruiting.manage. Server-validated; the duplicate-phone rule is the existing one.
   */
  async addLead(principal: Principal, input: RecruitAddLeadRequest): Promise<{ key: string; lead: Lead }> {
    this.assertManage(principal);
    const { firstName, lastName } = splitFullName(input.fullName);
    if (input.assignment === 'recruiter' && !input.recruiterEmployeeId) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'Choose the recruiter, or pick Automatic.',
        extensions: { errors: [{ path: 'recruiterEmployeeId', message: 'Choose the recruiter', code: 'custom' }] },
      });
    }
    if (!/^\+?[\d\s().-]{7,20}$/.test(input.phone) || phoneMatchKey(input.phone).length < 10) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'Enter a 10-digit phone number.',
        extensions: { errors: [{ path: 'phone', message: 'Enter a 10-digit phone number', code: 'custom' }] },
      });
    }
    const lead = await this.leads.create(principal, {
      firstName,
      lastName: lastName || '',
      phone: input.phone,
      email: input.email,
      cdlClass: null,
      state: null,
      yearsExperience: null,
      source: input.source,
      campaignId: null,
      recruiterEmployeeId: input.assignment === 'recruiter' ? input.recruiterEmployeeId : null,
      notes: null,
    });
    return { key: lead.id, lead };
  }

  /** Reassigns a candidate (lead, case and applicant together), audited. Needs recruiting.manage. */
  async reassign(principal: Principal, key: string, employeeId: string | null): Promise<RecruitCandidate> {
    this.assertManage(principal);
    const p = await this.person(principal, key);
    if (p.hiringCase) {
      await this.activityService.assignRecruiter(principal, p.hiringCase.id, { employeeId });
    } else if (p.lead) {
      await this.leads.update(principal, p.lead.id, { recruiterEmployeeId: employeeId });
    }
    return this.candidate(principal, key);
  }

  // ================================================================================ rename

  /** The records behind a candidate as read: the lead's and the case's last change. */
  private versionOf(p: { lead: { updatedAt: Date } | null; hiringCase: { updatedAt: Date } | null }): string {
    return `${p.lead ? p.lead.updatedAt.getTime() : '-'}.${p.hiringCase ? p.hiringCase.updatedAt.getTime() : '-'}`;
  }

  /**
   * Renames a candidate (owner, 2026-10-21): the lead, the hiring case and the candidate record
   * (applicant) each keep a copy of the name, so all of them change together, in one transaction,
   * with Safety's open file (verification case) while the person is not hired yet. A hired driver's
   * driver and employee records are never touched from here - they are renamed in Drivers.
   * Needs recruiting.manage; a stale `version` is a 409; audited with before and after.
   */
  async rename(principal: Principal, key: string, input: RenameCandidateRequest): Promise<RenameCandidateResult> {
    this.assertManage(principal);
    const p = await this.person(principal, key);
    const split = input.firstName !== undefined ? null : splitFullName(input.name ?? '');
    const firstName = (input.firstName ?? split?.firstName ?? '').trim();
    const lastName = (input.lastName ?? split?.lastName ?? '').trim();
    if (!firstName) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'Enter the first name.',
        extensions: { errors: [{ path: 'firstName', message: 'Enter the first name', code: 'custom' }] },
      });
    }
    const stale = () =>
      new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'This candidate changed since you opened it. Reload and try again.',
        extensions: { code: 'stale_version' },
      });
    if (input.version !== this.versionOf(p)) throw stale();

    const c = p.hiringCase;
    const hired = Boolean(c && (c.hiredAt || c.state === 'hired' || c.state === 'active_driver'));
    const driverNotice = hired ? 'Renamed in Recruiting only. The driver profile is renamed in Drivers.' : null;
    const before = this.nameOf(p);
    const after = `${firstName} ${lastName}`.trim();
    const beforeParts = p.lead ? { firstName: p.lead.firstName, lastName: p.lead.lastName } : splitFullName(c?.candidateName ?? '');
    if (after === before && beforeParts.firstName === firstName && beforeParts.lastName === lastName) {
      return { candidate: await this.candidate(principal, key), driverNotice };
    }

    const at = new Date();
    const applicantId = c?.applicantId ?? p.lead?.applicantId ?? null;
    const target = c ? { type: 'hiring_case', id: c.id } : { type: 'hiring_lead', id: (p.lead as HiringLeadRow).id };
    const event = await this.db.transaction(async (tx) => {
      // Re-read under a lock: a save that raced this one makes this one stale, never an overwrite.
      const [lockedLead] = p.lead
        ? await tx
            .select({ updatedAt: hiringLeads.updatedAt })
            .from(hiringLeads)
            .where(and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.id, p.lead.id)))
            .for('update')
        : [];
      const [lockedCase] = c
        ? await tx
            .select({ updatedAt: hiringCases.updatedAt })
            .from(hiringCases)
            .where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.id, c.id)))
            .for('update')
        : [];
      if (this.versionOf({ lead: lockedLead ?? null, hiringCase: lockedCase ?? null }) !== input.version) throw stale();

      if (p.lead) {
        await tx
          .update(hiringLeads)
          .set({ firstName, lastName, updatedAt: at })
          .where(and(eq(hiringLeads.companyId, principal.companyId), eq(hiringLeads.id, p.lead.id)));
      }
      if (c) {
        await tx
          .update(hiringCases)
          .set({ candidateName: after, updatedAt: at })
          .where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.id, c.id)));
        // Safety's file shows the candidate's name until the hire; after it, Drivers owns the name.
        if (c.verificationCaseId && !hired) {
          await tx
            .update(verificationCases)
            .set({ driverName: after })
            .where(and(eq(verificationCases.companyId, principal.companyId), eq(verificationCases.id, c.verificationCaseId)));
        }
      }
      if (applicantId) {
        await tx
          .update(applicants)
          .set({ firstName, lastName, updatedAt: at })
          .where(and(eq(applicants.companyId, principal.companyId), eq(applicants.id, applicantId)));
      }
      return this.audit.writeIn(tx, principal, {
        action: 'rename',
        entityType: target.type,
        entityId: target.id,
        entityLabel: after,
        summary: `Name changed from ${before || '(no name)'} to ${after}`,
        reason: driverNotice,
        changes: [
          { field: 'name', old: before, new: after },
          { field: 'firstName', old: beforeParts.firstName, new: firstName },
          { field: 'lastName', old: beforeParts.lastName, new: lastName },
        ],
        at,
      });
    });
    await this.audit.publish(event);
    return { candidate: await this.candidate(principal, key), driverNotice };
  }

  // ============================================================================== calendar

  async calendar(principal: Principal, query: RecruitCalendarQuery): Promise<RecruitCalendarEvent[]> {
    const scope = await this.scope(principal, query);
    const people = await this.people(principal.companyId, scope);
    const today = this.today();
    const names = await this.recruiterNames(principal.companyId, people.map((p) => this.recruiterOf(p)).filter((v): v is string => !!v));
    const events: RecruitCalendarEvent[] = [];
    const byCase = new Map<string, Person>();
    for (const p of people) {
      if (p.hiringCase) byCase.set(p.hiringCase.id, p);
      const progress = recruitProgressOf(this.progressInput(p));
      const on = this.followUpOf(p);
      const recruiterId = this.recruiterOf(p);
      if (on && isActiveProgress(progress) && on >= query.from && on <= query.to) {
        events.push({
          id: `follow_up:${p.lead?.id ?? p.hiringCase?.id}`,
          kind: 'follow_up',
          date: on,
          at: null,
          candidateKey: this.keyOf(p),
          candidateName: this.nameOf(p),
          detail: 'Follow-up',
          recruiter: recruiterId ? { employeeId: recruiterId, name: names.get(recruiterId) ?? recruiterId } : null,
          overdue: on < today,
        });
      }
    }
    // Overdue follow-ups before the window still need doing: shown on today when today is in it.
    if (today >= query.from && today <= query.to) {
      for (const p of people) {
        const on = this.followUpOf(p);
        const progress = recruitProgressOf(this.progressInput(p));
        if (on && on < query.from && isActiveProgress(progress)) {
          const recruiterId = this.recruiterOf(p);
          events.push({
            id: `follow_up:${p.lead?.id ?? p.hiringCase?.id}`,
            kind: 'follow_up',
            date: on,
            at: null,
            candidateKey: this.keyOf(p),
            candidateName: this.nameOf(p),
            detail: 'Follow-up (overdue)',
            recruiter: recruiterId ? { employeeId: recruiterId, name: names.get(recruiterId) ?? recruiterId } : null,
            overdue: true,
          });
        }
      }
    }
    const pipelineEvents = await this.pipeline.calendar(principal, query.from, query.to);
    for (const e of pipelineEvents) {
      const p = byCase.get(e.caseId);
      if (!p) continue;
      const recruiterId = this.recruiterOf(p);
      events.push({
        id: e.id,
        kind: e.kind,
        date: e.date,
        at: e.at,
        candidateKey: this.keyOf(p),
        candidateName: e.candidateName,
        detail: e.detail,
        recruiter: recruiterId ? { employeeId: recruiterId, name: names.get(recruiterId) ?? recruiterId } : null,
        overdue: false,
      });
    }
    return events.sort((a, b) => (a.date + (a.at ?? '')).localeCompare(b.date + (b.at ?? '')) || a.candidateName.localeCompare(b.candidateName));
  }

  // ============================================================================== analytics

  /**
   * Recruiting analytics for a period: leads added in it (Eastern dates), how many of those are
   * hired, by source and by recruiter. Conversion = hired ÷ leads of the same cohort.
   */
  async analytics(principal: Principal, query: { from: string; to: string }): Promise<RecruitAnalytics> {
    if (query.from > query.to) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'The period starts after it ends.' });
    }
    const added = sql`(${hiringLeads.createdAt} at time zone ${EASTERN})::date`;
    const rows = await this.db
      .select({ lead: hiringLeads, state: hiringCases.state, caseTest: hiringCases.isTest })
      .from(hiringLeads)
      .leftJoin(hiringCases, eq(hiringCases.id, hiringLeads.hiringCaseId))
      .where(
        and(
          eq(hiringLeads.companyId, principal.companyId),
          eq(hiringLeads.isTest, false),
          sql`${added} >= ${query.from}::date`,
          sql`${added} <= ${query.to}::date`,
        ),
      );
    const live = rows.filter((r) => !r.caseTest);
    const hired = (r: (typeof live)[number]) => r.state === 'hired' || r.state === 'active_driver';
    const names = await this.recruiterNames(principal.companyId, live.map((r) => r.lead.recruiterEmployeeId).filter((v): v is string => !!v));
    const bySource = new Map<string, { leads: number; hired: number }>();
    const byRecruiter = new Map<string, { leads: number; hired: number }>();
    for (const r of live) {
      const s = bySource.get(r.lead.source) ?? { leads: 0, hired: 0 };
      s.leads += 1;
      if (hired(r)) s.hired += 1;
      bySource.set(r.lead.source, s);
      const key = r.lead.recruiterEmployeeId ?? '';
      const x = byRecruiter.get(key) ?? { leads: 0, hired: 0 };
      x.leads += 1;
      if (hired(r)) x.hired += 1;
      byRecruiter.set(key, x);
    }
    const total = live.length;
    const hires = live.filter(hired).length;
    return {
      period: query,
      leads: total,
      hired: hires,
      conversion: total === 0 ? null : hires / total,
      conversionDefinition: 'Of the leads added in the period, the share that has been hired so far.',
      sources: [...bySource.entries()]
        .map(([key, v]) => ({ key, label: sourceLabel(key), ...v }))
        .sort((a, b) => b.leads - a.leads || a.label.localeCompare(b.label)),
      recruiters: [...byRecruiter.entries()]
        .map(([id, v]) => ({
          employeeId: id || null,
          name: id ? (names.get(id) ?? id) : 'Unassigned',
          leads: v.leads,
          hired: v.hired,
          conversion: v.leads === 0 ? null : v.hired / v.leads,
        }))
        .sort((a, b) => b.leads - a.leads || a.name.localeCompare(b.name)),
    };
  }

  /** Recruiters the filter and Add lead offer: active rotation members plus anyone assigned leads. */
  async recruiterOptions(principal: Principal): Promise<RecruitRecruiter[]> {
    const rows = await this.db
      .selectDistinct({ id: employees.id, first: employees.firstName, last: employees.lastName })
      .from(employees)
      .where(
        and(
          eq(employees.companyId, principal.companyId),
          or(
            and(ne(employees.status, 'terminated'), ilike(employees.position, '%recruit%')),
            sql`exists (select 1 from ${hiringLeads} l where l.recruiter_employee_id = ${employees.id} and l.company_id = ${principal.companyId} and l.is_test = false)`,
          ),
        ),
      )
      .orderBy(asc(employees.firstName), asc(employees.lastName));
    const [mine] = principal.membershipId
      ? await this.db.select({ employeeId: memberships.employeeId }).from(memberships).where(and(eq(memberships.companyId, principal.companyId), eq(memberships.id, principal.membershipId))).limit(1)
      : [];
    return rows.map((r) => ({ employeeId: r.id, name: `${r.first} ${r.last}`.trim(), isMe: Boolean(mine?.employeeId) && r.id === mine?.employeeId }));
  }
}
