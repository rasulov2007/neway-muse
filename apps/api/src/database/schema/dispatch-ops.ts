import { boolean, date, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { companies } from './roster';

/**
 * The dispatch operations layer around the boards (owner's brief §6–§14): the board roster, its
 * assignment history, the commission policy versions, per-week overrides and flags, salary runs
 * with their adjustments and allocations, detention claims, and one audit log for all of it.
 * Nothing here is ever hard-deleted; rows are voided or unassigned with a reason.
 */

/** A board row. `driver_id` links a driver file; imported rows the sheet ran may have none yet. */
export const dispatchRoster = pgTable(
  'dispatch_roster',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    driverId: text('driver_id'),
    importKey: text('import_key'),
    name: text('name').notNull(),
    coDriver: text('co_driver'),
    sourceName: text('source_name'),
    payTag: text('pay_tag'),
    truckUnit: text('truck_unit'),
    phone: text('phone').notNull().default(''),
    dispatcherId: text('dispatcher_id').notNull().default(''),
    dispatcherName: text('dispatcher_name').notNull().default(''),
    comment: text('comment').notNull().default(''),
    unassignedAt: timestamp('unassigned_at', { withTimezone: true }),
    unassignedFrom: date('unassigned_from'),
    unassignedReason: text('unassigned_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('dispatch_roster_driver_key').on(t.companyId, t.driverId),
    uniqueIndex('dispatch_roster_import_key').on(t.companyId, t.importKey),
    index('dispatch_roster_company_idx').on(t.companyId),
  ],
);

/** Where a row sat on a date: appended on every team / truck / co-driver change, read by the week. */
export const dispatchRosterAssignments = pgTable(
  'dispatch_roster_assignments',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    rosterId: text('roster_id').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    dispatcherId: text('dispatcher_id').notNull(),
    dispatcherName: text('dispatcher_name').notNull(),
    truckUnit: text('truck_unit'),
    coDriver: text('co_driver'),
    payTag: text('pay_tag'),
    /** Why the team changed (0062): asked for a change, vacation, left the company… */
    reason: text('reason'),
    by: text('by').notNull(),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dispatch_roster_assignments_idx').on(t.companyId, t.rosterId, t.effectiveFrom)],
);

/** One row per saved policy version; the version in force for a week is the latest effective on or before its Monday. */
export const dispatchPolicyVersions = pgTable(
  'dispatch_policy_versions',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    version: text('version').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    note: text('note').notNull().default(''),
    policy: text('policy').notNull(),
    createdBy: text('created_by').notNull(),
    createdByName: text('created_by_name').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('dispatch_policy_versions_key').on(t.companyId, t.version)],
);

/** The Commission cell's manual layer for one truck-week. */
export const dispatchWeekOverrides = pgTable(
  'dispatch_week_overrides',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    rosterId: text('roster_id').notNull(),
    weekStart: date('week_start').notNull(),
    mode: text('mode').notNull(),
    amountCents: integer('amount_cents').notNull(),
    reason: text('reason').notNull(),
    by: text('by').notNull(),
    byName: text('by_name').notNull().default(''),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [uniqueIndex('dispatch_week_overrides_key').on(t.companyId, t.rosterId, t.weekStart)],
);

/** Admin-set week eligibility: the complaint that withholds the RPM bonus; the junior rate. */
export const dispatchWeekFlags = pgTable(
  'dispatch_week_flags',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    rosterId: text('roster_id').notNull(),
    weekStart: date('week_start').notNull(),
    complaint: boolean('complaint').notNull().default(false),
    junior: boolean('junior').notNull().default(false),
    reason: text('reason').notNull().default(''),
    by: text('by').notNull(),
    byName: text('by_name').notNull().default(''),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('dispatch_week_flags_key').on(t.companyId, t.rosterId, t.weekStart)],
);

/** How a team's commission splits between the people behind "ARLO / MAXWELL"; versioned by date. */
export const dispatchAllocations = pgTable(
  'dispatch_allocations',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    dispatcherId: text('dispatcher_id').notNull(),
    effectiveFrom: date('effective_from').notNull(),
    shares: text('shares').notNull(),
    by: text('by').notNull(),
    byName: text('by_name').notNull().default(''),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dispatch_allocations_idx').on(t.companyId, t.dispatcherId, t.effectiveFrom)],
);

/** A salary run: the report for one period, with its lifecycle and, once final, its frozen snapshot. */
export const dispatchSalaryRuns = pgTable(
  'dispatch_salary_runs',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    periodKind: text('period_kind').notNull(),
    periodStart: date('period_start').notNull(),
    periodEnd: date('period_end').notNull(),
    status: text('status').notNull().default('draft'),
    snapshot: text('snapshot'),
    createdBy: text('created_by').notNull(),
    createdByName: text('created_by_name').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    finalizedBy: text('finalized_by'),
    finalizedByName: text('finalized_by_name'),
    finalizedAt: timestamp('finalized_at', { withTimezone: true }),
    reopenedBy: text('reopened_by'),
    reopenedByName: text('reopened_by_name'),
    reopenedAt: timestamp('reopened_at', { withTimezone: true }),
    reopenReason: text('reopen_reason'),
    version: integer('version').notNull().default(1),
  },
  (t) => [uniqueIndex('dispatch_salary_runs_key').on(t.companyId, t.periodKind, t.periodStart)],
);

/** Approved monthly bonuses and penalties, one row each, voided never deleted. */
export const dispatchSalaryAdjustments = pgTable(
  'dispatch_salary_adjustments',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    dispatcherId: text('dispatcher_id').notNull(),
    employeeName: text('employee_name').notNull().default(''),
    month: text('month').notNull(),
    kind: text('kind').notNull(),
    amountCents: integer('amount_cents').notNull(),
    reason: text('reason').notNull(),
    approvedByName: text('approved_by_name').notNull(),
    by: text('by').notNull(),
    byName: text('by_name').notNull().default(''),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
  },
  (t) => [index('dispatch_salary_adjustments_idx').on(t.companyId, t.month)],
);

/** Detention & layover: one live claim per load number. */
export const dispatchClaims = pgTable(
  'dispatch_claims',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    loadNumber: text('load_number').notNull(),
    claimType: text('claim_type').notNull(),
    rosterId: text('roster_id'),
    driverName: text('driver_name').notNull().default(''),
    claimDate: date('claim_date').notNull(),
    requestedCents: integer('requested_cents').notNull().default(0),
    recoveredCents: integer('recovered_cents').notNull().default(0),
    updater: text('updater').notNull().default(''),
    updaterPayoutCents: integer('updater_payout_cents').notNull().default(0),
    status: text('status').notNull().default('open'),
    notes: text('notes').notNull().default(''),
    by: text('by').notNull(),
    byName: text('by_name').notNull().default(''),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
    version: integer('version').notNull().default(1),
  },
  (t) => [index('dispatch_claims_idx').on(t.companyId, t.claimDate)],
);

/** Every non-cell change in this layer: who, when, before, after. Never edited. */
export const dispatchAudit = pgTable(
  'dispatch_audit',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    entity: text('entity').notNull(),
    entityId: text('entity_id').notNull(),
    action: text('action').notNull(),
    before: text('before'),
    after: text('after'),
    by: text('by').notNull(),
    byName: text('by_name').notNull().default(''),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('dispatch_audit_idx').on(t.companyId, t.entity, t.entityId)],
);
