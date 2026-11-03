import { Injectable } from '@nestjs/common';
import { and, asc, desc, eq, gt, gte, isNull, lt, ne } from 'drizzle-orm';
import {
  RETURN_DRUG_TEST_AFTER_DAYS,
  type ApproveVacationReturnInput,
  type AttributeVacationExpenseInput,
  type DriverVacationView,
  type ScheduleVacationTestInput,
  type SafetyDocument,
  type VacationReturnDetail,
  type VacationReturnExpense,
  type VacationReturnList,
  type VacationReturnRow,
  type VacationReturnState,
} from '@neway/shared';
import { hasPermission, type Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import { acctExpenses } from '../../database/schema/accounting';
import { drivers } from '../../database/schema/roster';
import { drugAlcoholTests, safetyReviews, type SafetyReviewRow } from '../../database/schema/safety';
import { VacationsService } from '../roster/vacations.service';
import { SafetyReviewsService } from './reviews.service';
import { SafetyCoreService } from './safety-core.service';
import { DrugTestsService } from './tests.service';

type TestRow = typeof drugAlcoholTests.$inferSelect;

/**
 * Vacation return reviews (owner, 2026-10-17). COMPANY POLICY: a driver away 30+ days is drug
 * tested before the next load and Safety records the clearance. Reuses the review (kind
 * vacation_return, linked to the vacation) and the drug test (type vacation_return) - no new case
 * type. An appointment is not a result, an uploaded result is not an approval, and the cost is an
 * existing Accounting expense pointed at, never one made here. Clearance is shown, not enforced on
 * load assignment (owner decision).
 */
@Injectable()
export class VacationReturnsService {
  constructor(
    private readonly database: DatabaseService,
    private readonly core: SafetyCoreService,
    private readonly reviews: SafetyReviewsService,
    private readonly tests: DrugTestsService,
    private readonly vacations: VacationsService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private async reviewFor(companyId: string, vacationId: string): Promise<SafetyReviewRow | null> {
    const [row] = await this.db
      .select()
      .from(safetyReviews)
      .where(and(eq(safetyReviews.companyId, companyId), eq(safetyReviews.kind, 'vacation_return'), eq(safetyReviews.linkedType, 'vacation'), eq(safetyReviews.linkedId, vacationId), isNull(safetyReviews.voidedAt)))
      .limit(1);
    return row ?? null;
  }

  /**
   * The vacation-return test for this vacation. A test is only ever opened through this vacation's
   * review (Schedule test opens the review first), so it is the newest live vacation_return test of
   * the driver opened after this review and before the driver's next vacation-return review.
   */
  private async testFor(companyId: string, v: DriverVacationView, review: SafetyReviewRow | null): Promise<TestRow | null> {
    if (!review) return null;
    const [next] = await this.db
      .select({ at: safetyReviews.createdAt })
      .from(safetyReviews)
      .where(and(eq(safetyReviews.companyId, companyId), eq(safetyReviews.kind, 'vacation_return'), eq(safetyReviews.driverId, v.driverId), gt(safetyReviews.createdAt, review.createdAt)))
      .orderBy(asc(safetyReviews.createdAt))
      .limit(1);
    const [row] = await this.db
      .select()
      .from(drugAlcoholTests)
      .where(
        and(
          eq(drugAlcoholTests.companyId, companyId),
          eq(drugAlcoholTests.driverId, v.driverId),
          eq(drugAlcoholTests.testType, 'vacation_return'),
          isNull(drugAlcoholTests.voidedAt),
          gte(drugAlcoholTests.createdAt, review.createdAt),
          ...(next ? [lt(drugAlcoholTests.createdAt, next.at)] : []),
        ),
      )
      .orderBy(desc(drugAlcoholTests.createdAt))
      .limit(1);
    return row ?? null;
  }

  private stateOf(review: SafetyReviewRow | null, test: TestRow | null): VacationReturnState {
    if (review?.status === 'completed') return 'cleared';
    if (!test || test.result === 'cancelled') return 'test_required';
    if (test.result === 'positive' || test.result === 'refused') return 'not_cleared';
    if (test.result === 'negative') return 'result_received';
    if (test.collectedAt) return 'result_pending';
    if (test.scheduledAt) return 'appointment_scheduled';
    return 'test_required';
  }

  private async rowOf(principal: Principal, v: DriverVacationView): Promise<VacationReturnRow & { review: SafetyReviewRow | null; test: TestRow | null }> {
    const review = await this.reviewFor(principal.companyId, v.id);
    const test = await this.testFor(principal.companyId, v, review);
    return { vacation: v, reviewId: review?.id ?? null, reviewNumber: review?.number ?? null, state: this.stateOf(review, test), review, test };
  }

  async list(principal: Principal): Promise<VacationReturnList> {
    const vacations = await this.vacations.longVacations(principal, RETURN_DRUG_TEST_AFTER_DAYS);
    const rows = await Promise.all(vacations.map((v) => this.rowOf(principal, v)));
    const today = new Date();
    const weekAgo = new Date(today.getTime() - 7 * 86_400_000);
    return {
      today: today.toISOString().slice(0, 10),
      rows: rows.map(({ vacation, reviewId, reviewNumber, state }) => ({ vacation, reviewId, reviewNumber, state })),
      counts: {
        awaitingReview: rows.filter((r) => r.state !== 'cleared').length,
        testPending: rows.filter((r) => r.state === 'test_required' || r.state === 'appointment_scheduled' || r.state === 'result_pending').length,
        clearedThisWeek: rows.filter((r) => r.state === 'cleared' && r.review?.completedAt && r.review.completedAt >= weekAgo).length,
      },
    };
  }

  async detail(principal: Principal, vacationId: string): Promise<VacationReturnDetail> {
    const v = await this.vacations.one(principal, vacationId);
    const { review, test, ...row } = await this.rowOf(principal, v);
    const seesResults = hasPermission(principal, 'safety_testing.view');
    const documents: SafetyDocument[] = [];
    if (review) documents.push(...(await this.core.documents(principal.companyId, 'safety_review', review.id)));
    if (test && seesResults) documents.push(...(await this.core.documents(principal.companyId, 'drug_test', test.id)));
    const history = [
      ...(review ? await this.core.timeline(principal, 'safety_review', review.id) : []),
      ...(test ? await this.core.timeline(principal, 'drug_test', test.id) : []),
    ].sort((a, b) => b.at.localeCompare(a.at));
    const expense = review?.accountingExpenseId ? await this.expense(principal, review.accountingExpenseId) : null;
    const documentProblems = await this.documentProblems(principal.companyId, v.driverId);
    return {
      ...row,
      reviewVersion: review?.version ?? null,
      test: test ? this.tests.toTest(test, principal) : null,
      documents,
      completedAt: review?.completedAt?.toISOString() ?? null,
      completedBy: review?.completedBy ?? null,
      outcome: review?.outcome ?? null,
      expense: expense === 'restricted' ? null : expense,
      expenseRestricted: expense === 'restricted',
      history,
      documentProblems,
      approveBlockers: [...this.blockers(review, test), ...(review?.status === 'completed' ? [] : documentProblems)],
    };
  }

  /** The driver's CDL and medical card in date today (owner mockup 2026-10-19: "Documents valid"). */
  private async documentProblems(companyId: string, driverId: string): Promise<string[]> {
    const [d] = await this.db
      .select({ cdl: drivers.cdlExpiresOn, medical: drivers.medicalCardExpiresOn })
      .from(drivers)
      .where(and(eq(drivers.companyId, companyId), eq(drivers.id, driverId)))
      .limit(1);
    if (!d) return ['The driver record is missing'];
    const today = this.core.today();
    const out: string[] = [];
    if (!d.cdl || d.cdl < today) out.push(d.cdl ? `CDL expired ${d.cdl}` : 'No CDL expiry on file');
    if (!d.medical || d.medical < today) out.push(d.medical ? `Medical card expired ${d.medical}` : 'No medical card expiry on file');
    return out;
  }

  private blockers(review: SafetyReviewRow | null, test: TestRow | null): string[] {
    if (review?.status === 'completed') return ['Already cleared'];
    const out: string[] = [];
    if (!test) out.push('No vacation-return test on file');
    else if (test.result !== 'negative') out.push(test.collectedAt ? 'The test result is not recorded as negative' : 'The test has not been collected');
    return out;
  }

  private async expense(principal: Principal, id: string): Promise<VacationReturnExpense | 'restricted' | null> {
    if (!hasPermission(principal, 'accounting.view')) return 'restricted';
    const [e] = await this.db.select().from(acctExpenses).where(and(eq(acctExpenses.companyId, principal.companyId), eq(acctExpenses.id, id))).limit(1);
    if (!e) return null;
    const r = e.record as Record<string, unknown>;
    return {
      id: e.id,
      expenseNumber: String(r.expenseNumber ?? e.id),
      onDate: e.onDate,
      description: String(r.description ?? ''),
      amountCents: Number(e.amountCents),
      status: e.status,
      payer: typeof r.payer === 'string' ? r.payer : null,
      burden: e.burden,
      vendorName: typeof r.vendorName === 'string' ? r.vendorName : null,
    };
  }

  /** Opens the review (once) and the vacation-return test (once), scheduled when a time is given. */
  async scheduleTest(principal: Principal, vacationId: string, input: ScheduleVacationTestInput): Promise<VacationReturnDetail> {
    const v = await this.vacations.one(principal, vacationId);
    if (v.state === 'cancelled') throw this.core.refused('This vacation was cancelled');
    if (v.daysAway < RETURN_DRUG_TEST_AFTER_DAYS) throw this.core.refused(`The company test applies from ${RETURN_DRUG_TEST_AFTER_DAYS} days away`);
    await this.reviews.openLinked(principal, {
      kind: 'vacation_return',
      reason: `Vacation return: ${v.daysAway} days away (company policy)`,
      driver: { id: v.driverId, name: v.driverName },
      linkedType: 'vacation',
      linked: { id: v.id, number: `Vacation ${v.startedOn}` },
    });
    const existing = await this.testFor(principal.companyId, v, await this.reviewFor(principal.companyId, v.id));
    if (!existing || existing.result === 'cancelled') {
      await this.tests.create(principal, { testType: 'vacation_return', substance: 'drug', driverId: v.driverId, scheduledAt: input.scheduledAt ?? null });
    } else if (input.scheduledAt && !existing.collectedAt) {
      await this.tests.update(principal, existing.id, { version: existing.version, scheduledAt: input.scheduledAt });
    }
    return this.detail(principal, vacationId);
  }

  /** Safety's approval: only with a negative vacation-return test on file; recorded on the review. */
  async approve(principal: Principal, vacationId: string, input: ApproveVacationReturnInput): Promise<VacationReturnDetail> {
    const v = await this.vacations.one(principal, vacationId);
    const review = await this.reviewFor(principal.companyId, v.id);
    const test = await this.testFor(principal.companyId, v, review);
    if (!review) throw this.core.refused('Open the review first: schedule the vacation-return test');
    const blockers = [...this.blockers(review, test), ...(await this.documentProblems(principal.companyId, v.driverId))];
    if (blockers.length > 0) throw this.core.refused('The driver cannot be cleared yet', blockers);
    await this.reviews.complete(principal, review.id, { version: input.version, outcome: `Vacation return cleared: ${input.outcome}` });
    return this.detail(principal, vacationId);
  }

  /** Points the review at an existing Accounting expense (or clears it). Nothing is posted. */
  async attributeExpense(principal: Principal, vacationId: string, input: AttributeVacationExpenseInput): Promise<VacationReturnDetail> {
    const v = await this.vacations.one(principal, vacationId);
    const review = await this.reviewFor(principal.companyId, v.id);
    if (!review) throw this.core.refused('Open the review first: schedule the vacation-return test');
    if (input.expenseId) {
      const [e] = await this.db.select().from(acctExpenses).where(and(eq(acctExpenses.companyId, principal.companyId), eq(acctExpenses.id, input.expenseId))).limit(1);
      if (!e) throw this.core.invalid('No such Accounting expense');
      if (e.status === 'void') throw this.core.invalid('That expense is void');
      const [taken] = await this.db
        .select({ number: safetyReviews.number })
        .from(safetyReviews)
        .where(and(eq(safetyReviews.companyId, principal.companyId), eq(safetyReviews.accountingExpenseId, input.expenseId), ne(safetyReviews.id, review.id), isNull(safetyReviews.voidedAt)))
        .limit(1);
      if (taken) throw this.core.refused(`That expense is already linked to ${taken.number}`);
    }
    const at = this.core.now();
    const updated = await this.db
      .update(safetyReviews)
      .set({ accountingExpenseId: input.expenseId, version: review.version + 1, updatedAt: at })
      .where(and(eq(safetyReviews.id, review.id), eq(safetyReviews.version, input.version)))
      .returning();
    if (updated.length === 0) throw this.core.stale(review.number, review);
    await this.core.write(principal, 'safety_review', review, input.expenseId ? 'safety_review_expense_linked' : 'safety_review_expense_unlinked', input.expenseId ? 'Accounting expense linked to the vacation-return review' : 'Accounting expense unlinked', {
      at,
      changes: [{ field: 'accounting_expense_id', old: review.accountingExpenseId, new: input.expenseId }],
    });
    return this.detail(principal, vacationId);
  }
}
