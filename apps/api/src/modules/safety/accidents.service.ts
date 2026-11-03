import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  ACCIDENT_NEXT_ACTION,
  ACCIDENT_STAGE_LABEL,
  accidentAdvanceBlockers,
  accidentCloseBlockers,
  assessPostAccidentTesting,
  dotRecordable,
  nextAccidentStage,
  unresolvedTesting,
  type AccidentCloseKind,
  type AccidentFault,
  type AccidentFlowInput,
  type AccidentStage,
  type CloseAccidentInput,
  type CreateAccidentInput,
  type LinkWorkOrderInput,
  type PreventabilityDecision,
  type SafetyAccident,
  type SafetyCaseDetail,
  type UpdateAccidentInput,
  type VersionOnlyInput,
  type VoidInput,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { safetyAccidents, safetyReviews, type SafetyAccidentRow } from '../../database/schema/safety';
import { SafetyReviewsService } from './reviews.service';
import { SafetyCoreService, baseOf, changesOf, iso, toDate } from './safety-core.service';
import { DrugTestsService } from './tests.service';

/**
 * Accidents: Reported → Evidence → Testing assessed → Repairs & claim → Review → Closed.
 *
 * The facts decide two things on every write, both shown with their working: whether the crash is
 * DOT recordable (49 CFR 390.5) and whether post-accident alcohol and drug tests are required
 * (49 CFR 382.303, each on its own clock). A required test gets its own record. The file cannot be
 * closed normally while a required test is unresolved; an administrative closure is a separate,
 * reasoned and audited act that leaves every open test and corrective action where it is. Closing
 * never clears the driver to operate.
 */
@Injectable()
export class AccidentsService {
  constructor(
    private readonly core: SafetyCoreService,
    private readonly tests: DrugTestsService,
    private readonly reviews: SafetyReviewsService,
  ) {}

  private get db() {
    return this.core.db;
  }

  async row(companyId: string, id: string): Promise<SafetyAccidentRow> {
    const [row] = await this.db
      .select()
      .from(safetyAccidents)
      .where(and(eq(safetyAccidents.companyId, companyId), eq(safetyAccidents.id, id)))
      .limit(1);
    if (!row) throw this.core.notFound('That accident');
    return row;
  }

  private async flowInput(companyId: string, row: SafetyAccidentRow): Promise<{ flow: AccidentFlowInput; testRows: Awaited<ReturnType<DrugTestsService['rowsForAccident']>> }> {
    const testRows = await this.tests.rowsForAccident(companyId, row.id);
    let reviewCompleted = false;
    if (row.reviewId) {
      const [review] = await this.db
        .select({ status: safetyReviews.status })
        .from(safetyReviews)
        .where(and(eq(safetyReviews.companyId, companyId), eq(safetyReviews.id, row.reviewId)))
        .limit(1);
      reviewCompleted = review?.status === 'completed';
    }
    return {
      testRows,
      flow: {
        stage: row.stage as AccidentStage,
        testing: assessmentOf(row),
        tests: testRows.map((t) => ({ substance: t.substance as 'alcohol' | 'drug', required: t.required, status: this.tests.rawStatus(t) })),
        preventability: row.preventability as PreventabilityDecision,
        reviewCompleted,
        closedAt: iso(row.closedAt),
      },
    };
  }

  async toAccident(principal: Principal, row: SafetyAccidentRow): Promise<SafetyAccident> {
    const { flow, testRows } = await this.flowInput(principal.companyId, row);
    const recordable = dotRecordable({ fatalities: row.fatalities, injuriesTreatedAway: row.injuriesTreatedAway, towedFromScene: row.disablingTow });
    const canSee = this.tests.canSeeResults(principal);
    const closeBlockers = row.closedAt ? [] : accidentCloseBlockers(flow);
    return {
      ...baseOf(row),
      occurredAt: row.occurredAt.toISOString(),
      location: row.location,
      city: row.city,
      state: row.state,
      driverId: row.driverId,
      driverName: row.driverName,
      truckId: row.truckId,
      truckNumber: row.truckNumber,
      trailerId: row.trailerId,
      trailerNumber: row.trailerNumber,
      loadId: row.loadId,
      loadNumber: row.loadNumber,
      description: row.description,
      fatalities: row.fatalities,
      injuries: row.injuries,
      injuriesTreatedAway: row.injuriesTreatedAway,
      disablingTow: row.disablingTow,
      citationIssued: row.citationIssued,
      citationAt: iso(row.citationAt),
      citationNote: row.citationNote,
      policeReportNumber: row.policeReportNumber,
      dotRecordable: recordable.recordable,
      recordableReasons: recordable.reasons,
      stage: row.stage as AccidentStage,
      fault: row.fault as AccidentFault,
      preventability: row.preventability as PreventabilityDecision,
      preventabilityNote: row.preventabilityNote,
      notes: row.notes,
      damageEstimateCents: row.damageEstimateCents,
      companyDeductibleCents: row.companyDeductibleCents,
      workOrderId: row.workOrderId,
      workOrderNumber: row.workOrderNumber,
      claimId: row.claimId,
      claimNumber: row.claimNumber,
      reviewId: row.reviewId,
      reviewNumber: row.reviewNumber,
      closedAt: iso(row.closedAt),
      closedBy: row.closedBy,
      closeKind: row.closeKind as AccidentCloseKind | null,
      closeReason: row.closeReason,
      testing: flow.testing,
      tests: testRows.map((t) => this.tests.toAccidentTest(t, principal)),
      // Blockers name tests, not results; a caller without testing access still sees that the
      // file is held, and by what step.
      closeBlockers: canSee ? closeBlockers : closeBlockers.map((b) => (b.includes(' test: ') ? b.replace(/ test: .*/, ' test: not resolved (restricted)') : b)),
      advanceBlockers: row.closedAt || row.voidedAt ? [] : accidentAdvanceBlockers(flow),
    };
  }

  async list(principal: Principal, query: { includeVoided?: boolean } = {}): Promise<SafetyAccident[]> {
    const parts = [eq(safetyAccidents.companyId, principal.companyId)];
    if (!query.includeVoided) parts.push(isNull(safetyAccidents.voidedAt));
    const rows = await this.db.select().from(safetyAccidents).where(and(...parts)).orderBy(desc(safetyAccidents.occurredAt));
    return Promise.all(rows.map((r) => this.toAccident(principal, r)));
  }

  async get(principal: Principal, id: string): Promise<SafetyAccident> {
    return this.toAccident(principal, await this.row(principal.companyId, id));
  }

  async detail(principal: Principal, id: string): Promise<SafetyCaseDetail<SafetyAccident>> {
    const [record, documents, timeline] = await Promise.all([
      this.get(principal, id),
      this.core.documents(principal.companyId, 'accident', id),
      this.core.timeline(principal, 'accident', id),
    ]);
    return { record, documents, timeline };
  }

  async create(principal: Principal, input: CreateAccidentInput): Promise<SafetyAccident> {
    if (Date.parse(input.occurredAt) > this.core.now().getTime() + 5 * 60_000) {
      throw this.core.invalid('The accident time is in the future');
    }
    if (input.citationAt && Date.parse(input.citationAt) < Date.parse(input.occurredAt)) {
      throw this.core.invalid('The citation cannot come before the accident');
    }
    const [driver, truck, trailer, load, owner] = await Promise.all([
      this.core.driver(principal.companyId, input.driverId),
      this.core.truck(principal.companyId, input.truckId),
      this.core.trailer(principal.companyId, input.trailerId),
      this.core.load(principal.companyId, input.loadId),
      this.core.person(principal.companyId, input.ownerId),
    ]);
    const at = this.core.now();
    const number = await this.core.nextNumber(principal.companyId, 'accident');
    const id = this.core.newId('acc');
    const next = ACCIDENT_NEXT_ACTION.reported;
    await this.db.insert(safetyAccidents).values({
      id,
      companyId: principal.companyId,
      number,
      ...this.core.ownerOf(principal, owner),
      nextAction: input.nextAction ?? next?.text ?? null,
      nextActionDueOn: input.nextActionDueOn ?? this.core.dueIn(next?.days ?? 1),
      isTest: input.isTest ?? false,
      createdBy: this.core.actor(principal),
      createdAt: at,
      updatedAt: at,
      occurredAt: new Date(input.occurredAt),
      location: input.location,
      city: input.city ?? null,
      state: input.state ?? null,
      driverId: driver?.id ?? null,
      driverName: driver?.name ?? null,
      truckId: truck?.id ?? null,
      truckNumber: truck?.number ?? null,
      trailerId: trailer?.id ?? null,
      trailerNumber: trailer?.number ?? null,
      loadId: load?.id ?? null,
      loadNumber: load?.number ?? null,
      description: input.description,
      fatalities: input.fatalities,
      injuries: input.injuries,
      injuriesTreatedAway: input.injuriesTreatedAway,
      disablingTow: input.disablingTow,
      citationIssued: input.citationIssued,
      citationAt: toDate(input.citationAt),
      citationNote: input.citationNote ?? null,
      policeReportNumber: input.policeReportNumber ?? null,
    });
    await this.core.write(principal, 'accident', { id, number }, 'accident_reported', `Accident reported at ${input.location}${driver ? ` (${driver.name})` : ''}`, { at });
    const row = await this.row(principal.companyId, id);
    await this.tests.syncForAccident(principal, row);
    return this.get(principal, id);
  }

  async update(principal: Principal, id: string, input: UpdateAccidentInput): Promise<SafetyAccident> {
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    if (row.closedAt) throw this.core.refused(`${row.number} is closed`);
    const patch: Partial<typeof safetyAccidents.$inferInsert> = {};
    if (input.driverId !== undefined) {
      const d = await this.core.driver(principal.companyId, input.driverId);
      patch.driverId = d?.id ?? null;
      patch.driverName = d?.name ?? null;
    }
    if (input.truckId !== undefined) {
      const t = await this.core.truck(principal.companyId, input.truckId);
      patch.truckId = t?.id ?? null;
      patch.truckNumber = t?.number ?? null;
    }
    if (input.trailerId !== undefined) {
      const t = await this.core.trailer(principal.companyId, input.trailerId);
      patch.trailerId = t?.id ?? null;
      patch.trailerNumber = t?.number ?? null;
    }
    if (input.loadId !== undefined) {
      const l = await this.core.load(principal.companyId, input.loadId);
      patch.loadId = l?.id ?? null;
      patch.loadNumber = l?.number ?? null;
    }
    if (input.ownerId !== undefined) {
      const o = await this.core.person(principal.companyId, input.ownerId);
      patch.ownerId = o?.id ?? null;
      patch.ownerName = o?.name ?? null;
    }
    if (input.occurredAt !== undefined) patch.occurredAt = new Date(input.occurredAt);
    if (input.citationAt !== undefined) patch.citationAt = toDate(input.citationAt);
    const copy = [
      'location',
      'city',
      'state',
      'description',
      'fatalities',
      'injuries',
      'injuriesTreatedAway',
      'disablingTow',
      'citationIssued',
      'citationNote',
      'policeReportNumber',
      'fault',
      'preventability',
      'preventabilityNote',
      'notes',
      'damageEstimateCents',
      'companyDeductibleCents',
      'nextAction',
      'nextActionDueOn',
    ] as const;
    for (const key of copy) {
      if (input[key] !== undefined) (patch as Record<string, unknown>)[key] = input[key] ?? null;
    }
    const occurred = patch.occurredAt ?? row.occurredAt;
    const citation = patch.citationAt === undefined ? row.citationAt : patch.citationAt;
    if (citation && citation.getTime() < occurred.getTime()) throw this.core.invalid('The citation cannot come before the accident');
    if (occurred.getTime() > this.core.now().getTime() + 5 * 60_000) throw this.core.invalid('The accident time is in the future');
    const at = this.core.now();
    const updated = await this.db
      .update(safetyAccidents)
      .set({ ...patch, version: row.version + 1, updatedAt: at })
      .where(and(eq(safetyAccidents.id, row.id), eq(safetyAccidents.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    const changes = changesOf(row as unknown as Record<string, unknown>, patch as Record<string, unknown>);
    await this.core.write(principal, 'accident', row, 'accident_updated', `Updated ${changes.map((c) => c.field).join(', ') || row.number}`, { changes, at });
    await this.tests.syncForAccident(principal, updated[0] as SafetyAccidentRow);
    return this.get(principal, id);
  }

  /**
   * "Mark complete" on the next action. Moving into Review opens the driver review (once); moving
   * out of Review is the normal close and needs everything `accidentCloseBlockers` names.
   */
  async advance(principal: Principal, id: string, input: VersionOnlyInput): Promise<SafetyAccident> {
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    if (row.closedAt) throw this.core.refused(`${row.number} is closed`);
    const { flow } = await this.flowInput(principal.companyId, row);
    const blockers = accidentAdvanceBlockers(flow);
    if (blockers.length > 0) {
      throw this.core.refused(
        `${row.number} cannot move past ${ACCIDENT_STAGE_LABEL[row.stage as AccidentStage]} yet`,
        this.tests.canSeeResults(principal) ? blockers : blockers.map((b) => (b.includes(' test: ') ? b.replace(/ test: .*/, ' test: not resolved (restricted)') : b)),
      );
    }
    const to = nextAccidentStage(row.stage as AccidentStage);
    if (!to) throw this.core.refused(`${row.number} is closed`);
    if (to === 'closed') return this.close(principal, id, { version: input.version, kind: 'normal', reason: null });
    const at = this.core.now();
    const next = ACCIDENT_NEXT_ACTION[to];
    const patch: Partial<typeof safetyAccidents.$inferInsert> = {
      stage: to,
      nextAction: next?.text ?? null,
      nextActionDueOn: next ? this.core.dueIn(next.days) : null,
    };
    if (to === 'testing') {
      const pending = unresolvedTesting(flow);
      if (pending.length === 0) {
        patch.nextAction = 'Confirm the testing assessment: no test is outstanding';
      }
    }
    if (to === 'review' && !row.reviewId) {
      const driver = row.driverId ? { id: row.driverId, name: row.driverName ?? '' } : null;
      const review = await this.reviews.openLinked(principal, {
        kind: 'driver_review',
        reason: 'Accident review',
        driver,
        linkedType: 'accident',
        linked: row,
        preventabilityRequired: true,
        owner: { ownerId: row.ownerId, ownerName: row.ownerName },
        dueDays: 7,
        isTest: row.isTest,
      });
      patch.reviewId = review.id;
      patch.reviewNumber = review.number;
    }
    const updated = await this.db
      .update(safetyAccidents)
      .set({ ...patch, version: row.version + 1, updatedAt: at })
      .where(and(eq(safetyAccidents.id, row.id), eq(safetyAccidents.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    await this.core.write(principal, 'accident', row, 'accident_stage_changed', `${ACCIDENT_STAGE_LABEL[row.stage as AccidentStage]} → ${ACCIDENT_STAGE_LABEL[to]}`, {
      changes: [{ field: 'stage', old: row.stage, new: to }],
      at,
    });
    if (patch.reviewId) {
      await this.core.write(principal, 'accident', row, 'accident_review_opened', `Driver review ${patch.reviewNumber} opened`, { at });
    }
    return this.get(principal, id);
  }

  /**
   * Closes the file. Normal: only when nothing is outstanding. Administrative: an explicit act
   * with a reason, by someone who holds both safety.manage and safety_testing.manage; it keeps
   * every open test and opens a corrective action for what was left, so nothing is dropped.
   */
  async close(principal: Principal, id: string, input: CloseAccidentInput): Promise<SafetyAccident> {
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    if (row.closedAt) throw this.core.refused(`${row.number} is already closed`);
    const { flow } = await this.flowInput(principal.companyId, row);
    const blockers = accidentCloseBlockers(flow);
    const kind = input.kind ?? 'normal';
    if (kind === 'normal' && blockers.length > 0) {
      throw this.core.refused(
        `${row.number} cannot be closed`,
        this.tests.canSeeResults(principal) ? blockers : blockers.map((b) => (b.includes(' test: ') ? b.replace(/ test: .*/, ' test: not resolved (restricted)') : b)),
      );
    }
    if (kind === 'administrative' && !(hasPermission(principal, 'safety.manage') && hasPermission(principal, 'safety_testing.manage'))) {
      throw this.core.forbidden('An administrative closure takes safety.manage and safety_testing.manage');
    }
    const at = this.core.now();
    const updated = await this.db
      .update(safetyAccidents)
      .set({
        stage: 'closed',
        closedAt: at,
        closedBy: this.core.actor(principal),
        closeKind: kind,
        closeReason: input.reason ?? null,
        nextAction: null,
        nextActionDueOn: null,
        version: row.version + 1,
        updatedAt: at,
      })
      .where(and(eq(safetyAccidents.id, row.id), eq(safetyAccidents.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    await this.core.write(
      principal,
      'accident',
      row,
      kind === 'normal' ? 'accident_closed' : 'accident_closed_administratively',
      kind === 'normal' ? 'Closed' : `Closed administratively with ${blockers.length} item(s) outstanding`,
      { changes: [{ field: 'stage', old: row.stage, new: 'closed' }], reason: input.reason ?? null, at },
    );
    if (kind === 'administrative' && blockers.length > 0) {
      // What was left open is carried, not dropped: one corrective action, linked to the file.
      await this.reviews.openLinked(principal, {
        kind: 'corrective_action',
        reason: `Outstanding at administrative closure: ${blockers.length} item(s)`,
        driver: row.driverId ? { id: row.driverId, name: row.driverName ?? '' } : null,
        linkedType: 'accident',
        linked: row,
        owner: { ownerId: row.ownerId, ownerName: row.ownerName },
        dueDays: 3,
        isTest: row.isTest,
      });
    }
    return this.get(principal, id);
  }

  /** Links an existing work order by reference. The work order stays in Fleet; nothing is copied. */
  async linkWorkOrder(principal: Principal, id: string, input: LinkWorkOrderInput): Promise<SafetyAccident> {
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    const wo = await this.core.workOrder(principal.companyId, input.workOrderId);
    if (row.workOrderId === wo.id) return this.get(principal, id);
    const at = this.core.now();
    const updated = await this.db
      .update(safetyAccidents)
      .set({ workOrderId: wo.id, workOrderNumber: wo.number, version: row.version + 1, updatedAt: at })
      .where(and(eq(safetyAccidents.id, row.id), eq(safetyAccidents.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    await this.core.write(principal, 'accident', row, 'accident_work_order_linked', `Repair ${wo.number} linked`, {
      changes: [{ field: 'workOrderId', old: row.workOrderId, new: wo.id }],
      at,
    });
    return this.get(principal, id);
  }

  async void(principal: Principal, id: string, input: VoidInput): Promise<SafetyAccident> {
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    const at = this.core.now();
    const updated = await this.db
      .update(safetyAccidents)
      .set({ voidedAt: at, voidedBy: this.core.actor(principal), voidReason: input.reason, version: row.version + 1, updatedAt: at })
      .where(and(eq(safetyAccidents.id, row.id), eq(safetyAccidents.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    await this.core.write(principal, 'accident', row, 'accident_voided', `Voided ${row.number}`, { reason: input.reason, at });
    return this.get(principal, id);
  }
}

export function assessmentOf(row: SafetyAccidentRow) {
  return assessPostAccidentTesting({
    occurredAt: row.occurredAt.toISOString(),
    fatalities: row.fatalities,
    injuriesTreatedAway: row.injuriesTreatedAway,
    disablingTow: row.disablingTow,
    citationIssued: row.citationIssued,
    citationAt: iso(row.citationAt),
  });
}
