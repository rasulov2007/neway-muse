import { Inject, Injectable, type OnModuleInit } from '@nestjs/common';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import {
  COMPLIANCE_AUDIT_ACTIONS,
  HIRING_STATES,
  VERIFICATION_OWNED_STATES,
  onboardingGate,
  hiringStageFromVerification,
  isTerminal,
  type HiringCase,
  type HiringEndReason,
  type HiringStageEvent,
  type HiringState,
  type VerificationCase,
} from '@neway/shared';
import { PinoLogger } from 'nestjs-pino';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { verificationCases } from '../../database/schema/compliance';
import {
  hiringCases,
  hiringDotApplications,
  hiringStageEvents,
  type HiringCaseRow,
} from '../../database/schema/hiring';
import { onboardingChecklists, onboardingItems } from '../../database/schema/hr';
import { drivers } from '../../database/schema/roster';
import { VerificationService } from '../compliance/verification.service';
import { CLOCK, type Clock } from '../dashboard/clock';
import { AuditService, type AuditEvent } from '../people/audit.service';

/**
 * The hiring funnel wrapper.
 *
 * A hiring case's middle stages are its verification case, read through the shared mapping. This
 * service keeps the two in step without either copying the other: whenever a compliance change is
 * audited for a driver, the driver's hiring case is re-derived and, if its state moved, an event is
 * appended. The verification pipeline does not know hiring exists — it writes its audit entry as
 * it always has, and this listens.
 *
 * The event table is append-only. Nothing here updates or deletes an event; `state` on the case
 * is a cached copy of the latest `to_state`, refreshed by the same code that appends.
 */
@Injectable()
export class HiringService implements OnModuleInit {
  constructor(
    private readonly database: DatabaseService,
    private readonly verification: VerificationService,
    private readonly audit: AuditService,
    private readonly logger: PinoLogger,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {
    this.logger.setContext(HiringService.name);
  }

  private get db() {
    return this.database.db;
  }

  onModuleInit(): void {
    this.audit.onWrite(async (event) => {
      try {
        await this.onAudit(event);
      } catch (error) {
        this.logger.error({ err: error, auditId: event.id }, 'Hiring sync failed');
      }
    });
  }

  /** A compliance change on a driver re-derives that driver's case. */
  /**
   * A compliance change on a driver re-derives that driver's case; the roster reporting a hired
   * driver dispatched or driving for the first time makes them an active driver.
   */
  private async onAudit(event: AuditEvent): Promise<void> {
    if (event.entityType === 'onboarding') {
      await this.onOnboardingChange(event);
      return;
    }
    if (event.entityType !== 'driver') return;
    const compliance = (COMPLIANCE_AUDIT_ACTIONS as readonly string[]).includes(event.action);
    const dispatched =
      event.action === 'status_change' &&
      event.changes.some(
        (c) => c.field === 'status' && (c.new === 'dispatched' || c.new === 'driving'),
      );
    if (!compliance && !dispatched) return;
    const [row] = await this.db
      .select()
      .from(hiringCases)
      .where(
        and(eq(hiringCases.companyId, event.companyId), eq(hiringCases.driverId, event.entityId)),
      )
      .orderBy(desc(hiringCases.openedAt))
      .limit(1);
    if (!row || isTerminal(row.state as HiringState)) return;
    if (dispatched) {
      if (row.state !== 'hired') return;
      const at = event.at;
      await this.db
        .update(hiringCases)
        .set({ firstDispatchAt: row.firstDispatchAt ?? at })
        .where(eq(hiringCases.id, row.id));
      await this.activateIfClear(
        event.companyId,
        { ...row, firstDispatchAt: row.firstDispatchAt ?? at },
        at,
        'First dispatch',
      );
      return;
    }
    await this.syncFromVerification(event.companyId, row);
  }

  /**
   * The onboarding gate: a hired driver becomes an active driver once the roster has dispatched
   * them *and* nothing blocking is open on their onboarding plan. Whichever happens last does it.
   */
  private async activateIfClear(
    companyId: string,
    row: HiringCaseRow,
    at: Date,
    note: string,
  ): Promise<void> {
    if (row.state !== 'hired' || !row.firstDispatchAt) return;
    const gate = await this.gateFor(companyId, row.employeeId);
    if (gate && gate.blockingOpen > 0) return;
    await this.append(
      companyId,
      row,
      'active_driver',
      { byId: null, byName: 'Roster', source: 'system', reason: null, note },
      at,
    );
  }

  private async onOnboardingChange(event: AuditEvent): Promise<void> {
    const [checklist] = await this.db
      .select({ employeeId: onboardingChecklists.employeeId })
      .from(onboardingChecklists)
      .where(eq(onboardingChecklists.id, event.entityId))
      .limit(1);
    if (!checklist) return;
    const [row] = await this.db
      .select()
      .from(hiringCases)
      .where(
        and(
          eq(hiringCases.companyId, event.companyId),
          eq(hiringCases.employeeId, checklist.employeeId),
        ),
      )
      .limit(1);
    if (!row) return;
    await this.activateIfClear(
      event.companyId,
      row,
      event.at,
      'Onboarding gate cleared after first dispatch',
    );
  }

  /** What still holds the driver at Hired, read from the plan's items on every call. */
  async gateFor(
    companyId: string,
    employeeId: string | null,
  ): Promise<ReturnType<typeof onboardingGate> | null> {
    if (!employeeId) return null;
    const [checklist] = await this.db
      .select({ id: onboardingChecklists.id })
      .from(onboardingChecklists)
      .where(
        and(
          eq(onboardingChecklists.companyId, companyId),
          eq(onboardingChecklists.employeeId, employeeId),
          sql`${onboardingChecklists.status} <> 'cancelled'`,
        ),
      )
      .limit(1);
    if (!checklist) return null;
    const items = await this.db
      .select({
        title: onboardingItems.title,
        blocking: onboardingItems.blocking,
        status: onboardingItems.status,
      })
      .from(onboardingItems)
      .where(eq(onboardingItems.checklistId, checklist.id));
    return onboardingGate(checklist.id, items);
  }

  // ============================================================================== derivation

  /**
   * Where the verification case says this candidate is.
   *
   * A driver whose case is decided and who is already on the roster with a hire date is an active
   * driver, not a candidate waiting at Offer — that distinction matters for the drivers who were
   * hired before the funnel existed.
   */
  private async stateFor(companyId: string, row: HiringCaseRow): Promise<HiringState | null> {
    if (!row.verificationCaseId) return null;
    // From Offer on, the recruiter's records move the case; the file no longer does.
    if (!VERIFICATION_OWNED_STATES.includes(row.state as HiringState)) return null;
    const [vc] = await this.db
      .select()
      .from(verificationCases)
      .where(eq(verificationCases.id, row.verificationCaseId))
      .limit(1);
    if (!vc) return null;
    const derived: VerificationCase = await this.verification.derive(companyId, vc);
    let driverIsActive = false;
    if (row.driverId) {
      const [driver] = await this.db
        .select({ status: drivers.status })
        .from(drivers)
        .where(eq(drivers.id, row.driverId))
        .limit(1);
      driverIsActive = driver !== undefined && driver.status !== 'terminated';
    }
    return hiringStageFromVerification(derived.stage, derived.decision, { driverIsActive });
  }

  /** Re-derives one case from its verification case now; used after the two are linked. */
  async resync(companyId: string, caseId: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(hiringCases)
      .where(eq(hiringCases.id, caseId))
      .limit(1);
    if (row && !isTerminal(row.state as HiringState))
      await this.syncFromVerification(companyId, row);
  }

  /**
   * Gives a case its qualification-file key and verification case. Called once, when the DOT
   * application is submitted; from then on the case's middle stages are derived, not clicked.
   */
  async linkVerificationCase(
    companyId: string,
    caseId: string,
    link: { driverId: string; verificationCaseId: string },
  ): Promise<void> {
    await this.db
      .update(hiringCases)
      .set({
        driverId: link.driverId,
        verificationCaseId: link.verificationCaseId,
        updatedAt: new Date(),
      })
      .where(and(eq(hiringCases.companyId, companyId), eq(hiringCases.id, caseId)));
  }

  private async syncFromVerification(companyId: string, row: HiringCaseRow): Promise<void> {
    const next = await this.stateFor(companyId, row);
    if (next === null || next === row.state) return;
    await this.append(companyId, row, next, {
      byId: null,
      byName: 'Verification',
      source: 'verification',
      reason: next === 'disqualified' ? 'safety_review_rejected' : null,
      note: null,
    });
  }

  /** A recruiter's move: offer sent, ticket booked, orientation attended, hired, or an end. */
  async transition(
    principal: Principal,
    row: HiringCaseRow,
    to: HiringState,
    detail: { reason?: HiringEndReason | null; note?: string | null; at?: Date } = {},
  ): Promise<void> {
    await this.append(
      principal.companyId,
      row,
      to,
      {
        byId: principal.userId,
        byName: principal.userName ?? principal.userId,
        source: 'user',
        reason: detail.reason ?? null,
        note: detail.note ?? null,
      },
      detail.at ?? new Date(),
    );
  }

  /**
   * Runs `fn` while holding a database-wide lock on `key`. Two requests for the same key (a double
   * click, a retry after a timeout, two tabs) run one after the other, so the second one reads
   * what the first one wrote and cannot create a second offer, ticket, hire or candidate.
   *
   * The lock lives in a transaction that does nothing else; `fn` writes through the normal
   * connections and its writes commit as they always did. A waiting request does not sit on a
   * pooled connection: it tries, lets go, and tries again, then gives up with a conflict. Never
   * nest two calls for the same key.
   */
  async withLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 80; attempt += 1) {
      const outcome = await this.db.transaction(async (tx) => {
        const rows = (await tx.execute(
          sql`select pg_try_advisory_xact_lock(hashtext(${key})) as ok`,
        )) as unknown as { ok: boolean }[];
        if (!rows[0]?.ok) return { held: false as const };
        return { held: true as const, value: await fn() };
      });
      if (outcome.held) return outcome.value;
      await new Promise((resolve) => setTimeout(resolve, 125));
    }
    throw new AppError({
      status: 409,
      title: 'Conflict',
      detail: 'Another save of this record is still running. Try again in a moment.',
    });
  }

  async row(principal: Principal, id: string): Promise<HiringCaseRow> {
    const [row] = await this.db
      .select()
      .from(hiringCases)
      .where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.id, id)))
      .limit(1);
    if (!row)
      throw new AppError({ status: 404, title: 'Not Found', detail: `No hiring case ${id}` });
    return row;
  }

  private async append(
    companyId: string,
    row: HiringCaseRow,
    to: HiringState,
    by: {
      byId: string | null;
      byName: string;
      source: 'user' | 'system' | 'verification';
      reason: HiringEndReason | null;
      note: string | null;
    },
    // The wall clock, like every write; the pinned demo clock is for "today"-relative reads only.
    at: Date = new Date(),
  ): Promise<void> {
    await this.db.transaction(async (tx) => {
      await tx.insert(hiringStageEvents).values({
        id: `hse_${crypto.randomUUID()}`,
        companyId,
        caseId: row.id,
        fromState: row.state,
        toState: to,
        at,
        byId: by.byId,
        byName: by.byName,
        reason: by.reason,
        note: by.note,
        source: by.source,
      });
      await tx
        .update(hiringCases)
        .set({
          state: to,
          stateSince: at,
          closedAt: isTerminal(to) ? at : null,
          endReason: isTerminal(to) ? by.reason : null,
          endNote: isTerminal(to) ? by.note : null,
          updatedAt: at,
        })
        .where(eq(hiringCases.id, row.id));
    });
  }

  // ================================================================================ backfill

  /**
   * Opens a hiring case for every verification case that has none.
   *
   * Runs at boot after the compliance seed and is idempotent: a case wraps exactly one
   * verification case (unique index), so the second run finds nothing to do. The first event on
   * each backfilled case is stamped with the verification case's opening time and sourced
   * `verification`, so nobody reads it as a recruiter's click.
   */
  async backfillFromVerification(companyId: string): Promise<number> {
    const missing = await this.db
      .select({ vc: verificationCases })
      .from(verificationCases)
      .leftJoin(hiringCases, eq(hiringCases.verificationCaseId, verificationCases.id))
      .where(and(eq(verificationCases.companyId, companyId), isNull(hiringCases.id)));

    for (const { vc } of missing) {
      const id = `hc_${crypto.randomUUID()}`;
      const openedAt = vc.openedAt;
      await this.db.insert(hiringCases).values({
        id,
        companyId,
        applicantId: null,
        driverId: vc.driverId,
        verificationCaseId: vc.id,
        candidateName: vc.driverName,
        state: 'application',
        stateSince: openedAt,
        openedAt,
        recruiterId: vc.ownerId,
        recruiterName: vc.ownerName,
      });
      await this.db.insert(hiringStageEvents).values({
        id: `hse_${crypto.randomUUID()}`,
        companyId,
        caseId: id,
        fromState: null,
        toState: 'application',
        at: openedAt,
        byId: vc.ownerId,
        byName: vc.ownerName,
        reason: null,
        note: 'Opened from the verification case',
        source: 'verification',
      });
      const [row] = await this.db.select().from(hiringCases).where(eq(hiringCases.id, id)).limit(1);
      if (row) {
        const next = await this.stateFor(companyId, row);
        if (next && next !== row.state) {
          await this.append(
            companyId,
            row,
            next,
            {
              byId: null,
              byName: 'Verification',
              source: 'verification',
              reason: next === 'disqualified' ? 'safety_review_rejected' : null,
              note: null,
            },
            vc.decisionAt ?? vc.openedAt,
          );
        }
      }
    }
    if (missing.length > 0) {
      this.logger.info({ cases: missing.length }, 'Hiring cases opened for verification cases');
    }
    return missing.length;
  }

  // ============================================================================ front of funnel

  /**
   * Opens a hiring case for a lead that was just converted into an applicant.
   *
   * The lead's own history (created, contacted, prequalified) is replayed as the first events so
   * the case's timeline starts where the person's actually did — days-in-stage for Lead and
   * Prequalified are real, not "since conversion".
   */
  async openForApplicant(
    principal: Principal,
    input: {
      applicantId: string;
      candidateName: string;
      recruiterId: string | null;
      recruiterName: string | null;
      history: { state: HiringState; at: Date; byName: string }[];
    },
  ): Promise<string> {
    const id = `hc_${crypto.randomUUID()}`;
    const first = input.history[0];
    if (!first)
      throw new AppError({
        status: 500,
        title: 'Internal Server Error',
        detail: 'A case needs an opening event',
      });
    await this.db.transaction(async (tx) => {
      await tx.insert(hiringCases).values({
        id,
        companyId: principal.companyId,
        applicantId: input.applicantId,
        driverId: null,
        verificationCaseId: null,
        candidateName: input.candidateName,
        state: first.state,
        stateSince: first.at,
        openedAt: first.at,
        recruiterId: input.recruiterId,
        recruiterName: input.recruiterName,
      });
      let previous: HiringState | null = null;
      for (const step of input.history) {
        await tx.insert(hiringStageEvents).values({
          id: `hse_${crypto.randomUUID()}`,
          companyId: principal.companyId,
          caseId: id,
          fromState: previous,
          toState: step.state,
          at: step.at,
          byId: principal.userId,
          byName: step.byName,
          reason: null,
          note: null,
          source: 'user',
        });
        previous = step.state;
      }
      const last = input.history[input.history.length - 1] ?? first;
      await tx
        .update(hiringCases)
        .set({ state: last.state, stateSince: last.at, updatedAt: last.at })
        .where(eq(hiringCases.id, id));
    });
    return id;
  }

  // ==================================================================================== reads

  async list(
    principal: Principal,
    query: { state?: HiringState; applicantId?: string },
  ): Promise<HiringCase[]> {
    const parts = [eq(hiringCases.companyId, principal.companyId), eq(hiringCases.isTest, false)];
    if (query.state) parts.push(eq(hiringCases.state, query.state));
    if (query.applicantId) parts.push(eq(hiringCases.applicantId, query.applicantId));
    const rows = await this.db
      .select()
      .from(hiringCases)
      .where(and(...parts))
      .orderBy(desc(hiringCases.openedAt));
    return Promise.all(rows.map((row) => this.hydrate(row)));
  }

  /** Test data (owner, 2026-10-07): the case is kept and audited but left out of the pipeline. */
  async markTest(principal: Principal, id: string, reason: string): Promise<void> {
    const [row] = await this.db
      .select()
      .from(hiringCases)
      .where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.id, id)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No hiring case ${id}` });
    if (row.isTest) return;
    const at = new Date();
    await this.db
      .update(hiringCases)
      .set({
        isTest: true,
        testMarkedAt: at,
        testMarkedBy: principal.userName ?? principal.userId,
        testReason: reason,
        updatedAt: at,
      })
      .where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.id, id)));
    await this.audit.write(principal, {
      action: 'mark_test',
      entityType: 'hiring_case',
      entityId: id,
      entityLabel: row.candidateName,
      summary: `Candidate ${row.candidateName} marked as test data and hidden`,
      reason,
      changes: [{ field: 'isTest', old: 'false', new: 'true' }],
      at,
    });
  }

  async get(principal: Principal, id: string): Promise<HiringCase> {
    const [row] = await this.db
      .select()
      .from(hiringCases)
      .where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.id, id)))
      .limit(1);
    if (!row)
      throw new AppError({ status: 404, title: 'Not Found', detail: `No hiring case ${id}` });
    return this.hydrate(row);
  }

  /** Counts per state, including zeros, so the pipeline board never hides an empty column. */
  async summary(principal: Principal): Promise<Record<HiringState, number>> {
    const rows = await this.db
      .select({ state: hiringCases.state, value: sql<number>`count(*)::int` })
      .from(hiringCases)
      .where(and(eq(hiringCases.companyId, principal.companyId), eq(hiringCases.isTest, false)))
      .groupBy(hiringCases.state);
    const out = Object.fromEntries(HIRING_STATES.map((s) => [s, 0])) as Record<HiringState, number>;
    for (const row of rows) if (row.state in out) out[row.state as HiringState] = row.value;
    return out;
  }

  private async hydrate(row: HiringCaseRow): Promise<HiringCase> {
    const events = await this.db
      .select()
      .from(hiringStageEvents)
      .where(eq(hiringStageEvents.caseId, row.id))
      .orderBy(asc(hiringStageEvents.at), asc(hiringStageEvents.id));
    const [application] = await this.db
      .select({
        id: hiringDotApplications.id,
        status: hiringDotApplications.status,
        submittedAt: hiringDotApplications.submittedAt,
        documentId: hiringDotApplications.documentId,
        certifiedSnapshot: hiringDotApplications.certifiedAt,
      })
      .from(hiringDotApplications)
      .where(eq(hiringDotApplications.hiringCaseId, row.id))
      .limit(1);
    const now = this.clock().getTime();
    return {
      id: row.id,
      applicantId: row.applicantId,
      driverId: row.driverId,
      verificationCaseId: row.verificationCaseId,
      candidateName: row.candidateName,
      state: row.state as HiringState,
      stateSince: row.stateSince.toISOString(),
      daysInState: Math.max(0, Math.floor((now - row.stateSince.getTime()) / 86_400_000)),
      openedAt: row.openedAt.toISOString(),
      closedAt: row.closedAt?.toISOString() ?? null,
      endReason: row.endReason as HiringEndReason | null,
      endNote: row.endNote,
      recruiterId: row.recruiterId,
      recruiterName: row.recruiterName,
      dotApplication: application
        ? {
            id: application.id,
            // The brief 'submitting' claim reads as what it was until the filing finishes.
            status: (application.status === 'submitted'
              ? 'submitted'
              : application.status === 'driver_submitted' || (application.status === 'submitting' && application.certifiedSnapshot)
                ? 'driver_submitted'
                : 'draft') as 'draft' | 'driver_submitted' | 'submitted',
            submittedAt: application.submittedAt?.toISOString() ?? null,
            documentId: application.documentId,
          }
        : null,
      offerId: row.offerId,
      employeeId: row.employeeId,
      hiredAt: row.hiredAt?.toISOString() ?? null,
      firstDispatchAt: row.firstDispatchAt?.toISOString() ?? null,
      onboardingGate: row.employeeId ? await this.gateFor(row.companyId, row.employeeId) : null,
      events: events.map((e): HiringStageEvent => ({
        id: e.id,
        caseId: e.caseId,
        fromState: e.fromState as HiringState | null,
        toState: e.toState as HiringState,
        at: e.at.toISOString(),
        byId: e.byId,
        byName: e.byName,
        reason: e.reason as HiringEndReason | null,
        note: e.note,
        source: e.source as HiringStageEvent['source'],
      })),
    };
  }
}
