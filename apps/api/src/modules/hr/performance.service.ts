import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, inArray, isNull, not, or, sql } from 'drizzle-orm';
import {
  REVIEW_TRANSITIONS,
  goalIsBehind,
  goalProgress,
  type ActionPlanRecord,
  type ActionPlanStatus,
  type ChangeReviewStatusRequest,
  type CreateActionPlanRequest,
  type CreateFeedbackRequest,
  type CreatePerformanceCycleRequest,
  type CreatePerformanceGoalRequest,
  type CreatePerformanceReviewRequest,
  type GoalStatus,
  type PerformanceCycleRecord,
  type PerformanceFeedbackRecord,
  type PerformanceGoalRecord,
  type PerformanceQuery,
  type PerformanceReviewRecord,
  type ReviewStatus,
  type UpdateActionPlanRequest,
  type UpdateGoalProgressRequest,
  type UpdatePerformanceReviewRequest,
  type WorkforcePerformanceSummary,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import {
  performanceActionPlans,
  performanceCycles,
  performanceFeedback,
  performanceGoals,
  performanceReviews,
} from '../../database/schema/hr';
import { employees } from '../../database/schema/people';
import { AuditService } from '../people/audit.service';
import { hrReach, num, today, assertCompanyRefs, employeeRef } from './hr.util';

/**
 * Performance.
 *
 * A completed review can only be reopened with a stated reason, and the change is audited — an
 * employment record that can be quietly rewritten after the fact is worth nothing in a dispute.
 * Ratings and goal progress are `null` until somebody supplies them; nothing here defaults a
 * judgement about a person to zero.
 */
@Injectable()
export class PerformanceService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
  ) {}

  private get db() {
    return this.database.db;
  }

  // ------------------------------------------------------------------------------------ cycles

  async listCycles(principal: Principal): Promise<PerformanceCycleRecord[]> {
    const rows = await this.db
      .select()
      .from(performanceCycles)
      .where(eq(performanceCycles.companyId, principal.companyId))
      .orderBy(desc(performanceCycles.periodStart));
    return rows.map((row) => ({
      id: row.id,
      name: row.name,
      kind: row.kind as PerformanceCycleRecord['kind'],
      periodStart: row.periodStart,
      periodEnd: row.periodEnd,
      reviewsDueOn: row.reviewsDueOn,
      status: row.status as PerformanceCycleRecord['status'],
    }));
  }

  async createCycle(
    principal: Principal,
    input: CreatePerformanceCycleRequest,
  ): Promise<PerformanceCycleRecord[]> {
    const id = `cyc_${crypto.randomUUID()}`;
    await this.db.insert(performanceCycles).values({
      id,
      companyId: principal.companyId,
      name: input.name,
      kind: input.kind,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      reviewsDueOn: input.reviewsDueOn,
      status: input.periodStart <= today() && input.periodEnd >= today() ? 'active' : 'planned',
    });
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'performance_cycle',
      entityId: id,
      entityLabel: input.name,
      summary: `Cycle ${input.name} created (${input.periodStart} to ${input.periodEnd})`,
    });
    return this.listCycles(principal);
  }

  // ------------------------------------------------------------------------------------- goals

  private goalSelect() {
    return {
      goal: performanceGoals,
      first: employees.firstName,
      last: employees.lastName,
      employeeNumber: employees.employeeNumber,
      department: employees.department,
      cycleName: performanceCycles.name,
    };
  }

  private toGoal(row: {
    goal: typeof performanceGoals.$inferSelect;
    first: string | null;
    last: string | null;
    employeeNumber: string | null;
    department: string | null;
    cycleName: string | null;
  }): PerformanceGoalRecord {
    const g = row.goal;
    return {
      id: g.id,
      employeeId: g.employeeId,
      employeeName: `${row.first ?? ''} ${row.last ?? ''}`.trim(),
      employeeNumber: row.employeeNumber ?? '',
      department: (row.department ?? 'dispatch') as PerformanceGoalRecord['department'],
      cycleId: g.cycleId,
      cycleName: row.cycleName,
      title: g.title,
      description: g.description,
      category: g.category as PerformanceGoalRecord['category'],
      measure: g.measure as PerformanceGoalRecord['measure'],
      targetValue: num(g.targetValue),
      currentValue: num(g.currentValue),
      unit: g.unit,
      startDate: g.startDate,
      dueDate: g.dueDate,
      status: g.status as GoalStatus,
      notes: g.notes,
      createdAt: g.createdAt.toISOString(),
    };
  }

  async listGoals(
    principal: Principal,
    query: PerformanceQuery,
  ): Promise<{ data: PerformanceGoalRecord[]; total: number; page: number; pageSize: number }> {
    const parts = [eq(performanceGoals.companyId, principal.companyId), hrReach(principal, 'performance.manage', performanceGoals.employeeId)];
    if (query.employeeId) parts.push(eq(performanceGoals.employeeId, query.employeeId));
    if (query.department) parts.push(eq(employees.department, query.department));
    if (query.cycleId) parts.push(eq(performanceGoals.cycleId, query.cycleId));
    if (query.goalStatus) parts.push(eq(performanceGoals.status, query.goalStatus));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(
        ilike(performanceGoals.title, term),
        ilike(employees.firstName, term),
        ilike(employees.lastName, term),
      );
      if (match) parts.push(match);
    }
    const where = and(...parts);

    const [counted] = await this.db
      .select({ value: count() })
      .from(performanceGoals)
      .innerJoin(employees, and(eq(performanceGoals.employeeId, employees.id), eq(employees.companyId, performanceGoals.companyId)))
      .where(where);

    const column = {
      employeeName: employees.lastName,
      dueDate: performanceGoals.dueDate,
      status: performanceGoals.status,
    }[query.sort];
    const direction = query.sortDir === 'desc' ? desc : asc;

    const rows = await this.db
      .select(this.goalSelect())
      .from(performanceGoals)
      .innerJoin(employees, and(eq(performanceGoals.employeeId, employees.id), eq(employees.companyId, performanceGoals.companyId)))
      .leftJoin(performanceCycles, and(eq(performanceGoals.cycleId, performanceCycles.id), eq(performanceCycles.companyId, performanceGoals.companyId)))
      .where(where)
      .orderBy(direction(column))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      data: rows.map((r) => this.toGoal(r)),
      total: counted?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async createGoal(
    principal: Principal,
    input: CreatePerformanceGoalRequest,
  ): Promise<PerformanceGoalRecord> {
    await assertCompanyRefs(this.db, principal.companyId, [employeeRef(input.employeeId), { table: performanceCycles, idColumn: performanceCycles.id, companyColumn: performanceCycles.companyId, id: input.cycleId, label: 'review cycle' }]);
    const id = `gol_${crypto.randomUUID()}`;
    await this.db.insert(performanceGoals).values({
      id,
      companyId: principal.companyId,
      employeeId: input.employeeId,
      cycleId: input.cycleId,
      title: input.title,
      description: input.description,
      category: input.category,
      measure: input.measure,
      targetValue: input.targetValue === null ? null : String(input.targetValue),
      currentValue: input.currentValue === null ? null : String(input.currentValue),
      unit: input.unit,
      startDate: input.startDate,
      dueDate: input.dueDate,
      status: 'not_started',
      notes: input.notes,
    });
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'performance_goal',
      entityId: id,
      entityLabel: input.title,
      summary: `Goal set: ${input.title}, due ${input.dueDate}`,
    });
    return this.getGoal(principal, id);
  }

  async getGoal(principal: Principal, id: string): Promise<PerformanceGoalRecord> {
    const [row] = await this.db
      .select(this.goalSelect())
      .from(performanceGoals)
      .innerJoin(employees, and(eq(performanceGoals.employeeId, employees.id), eq(employees.companyId, performanceGoals.companyId)))
      .leftJoin(performanceCycles, and(eq(performanceGoals.cycleId, performanceCycles.id), eq(performanceCycles.companyId, performanceGoals.companyId)))
      .where(and(eq(performanceGoals.companyId, principal.companyId), eq(performanceGoals.id, id), hrReach(principal, 'performance.manage', performanceGoals.employeeId)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No goal ${id}` });
    return this.toGoal(row);
  }

  async updateGoal(
    principal: Principal,
    id: string,
    patch: UpdateGoalProgressRequest,
  ): Promise<PerformanceGoalRecord> {
    const before = await this.getGoal(principal, id);
    await this.db
      .update(performanceGoals)
      .set({
        ...(patch.currentValue !== undefined
          ? { currentValue: patch.currentValue === null ? null : String(patch.currentValue) }
          : {}),
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        updatedAt: new Date(),
      })
      .where(eq(performanceGoals.id, id));

    const changes = [
      ...(patch.currentValue !== undefined
        ? [
            {
              field: 'progress',
              old: before.currentValue === null ? null : String(before.currentValue),
              new: patch.currentValue === null ? null : String(patch.currentValue),
            },
          ]
        : []),
      ...(patch.status !== undefined && patch.status !== before.status
        ? [{ field: 'status', old: before.status, new: patch.status }]
        : []),
    ];
    if (changes.length > 0) {
      await this.audit.write(principal, {
        action: 'update',
        entityType: 'performance_goal',
        entityId: id,
        entityLabel: before.title,
        summary: `Goal updated: ${before.title}`,
        changes,
      });
    }
    return this.getGoal(principal, id);
  }

  // ----------------------------------------------------------------------------------- reviews

  private reviewSelect() {
    const reviewer = sql`reviewer`;
    return {
      review: performanceReviews,
      first: employees.firstName,
      last: employees.lastName,
      employeeNumber: employees.employeeNumber,
      department: employees.department,
      position: employees.position,
      reviewerFirst: sql<string | null>`${reviewer}.first_name`,
      reviewerLast: sql<string | null>`${reviewer}.last_name`,
      cycleName: performanceCycles.name,
    };
  }

  private toReview(row: {
    review: typeof performanceReviews.$inferSelect;
    first: string | null;
    last: string | null;
    employeeNumber: string | null;
    department: string | null;
    position: string | null;
    reviewerFirst: string | null;
    reviewerLast: string | null;
    cycleName: string | null;
  }): PerformanceReviewRecord {
    const r = row.review;
    return {
      id: r.id,
      employeeId: r.employeeId,
      employeeName: `${row.first ?? ''} ${row.last ?? ''}`.trim(),
      employeeNumber: row.employeeNumber ?? '',
      department: (row.department ?? 'dispatch') as PerformanceReviewRecord['department'],
      position: row.position ?? '',
      reviewerEmployeeId: r.reviewerEmployeeId,
      reviewerName: row.reviewerFirst
        ? `${row.reviewerFirst} ${row.reviewerLast ?? ''}`.trim()
        : null,
      cycleId: r.cycleId,
      cycleName: row.cycleName,
      periodStart: r.periodStart,
      periodEnd: r.periodEnd,
      rating: r.rating,
      summary: r.summary,
      strengths: r.strengths,
      developmentAreas: r.developmentAreas,
      managerFeedback: r.managerFeedback,
      employeeComments: r.employeeComments,
      status: r.status as ReviewStatus,
      submittedAt: r.submittedAt?.toISOString() ?? null,
      acknowledgedAt: r.acknowledgedAt?.toISOString() ?? null,
      createdAt: r.createdAt.toISOString(),
    };
  }

  async listReviews(
    principal: Principal,
    query: PerformanceQuery,
  ): Promise<{ data: PerformanceReviewRecord[]; total: number; page: number; pageSize: number }> {
    const parts = [eq(performanceReviews.companyId, principal.companyId), hrReach(principal, 'performance.manage', performanceReviews.employeeId)];
    if (query.employeeId) parts.push(eq(performanceReviews.employeeId, query.employeeId));
    if (query.department) parts.push(eq(employees.department, query.department));
    if (query.cycleId) parts.push(eq(performanceReviews.cycleId, query.cycleId));
    if (query.reviewStatus) parts.push(eq(performanceReviews.status, query.reviewStatus));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(ilike(employees.firstName, term), ilike(employees.lastName, term));
      if (match) parts.push(match);
    }
    const where = and(...parts);

    const [counted] = await this.db
      .select({ value: count() })
      .from(performanceReviews)
      .innerJoin(employees, and(eq(performanceReviews.employeeId, employees.id), eq(employees.companyId, performanceReviews.companyId)))
      .where(where);

    const rows = await this.db
      .select(this.reviewSelect())
      .from(performanceReviews)
      .innerJoin(employees, and(eq(performanceReviews.employeeId, employees.id), eq(employees.companyId, performanceReviews.companyId)))
      .leftJoin(
        sql`${employees} as reviewer`,
        sql`reviewer.id = ${performanceReviews.reviewerEmployeeId} and reviewer.company_id = ${performanceReviews.companyId}`,
      )
      .leftJoin(performanceCycles, and(eq(performanceReviews.cycleId, performanceCycles.id), eq(performanceCycles.companyId, performanceReviews.companyId)))
      .where(where)
      .orderBy(desc(performanceReviews.periodEnd))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    return {
      data: rows.map((r) => this.toReview(r)),
      total: counted?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  async getReview(principal: Principal, id: string): Promise<PerformanceReviewRecord> {
    const [row] = await this.db
      .select(this.reviewSelect())
      .from(performanceReviews)
      .innerJoin(employees, and(eq(performanceReviews.employeeId, employees.id), eq(employees.companyId, performanceReviews.companyId)))
      .leftJoin(
        sql`${employees} as reviewer`,
        sql`reviewer.id = ${performanceReviews.reviewerEmployeeId} and reviewer.company_id = ${performanceReviews.companyId}`,
      )
      .leftJoin(performanceCycles, and(eq(performanceReviews.cycleId, performanceCycles.id), eq(performanceCycles.companyId, performanceReviews.companyId)))
      .where(
        and(eq(performanceReviews.companyId, principal.companyId), eq(performanceReviews.id, id), hrReach(principal, 'performance.manage', performanceReviews.employeeId)),
      )
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No review ${id}` });
    return this.toReview(row);
  }

  async createReview(
    principal: Principal,
    input: CreatePerformanceReviewRequest,
  ): Promise<PerformanceReviewRecord> {
    await assertCompanyRefs(this.db, principal.companyId, [employeeRef(input.employeeId), employeeRef(input.reviewerEmployeeId, 'reviewer'), { table: performanceCycles, idColumn: performanceCycles.id, companyColumn: performanceCycles.companyId, id: input.cycleId, label: 'review cycle' }]);
    const id = `rev_${crypto.randomUUID()}`;
    await this.db.insert(performanceReviews).values({
      id,
      companyId: principal.companyId,
      employeeId: input.employeeId,
      reviewerEmployeeId: input.reviewerEmployeeId,
      cycleId: input.cycleId,
      periodStart: input.periodStart,
      periodEnd: input.periodEnd,
      status: 'draft',
    });
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'performance_review',
      entityId: id,
      entityLabel: input.employeeId,
      summary: `Review opened for ${input.periodStart} to ${input.periodEnd}`,
    });
    return this.getReview(principal, id);
  }

  async updateReview(
    principal: Principal,
    id: string,
    patch: UpdatePerformanceReviewRequest,
  ): Promise<PerformanceReviewRecord> {
    const before = await this.getReview(principal, id);
    if (before.status === 'completed') {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'A completed review cannot be edited. Reopen it first, with a reason.',
      });
    }
    await this.db
      .update(performanceReviews)
      .set({
        ...(patch.rating !== undefined ? { rating: patch.rating } : {}),
        ...(patch.summary !== undefined ? { summary: patch.summary } : {}),
        ...(patch.strengths !== undefined ? { strengths: patch.strengths } : {}),
        ...(patch.developmentAreas !== undefined
          ? { developmentAreas: patch.developmentAreas }
          : {}),
        ...(patch.managerFeedback !== undefined ? { managerFeedback: patch.managerFeedback } : {}),
        ...(patch.employeeComments !== undefined
          ? { employeeComments: patch.employeeComments }
          : {}),
        updatedAt: new Date(),
      })
      .where(eq(performanceReviews.id, id));

    if (patch.rating !== undefined && patch.rating !== before.rating) {
      await this.audit.write(principal, {
        action: 'update',
        entityType: 'performance_review',
        entityId: id,
        entityLabel: before.employeeName,
        summary: `Rating set to ${patch.rating ?? '—'}`,
        changes: [
          {
            field: 'rating',
            old: before.rating === null ? null : String(before.rating),
            new: patch.rating === null ? null : String(patch.rating),
          },
        ],
      });
    }
    return this.getReview(principal, id);
  }

  async changeReviewStatus(
    principal: Principal,
    id: string,
    input: ChangeReviewStatusRequest,
  ): Promise<PerformanceReviewRecord> {
    const before = await this.getReview(principal, id);
    const reopening = before.status === 'completed';
    const allowed = REVIEW_TRANSITIONS[before.status] ?? [];

    if (!reopening && !allowed.includes(input.status)) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `A ${before.status.replace(/_/g, ' ')} review cannot become ${input.status.replace(/_/g, ' ')}`,
      });
    }
    if (reopening && !input.reason) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail:
          'Reopening a completed review must say why. The change is recorded against the employment record.',
      });
    }
    if (input.status === 'submitted' && before.rating === null) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'A review cannot be submitted without a rating.',
      });
    }

    await this.db
      .update(performanceReviews)
      .set({
        status: input.status,
        ...(input.status === 'submitted' ? { submittedAt: new Date() } : {}),
        ...(input.status === 'acknowledged' ? { acknowledgedAt: new Date() } : {}),
        updatedAt: new Date(),
      })
      .where(eq(performanceReviews.id, id));

    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'performance_review',
      entityId: id,
      entityLabel: before.employeeName,
      summary: `Review: ${before.status} → ${input.status}${reopening ? ' (reopened after completion)' : ''}`,
      changes: [{ field: 'status', old: before.status, new: input.status }],
      reason: input.reason,
    });
    return this.getReview(principal, id);
  }

  // ---------------------------------------------------------------------------------- feedback

  async listFeedback(
    principal: Principal,
    employeeId: string,
    canSeePrivate: boolean,
  ): Promise<PerformanceFeedbackRecord[]> {
    const parts = [
      eq(performanceFeedback.companyId, principal.companyId),
      eq(performanceFeedback.employeeId, employeeId),
      hrReach(principal, 'performance.manage', performanceFeedback.employeeId),
    ];
    // Manager-only notes are filtered in the query, not hidden in the UI: data that never leaves
    // the server cannot leak through a network tab.
    if (!canSeePrivate) parts.push(eq(performanceFeedback.visibility, 'shared'));

    const rows = await this.db
      .select()
      .from(performanceFeedback)
      .where(and(...parts))
      .orderBy(desc(performanceFeedback.at));

    return rows.map((row) => ({
      id: row.id,
      employeeId: row.employeeId,
      authorName: row.authorName,
      kind: row.kind as PerformanceFeedbackRecord['kind'],
      body: row.body,
      goalId: row.goalId,
      visibility: row.visibility as PerformanceFeedbackRecord['visibility'],
      at: row.at.toISOString(),
    }));
  }

  async addFeedback(
    principal: Principal,
    input: CreateFeedbackRequest,
  ): Promise<PerformanceFeedbackRecord[]> {
    await assertCompanyRefs(this.db, principal.companyId, [employeeRef(input.employeeId), { table: performanceGoals, idColumn: performanceGoals.id, companyColumn: performanceGoals.companyId, id: input.goalId, label: 'goal' }]);
    const id = `fbk_${crypto.randomUUID()}`;
    await this.db.insert(performanceFeedback).values({
      id,
      companyId: principal.companyId,
      employeeId: input.employeeId,
      authorName: principal.userName ?? principal.userId,
      kind: input.kind,
      body: input.body,
      goalId: input.goalId,
      visibility: input.visibility,
    });
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'performance_feedback',
      entityId: input.employeeId,
      entityLabel: input.employeeId,
      summary: `${input.kind} feedback recorded (${input.visibility.replace(/_/g, ' ')})`,
    });
    return this.listFeedback(principal, input.employeeId, true);
  }

  // ------------------------------------------------------------------------------ action plans

  async listActionPlans(principal: Principal, employeeId?: string): Promise<ActionPlanRecord[]> {
    const parts = [eq(performanceActionPlans.companyId, principal.companyId), hrReach(principal, 'performance.manage', performanceActionPlans.employeeId)];
    if (employeeId) parts.push(eq(performanceActionPlans.employeeId, employeeId));
    const owner = sql`owner`;
    const rows = await this.db
      .select({
        plan: performanceActionPlans,
        first: employees.firstName,
        last: employees.lastName,
        ownerFirst: sql<string | null>`${owner}.first_name`,
        ownerLast: sql<string | null>`${owner}.last_name`,
      })
      .from(performanceActionPlans)
      .innerJoin(employees, and(eq(performanceActionPlans.employeeId, employees.id), eq(employees.companyId, performanceActionPlans.companyId)))
      .leftJoin(
        sql`${employees} as owner`,
        sql`owner.id = ${performanceActionPlans.ownerEmployeeId} and owner.company_id = ${performanceActionPlans.companyId}`,
      )
      .where(and(...parts))
      .orderBy(asc(performanceActionPlans.dueDate));

    return rows.map(({ plan, first, last, ownerFirst, ownerLast }) => ({
      id: plan.id,
      employeeId: plan.employeeId,
      employeeName: `${first ?? ''} ${last ?? ''}`.trim(),
      ownerEmployeeId: plan.ownerEmployeeId,
      ownerName: ownerFirst ? `${ownerFirst} ${ownerLast ?? ''}`.trim() : null,
      issue: plan.issue,
      expectedOutcome: plan.expectedOutcome,
      actions: (plan.actions ?? []) as { title: string; done: boolean }[],
      startDate: plan.startDate,
      dueDate: plan.dueDate,
      reviewDate: plan.reviewDate,
      status: plan.status as ActionPlanStatus,
      notes: plan.notes,
      createdAt: plan.createdAt.toISOString(),
    }));
  }

  async createActionPlan(
    principal: Principal,
    input: CreateActionPlanRequest,
  ): Promise<ActionPlanRecord[]> {
    await assertCompanyRefs(this.db, principal.companyId, [employeeRef(input.employeeId), employeeRef(input.ownerEmployeeId, 'owner')]);
    const id = `pap_${crypto.randomUUID()}`;
    await this.db.insert(performanceActionPlans).values({
      id,
      companyId: principal.companyId,
      employeeId: input.employeeId,
      ownerEmployeeId: input.ownerEmployeeId,
      issue: input.issue,
      expectedOutcome: input.expectedOutcome,
      actions: input.actions,
      startDate: input.startDate,
      dueDate: input.dueDate,
      reviewDate: input.reviewDate,
      status: 'open',
      notes: input.notes,
    });
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'performance_action_plan',
      entityId: id,
      entityLabel: input.employeeId,
      summary: `Action plan opened, due ${input.dueDate}`,
    });
    return this.listActionPlans(principal, input.employeeId);
  }

  async updateActionPlan(
    principal: Principal,
    id: string,
    patch: UpdateActionPlanRequest,
  ): Promise<ActionPlanRecord[]> {
    const [existing] = await this.db
      .select()
      .from(performanceActionPlans)
      .where(
        and(
          eq(performanceActionPlans.companyId, principal.companyId),
          eq(performanceActionPlans.id, id),
        ),
      )
      .limit(1);
    if (!existing) {
      throw new AppError({ status: 404, title: 'Not Found', detail: 'No such action plan' });
    }
    await this.db
      .update(performanceActionPlans)
      .set({
        ...(patch.status !== undefined ? { status: patch.status } : {}),
        ...(patch.actions !== undefined ? { actions: patch.actions } : {}),
        ...(patch.reviewDate !== undefined ? { reviewDate: patch.reviewDate } : {}),
        ...(patch.notes !== undefined ? { notes: patch.notes } : {}),
        updatedAt: new Date(),
      })
      .where(eq(performanceActionPlans.id, id));

    await this.audit.write(principal, {
      action: patch.status ? 'status_change' : 'update',
      entityType: 'performance_action_plan',
      entityId: id,
      entityLabel: existing.employeeId,
      summary: patch.status
        ? `Action plan: ${existing.status} → ${patch.status}`
        : 'Action plan updated',
      ...(patch.status
        ? { changes: [{ field: 'status', old: existing.status, new: patch.status }] }
        : {}),
    });
    return this.listActionPlans(principal, existing.employeeId);
  }

  // ----------------------------------------------------------------------------------- summary

  async summary(principal: Principal): Promise<WorkforcePerformanceSummary> {
    const now = today();
    const goalScope = and(eq(performanceGoals.companyId, principal.companyId), hrReach(principal, 'performance.manage', performanceGoals.employeeId));
    const reviewScope = and(eq(performanceReviews.companyId, principal.companyId), hrReach(principal, 'performance.manage', performanceReviews.employeeId));

    const [goals, [reviewsDue], [reviewsCompleted], [withoutGoals], [openPlans]] =
      await Promise.all([
        this.db
          .select({
            id: performanceGoals.id,
            measure: performanceGoals.measure,
            targetValue: performanceGoals.targetValue,
            currentValue: performanceGoals.currentValue,
            status: performanceGoals.status,
            startDate: performanceGoals.startDate,
            dueDate: performanceGoals.dueDate,
          })
          .from(performanceGoals)
          .where(goalScope),
        this.db
          .select({ value: count() })
          .from(performanceReviews)
          .where(
            and(
              reviewScope,
              not(inArray(performanceReviews.status, ['completed', 'acknowledged'])),
            ),
          ),
        this.db
          .select({ value: count() })
          .from(performanceReviews)
          .where(and(reviewScope, eq(performanceReviews.status, 'completed'))),
        this.db
          .select({ value: count() })
          .from(employees)
          .leftJoin(performanceGoals, and(eq(performanceGoals.employeeId, employees.id), eq(performanceGoals.companyId, employees.companyId)))
          .where(
            and(
              eq(employees.companyId, principal.companyId),
              hrReach(principal, 'performance.manage', employees.id),
              eq(employees.status, 'active'),
              isNull(performanceGoals.id),
            ),
          ),
        this.db
          .select({ value: count() })
          .from(performanceActionPlans)
          .where(
            and(
              eq(performanceActionPlans.companyId, principal.companyId),
              hrReach(principal, 'performance.manage', performanceActionPlans.employeeId),
              inArray(performanceActionPlans.status, ['open', 'in_progress']),
            ),
          ),
      ]);

    // "At risk" is either declared by a person or derived from the clock running ahead of the work.
    const atRisk = goals.filter((g) => {
      if (g.status === 'at_risk') return true;
      if (g.status === 'completed' || g.status === 'cancelled') return false;
      const progress = goalProgress({
        measure: g.measure as PerformanceGoalRecord['measure'],
        targetValue: num(g.targetValue),
        currentValue: num(g.currentValue),
        status: g.status as GoalStatus,
      });
      return goalIsBehind({ startDate: g.startDate, dueDate: g.dueDate }, progress, now);
    }).length;

    return {
      reviewsDue: reviewsDue?.value ?? 0,
      reviewsCompleted: reviewsCompleted?.value ?? 0,
      goalsAtRisk: atRisk,
      goalsCompleted: goals.filter((g) => g.status === 'completed').length,
      employeesWithoutGoals: withoutGoals?.value ?? 0,
      openActionPlans: openPlans?.value ?? 0,
    };
  }
}
