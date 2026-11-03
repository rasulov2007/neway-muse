import { sql } from 'drizzle-orm';
import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { companies } from './roster';

/**
 * The weekly walk-around, as rows a person can own.
 *
 * A PTI defect used to be three columns on an inspection row in the workspace blob — category,
 * issue text, action text — so it could not be owned, dated, aged, assigned, verified or
 * referenced by anything else. Here the inspection is the event, the defect is the record, and
 * the history is append-only. The blob's `ws2-ptirecords` is left readable for the screens that
 * have not moved; nothing here writes to it.
 */

export const ptiInspections = pgTable(
  'pti_inspections',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** A truck id. Trailers do not get a weekly walk-around of their own. */
    unitId: text('unit_id').notNull(),
    unitNumber: text('unit_number').notNull().default(''),
    weekStart: date('week_start').notNull(),
    dueAt: date('due_at').notNull(),
    /** The driver and dispatcher as they were when the week opened; re-read while unreviewed. */
    driverId: text('driver_id'),
    driverName: text('driver_name'),
    driverType: text('driver_type'),
    dispatcherId: text('dispatcher_id'),
    dispatcherName: text('dispatcher_name'),
    /** not_due · awaiting · received · late · missing · exempt_in_shop */
    receiptStatus: text('receipt_status').notNull().default('awaiting'),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    /** The Telegram pointer. Never the video. */
    source: jsonb('source'),
    /** unreviewed · in_review · reviewed */
    reviewState: text('review_state').notNull().default('unreviewed'),
    reviewerId: text('reviewer_id'),
    reviewerName: text('reviewer_name'),
    reviewedAt: timestamp('reviewed_at', { withTimezone: true }),
    /** no_issues · issues_found; only meaningful once reviewed. */
    reviewResult: text('review_result'),
    inReviewBy: text('in_review_by'),
    inReviewByName: text('in_review_by_name'),
    inReviewSince: timestamp('in_review_since', { withTimezone: true }),
    /** What the reviewer said about defects that were already open. */
    openDefectDispositions: jsonb('open_defect_dispositions')
      .notNull()
      .default(sql`'[]'::jsonb`),
    legacyRecordId: text('legacy_record_id'),
    /** Safety asked the driver to redo the walk-around (0081): when, who, why. Cleared by the resubmission. */
    correctionRequestedAt: timestamp('correction_requested_at', { withTimezone: true }),
    correctionRequestedBy: text('correction_requested_by'),
    correctionReason: text('correction_reason'),
    /** How many times the driver submitted this week's walk-around from the app. */
    driverSubmissionCount: integer('driver_submission_count').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('pti_inspections_unit_week_key').on(t.companyId, t.unitId, t.weekStart),
    index('pti_inspections_week_idx').on(t.companyId, t.weekStart),
  ],
);

export const ptiDefects = pgTable(
  'pti_defects',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** Human-facing: DEF-0001. */
    defectNumber: text('defect_number').notNull(),
    unitId: text('unit_id').notNull(),
    unitNumber: text('unit_number').notNull().default(''),
    foundOnInspectionId: text('found_on_inspection_id').references(() => ptiInspections.id, {
      onDelete: 'set null',
    }),
    /** A key from the component catalog. Never free text. */
    component: text('component').notNull(),
    componentName: text('component_name').notNull().default(''),
    description: text('description').notNull(),
    quickPick: text('quick_pick'),
    /** monitor · replace_soon · replace_now · oos_risk */
    severity: text('severity').notNull(),
    /** open · assigned · scheduled · in_repair · fixed_pending_verify · verified · dismissed */
    state: text('state').notNull().default('open'),
    evidence: jsonb('evidence')
      .notNull()
      .default(sql`'{"clipTime":null,"screenshots":[]}'::jsonb`),
    ownerId: text('owner_id'),
    ownerName: text('owner_name'),
    dueAt: timestamp('due_at', { withTimezone: true }),
    /** The work order fixing it, by id. The link is this field, never a sentence. */
    workOrderId: text('work_order_id'),
    workOrderNumber: text('work_order_number'),
    resolution: jsonb('resolution')
      .notNull()
      .default(sql`'{}'::jsonb`),
    /** Set by the backfill on a row whose legacy text could not be trusted; a person clears it. */
    needsReview: boolean('needs_review').notNull().default(false),
    legacyRecordId: text('legacy_record_id'),
    createdBy: text('created_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('pti_defects_company_number_key').on(t.companyId, t.defectNumber),
    index('pti_defects_unit_state_idx').on(t.companyId, t.unitId, t.state),
    index('pti_defects_state_idx').on(t.companyId, t.state),
  ],
);

/** Append-only. Nothing updates or deletes a row here. */
export const ptiDefectHistory = pgTable(
  'pti_defect_history',
  {
    id: text('id').primaryKey(),
    defectId: text('defect_id')
      .notNull()
      .references(() => ptiDefects.id, { onDelete: 'cascade' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    byId: text('by_id').notNull(),
    byName: text('by_name').notNull(),
    fromState: text('from_state'),
    toState: text('to_state').notNull(),
    note: text('note'),
  },
  (t) => [index('pti_defect_history_defect_idx').on(t.defectId, t.at)],
);
