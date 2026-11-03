import { Inject, Injectable } from '@nestjs/common';
import { and, asc, eq, isNull } from 'drizzle-orm';
import {
  SYSTEM_REQUIREMENTS,
  deriveVerificationCase,
  type VerificationCase,
  type VerificationCaseRecord,
  type VerificationDecision,
  type VerificationStage,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { verificationCases, type VerificationCaseRow } from '../../database/schema/compliance';
import { drivers } from '../../database/schema/roster';
import { CLOCK, type Clock } from '../dashboard/clock';
import { ComplianceAuditService } from './compliance-audit.service';
import { ComplianceService } from './compliance.service';
import { ConsentsService } from './consents.service';

/**
 * Verification cases, derived on every read.
 *
 * The row holds the human facts; the steps come from the driver's items and consents through the
 * shared `deriveVerificationCase`. Recording a decision is the only write here, because it is the
 * only step a document cannot evidence.
 */
@Injectable()
export class VerificationService {
  constructor(
    private readonly database: DatabaseService,
    private readonly compliance: ComplianceService,
    private readonly consents: ConsentsService,
    private readonly audit: ComplianceAuditService,
    @Inject(CLOCK) private readonly clock: Clock,
  ) {}

  private get db() {
    return this.database.db;
  }

  toRecord(row: VerificationCaseRow): VerificationCaseRecord {
    return {
      id: row.id,
      driverId: row.driverId,
      driverName: row.driverName,
      openedAt: row.openedAt.toISOString(),
      ownerId: row.ownerId,
      ownerName: row.ownerName,
      safetyReviewStatus: row.safetyReviewStatus as VerificationCaseRecord['safetyReviewStatus'],
      safetyReviewAt: row.safetyReviewAt?.toISOString() ?? null,
      safetyReviewBy: row.safetyReviewBy,
      decision: row.decision as VerificationDecision | null,
      decisionAt: row.decisionAt?.toISOString() ?? null,
      decisionBy: row.decisionBy,
      conditions: Array.isArray(row.conditions) ? (row.conditions as string[]) : [],
      decisionNote: row.decisionNote,
    };
  }

  async derive(companyId: string, row: VerificationCaseRow): Promise<VerificationCase> {
    const [items, consents, driver] = await Promise.all([
      this.compliance.itemsForEntity(companyId, 'driver', row.driverId),
      this.consents.forDriver(companyId, row.driverId),
      this.db
        .select({ first: drivers.firstName })
        .from(drivers)
        .where(eq(drivers.id, row.driverId))
        .limit(1),
    ]);
    return deriveVerificationCase({
      record: this.toRecord(row),
      items,
      consents,
      requirements: SYSTEM_REQUIREMENTS,
      now: this.clock(),
      driverFirstName: driver[0]?.first,
    });
  }

  async list(
    principal: Principal,
    query: { stage?: VerificationStage; ownerId?: string; driverId?: string },
  ): Promise<VerificationCase[]> {
    const parts = [eq(verificationCases.companyId, principal.companyId)];
    if (query.ownerId) parts.push(eq(verificationCases.ownerId, query.ownerId));
    if (query.driverId) parts.push(eq(verificationCases.driverId, query.driverId));
    const rows = await this.db
      .select()
      .from(verificationCases)
      .where(and(...parts))
      .orderBy(asc(verificationCases.openedAt), asc(verificationCases.id));
    const cases = await Promise.all(rows.map((row) => this.derive(principal.companyId, row)));
    // Stage is derived, so it is filtered after derivation rather than in SQL.
    return query.stage ? cases.filter((c) => c.stage === query.stage) : cases;
  }

  async get(principal: Principal, id: string): Promise<VerificationCase> {
    const [row] = await this.db
      .select()
      .from(verificationCases)
      .where(
        and(eq(verificationCases.companyId, principal.companyId), eq(verificationCases.id, id)),
      )
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No case ${id}` });
    return this.derive(principal.companyId, row);
  }

  /**
   * Opens a case: the candidate's application has been received. One open case per driver id is
   * enforced by the table, and a second open is answered with the case that already exists.
   */
  async open(
    principal: Principal,
    input: { driverId: string; driverName: string; at?: Date },
  ): Promise<VerificationCase> {
    const [existing] = await this.db
      .select()
      .from(verificationCases)
      .where(
        and(
          eq(verificationCases.companyId, principal.companyId),
          eq(verificationCases.driverId, input.driverId),
          isNull(verificationCases.decision),
        ),
      )
      .limit(1);
    if (existing) return this.derive(principal.companyId, existing);
    const at = input.at ?? new Date();
    const id = `vc_${crypto.randomUUID()}`;
    await this.db.insert(verificationCases).values({
      id,
      companyId: principal.companyId,
      driverId: input.driverId,
      driverName: input.driverName,
      openedAt: at,
      ownerId: principal.userId,
      ownerName: principal.userName ?? principal.userId,
      createdAt: at,
      updatedAt: at,
    });
    await this.audit.write(principal, {
      action: 'verification_advanced',
      entity: { type: 'driver', id: input.driverId, label: input.driverName },
      subject: null,
      before: null,
      after: 'recruiting',
      reason: 'Application received; verification case opened',
      at,
    });
    return this.get(principal, id);
  }

  /** A driver's name for an audit line: the roster row, else the open case, else the id. */
  async driverLabel(companyId: string, driverId: string): Promise<string> {
    const [driver] = await this.db
      .select({ first: drivers.firstName, last: drivers.lastName })
      .from(drivers)
      .where(and(eq(drivers.companyId, companyId), eq(drivers.id, driverId)))
      .limit(1);
    if (driver) return `${driver.first} ${driver.last}`.trim();
    const [vc] = await this.db
      .select({ name: verificationCases.driverName })
      .from(verificationCases)
      .where(and(eq(verificationCases.companyId, companyId), eq(verificationCases.driverId, driverId)))
      .limit(1);
    if (vc) return vc.name;
    throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'That driver is not in this company' });
  }

  /**
   * What stands between a case and an approval: every ladder step before the safety review that
   * is not complete (each with its blocker), and the safety review itself if nobody started it.
   */
  missingForDecision(c: VerificationCase): string[] {
    const missing = c.steps
      .filter((s) => s.stage !== 'safety_review' && s.stage !== 'decision' && s.status !== 'complete')
      .map((s) => (s.blocker ? `${s.label}: ${s.blocker}` : `${s.label} is not complete`));
    if (c.safetyReviewStatus === 'not_started') missing.push('Safety review has not been started');
    return missing;
  }

  /**
   * Safety picks the case up: the review is in progress, with who and when (audited). Refused on
   * a decided case and on one whose review is already under way.
   */
  async startReview(principal: Principal, id: string, options: { at?: Date } = {}): Promise<VerificationCase> {
    const before = await this.get(principal, id);
    if (before.decision !== null) {
      throw new AppError({ status: 409, title: 'Conflict', detail: `The case was already decided (${before.decision})` });
    }
    if (before.safetyReviewStatus !== 'not_started') {
      throw new AppError({ status: 409, title: 'Conflict', detail: `The safety review is already ${before.safetyReviewStatus.replace('_', ' ')}` });
    }
    const at = options.at ?? new Date();
    const by = principal.userName ?? principal.userId;
    const updated = await this.db
      .update(verificationCases)
      .set({ safetyReviewStatus: 'in_progress', safetyReviewBy: by, updatedAt: at })
      .where(and(eq(verificationCases.id, id), eq(verificationCases.companyId, principal.companyId), eq(verificationCases.safetyReviewStatus, 'not_started')))
      .returning({ id: verificationCases.id });
    if (updated.length === 0) {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'Somebody else started the review a moment ago; reload the case' });
    }
    await this.audit.write(principal, {
      action: 'verification_advanced',
      entity: { type: 'driver', id: before.driverId, label: before.driverName },
      subject: null,
      before: 'not_started',
      after: 'safety review in progress',
      reason: 'Safety review started',
      at,
    });
    return this.get(principal, id);
  }

  async recordDecision(
    principal: Principal,
    id: string,
    input: { decision: VerificationDecision; conditions: string[]; note: string | null },
    options: { at?: Date } = {},
  ): Promise<VerificationCase> {
    const before = await this.get(principal, id);
    if (before.decision !== null) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `A ${before.decision} decision was already recorded on ${before.decisionAt?.slice(0, 10)}`,
      });
    }
    // An approval (full or conditional) needs every mandatory check reviewed and accepted and the
    // safety review under way. A rejection never waits for a file to be complete.
    if (input.decision !== 'rejected') {
      const missing = this.missingForDecision(before);
      if (missing.length > 0) {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          detail: `The file is not ready for a ${input.decision} decision: ${missing.join('; ')}`,
          extensions: { missing },
        });
      }
    }
    const at = options.at ?? new Date();
    const by = principal.userName ?? principal.userId;
    await this.db
      .update(verificationCases)
      .set({
        decision: input.decision,
        decisionAt: at,
        decisionBy: by,
        conditions: input.conditions,
        decisionNote: input.note,
        // Deciding closes the review; a decision without a completed review is recorded as one.
        safetyReviewStatus: 'complete',
        safetyReviewAt: before.safetyReviewAt ? new Date(before.safetyReviewAt) : at,
        safetyReviewBy: before.safetyReviewBy ?? by,
        updatedAt: at,
      })
      .where(eq(verificationCases.id, id));
    await this.audit.write(principal, {
      action: 'decision_recorded',
      entity: { type: 'driver', id: before.driverId, label: before.driverName },
      subject: null,
      before: before.stage,
      after: input.decision,
      reason: input.note ?? (input.conditions.length > 0 ? input.conditions.join('; ') : null),
      at,
    });
    return this.get(principal, id);
  }
}
