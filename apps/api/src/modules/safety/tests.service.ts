import { Injectable } from '@nestjs/common';
import { and, desc, eq, isNull } from 'drizzle-orm';
import {
  DRUG_ALCOHOL_TEST_TYPE_LABEL,
  assessPostAccidentTesting,
  collectionLimit,
  testStatus,
  type ComplianceDocument,
  type CreateDrugTestInput,
  type DrugAlcoholTestType,
  type RecordRandomDrugTestInput,
  type ReviewTestExceptionInput,
  type SafetyAccidentTest,
  type SafetyCaseDetail,
  type SafetyDrugTest,
  type TestResult,
  type TestSubstance,
  type UpdateDrugTestInput,
  type VoidInput,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { drugAlcoholTests, type DrugAlcoholTestRow, type SafetyAccidentRow } from '../../database/schema/safety';
import { ComplianceService } from '../compliance/compliance.service';
import { SafetyCoreService, baseOf, changesOf, iso, toDate } from './safety-core.service';

/**
 * Drug and alcohol tests (49 CFR 382), post-accident ones first.
 *
 * Results are restricted (owner, 2026-10-02): a caller without `safety_testing.view` gets the
 * record with its result and the reasons around it removed by this service, whatever screen asked.
 * Recording a result or a not-completed reason takes `safety_testing.manage`; the Safety review of
 * a missed, refused or could-not-complete test takes that and `safety.manage`.
 */
@Injectable()
export class DrugTestsService {
  constructor(
    private readonly core: SafetyCoreService,
    private readonly compliance: ComplianceService,
  ) {}

  private get db() {
    return this.core.db;
  }

  canSeeResults(principal: Principal): boolean {
    return hasPermission(principal, 'safety_testing.view');
  }

  private statusOf(row: DrugAlcoholTestRow) {
    return testStatus(
      {
        substance: row.substance as TestSubstance,
        testType: row.testType as DrugAlcoholTestType,
        occurredAt: iso(row.occurredAt),
        required: row.required,
        scheduledAt: iso(row.scheduledAt),
        collectedAt: iso(row.collectedAt),
        result: row.result as TestResult,
        notCompletedReason: row.notCompletedReason,
        lateReason: row.lateReason,
        exceptionReviewedAt: iso(row.exceptionReviewedAt),
      },
      this.core.now().toISOString(),
    );
  }

  toTest(row: DrugAlcoholTestRow, principal: Principal): SafetyDrugTest {
    const visible = this.canSeeResults(principal);
    const status = this.statusOf(row);
    return {
      ...baseOf(row),
      testType: row.testType as DrugAlcoholTestType,
      substance: row.substance as TestSubstance,
      driverId: row.driverId,
      driverName: row.driverName,
      accidentId: row.accidentId,
      accidentNumber: row.accidentNumber,
      required: row.required,
      requiredReason: row.requiredReason,
      occurredAt: iso(row.occurredAt),
      scheduledAt: iso(row.scheduledAt),
      collectedAt: iso(row.collectedAt),
      result: visible ? (row.result as TestResult) : null,
      resultAt: visible ? iso(row.resultAt) : null,
      resultRestricted: !visible,
      // The reasons around a refusal say what the result was; they follow the result.
      notCompletedReason: visible ? row.notCompletedReason : row.notCompletedReason ? 'Restricted' : null,
      lateReason: visible ? row.lateReason : row.lateReason ? 'Restricted' : null,
      exceptionReviewedAt: iso(row.exceptionReviewedAt),
      exceptionReviewedBy: row.exceptionReviewedBy,
      exceptionNote: visible ? row.exceptionNote : row.exceptionNote ? 'Restricted' : null,
      status: visible ? status : redactStatus(status),
    };
  }

  toAccidentTest(row: DrugAlcoholTestRow, principal: Principal): SafetyAccidentTest {
    const t = this.toTest(row, principal);
    return {
      id: t.id,
      number: t.number,
      substance: t.substance,
      required: t.required,
      result: t.result,
      resultRestricted: t.resultRestricted,
      scheduledAt: t.scheduledAt,
      collectedAt: t.collectedAt,
      status: t.status,
    };
  }

  /** The unredacted status, for rules the server enforces (closing an accident). */
  rawStatus(row: DrugAlcoholTestRow) {
    return this.statusOf(row);
  }

  async rowsForAccident(companyId: string, accidentId: string): Promise<DrugAlcoholTestRow[]> {
    return this.db
      .select()
      .from(drugAlcoholTests)
      .where(
        and(
          eq(drugAlcoholTests.companyId, companyId),
          eq(drugAlcoholTests.accidentId, accidentId),
          isNull(drugAlcoholTests.voidedAt),
        ),
      );
  }

  async list(principal: Principal, query: { driverId?: string; includeVoided?: boolean } = {}): Promise<SafetyDrugTest[]> {
    const parts = [eq(drugAlcoholTests.companyId, principal.companyId)];
    if (query.driverId) parts.push(eq(drugAlcoholTests.driverId, query.driverId));
    if (!query.includeVoided) parts.push(isNull(drugAlcoholTests.voidedAt));
    const rows = await this.db
      .select()
      .from(drugAlcoholTests)
      .where(and(...parts))
      .orderBy(desc(drugAlcoholTests.createdAt));
    return rows.map((r) => this.toTest(r, principal));
  }

  async row(companyId: string, id: string): Promise<DrugAlcoholTestRow> {
    const [row] = await this.db
      .select()
      .from(drugAlcoholTests)
      .where(and(eq(drugAlcoholTests.companyId, companyId), eq(drugAlcoholTests.id, id)))
      .limit(1);
    if (!row) throw this.core.notFound('That test');
    return row;
  }

  async detail(principal: Principal, id: string): Promise<SafetyCaseDetail<SafetyDrugTest>> {
    const row = await this.row(principal.companyId, id);
    const [documents, timeline] = await Promise.all([
      // Test records are restricted documents: listed only for those who may see results.
      this.canSeeResults(principal) ? this.core.documents(principal.companyId, 'drug_test', id) : Promise.resolve([]),
      this.core.timeline(principal, 'drug_test', id),
    ]);
    return { record: this.toTest(row, principal), documents, timeline };
  }

  /**
   * Makes the post-accident test rows match the accident's facts.
   *
   * A test the rule now requires gets a row (one per accident and substance — the unique index
   * holds it). A row whose requirement changed is updated and audited, never removed: the record
   * of what was collected, refused or excused stays.
   */
  async syncForAccident(principal: Principal, accident: SafetyAccidentRow): Promise<void> {
    if (accident.voidedAt) return;
    const assessment = assessPostAccidentTesting({
      occurredAt: accident.occurredAt.toISOString(),
      fatalities: accident.fatalities,
      injuriesTreatedAway: accident.injuriesTreatedAway,
      disablingTow: accident.disablingTow,
      citationIssued: accident.citationIssued,
      citationAt: iso(accident.citationAt),
    });
    const existing = await this.rowsForAccident(principal.companyId, accident.id);
    for (const substance of ['alcohol', 'drug'] as const) {
      const a = assessment[substance];
      const row = existing.find((r) => r.substance === substance);
      const required = a.required === 'yes';
      const reason = a.reasons[0] ?? null;
      if (!row) {
        if (!required) continue;
        const at = this.core.now();
        const number = await this.core.nextNumber(principal.companyId, 'drug_test');
        const id = this.core.newId('dat');
        const inserted = await this.db
          .insert(drugAlcoholTests)
          .values({
            id,
            companyId: principal.companyId,
            number,
            ownerId: accident.ownerId,
            ownerName: accident.ownerName,
            nextAction: `Schedule the post-accident ${substance} test`,
            nextActionDueOn: a.deadlineAt.slice(0, 10),
            isTest: accident.isTest,
            createdBy: this.core.actor(principal),
            createdAt: at,
            updatedAt: at,
            testType: 'post_accident',
            substance,
            driverId: accident.driverId,
            driverName: accident.driverName,
            accidentId: accident.id,
            accidentNumber: accident.number,
            required: true,
            requiredReason: reason,
            occurredAt: accident.occurredAt,
          })
          .onConflictDoNothing()
          .returning({ id: drugAlcoholTests.id });
        if (inserted.length > 0) {
          await this.core.write(principal, 'drug_test', { id, number }, 'drug_test_required', `Post-accident ${substance} test required for ${accident.number}`, {
            reason,
            at,
          });
          await this.core.write(principal, 'accident', accident, 'drug_test_required', `${capital(substance)} test ${number} required: ${reason ?? ''}`, { at });
        }
        continue;
      }
      const patch: Partial<typeof drugAlcoholTests.$inferInsert> = {};
      if (row.required !== required) patch.required = required;
      if (row.requiredReason !== reason) patch.requiredReason = reason;
      if (row.occurredAt?.getTime() !== accident.occurredAt.getTime()) patch.occurredAt = accident.occurredAt;
      if (row.driverId !== accident.driverId) {
        patch.driverId = accident.driverId;
        patch.driverName = accident.driverName;
      }
      if (Object.keys(patch).length === 0) continue;
      const at = this.core.now();
      await this.db
        .update(drugAlcoholTests)
        .set({ ...patch, version: row.version + 1, updatedAt: at })
        .where(eq(drugAlcoholTests.id, row.id));
      await this.core.write(
        principal,
        'drug_test',
        row,
        'drug_test_requirement_changed',
        required ? `Required again after the accident facts changed` : `No longer required after the accident facts changed`,
        { changes: changesOf(row as unknown as Record<string, unknown>, patch as Record<string, unknown>), reason, at },
      );
    }
  }

  /** A test that is not post-accident: random, pre-employment, reasonable suspicion, … */
  async create(principal: Principal, input: CreateDrugTestInput): Promise<SafetyDrugTest> {
    const [driver, owner] = await Promise.all([
      this.core.driver(principal.companyId, input.driverId),
      this.core.person(principal.companyId, input.ownerId),
    ]);
    if (input.testType === 'post_accident') {
      throw this.core.invalid('Post-accident tests are opened from the accident, which decides whether they are required');
    }
    const at = this.core.now();
    const number = await this.core.nextNumber(principal.companyId, 'drug_test');
    const id = this.core.newId('dat');
    await this.db.insert(drugAlcoholTests).values({
      id,
      companyId: principal.companyId,
      number,
      ...this.core.ownerOf(principal, owner),
      nextAction: input.nextAction ?? `Collect the ${DRUG_ALCOHOL_TEST_TYPE_LABEL[input.testType].toLowerCase()} ${input.substance} test`,
      nextActionDueOn: input.nextActionDueOn ?? this.core.dueIn(1),
      createdBy: this.core.actor(principal),
      createdAt: at,
      updatedAt: at,
      testType: input.testType,
      substance: input.substance,
      driverId: driver?.id ?? null,
      driverName: driver?.name ?? null,
      required: true,
      requiredReason: `${DRUG_ALCOHOL_TEST_TYPE_LABEL[input.testType]} test`,
      scheduledAt: toDate(input.scheduledAt),
    });
    await this.core.write(principal, 'drug_test', { id, number }, 'drug_test_created', `${DRUG_ALCOHOL_TEST_TYPE_LABEL[input.testType]} ${input.substance} test opened for ${driver?.name ?? 'driver'}`, { at });
    return this.toTest(await this.row(principal.companyId, id), principal);
  }

  async update(principal: Principal, id: string, input: UpdateDrugTestInput): Promise<SafetyDrugTest> {
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    const touchesRestricted =
      input.result !== undefined || input.notCompletedReason !== undefined || input.lateReason !== undefined || input.collectedAt !== undefined;
    if (touchesRestricted && !hasPermission(principal, 'safety_testing.manage')) {
      throw this.core.forbidden('Recording a collection, a result or a reason takes safety_testing.manage');
    }
    const patch: Partial<typeof drugAlcoholTests.$inferInsert> = {};
    if (input.scheduledAt !== undefined) patch.scheduledAt = toDate(input.scheduledAt);
    if (input.collectedAt !== undefined) {
      const collected = toDate(input.collectedAt);
      const limit = collectionLimit({ substance: row.substance as TestSubstance, testType: row.testType as DrugAlcoholTestType, occurredAt: iso(row.occurredAt) });
      if (collected && limit && collected.getTime() > Date.parse(limit)) {
        throw this.core.invalid(
          `A post-accident ${row.substance} test may not be collected after ${limit} (${row.substance === 'alcohol' ? 8 : 32} hours). Stop attempting and document why it was not given.`,
        );
      }
      if (collected && collected.getTime() > this.core.now().getTime() + 5 * 60_000) {
        throw this.core.invalid('The collection time is in the future');
      }
      patch.collectedAt = collected;
    }
    if (input.result !== undefined && input.result !== row.result) {
      if (input.result !== 'pending' && input.result !== 'refused' && input.result !== 'cancelled' && !(patch.collectedAt ?? row.collectedAt)) {
        throw this.core.invalid('Record when the specimen was collected before its result');
      }
      patch.result = input.result;
      patch.resultAt = input.result === 'pending' ? null : this.core.now();
    }
    if (input.notCompletedReason !== undefined) patch.notCompletedReason = input.notCompletedReason ?? null;
    if (input.lateReason !== undefined) patch.lateReason = input.lateReason ?? null;
    if (input.ownerId !== undefined) {
      const owner = await this.core.person(principal.companyId, input.ownerId);
      patch.ownerId = owner?.id ?? null;
      patch.ownerName = owner?.name ?? null;
    }
    if (input.nextAction !== undefined) patch.nextAction = input.nextAction ?? null;
    if (input.nextActionDueOn !== undefined) patch.nextActionDueOn = input.nextActionDueOn ?? null;
    // A changed exception is a new exception: the old review no longer covers it.
    if ((patch.notCompletedReason !== undefined && patch.notCompletedReason !== row.notCompletedReason) || (patch.result && ['refused', 'cancelled'].includes(patch.result))) {
      patch.exceptionReviewedAt = null;
      patch.exceptionReviewedBy = null;
    }
    const at = this.core.now();
    const updated = await this.db
      .update(drugAlcoholTests)
      .set({ ...patch, version: row.version + 1, updatedAt: at })
      .where(and(eq(drugAlcoholTests.id, row.id), eq(drugAlcoholTests.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    const next = updated[0] as DrugAlcoholTestRow;
    const status = this.statusOf(next);
    if (status.nextAction !== row.nextAction && input.nextAction === undefined) {
      await this.db.update(drugAlcoholTests).set({ nextAction: status.nextAction }).where(eq(drugAlcoholTests.id, row.id));
    }
    // The audit line names what moved but never the result itself: the timeline is read by people
    // who may not see results. The before/after values are in `changes`, which only the audit log
    // (administrators) shows.
    const moved = changesOf(row as unknown as Record<string, unknown>, patch as Record<string, unknown>);
    await this.core.write(principal, 'drug_test', row, 'drug_test_updated', `Updated ${moved.map((c) => humanField(c.field)).join(', ') || 'the test'}`, {
      changes: moved,
      at,
    });
    return this.toTest(await this.row(principal.companyId, id), principal);
  }

  /**
   * A random test submitted from the driver's Documents tab (owner, 2026-10-24): the test record
   * with its collection date and result, and the paper filed in the driver's qualification file
   * as a "Random drug test" document. The result lives only on the test, where it is restricted;
   * the document carries the date and the file, never the result.
   */
  async recordRandom(
    principal: Principal,
    input: RecordRandomDrugTestInput,
  ): Promise<{ test: SafetyDrugTest; document: ComplianceDocument }> {
    if (!hasPermission(principal, 'safety_testing.manage')) {
      throw this.core.forbidden('Recording a test result takes safety_testing.manage');
    }
    const driver = await this.core.driver(principal.companyId, input.driverId);
    if (!driver) throw this.core.invalid('Choose the driver');
    if (input.collectedOn > this.core.today()) throw this.core.invalid('The collection date is in the future');
    const substance = (input.substance ?? 'drug') as TestSubstance;
    const at = this.core.now();
    const number = await this.core.nextNumber(principal.companyId, 'drug_test');
    const id = this.core.newId('dat');
    // Noon Eastern on the collection day: the form asks for a date, the column holds an instant.
    const collectedAt = new Date(`${input.collectedOn}T12:00:00-05:00`);
    const resultRecorded = input.result !== 'pending';
    await this.db.insert(drugAlcoholTests).values({
      id,
      companyId: principal.companyId,
      number,
      ...this.core.ownerOf(principal, null),
      nextAction: resultRecorded ? null : `Record the ${substance} result`,
      nextActionDueOn: resultRecorded ? null : this.core.dueIn(3),
      createdBy: this.core.actor(principal),
      createdAt: at,
      updatedAt: at,
      testType: 'random',
      substance,
      driverId: driver.id,
      driverName: driver.name,
      required: true,
      requiredReason: `${DRUG_ALCOHOL_TEST_TYPE_LABEL.random} test`,
      collectedAt,
      result: input.result,
      resultAt: resultRecorded ? at : null,
      notCompletedReason: input.result === 'refused' || input.result === 'cancelled' ? (input.notes ?? null) : null,
    });
    const { document } = await this.compliance.upload(principal, {
      ownerType: 'driver',
      ownerId: driver.id,
      ownerLabel: driver.name,
      requirementCode: 'random_drug_test',
      title: `Random ${substance} test ${number}`,
      fileName: input.fileName,
      contentType: input.contentType,
      sizeBytes: Math.floor((input.content.length * 3) / 4),
      issuedOn: input.collectedOn,
      expiresOn: null,
      source: 'staff',
      notes: `${number}${input.notes ? ` · ${input.notes}` : ''}`,
      bytes: Buffer.from(input.content, 'base64'),
      at,
    });
    // The audit line names the test and the date, never the result: the timeline is read by
    // people who may not see results; the before/after values are in `changes` (audit log only).
    await this.core.write(principal, 'drug_test', { id, number }, 'drug_test_created', `Random ${substance} test collected ${input.collectedOn} recorded for ${driver.name}; paper filed as ${document.id}`, {
      changes: [
        { field: 'collectedAt', old: null, new: collectedAt.toISOString() },
        { field: 'result', old: null, new: input.result },
        { field: 'documentId', old: null, new: document.id },
      ],
      at,
    });
    return { test: this.toTest(await this.row(principal.companyId, id), principal), document };
  }

  /** The authorised Safety review of a missed, refused or could-not-complete test. */
  async reviewException(principal: Principal, id: string, input: ReviewTestExceptionInput): Promise<SafetyDrugTest> {
    if (!hasPermission(principal, 'safety_testing.manage') || !hasPermission(principal, 'safety.manage')) {
      throw this.core.forbidden('Reviewing a testing exception takes safety.manage and safety_testing.manage');
    }
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    const status = this.statusOf(row);
    if (status.progress !== 'not_completed') {
      throw this.core.refused('Only a test that was missed, refused or could not be completed is reviewed as an exception');
    }
    if (!row.notCompletedReason) {
      throw this.core.refused('Document why the test was not completed before reviewing it', ['A documented reason']);
    }
    const at = this.core.now();
    const updated = await this.db
      .update(drugAlcoholTests)
      .set({
        exceptionReviewedAt: at,
        exceptionReviewedBy: this.core.actor(principal),
        exceptionNote: input.note,
        nextAction: null,
        version: row.version + 1,
        updatedAt: at,
      })
      .where(and(eq(drugAlcoholTests.id, row.id), eq(drugAlcoholTests.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    await this.core.write(principal, 'drug_test', row, 'drug_test_exception_reviewed', 'Testing exception reviewed by Safety', { at });
    if (row.accidentId) {
      await this.core.write(principal, 'accident', { id: row.accidentId, number: row.accidentNumber ?? '' }, 'drug_test_exception_reviewed', `${row.number}: testing exception reviewed by Safety`, { at });
    }
    return this.toTest(updated[0] as DrugAlcoholTestRow, principal);
  }

  async void(principal: Principal, id: string, input: VoidInput): Promise<SafetyDrugTest> {
    if (!hasPermission(principal, 'safety_testing.manage')) {
      throw this.core.forbidden('Voiding a test takes safety_testing.manage');
    }
    const row = await this.row(principal.companyId, id);
    this.core.checkWritable(row.number, row, input.version);
    if (row.testType === 'post_accident' && row.required && !this.statusOf(row).resolved) {
      throw this.core.refused('A required post-accident test cannot be voided while unresolved; document why it was not completed instead');
    }
    const at = this.core.now();
    const updated = await this.db
      .update(drugAlcoholTests)
      .set({ voidedAt: at, voidedBy: this.core.actor(principal), voidReason: input.reason, version: row.version + 1, updatedAt: at })
      .where(and(eq(drugAlcoholTests.id, row.id), eq(drugAlcoholTests.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(row.number, row);
    await this.core.write(principal, 'drug_test', row, 'drug_test_voided', `Voided ${row.number}`, { reason: input.reason, at });
    return this.toTest(updated[0] as DrugAlcoholTestRow, principal);
  }
}

/** Status without anything that reveals a result. */
function redactStatus(status: ReturnType<typeof testStatus>): ReturnType<typeof testStatus> {
  const hidden = status.progress === 'result_recorded' || status.progress === 'not_completed' || status.progress === 'exception_reviewed';
  return {
    ...status,
    progress: hidden ? (status.resolved ? 'result_recorded' : 'result_pending') : status.progress,
    blockers: status.blockers.map(() => 'Restricted: Safety is working on this test'),
    nextAction: status.nextAction && hidden ? 'Restricted' : status.nextAction,
  };
}

function capital(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

function humanField(field: string): string {
  return field.replace(/([A-Z])/g, ' $1').toLowerCase();
}
