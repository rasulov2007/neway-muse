import { z } from 'zod';
import { EMPLOYEE_DEPARTMENTS } from '../people/employee.js';

/**
 * Performance: goals, reviews, feedback and action plans.
 *
 * Two rules shape this file. A goal is not always a percentage — a numeric target, a milestone and
 * a yes/no commitment are all real goals, and forcing them into a progress bar produces figures
 * nobody believes. And a rating is `null` until a reviewer gives one: an unrated review is not a
 * review scored zero.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

// --------------------------------------------------------------------------------------- cycles

export const PERFORMANCE_CYCLE_KINDS = ['annual', 'semiannual', 'quarterly', 'custom'] as const;
export const PERFORMANCE_CYCLE_STATUSES = ['planned', 'active', 'closed'] as const;

export const PerformanceCycleSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(PERFORMANCE_CYCLE_KINDS),
  periodStart: isoDate,
  periodEnd: isoDate,
  reviewsDueOn: isoDate.nullable(),
  status: z.enum(PERFORMANCE_CYCLE_STATUSES),
});
export type PerformanceCycleRecord = z.infer<typeof PerformanceCycleSchema>;

export const CreatePerformanceCycleSchema = z
  .object({
    name: z.string().trim().min(1, 'A name is required').max(60),
    kind: z.enum(PERFORMANCE_CYCLE_KINDS),
    periodStart: isoDate,
    periodEnd: isoDate,
    reviewsDueOn: isoDate.nullable().default(null),
  })
  .refine((v) => v.periodEnd > v.periodStart, {
    message: 'The period must end after it starts',
    path: ['periodEnd'],
  });
export type CreatePerformanceCycleRequest = z.infer<typeof CreatePerformanceCycleSchema>;

// ---------------------------------------------------------------------------------------- goals

export const GOAL_STATUSES = [
  'not_started',
  'in_progress',
  'at_risk',
  'completed',
  'cancelled',
] as const;
export type GoalStatus = (typeof GOAL_STATUSES)[number];

export const GOAL_CATEGORIES = [
  'safety',
  'performance',
  'development',
  'financial',
  'service',
  'compliance',
  'other',
] as const;

/** How a goal is measured. Not every goal is a percentage. */
export const GOAL_MEASURES = ['percent', 'numeric', 'milestone', 'binary'] as const;
export type GoalMeasure = (typeof GOAL_MEASURES)[number];

export const PerformanceGoalSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  employeeName: z.string(),
  employeeNumber: z.string(),
  department: z.enum(EMPLOYEE_DEPARTMENTS),
  cycleId: z.string().nullable(),
  cycleName: z.string().nullable(),
  title: z.string(),
  description: z.string().nullable(),
  category: z.enum(GOAL_CATEGORIES),
  measure: z.enum(GOAL_MEASURES),
  targetValue: z.number().nullable(),
  currentValue: z.number().nullable(),
  unit: z.string().nullable(),
  startDate: isoDate,
  dueDate: isoDate,
  status: z.enum(GOAL_STATUSES),
  notes: z.string().nullable(),
  createdAt: z.string(),
});
export type PerformanceGoalRecord = z.infer<typeof PerformanceGoalSchema>;

export const CreatePerformanceGoalSchema = z
  .object({
    employeeId: z.string().min(1, 'An employee is required'),
    cycleId: z.string().nullable().default(null),
    title: z.string().trim().min(1, 'A goal needs a title').max(120),
    description: z.string().trim().max(2000).nullable().default(null),
    category: z.enum(GOAL_CATEGORIES),
    measure: z.enum(GOAL_MEASURES),
    targetValue: z.number().nullable().default(null),
    currentValue: z.number().nullable().default(null),
    unit: z.string().trim().max(20).nullable().default(null),
    startDate: isoDate,
    dueDate: isoDate,
    notes: z.string().trim().max(2000).nullable().default(null),
  })
  .refine((v) => v.dueDate >= v.startDate, {
    message: 'The due date cannot be before the start date',
    path: ['dueDate'],
  })
  .refine((v) => v.measure !== 'numeric' || v.targetValue !== null, {
    message: 'A numeric goal needs a target',
    path: ['targetValue'],
  });
export type CreatePerformanceGoalRequest = z.infer<typeof CreatePerformanceGoalSchema>;

export const UpdateGoalProgressSchema = z.object({
  currentValue: z.number().nullable().optional(),
  status: z.enum(GOAL_STATUSES).optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type UpdateGoalProgressRequest = z.infer<typeof UpdateGoalProgressSchema>;

/**
 * Goal progress as a percentage, when that is a meaningful thing to compute.
 *
 * A milestone goal has no percentage — it is done or it is not, and inventing "40% of a milestone"
 * is a number with no referent. `null` says the question does not apply here.
 */
export function goalProgress(goal: {
  measure: GoalMeasure;
  targetValue: number | null;
  currentValue: number | null;
  status: GoalStatus;
}): number | null {
  if (goal.status === 'completed') return 100;
  if (goal.status === 'cancelled') return null;
  // A milestone is reached or it is not; "40% of a milestone" is a number with no referent.
  if (goal.measure === 'binary' || goal.measure === 'milestone') return 0;
  if (goal.currentValue === null) return null;
  if (goal.measure === 'percent') return clamp(goal.currentValue);
  if (goal.targetValue === null || goal.targetValue === 0) return null;
  return clamp((goal.currentValue / goal.targetValue) * 100);
}

function clamp(value: number): number {
  return Math.max(0, Math.min(100, Math.round(value)));
}

/** A goal is at risk when time has run out faster than progress. Advisory, never automatic. */
export function goalIsBehind(
  goal: { dueDate: string; startDate: string },
  progress: number | null,
  today: string,
): boolean {
  if (progress === null) return false;
  const start = Date.parse(`${goal.startDate}T00:00:00Z`);
  const end = Date.parse(`${goal.dueDate}T00:00:00Z`);
  const now = Date.parse(`${today}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return false;
  const elapsed = ((now - start) / (end - start)) * 100;
  return elapsed > progress + 20;
}

// -------------------------------------------------------------------------------------- reviews

export const REVIEW_STATUSES = [
  'draft',
  'in_progress',
  'submitted',
  'acknowledged',
  'completed',
] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

export const REVIEW_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  draft: ['in_progress', 'submitted'],
  in_progress: ['submitted'],
  submitted: ['acknowledged'],
  acknowledged: ['completed'],
  completed: [],
};

/** A rating scale, with what each point actually means. */
export const RATING_SCALE = [
  { value: 1, label: 'Needs significant improvement' },
  { value: 2, label: 'Needs improvement' },
  { value: 3, label: 'Meets expectations' },
  { value: 4, label: 'Exceeds expectations' },
  { value: 5, label: 'Exceptional' },
] as const;

export const PerformanceReviewSchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  employeeName: z.string(),
  employeeNumber: z.string(),
  department: z.enum(EMPLOYEE_DEPARTMENTS),
  position: z.string(),
  reviewerEmployeeId: z.string().nullable(),
  reviewerName: z.string().nullable(),
  cycleId: z.string().nullable(),
  cycleName: z.string().nullable(),
  periodStart: isoDate,
  periodEnd: isoDate,
  /** Null until somebody rates it. Never defaulted. */
  rating: z.number().int().nullable(),
  summary: z.string().nullable(),
  strengths: z.string().nullable(),
  developmentAreas: z.string().nullable(),
  managerFeedback: z.string().nullable(),
  employeeComments: z.string().nullable(),
  status: z.enum(REVIEW_STATUSES),
  submittedAt: z.string().nullable(),
  acknowledgedAt: z.string().nullable(),
  createdAt: z.string(),
});
export type PerformanceReviewRecord = z.infer<typeof PerformanceReviewSchema>;

export const CreatePerformanceReviewSchema = z
  .object({
    employeeId: z.string().min(1, 'An employee is required'),
    reviewerEmployeeId: z.string().nullable().default(null),
    cycleId: z.string().nullable().default(null),
    periodStart: isoDate,
    periodEnd: isoDate,
  })
  .refine((v) => v.periodEnd > v.periodStart, {
    message: 'The period must end after it starts',
    path: ['periodEnd'],
  });
export type CreatePerformanceReviewRequest = z.infer<typeof CreatePerformanceReviewSchema>;

export const UpdatePerformanceReviewSchema = z.object({
  rating: z.number().int().min(1).max(5).nullable().optional(),
  summary: z.string().trim().max(4000).nullable().optional(),
  strengths: z.string().trim().max(4000).nullable().optional(),
  developmentAreas: z.string().trim().max(4000).nullable().optional(),
  managerFeedback: z.string().trim().max(4000).nullable().optional(),
  employeeComments: z.string().trim().max(4000).nullable().optional(),
});
export type UpdatePerformanceReviewRequest = z.infer<typeof UpdatePerformanceReviewSchema>;

export const ChangeReviewStatusSchema = z.object({
  status: z.enum(REVIEW_STATUSES),
  /** A completed review that is being changed must say why, and the change is audited. */
  reason: z.string().trim().max(400).nullable().default(null),
});
export type ChangeReviewStatusRequest = z.infer<typeof ChangeReviewStatusSchema>;

// ------------------------------------------------------------------------------------- feedback

export const FEEDBACK_KINDS = ['commendation', 'coaching', 'concern', 'note'] as const;
export const FEEDBACK_VISIBILITIES = ['shared', 'manager_only'] as const;

export const CreateFeedbackSchema = z.object({
  employeeId: z.string().min(1),
  kind: z.enum(FEEDBACK_KINDS),
  body: z.string().trim().min(1, 'Say something').max(4000),
  goalId: z.string().nullable().default(null),
  visibility: z.enum(FEEDBACK_VISIBILITIES).default('manager_only'),
});
export type CreateFeedbackRequest = z.infer<typeof CreateFeedbackSchema>;

export interface PerformanceFeedbackRecord {
  id: string;
  employeeId: string;
  authorName: string;
  kind: (typeof FEEDBACK_KINDS)[number];
  body: string;
  goalId: string | null;
  visibility: (typeof FEEDBACK_VISIBILITIES)[number];
  at: string;
}

// --------------------------------------------------------------------------------- action plans

export const ACTION_PLAN_STATUSES = ['open', 'in_progress', 'completed', 'cancelled'] as const;
export type ActionPlanStatus = (typeof ACTION_PLAN_STATUSES)[number];

export const ActionPlanStepSchema = z.object({
  title: z.string().trim().min(1).max(200),
  done: z.boolean().default(false),
});

export const CreateActionPlanSchema = z
  .object({
    employeeId: z.string().min(1),
    ownerEmployeeId: z.string().nullable().default(null),
    issue: z.string().trim().min(1, 'State the issue').max(2000),
    expectedOutcome: z.string().trim().min(1, 'State what good looks like').max(2000),
    actions: z.array(ActionPlanStepSchema).default([]),
    startDate: isoDate,
    dueDate: isoDate,
    reviewDate: isoDate.nullable().default(null),
    notes: z.string().trim().max(2000).nullable().default(null),
  })
  .refine((v) => v.dueDate >= v.startDate, {
    message: 'The due date cannot be before the start date',
    path: ['dueDate'],
  });
export type CreateActionPlanRequest = z.infer<typeof CreateActionPlanSchema>;

export const UpdateActionPlanSchema = z.object({
  status: z.enum(ACTION_PLAN_STATUSES).optional(),
  actions: z.array(ActionPlanStepSchema).optional(),
  reviewDate: isoDate.nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
});
export type UpdateActionPlanRequest = z.infer<typeof UpdateActionPlanSchema>;

export interface ActionPlanRecord {
  id: string;
  employeeId: string;
  employeeName: string;
  ownerEmployeeId: string | null;
  ownerName: string | null;
  issue: string;
  expectedOutcome: string;
  actions: { title: string; done: boolean }[];
  startDate: string;
  dueDate: string;
  reviewDate: string | null;
  status: ActionPlanStatus;
  notes: string | null;
  createdAt: string;
}

// -------------------------------------------------------------------------------------- queries

export const PerformanceQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(120).optional(),
  employeeId: z.string().max(40).optional(),
  department: z.enum(EMPLOYEE_DEPARTMENTS).optional(),
  cycleId: z.string().max(40).optional(),
  goalStatus: z.enum(GOAL_STATUSES).optional(),
  reviewStatus: z.enum(REVIEW_STATUSES).optional(),
  sort: z.enum(['employeeName', 'dueDate', 'status']).default('dueDate'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
});
export type PerformanceQuery = z.infer<typeof PerformanceQuerySchema>;

/** Named for the workforce because `PerformanceSummary` already means dispatch performance. */
export interface WorkforcePerformanceSummary {
  reviewsDue: number;
  reviewsCompleted: number;
  goalsAtRisk: number;
  goalsCompleted: number;
  employeesWithoutGoals: number;
  openActionPlans: number;
}
