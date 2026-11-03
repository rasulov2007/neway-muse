import { sql } from 'drizzle-orm';
import {
  boolean,
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
 * Driver Relations (migration 0043, owner brief 2026-10-06).
 *
 * One canonical request per driver conversation, an append-only activity log beside it, the
 * submissions that arrived through the public Driver Care page (idempotency and rate limits), the
 * Driver Care links that decide the company, and an outbox for notifications that are sent after
 * the request is committed. Every row carries `company_id` and every query filters by it.
 */

/** A public Driver Care address, `/care/<slug>`. The slug decides the company on the server. */
export const driverCareLinks = pgTable(
  'driver_care_links',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    slug: text('slug').notNull(),
    name: text('name').notNull(),
    active: boolean('active').notNull().default(true),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('driver_care_links_slug_key').on(table.slug),
    index('driver_care_links_company_idx').on(table.companyId),
  ],
);

export const driverRelationRequests = pgTable(
  'driver_relation_requests',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** DR-1001, per company. */
    requestNumber: text('request_number').notNull(),
    /** referral · complaint_feedback · reimbursement · pay_statement · compliance · management_call */
    topic: text('topic').notNull(),
    /** driver_care · staff */
    source: text('source').notNull(),
    careLinkId: text('care_link_id').references(() => driverCareLinks.id),
    /** Verified by staff; never resolved from the typed name. */
    driverId: text('driver_id'),
    truckId: text('truck_id'),
    verifiedBy: text('verified_by'),
    verifiedAt: timestamp('verified_at', { withTimezone: true }),
    submittedName: text('submitted_name').notNull(),
    truckSnapshot: text('truck_snapshot'),
    /** E.164; null for a referral, whose form asks no phone of the referrer. */
    contactPhone: text('contact_phone'),
    phoneKey: text('phone_key'),
    description: text('description').notNull(),
    payload: jsonb('payload').notNull(),
    /** new · contacted · resolved */
    status: text('status').notNull().default('new'),
    needsContact: boolean('needs_contact').notNull().default(true),
    /** Complaint & Feedback, or a call request about a confidential concern: driver_relations.confidential only. */
    confidential: boolean('confidential').notNull().default(false),
    /** Test data (owner, 2026-10-07): kept and audited, hidden from every list, count and thread. */
    isTest: boolean('is_test').notNull().default(false),
    testMarkedAt: timestamp('test_marked_at', { withTimezone: true }),
    testMarkedBy: text('test_marked_by'),
    testReason: text('test_reason'),
    assignedUserId: text('assigned_user_id'),
    assignedUserName: text('assigned_user_name'),
    assignedTeam: text('assigned_team').notNull().default('driver_relations'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
    lastDriverMessageAt: timestamp('last_driver_message_at', { withTimezone: true })
      .notNull()
      .defaultNow(),
    contactedAt: timestamp('contacted_at', { withTimezone: true }),
    contactedBy: text('contacted_by'),
    contactedByName: text('contacted_by_name'),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedBy: text('resolved_by'),
    resolvedByName: text('resolved_by_name'),
    /** The HR lead a referral created or joined (HR → Recruiting → Leads, source "referral"). */
    hrLeadId: text('hr_lead_id'),
    /** An Accounting reimbursement (an expense with a review block) linked by a person. */
    accountingExpenseId: text('accounting_expense_id'),
    version: integer('version').notNull().default(1),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('driver_relation_requests_number_key').on(table.companyId, table.requestNumber),
    uniqueIndex('driver_relation_requests_idem_key')
      .on(table.companyId, table.idempotencyKey)
      .where(sql`${table.idempotencyKey} is not null`),
    index('driver_relation_requests_alert_idx').on(table.companyId, table.needsContact, table.topic),
    index('driver_relation_requests_status_idx').on(table.companyId, table.status, table.receivedAt),
    index('driver_relation_requests_phone_idx').on(table.companyId, table.phoneKey, table.topic),
    index('driver_relation_requests_confidential_idx').on(table.companyId, table.confidential),
  ],
);

export type DriverRelationRequestRow = typeof driverRelationRequests.$inferSelect;

/** Append-only (a trigger refuses UPDATE and DELETE): corrections are new entries. */
export const driverRelationActivities = pgTable(
  'driver_relation_activities',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    requestId: text('request_id')
      .notNull()
      .references(() => driverRelationRequests.id),
    /** received · driver_message · assigned · attempt · contacted · note · correction · resolved · reopened · linked */
    type: text('type').notNull(),
    /** driver · staff · system */
    actorType: text('actor_type').notNull(),
    actorId: text('actor_id').notNull(),
    actorName: text('actor_name').notNull(),
    method: text('method'),
    note: text('note'),
    correctsActivityId: text('corrects_activity_id'),
    detail: jsonb('detail'),
    /** The request's version after this entry. */
    requestVersion: integer('request_version').notNull(),
    /** A submission key or other external id; unique per company so a retry lands once. */
    eventKey: text('event_key'),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index('driver_relation_activities_request_idx').on(table.companyId, table.requestId, table.at),
    uniqueIndex('driver_relation_activities_event_key')
      .on(table.companyId, table.eventKey)
      .where(sql`${table.eventKey} is not null`),
  ],
);

/** Every public submission: idempotency, durable rate limits, and what it became. */
export const driverCareSubmissions = pgTable(
  'driver_care_submissions',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    careLinkId: text('care_link_id')
      .notNull()
      .references(() => driverCareLinks.id),
    submissionKey: text('submission_key').notNull(),
    requestId: text('request_id')
      .notNull()
      .references(() => driverRelationRequests.id),
    /** new_request · thread_message */
    outcome: text('outcome').notNull(),
    topic: text('topic').notNull(),
    phoneKey: text('phone_key'),
    ipHash: text('ip_hash'),
    userAgent: text('user_agent'),
    receivedAt: timestamp('received_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('driver_care_submissions_key').on(table.companyId, table.submissionKey),
    index('driver_care_submissions_ip_idx').on(table.ipHash, table.receivedAt),
    index('driver_care_submissions_phone_idx').on(table.companyId, table.phoneKey, table.receivedAt),
  ],
);

/**
 * Notifications waiting to go out, written in the same transaction as the event they announce.
 * A failed send never touches the request; the row records the attempt and the next retry.
 */
export const driverRelationOutbox = pgTable(
  'driver_relation_outbox',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    requestId: text('request_id')
      .notNull()
      .references(() => driverRelationRequests.id),
    /** The activity this announces; with the adapter, the dedup key. */
    eventId: text('event_id').notNull(),
    eventType: text('event_type').notNull(),
    adapter: text('adapter').notNull(),
    /** pending · sent · failed · skipped */
    status: text('status').notNull().default('pending'),
    attempts: integer('attempts').notNull().default(0),
    retryAt: timestamp('retry_at', { withTimezone: true }).notNull().defaultNow(),
    lastError: text('last_error'),
    externalId: text('external_id'),
    sentAt: timestamp('sent_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('driver_relation_outbox_event_key').on(table.adapter, table.eventId),
    index('driver_relation_outbox_due_idx').on(table.status, table.retryAt),
    index('driver_relation_outbox_request_idx').on(table.companyId, table.requestId),
  ],
);

/**
 * Receipts a driver attached. The bytes live in private document storage under
 * driver-relations/<company>/<request>/<id>, never in stored_files (whose route any signed-in
 * account can read): the only way out is the permission-checked Driver Relations route.
 */
export const driverRelationAttachments = pgTable(
  'driver_relation_attachments',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    requestId: text('request_id')
      .notNull()
      .references(() => driverRelationRequests.id),
    /** The received or driver_message entry the file came with. */
    activityId: text('activity_id'),
    originalFileName: text('original_file_name').notNull(),
    /** Sniffed from the bytes, not taken from the browser. */
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull(),
    sha256: text('sha256').notNull(),
    storageKey: text('storage_key').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('driver_relation_attachments_request_idx').on(table.companyId, table.requestId)],
);
