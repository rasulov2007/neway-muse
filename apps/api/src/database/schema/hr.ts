import { relations, sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { companies } from './roster';
import { employees } from './people';

/**
 * Phase 11: the rest of the employee lifecycle.
 *
 * Recruiting → hiring → onboarding → attendance, PTO and performance. Every one of these tables
 * keys on `employees.id`, which docs/DATABASE.md §3.15 committed as their relationship before any
 * of them existed. None of them holds a second copy of a person: an applicant becomes an employee
 * by pointing at one, and every module after that references the employee by id.
 *
 * Table shapes follow §3.15 where it specifies them. Job openings, interviews, offers, goals,
 * feedback and action plans are added here because the lifecycle the brief describes needs them and
 * the committed schema stops short of them; each follows the same conventions as its neighbours.
 */

// =================================================================================== recruiting

export const jobOpenings = pgTable(
  'job_openings',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    jobNumber: text('job_number').notNull(),
    title: text('title').notNull(),
    department: text('department').notNull(),
    location: text('location'),
    employmentType: text('employment_type').notNull(),
    hiringManagerEmployeeId: text('hiring_manager_employee_id').references(() => employees.id),
    openDate: date('open_date').notNull(),
    targetHireDate: date('target_hire_date'),
    positionsCount: integer('positions_count').notNull().default(1),
    status: text('status').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('job_openings_company_number_key').on(table.companyId, table.jobNumber),
    index('job_openings_company_status_idx').on(table.companyId, table.status),
  ],
);

export const applicants = pgTable(
  'applicants',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    applicantNumber: text('applicant_number').notNull(),
    jobOpeningId: text('job_opening_id').references(() => jobOpenings.id),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    email: text('email').notNull(),
    phone: text('phone').notNull(),
    position: text('position').notNull(),
    department: text('department').notNull(),
    location: text('location'),
    source: text('source'),
    stage: text('stage').notNull(),
    /** Set when a candidate leaves the pipeline; the stage says which way. */
    closedReason: text('closed_reason'),
    assignedRecruiterEmployeeId: text('assigned_recruiter_employee_id').references(
      () => employees.id,
    ),
    driverType: text('driver_type'),
    appliedOn: date('applied_on').notNull(),
    /**
     * The employee this person became. Set exactly once, by the hire conversion, and the reason a
     * hired candidate is never a second unrelated person.
     */
    hiredEmployeeId: text('hired_employee_id').references(() => employees.id),
    hiredOn: date('hired_on'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('applicants_company_number_key').on(table.companyId, table.applicantNumber),
    uniqueIndex('applicants_company_email_key').on(table.companyId, sql`lower(${table.email})`),
    // One applicant can only ever have produced one employee.
    uniqueIndex('applicants_hired_employee_key')
      .on(table.hiredEmployeeId)
      .where(sql`${table.hiredEmployeeId} is not null`),
    index('applicants_company_stage_idx').on(table.companyId, table.stage),
  ],
);

export const interviews = pgTable(
  'interviews',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    applicantId: text('applicant_id')
      .notNull()
      .references(() => applicants.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    scheduledAt: timestamp('scheduled_at', { withTimezone: true }).notNull(),
    interviewerEmployeeId: text('interviewer_employee_id').references(() => employees.id),
    location: text('location'),
    status: text('status').notNull(),
    /** Null until somebody scores it. Never defaulted to a number nobody gave. */
    score: integer('score'),
    recommendation: text('recommendation'),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('interviews_applicant_idx').on(table.applicantId, table.scheduledAt)],
);

export const offers = pgTable(
  'offers',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    offerNumber: text('offer_number').notNull(),
    applicantId: text('applicant_id')
      .notNull()
      .references(() => applicants.id, { onDelete: 'restrict' }),
    position: text('position').notNull(),
    department: text('department').notNull(),
    employmentType: text('employment_type').notNull(),
    payType: text('pay_type'),
    payRate: numeric('pay_rate', { precision: 12, scale: 2 }),
    startDate: date('start_date').notNull(),
    expiresOn: date('expires_on'),
    status: text('status').notNull(),
    notes: text('notes'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    /**
     * Driver offers only. The same table — an offer is an offer — with what a driver's says that
     * an office one does not: the pay plan in the roster's own terms, bonuses, who referred them,
     * and the orientation date the offer is for. No FK on the hiring case: the schema files
     * import one way, and the hiring module owns the link from its side.
     */
    hiringCaseId: text('hiring_case_id'),
    driverType: text('driver_type'),
    payPlanKind: text('pay_plan_kind'),
    payPlanRate: numeric('pay_plan_rate', { precision: 8, scale: 4 }),
    signOnBonus: numeric('sign_on_bonus', { precision: 12, scale: 2 }),
    referralBonus: numeric('referral_bonus', { precision: 12, scale: 2 }),
    referringDriverId: text('referring_driver_id'),
    orientationDate: date('orientation_date'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('offers_company_number_key').on(table.companyId, table.offerNumber),
    index('offers_applicant_idx').on(table.applicantId),
  ],
);

// =================================================================================== onboarding

export const onboardingTemplates = pgTable(
  'onboarding_templates',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** Which hires this template fits. Null matches anything. */
    position: text('position'),
    department: text('department'),
    employmentType: text('employment_type'),
    /** company · owner_operator · lease_operator; null for office hires or any driver. */
    driverType: text('driver_type'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('onboarding_templates_company_idx').on(table.companyId)],
);

export const onboardingTemplateItems = pgTable(
  'onboarding_template_items',
  {
    id: text('id').primaryKey(),
    templateId: text('template_id')
      .notNull()
      .references(() => onboardingTemplates.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    category: text('category').notNull(),
    /** Days after the start date this item is due. */
    dueOffsetDays: integer('due_offset_days').notNull().default(0),
    sortOrder: integer('sort_order').notNull().default(0),
    /** Holds a hired driver at Hired until done. */
    blocking: boolean('blocking').notNull().default(false),
    ownerRole: text('owner_role'),
    /** Completed from the qualification file when this requirement is verified. */
    requirementCode: text('requirement_code'),
  },
  (table) => [index('onboarding_template_items_template_idx').on(table.templateId)],
);

export const onboardingChecklists = pgTable(
  'onboarding_checklists',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    employeeId: text('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    templateId: text('template_id').references(() => onboardingTemplates.id),
    ownerEmployeeId: text('owner_employee_id').references(() => employees.id),
    startDate: date('start_date').notNull(),
    dueDate: date('due_date'),
    status: text('status').notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One live plan per person: two competing checklists is how half the tasks get missed.
    uniqueIndex('onboarding_checklists_employee_open_key')
      .on(table.employeeId)
      .where(sql`${table.status} <> 'cancelled'`),
    index('onboarding_checklists_company_status_idx').on(table.companyId, table.status),
  ],
);

export const onboardingItems = pgTable(
  'onboarding_items',
  {
    id: text('id').primaryKey(),
    checklistId: text('checklist_id')
      .notNull()
      .references(() => onboardingChecklists.id, { onDelete: 'cascade' }),
    title: text('title').notNull(),
    category: text('category').notNull(),
    ownerEmployeeId: text('owner_employee_id').references(() => employees.id),
    dueDate: date('due_date'),
    status: text('status').notNull(),
    completedByEmployeeId: text('completed_by_employee_id').references(() => employees.id),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    sortOrder: integer('sort_order').notNull().default(0),
    notes: text('notes'),
    blocking: boolean('blocking').notNull().default(false),
    ownerRole: text('owner_role'),
    requirementCode: text('requirement_code'),
  },
  (table) => [index('onboarding_items_checklist_idx').on(table.checklistId, table.sortOrder)],
);

// =================================================================================== attendance

export const attendanceEntries = pgTable(
  'attendance_entries',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    employeeId: text('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    entryDate: date('entry_date').notNull(),
    checkInAt: timestamp('check_in_at', { withTimezone: true }),
    checkOutAt: timestamp('check_out_at', { withTimezone: true }),
    breakMinutes: integer('break_minutes').notNull().default(0),
    status: text('status').notNull(),
    /** `missing_in`, `missing_out`, `late`, `long_day`… Null when the day is clean. */
    exception: text('exception'),
    exceptionResolvedAt: timestamp('exception_resolved_at', { withTimezone: true }),
    exceptionNote: text('exception_note'),
    source: text('source').notNull().default('manual'),
    approvedByEmployeeId: text('approved_by_employee_id').references(() => employees.id),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    // One row per person per day. Two rows for one day is how hours get paid twice.
    uniqueIndex('attendance_employee_date_key').on(table.employeeId, table.entryDate),
    index('attendance_company_date_idx').on(table.companyId, table.entryDate),
    index('attendance_company_exception_idx').on(table.companyId, table.exception),
  ],
);

// ========================================================================================== pto

export const ptoPolicies = pgTable(
  'pto_policies',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    accrualHoursPerPeriod: numeric('accrual_hours_per_period', { precision: 8, scale: 2 })
      .notNull()
      .default('0'),
    period: text('period').notNull().default('monthly'),
    maxBalanceHours: numeric('max_balance_hours', { precision: 8, scale: 2 }),
    carryoverHours: numeric('carryover_hours', { precision: 8, scale: 2 }),
    /** Whether a request may take the balance below zero. Policy, not a per-request override. */
    allowsNegativeBalance: boolean('allows_negative_balance').notNull().default(false),
    isActive: boolean('is_active').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('pto_policies_company_name_key').on(table.companyId, table.name)],
);

export const ptoRequests = pgTable(
  'pto_requests',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    requestNumber: text('request_number').notNull(),
    employeeId: text('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    policyId: text('policy_id')
      .notNull()
      .references(() => ptoPolicies.id, { onDelete: 'restrict' }),
    startsOn: date('starts_on').notNull(),
    endsOn: date('ends_on').notNull(),
    hours: numeric('hours', { precision: 8, scale: 2 }).notNull(),
    status: text('status').notNull(),
    reason: text('reason'),
    notes: text('notes'),
    approverEmployeeId: text('approver_employee_id').references(() => employees.id),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decisionNote: text('decision_note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('pto_requests_company_number_key').on(table.companyId, table.requestNumber),
    index('pto_requests_employee_idx').on(table.employeeId, table.startsOn),
    index('pto_requests_company_status_idx').on(table.companyId, table.status),
  ],
);

/**
 * The ledger a balance is derived from.
 *
 * A balance is never a column somebody can type over: it is the sum of accruals, usage and
 * explicit, audited adjustments. That is the same reason the accounting module keeps a general
 * ledger — a number you can edit directly is a number nobody can reconcile.
 */
export const ptoTransactions = pgTable(
  'pto_transactions',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    employeeId: text('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    policyId: text('policy_id')
      .notNull()
      .references(() => ptoPolicies.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    /** Positive adds to the balance, negative takes from it. */
    hours: numeric('hours', { precision: 8, scale: 2 }).notNull(),
    effectiveOn: date('effective_on').notNull(),
    requestId: text('request_id').references(() => ptoRequests.id),
    reason: text('reason'),
    actorName: text('actor_name'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('pto_transactions_employee_idx').on(table.employeeId, table.policyId, table.effectiveOn),
    // A request may only ever spend its hours once.
    uniqueIndex('pto_transactions_request_usage_key')
      .on(table.requestId)
      .where(sql`${table.kind} = 'usage' and ${table.requestId} is not null`),
  ],
);

// ================================================================================== performance

export const performanceCycles = pgTable(
  'performance_cycles',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    kind: text('kind').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    reviewsDueOn: date('reviews_due_on'),
    status: text('status').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('performance_cycles_company_name_key').on(table.companyId, table.name)],
);

export const performanceGoals = pgTable(
  'performance_goals',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    employeeId: text('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    cycleId: text('cycle_id').references(() => performanceCycles.id),
    title: text('title').notNull(),
    description: text('description'),
    category: text('category').notNull(),
    /** percent · numeric · milestone · binary — not every goal is a percentage. */
    measure: text('measure').notNull(),
    targetValue: numeric('target_value', { precision: 14, scale: 2 }),
    currentValue: numeric('current_value', { precision: 14, scale: 2 }),
    unit: text('unit'),
    startDate: date('start_date').notNull(),
    dueDate: date('due_date').notNull(),
    status: text('status').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('performance_goals_employee_idx').on(table.employeeId, table.dueDate),
    index('performance_goals_company_status_idx').on(table.companyId, table.status),
  ],
);

export const performanceReviews = pgTable(
  'performance_reviews',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    employeeId: text('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    reviewerEmployeeId: text('reviewer_employee_id').references(() => employees.id),
    cycleId: text('cycle_id').references(() => performanceCycles.id),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    /** Null until a reviewer gives one. A review with no rating is not a rating of zero. */
    rating: integer('rating'),
    summary: text('summary'),
    strengths: text('strengths'),
    developmentAreas: text('development_areas'),
    managerFeedback: text('manager_feedback'),
    employeeComments: text('employee_comments'),
    status: text('status').notNull(),
    submittedAt: timestamp('submitted_at', { withTimezone: true }),
    acknowledgedAt: timestamp('acknowledged_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('performance_reviews_employee_idx').on(table.employeeId, table.periodEnd),
    index('performance_reviews_company_status_idx').on(table.companyId, table.status),
  ],
);

export const performanceFeedback = pgTable(
  'performance_feedback',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    employeeId: text('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    authorEmployeeId: text('author_employee_id').references(() => employees.id),
    authorName: text('author_name').notNull(),
    kind: text('kind').notNull(),
    body: text('body').notNull(),
    goalId: text('goal_id').references(() => performanceGoals.id),
    /** `shared` is visible to the employee; `manager_only` is not. */
    visibility: text('visibility').notNull().default('manager_only'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('performance_feedback_employee_idx').on(table.employeeId, table.at)],
);

export const performanceActionPlans = pgTable(
  'performance_action_plans',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    employeeId: text('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    ownerEmployeeId: text('owner_employee_id').references(() => employees.id),
    issue: text('issue').notNull(),
    expectedOutcome: text('expected_outcome').notNull(),
    actions: jsonb('actions')
      .notNull()
      .default(sql`'[]'::jsonb`),
    startDate: date('start_date').notNull(),
    dueDate: date('due_date').notNull(),
    reviewDate: date('review_date'),
    status: text('status').notNull(),
    notes: text('notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('performance_action_plans_employee_idx').on(table.employeeId, table.dueDate)],
);

// ==================================================================================== relations

export const applicantRelations = relations(applicants, ({ one, many }) => ({
  jobOpening: one(jobOpenings, {
    fields: [applicants.jobOpeningId],
    references: [jobOpenings.id],
  }),
  hiredEmployee: one(employees, {
    fields: [applicants.hiredEmployeeId],
    references: [employees.id],
  }),
  interviews: many(interviews),
  offers: many(offers),
}));

export const onboardingChecklistRelations = relations(onboardingChecklists, ({ one, many }) => ({
  employee: one(employees, {
    fields: [onboardingChecklists.employeeId],
    references: [employees.id],
  }),
  items: many(onboardingItems),
}));

export type JobOpeningRow = typeof jobOpenings.$inferSelect;
export type ApplicantRow = typeof applicants.$inferSelect;
export type InterviewRow = typeof interviews.$inferSelect;
export type OfferRow = typeof offers.$inferSelect;
export type OnboardingChecklistRow = typeof onboardingChecklists.$inferSelect;
export type OnboardingItemRow = typeof onboardingItems.$inferSelect;
export type AttendanceEntryRow = typeof attendanceEntries.$inferSelect;
export type PtoPolicyRow = typeof ptoPolicies.$inferSelect;
export type PtoRequestRow = typeof ptoRequests.$inferSelect;
export type PtoTransactionRow = typeof ptoTransactions.$inferSelect;
export type PerformanceCycleRow = typeof performanceCycles.$inferSelect;
export type PerformanceGoalRow = typeof performanceGoals.$inferSelect;
export type PerformanceReviewRow = typeof performanceReviews.$inferSelect;
export type PerformanceFeedbackRow = typeof performanceFeedback.$inferSelect;
export type PerformanceActionPlanRow = typeof performanceActionPlans.$inferSelect;
