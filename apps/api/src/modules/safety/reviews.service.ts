import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  REVIEW_NEXT_ACTION,
  reviewCompleteBlockers,
  type CompleteSafetyReviewInput,
  type CreateSafetyReviewInput,
  type PreventabilityDecision,
  type SafetyCaseDetail,
  type SafetyLinkedType,
  type SafetyReview,
  type SafetyReviewKind,
  type SafetyReviewStatus,
  type UpdateSafetyReviewInput,
  type VoidInput,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import {
  drugAlcoholTests,
  safetyAccidents,
  safetyClaims,
  safetyRoadsideInspections,
  safetyReviews,
  safetyViolations,
  type SafetyReviewRow,
} from '../../database/schema/safety';
import { SafetyCoreService, baseOf, changesOf, iso } from './safety-core.service';

export interface DriverRelatedRecords {
  accidents: { id: string; number: string; occurredAt: string; stage: string }[];
  claims: { id: string; number: string; openedOn: string; stage: string }[];
  violations: { id: string; number: string; occurredAt: string; description: string }[];
}

/**
 * Safety reviews: driver reviews, coaching and corrective actions.
 *
 * A review is opened by a person, or by the case it follows: an accident reaching Review, a
 * violation issued to a driver, a positive or refused test. One live review per kind per linked
 * case — the unique index makes "open the review" safe to repeat. Completing one is refused until
 * its required steps are done, and an accident review writes the preventability decision back to
 * the accident it came from.
 */
@Injectable()
export class SafetyReviewsService {
  constructor(private readonly core: SafetyCoreService) {}

  private get db() {
    return this.core.db;
  }

  toReview(row: SafetyReviewRow): SafetyReview {
    return {
      ...baseOf(row),
      kind: row.kind as SafetyReviewKind,
      reason: row.reason,
      driverId: row.driverId,
      driverName: row.driverName,
      linkedType: row.linkedType as SafetyLinkedType | null,
      linkedId: row.linkedId,
      linkedNumber: row.linkedNumber,
      status: row.status as SafetyReviewStatus,
      scheduledFor: row.scheduledFor,
      preventabilityRequired: row.preventabilityRequired,
      preventability: row.preventability as PreventabilityDecision,
      requiredTraining: row.requiredTraining,
      trainingCompletedOn: row.trainingCompletedOn,
      notes: row.notes,
      outcome: row.outcome,
      followUpOn: row.followUpOn,
      evidenceNote: row.evidenceNote,
      completedAt: iso(row.completedAt),
      completedBy: row.completedBy,
      completeBlockers:
        row.status === 'completed'
          ? []
          : reviewCompleteBlockers({
              kind: row.kind as SafetyReviewKind,
              preventabilityRequired: row.preventabilityRequired,
              preventability: row.preventability as PreventabilityDecision,
              requiredTraining: row.requiredTraining,
              trainingCompletedOn: row.trainingCompletedOn,
              outcome: row.outcome,
            }),
    };
  }

  async row(companyId: string, id: string): Promise<SafetyReviewRow> {
    const [row] = await this.db
      .select()
      .from(safetyReviews)
      .where(and(eq(safetyReviews.companyId, companyId), eq(safetyReviews.id, id)))
      .limit(1);
    if (!row) throw this.core.notFound('That review');
    return row;
  }

  async list(
    principal: Principal,
    query: { kind?: SafetyReviewKind; driverId?: string; open?: boolean; includeVoided?: boolean } = {},
  ): Promise<SafetyReview[]> {
    const parts = [eq(safetyReviews.companyId, principal.companyId)];
    if (query.kind) parts.push(eq(safetyReviews.kind, query.kind));
    if (query.driverId) parts.push(eq(safetyReviews.driverId, query.driverId));
    if (!query.includeVoided) parts.push(isNull(safetyReviews.voidedAt));
    const rows = await this.db
      .select()
      .from(safetyReviews)
      .where(and(...parts))
      .orderBy(desc(safetyReviews.createdAt));
    const all = rows.map((r) => this.toReview(r));
    return query.open ? all.filter((r) => r.status !== 'completed') : all;
  }

  async detail(principal: Principal, id: string): Promise<SafetyCaseDetail<SafetyReview> & { related: DriverRelatedRecords }> {
    const row = await this.row(principal.companyId, id);
    const [documents, timeline, related] = await Promise.all([
      this.core.documents(principal.companyId, 'safety_review', id),
      this.core.timeline(principal, 'safety_review', id),
      this.related(principal.companyId, row.driverId),
    ]);
    return { record: this.toReview(row), documents, timeline, related };
  }

  /** The driver's accidents, claims and violations, for the review drawer. */
  async related(companyId: string, driverId: string | null): Promise<DriverRelatedRecords> {
    if (!driverId) return { accidents: [], claims: [], violations: [] };
    const [accidents, claims, violations] = await Promise.all([
      this.db
        .select({ id: safetyAccidents.id, number: safetyAccidents.number, occurredAt: safetyAccidents.occurredAt, stage: safetyAccidents.stage })
        .from(safetyAccidents)
        .where(and(eq(safetyAccidents.companyId, companyId), eq(safetyAccidents.driverId, driverId), isNull(safetyAccidents.voidedAt)))
        .orderBy(desc(safetyAccidents.occurredAt)),
      this.db
        .select({ id: safetyClaims.id, number: safetyClaims.number, openedOn: safetyClaims.openedOn, stage: safetyClaims.stage })
        .from(safetyClaims)
        .where(and(eq(safetyClaims.companyId, companyId), eq(safetyClaims.driverId, driverId), isNull(safetyClaims.voidedAt)))
        .orderBy(desc(safetyClaims.openedOn)),
      this.db
        .select({ id: safetyViolations.id, number: safetyViolations.number, occurredAt: safetyViolations.occurredAt, description: safetyViolations.description })
        .from(safetyViolations)
        .where(and(eq(safetyViolations.companyId, companyId), eq(safetyViolations.driverId, driverId), isNull(safetyViolations.voidedAt)))
        .orderBy(desc(safetyViolations.occurredAt)),
    ]);
    return {
      accidents: accidents.map((a) => ({ ...a, occurredAt: a.occurredAt.toISOString() })),
      claims,
      violations: violations.map((v) => ({ ...v, occurredAt: v.occurredAt.toISOString() })),
    };
  }

  /**
   * Opens the review a case calls for, or returns the one already open for it. Safe to repeat.
   */
  async openLinked(
    principal: Principal,
    input: {
      kind: SafetyReviewKind;
      reason: string;
      driver: { id: string; name: string } | null;
      linkedType: SafetyLinkedType;
      linked: { id: string; number: string };
      preventabilityRequired?: boolean;
      owner?: { ownerId: string | null; ownerName: string | null };
      dueDays?: number;
      isTest?: boolean;
    },
  ): Promise<SafetyReviewRow> {
    const existing = await this.findLinked(principal.companyId, input.kind, input.linkedType, input.linked.id);
    if (existing) return existing;
    const at = this.core.now();
    const number = await this.core.nextNumber(principal.companyId, 'safety_review');
    const id = this.core.newId('srv');
    const inserted = await this.db
      .insert(safetyReviews)
      .values({
        id,
        companyId: principal.companyId,
        number,
        ownerId: input.owner?.ownerId ?? principal.userId,
        ownerName: input.owner?.ownerName ?? this.core.actor(principal),
        nextAction: REVIEW_NEXT_ACTION[input.kind],
        nextActionDueOn: this.core.dueIn(input.dueDays ?? 7),
        isTest: input.isTest ?? false,
        createdBy: this.core.actor(principal),
        createdAt: at,
        updatedAt: at,
        kind: input.kind,
        reason: input.reason,
        driverId: input.driver?.id ?? null,
        driverName: input.driver?.name ?? null,
        linkedType: input.linkedType,
        linkedId: input.linked.id,
        linkedNumber: input.linked.number,
        preventabilityRequired: input.preventabilityRequired ?? false,
      })
      .onConflictDoNothing()
      .returning();
    if (inserted.length === 0) {
      // Someone else opened it in the same instant: theirs is the one.
      const again = await this.findLinked(principal.companyId, input.kind, input.linkedType, input.linked.id);
      if (again) return again;
      throw this.core.refused('The review could not be opened');
    }
    await this.core.write(principal, 'safety_review', { id, number }, 'safety_review_opened', `${input.reason} opened from ${input.linked.number}`, { at });
    return inserted[0] as SafetyReviewRow;
  }

  private async findLinked(companyId: string, kind: string, linkedType: string, linkedId: string): Promise<SafetyReviewRow | null> {
    const [row] = await this.db
      .select()
      .from(safetyReviews)
      .where(
        and(
          eq(safetyReviews.companyId, companyId),
          eq(safetyReviews.kind, kind),
          eq(safetyReviews.linkedType, linkedType),
          eq(safetyReviews.linkedId, linkedId),
          isNull(safetyReviews.voidedAt),
        ),
      )
      .limit(1);
    return row ?? null;
  }

  /** The number of a linked case, checked to belong to this company. */
  private async linkedNumber(companyId: string, type: SafetyLinkedType, id: string): Promise<string> {
    const table =
      type === 'accident'
        ? safetyAccidents
        : type === 'claim'
          ? safetyClaims
          : type === 'violation'
            ? safetyViolations
            : type === 'roadside_inspection'
              ? safetyRoadsideInspections
              : drugAlcoholTests;
    const [row] = await this.db
      .select({ number: table.number })
      .from(table)
      .where(and(eq(table.companyId, companyId), eq(table.id, id)))
      .limit(1);
    if (!row) throw this.core.invalid('The linked case is not in this company');
    return row.number;
  }

  async create(principal: Principal, input: CreateSafetyReviewInput): Promise<SafetyReview> {
    const [driver, owner] = await Promise.all([
      this.core.driver(principal.companyId, input.driverId),
      this.core.person(principal.companyId, input.ownerId),
    ]);
    let linkedNumber: string | null = null;
    if (input.linkedType && input.linkedId) {
      linkedNumber = await this.linkedNumber(principal.companyId, input.linkedType, input.linkedId);
      const existing = await this.findLinked(principal.companyId, input.kind, input.linkedType, input.linkedId);
      if (existing) return this.toReview(existing);
    }
    const at = this.core.now();
    const number = await this.core.nextNumber(principal.companyId, 'safety_review');
    const id = this.core.newId('srv');
    await this.db.insert(safetyReviews).values({
      id,
      companyId: principal.companyId,
      number,
      ...this.core.ownerOf(principal, owner),
      nextAction: input.nextAction ?? REVIEW_NEXT_ACTION[input.kind],
      nextActionDueOn: input.nextActionDueOn ?? this.core.dueIn(7),
      isTest: input.isTest ?? false,
      createdBy: this.core.actor(principal),
      createdAt: at,
      updatedAt: at,
      kind: input.kind,
      reason: input.reason,
      driverId: driver?.id ?? null,
      driverName: driver?.name ?? null,
      linkedType: input.linkedType && input.linkedId ? input.linkedType : null,
      linkedId: input.linkedType && input.linkedId ? input.linkedId : null,
      linkedNumber,
      status: input.scheduledFor ? 'scheduled' : 'not_started',
      scheduledFor: input.scheduledFor ?? null,
      preventabilityRequired: input.linkedType === 'accident' && input.kind === 'driver_review',
      requiredTraining: input.requiredTraining ?? null,
      notes: input.notes ?? null,
    });
    await this.core.write(principal, 'safety_review', { id, number }, 'safety_review_opened', `${input.reason} opened${driver ? ` for ${driver.name}` : ''}`, { at });
    return this.toReview(await this.row(principal.companyId, id));
  }

  async update(principal: Principal, id: string, input: UpdateSafetyReviewInput): Promise<SafetyReview> {
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    if (row.status === 'completed') throw this.core.refused(`${row.number} is complete; open a follow-up review instead`);
    const patch: Partial<typeof safetyReviews.$inferInsert> = {};
    const copy = ['reason', 'status', 'scheduledFor', 'preventability', 'requiredTraining', 'trainingCompletedOn', 'notes', 'outcome', 'followUpOn', 'evidenceNote', 'nextAction', 'nextActionDueOn'] as const;
    for (const key of copy) {
      if (input[key] !== undefined) (patch as Record<string, unknown>)[key] = input[key] ?? null;
    }
    if (input.scheduledFor && !input.status && row.status === 'not_started') patch.status = 'scheduled';
    if (input.ownerId !== undefined) {
      const owner = await this.core.person(principal.companyId, input.ownerId);
      patch.ownerId = owner?.id ?? null;
      patch.ownerName = owner?.name ?? null;
    }
    const at = this.core.now();
    const updated = await this.db
      .update(safetyReviews)
      .set({ ...patch, version: row.version + 1, updatedAt: at })
      .where(and(eq(safetyReviews.id, row.id), eq(safetyReviews.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    const changes = changesOf(row as unknown as Record<string, unknown>, patch as Record<string, unknown>);
    await this.core.write(principal, 'safety_review', row, 'safety_review_updated', `Updated ${changes.map((c) => c.field).join(', ') || row.number}`, { changes, at });
    return this.toReview(updated[0] as SafetyReviewRow);
  }

  async complete(principal: Principal, id: string, input: CompleteSafetyReviewInput): Promise<SafetyReview> {
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    if (row.status === 'completed') throw this.core.refused(`${row.number} is already complete`);
    const outcome = input.outcome ?? row.outcome;
    const blockers = reviewCompleteBlockers({
      kind: row.kind as SafetyReviewKind,
      preventabilityRequired: row.preventabilityRequired,
      preventability: row.preventability as PreventabilityDecision,
      requiredTraining: row.requiredTraining,
      trainingCompletedOn: row.trainingCompletedOn,
      outcome,
    });
    if (blockers.length > 0) throw this.core.refused('The review cannot be completed yet', blockers);
    const at = this.core.now();
    const updated = await this.db
      .update(safetyReviews)
      .set({
        status: 'completed',
        outcome,
        completedAt: at,
        completedBy: this.core.actor(principal),
        nextAction: row.followUpOn ? 'Follow up with the driver' : null,
        nextActionDueOn: row.followUpOn ?? null,
        version: row.version + 1,
        updatedAt: at,
      })
      .where(and(eq(safetyReviews.id, row.id), eq(safetyReviews.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    await this.core.write(principal, 'safety_review', row, 'safety_review_completed', `Review completed${row.preventabilityRequired ? `: ${row.preventability.replace('_', ' ')}` : ''}`, {
      reason: outcome,
      at,
    });
    // An accident review decides the accident's preventability. Written back with its own audit
    // line on the accident, so the accident's timeline says who decided it and where.
    if (row.linkedType === 'accident' && row.linkedId && row.preventabilityRequired) {
      const [accident] = await this.db
        .select()
        .from(safetyAccidents)
        .where(and(eq(safetyAccidents.companyId, principal.companyId), eq(safetyAccidents.id, row.linkedId)))
        .limit(1);
      if (accident && accident.preventability !== row.preventability) {
        await this.db
          .update(safetyAccidents)
          .set({ preventability: row.preventability, version: accident.version + 1, updatedAt: at })
          .where(eq(safetyAccidents.id, accident.id));
      }
      if (accident) {
        await this.core.write(principal, 'accident', accident, 'accident_review_completed', `Driver review ${row.number} completed: ${row.preventability.replace('_', ' ')}`, {
          changes: [{ field: 'preventability', old: accident.preventability, new: row.preventability }],
          at,
        });
      }
    }
    return this.toReview(updated[0] as SafetyReviewRow);
  }

  async void(principal: Principal, id: string, input: VoidInput): Promise<SafetyReview> {
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    const at = this.core.now();
    const updated = await this.db
      .update(safetyReviews)
      .set({ voidedAt: at, voidedBy: this.core.actor(principal), voidReason: input.reason, version: row.version + 1, updatedAt: at })
      .where(and(eq(safetyReviews.id, row.id), eq(safetyReviews.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    await this.core.write(principal, 'safety_review', row, 'safety_review_voided', `Voided ${row.number}`, { reason: input.reason, at });
    return this.toReview(updated[0] as SafetyReviewRow);
  }
}
