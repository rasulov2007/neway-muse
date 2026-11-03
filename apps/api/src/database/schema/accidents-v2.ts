import { sql } from 'drizzle-orm';
import { bigint, boolean, index, integer, jsonb, pgTable, primaryKey, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { companies } from './roster';
import { workOrders } from './fleet';
import { safetyAccidents, safetyClaims } from './safety';

/**
 * Accident & Claims v2, phase P1 (migration 0069, docs/accidents/IMPLEMENTATION-PLAN.md).
 *
 * The case itself stays `safety_accidents` (extended in place). These tables hold what a case owns
 * beside it: the units involved, the restricted details, tasks and cross-department requests, the
 * event-time timeline, out-of-service periods and per-company rule settings. Every row carries
 * `company_id`; nothing here is ever deleted.
 */

export const accidentUnits = pgTable(
  'accident_units',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    accidentId: text('accident_id')
      .notNull()
      .references(() => safetyAccidents.id, { onDelete: 'restrict' }),
    /** truck · trailer */
    unitKind: text('unit_kind').notNull(),
    unitId: text('unit_id').notNull(),
    unitNumber: text('unit_number'),
    /** drivable · not_drivable · unknown — written at intake / by Safety only; a repair never changes it. */
    conditionAtScene: text('condition_at_scene').notNull().default('unknown'),
    status: text('status').notNull().default('unknown'),
    damage: text('damage'),
    towCompany: text('tow_company'),
    towedTo: text('towed_to'),
    storageRateCents: bigint('storage_rate_cents', { mode: 'number' }),
    storageSince: timestamp('storage_since', { withTimezone: true }),
    returnedToServiceAt: timestamp('returned_to_service_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('accident_units_unit_key').on(t.companyId, t.accidentId, t.unitKind, t.unitId)],
);

export const accidentRestricted = pgTable('accident_restricted', {
  accidentId: text('accident_id')
    .primaryKey()
    .references(() => safetyAccidents.id, { onDelete: 'restrict' }),
  companyId: text('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'restrict' }),
  medicalDetails: text('medical_details'),
  legalLiability: text('legal_liability'),
  legalBasis: text('legal_basis'),
  legalBy: text('legal_by'),
  legalAt: timestamp('legal_at', { withTimezone: true }),
  version: integer('version').notNull().default(1),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const safetyTasks = pgTable(
  'safety_tasks',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    accidentId: text('accident_id').references(() => safetyAccidents.id, { onDelete: 'restrict' }),
    claimId: text('claim_id'),
    workOrderId: text('work_order_id'),
    title: text('title').notNull(),
    dept: text('dept').notNull(),
    assigneeId: text('assignee_id'),
    assigneeName: text('assignee_name'),
    dueAt: timestamp('due_at', { withTimezone: true }).notNull(),
    /** open · in_progress · blocked · done · cancelled */
    status: text('status').notNull().default('open'),
    /** normal · high */
    priority: text('priority').notNull().default('normal'),
    instructions: text('instructions'),
    blockedReason: text('blocked_reason'),
    autoRule: text('auto_rule'),
    promptKey: text('prompt_key'),
    /** unit_unavailable · repower_transload · notify_broker · unit_ready · other — set = a request to that department. */
    requestKind: text('request_kind'),
    requestPayload: jsonb('request_payload'),
    confirmedBy: text('confirmed_by'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    isTest: boolean('is_test').notNull().default(false),
    createdBy: text('created_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedBy: text('completed_by'),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    version: integer('version').notNull().default(1),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    legacyRef: text('legacy_ref'),
    legacyPayload: jsonb('legacy_payload'),
  },
  (t) => [
    index('safety_tasks_accident_idx').on(t.companyId, t.accidentId),
    index('safety_tasks_claim_idx').on(t.companyId, t.claimId),
    index('safety_tasks_open_idx').on(t.companyId, t.dueAt).where(sql`${t.status} not in ('done','cancelled')`),
    index('safety_tasks_assignee_idx').on(t.companyId, t.assigneeId, t.status),
  ],
);

export const safetyTaskUpdates = pgTable(
  'safety_task_updates',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    taskId: text('task_id')
      .notNull()
      .references(() => safetyTasks.id, { onDelete: 'restrict' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    byId: text('by_id'),
    byName: text('by_name').notNull(),
    text: text('text').notNull(),
  },
  (t) => [index('safety_task_updates_task_idx').on(t.companyId, t.taskId, t.at)],
);

/** Append-only (a trigger refuses UPDATE and DELETE). Event time and logged time are both kept. */
export const safetyTimelineEvents = pgTable(
  'safety_timeline_events',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    accidentId: text('accident_id').references(() => safetyAccidents.id, { onDelete: 'restrict' }),
    claimId: text('claim_id'),
    workOrderId: text('work_order_id'),
    occurredAt: timestamp('occurred_at', { withTimezone: true }).notNull(),
    loggedAt: timestamp('logged_at', { withTimezone: true }).notNull().defaultNow(),
    actorId: text('actor_id'),
    actorName: text('actor_name').notNull(),
    source: text('source').notNull(),
    /** milestone · change · note · task · access */
    kind: text('kind').notNull(),
    text: text('text').notNull(),
    restricted: boolean('restricted').notNull().default(false),
    before: jsonb('before'),
    after: jsonb('after'),
  },
  (t) => [
    index('safety_timeline_events_accident_idx').on(t.companyId, t.accidentId, t.occurredAt),
    index('safety_timeline_events_claim_idx').on(t.companyId, t.claimId, t.occurredAt),
  ],
);

export const downtimePeriods = pgTable(
  'downtime_periods',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    accidentId: text('accident_id')
      .notNull()
      .references(() => safetyAccidents.id, { onDelete: 'restrict' }),
    unitKind: text('unit_kind').notNull(),
    unitId: text('unit_id').notNull(),
    startedAt: timestamp('started_at', { withTimezone: true }).notNull(),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    /** daily_board · work_order · entered */
    source: text('source').notNull(),
    verifiedBy: text('verified_by'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    note: text('note'),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('downtime_periods_accident_idx').on(t.companyId, t.accidentId),
    index('downtime_periods_open_idx').on(t.companyId, t.unitKind, t.unitId).where(sql`${t.endedAt} is null`),
    uniqueIndex('downtime_periods_one_open_per_unit').on(t.companyId, t.accidentId, t.unitKind, t.unitId).where(sql`${t.endedAt} is null`),
  ],
);

export const safetySettings = pgTable(
  'safety_settings',
  {
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    value: jsonb('value').notNull(),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [primaryKey({ columns: [t.companyId, t.key] })],
);

/** Claim documents checklist (P2, 0070): the labels a coverage needs and whether each was received. */
export const safetyClaimDocuments = pgTable(
  'safety_claim_documents',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    claimId: text('claim_id')
      .notNull()
      .references(() => safetyClaims.id, { onDelete: 'restrict' }),
    label: text('label').notNull(),
    received: boolean('received').notNull().default(false),
    receivedAt: timestamp('received_at', { withTimezone: true }),
    receivedBy: text('received_by'),
    fileId: text('file_id'),
    sort: integer('sort').notNull().default(0),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('safety_claim_documents_label_key').on(t.companyId, t.claimId, t.label)],
);

/** Claim correspondence & notes (P2, 0070): what was said or sent, by whom, when. Never edited. */
export const safetyClaimLog = pgTable(
  'safety_claim_log',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    claimId: text('claim_id')
      .notNull()
      .references(() => safetyClaims.id, { onDelete: 'restrict' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    byId: text('by_id'),
    byName: text('by_name').notNull(),
    /** Email · Phone · Portal · Letter · Note */
    channel: text('channel').notNull(),
    text: text('text').notNull(),
  },
  (t) => [index('safety_claim_log_claim_idx').on(t.companyId, t.claimId, t.at)],
);

/** Repair estimates on a work order (P3, 0071). One selected estimate at most; approval lives on the work order. */
export const workOrderEstimates = pgTable(
  'work_order_estimates',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    workOrderId: text('work_order_id')
      .notNull()
      .references(() => workOrders.id, { onDelete: 'restrict' }),
    vendor: text('vendor').notNull(),
    amountCents: bigint('amount_cents', { mode: 'number' }).notNull(),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull(),
    selected: boolean('selected').notNull().default(false),
    fileId: text('file_id'),
    createdBy: text('created_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('work_order_estimates_wo_idx').on(t.companyId, t.workOrderId), uniqueIndex('work_order_estimates_one_selected').on(t.workOrderId).where(sql`${t.selected}`)],
);

/** A unit's status history (P3, 0071): written only when Dispatch confirms a request; the previous row is closed. */
export const unitStatusHistory = pgTable(
  'unit_status_history',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    unitKind: text('unit_kind').notNull(),
    unitId: text('unit_id').notNull(),
    status: text('status').notNull(),
    since: timestamp('since', { withTimezone: true }).notNull(),
    until: timestamp('until', { withTimezone: true }),
    setBy: text('set_by'),
    source: text('source').notNull().default('dispatch_confirmation'),
    accidentId: text('accident_id'),
    taskId: text('task_id'),
    note: text('note'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('unit_status_history_unit_idx').on(t.companyId, t.unitKind, t.unitId, t.since)],
);

export type AccidentUnitRow = typeof accidentUnits.$inferSelect;
export type AccidentRestrictedRow = typeof accidentRestricted.$inferSelect;
export type SafetyTaskRow = typeof safetyTasks.$inferSelect;
export type SafetyTaskUpdateRow = typeof safetyTaskUpdates.$inferSelect;
export type SafetyTimelineEventRow = typeof safetyTimelineEvents.$inferSelect;
export type DowntimePeriodRow = typeof downtimePeriods.$inferSelect;
export type SafetyClaimDocumentRow = typeof safetyClaimDocuments.$inferSelect;
export type SafetyClaimLogRow = typeof safetyClaimLog.$inferSelect;
export type WorkOrderEstimateRow = typeof workOrderEstimates.$inferSelect;

/* ------------------------------------------------------------------------------------------- P4 (0072) */

const ref = () => ({
  id: text('id').primaryKey(),
  companyId: text('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'restrict' }),
  accidentId: text('accident_id')
    .notNull()
    .references(() => safetyAccidents.id, { onDelete: 'restrict' }),
});

export const accidentOtherVehicles = pgTable('accident_other_vehicles', {
  ...ref(),
  description: text('description').notNull(),
  ownerName: text('owner_name'),
  driverName: text('driver_name'),
  insurer: text('insurer'),
  policyNo: text('policy_no'),
  plate: text('plate'),
  damage: text('damage'),
  towed: text('towed'),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

/** A witness; `contact` is restricted (redacted without accidents.restricted). */
export const accidentWitnesses = pgTable('accident_witnesses', {
  ...ref(),
  name: text('name').notNull(),
  contact: text('contact'),
  note: text('note'),
  statementDocumentId: text('statement_document_id'),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accidentFacts = pgTable('accident_facts', {
  ...ref(),
  text: text('text').notNull(),
  source: text('source').notNull(),
  provenance: text('provenance').notNull(),
  createdBy: text('created_by').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accidentQuestions = pgTable('accident_questions', {
  ...ref(),
  text: text('text').notNull(),
  ownerId: text('owner_id'),
  ownerName: text('owner_name'),
  answer: text('answer'),
  resolvedAt: timestamp('resolved_at', { withTimezone: true }),
  resolvedBy: text('resolved_by'),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accidentStatements = pgTable('accident_statements', {
  ...ref(),
  party: text('party').notNull(),
  kind: text('kind').notNull(),
  takenAt: timestamp('taken_at', { withTimezone: true }).notNull(),
  takenBy: text('taken_by').notNull(),
  summary: text('summary').notNull(),
  documentId: text('document_id'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
});

export const accidentFactors = pgTable('accident_factors', {
  ...ref(),
  category: text('category').notNull(),
  label: text('label').notNull(),
  level: text('level').notNull().default('possible'),
  version: integer('version').notNull().default(1),
  createdBy: text('created_by').notNull().default(''),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/** "Evidence reviewed" checklist items. */
export const accidentReviewItems = pgTable(
  'accident_review_items',
  {
    ...ref(),
    key: text('key').notNull(),
    label: text('label').notNull(),
    state: text('state').notNull().default('pending'),
    note: text('note'),
    restricted: boolean('restricted').notNull().default(false),
    sort: integer('sort').notNull().default(0),
    version: integer('version').notNull().default(1),
    updatedBy: text('updated_by'),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('accident_review_items_key').on(t.companyId, t.accidentId, t.key)],
);

/** Every successful read of restricted data by a permitted user (append-only). */
export const restrictedAccessLog = pgTable('restricted_access_log', {
  id: text('id').primaryKey(),
  companyId: text('company_id')
    .notNull()
    .references(() => companies.id, { onDelete: 'restrict' }),
  at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  actorId: text('actor_id').notNull(),
  actorName: text('actor_name'),
  accidentId: text('accident_id'),
  claimId: text('claim_id'),
  resource: text('resource').notNull(),
});

/** Immutable versions of a case document (DB trigger refuses UPDATE/DELETE). */
export const safetyDocumentVersions = pgTable(
  'safety_document_versions',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    documentId: text('document_id').notNull(),
    version: integer('version').notNull(),
    fileId: text('file_id').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    sha256: text('sha256').notNull(),
    note: text('note'),
    uploadedBy: text('uploaded_by').notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('safety_document_versions_key').on(t.documentId, t.version)],
);

export type AccidentOtherVehicleRow = typeof accidentOtherVehicles.$inferSelect;
export type AccidentWitnessRow = typeof accidentWitnesses.$inferSelect;
export type AccidentFactRow = typeof accidentFacts.$inferSelect;
export type AccidentQuestionRow = typeof accidentQuestions.$inferSelect;
export type AccidentStatementRow = typeof accidentStatements.$inferSelect;
export type AccidentFactorRow = typeof accidentFactors.$inferSelect;
export type AccidentReviewItemRow = typeof accidentReviewItems.$inferSelect;
export type SafetyDocumentVersionRow = typeof safetyDocumentVersions.$inferSelect;
export type UnitStatusHistoryRow = typeof unitStatusHistory.$inferSelect;
