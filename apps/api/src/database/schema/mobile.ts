import { sql } from 'drizzle-orm';
import { bigint, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { memberships, users } from './admin';
import { companies } from './roster';

/**
 * The NeWay mobile app (migration 0081, docs/mobile/PLAN.md §C).
 *
 * M1 uses `mobile_devices`, `mobile_idempotency` and `mobile_push_log`; M3 (0082) uses
 * `fleet_breakdowns` and `driver_app_submissions`. The conversation tables are for M4.
 */

/** An Expo push token registered by a signed-in membership. Revoked on logout; never deleted. */
export const mobileDevices = pgTable(
  'mobile_devices',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    membershipId: text('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'restrict' }),
    userId: text('user_id')
      .notNull()
      .references(() => users.id, { onDelete: 'restrict' }),
    /** The auth session that registered it: logging that session out revokes the device. */
    sessionId: text('session_id'),
    expoToken: text('expo_token').notNull(),
    /** ios · android */
    platform: text('platform').notNull(),
    appVersion: text('app_version'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    lastSeenAt: timestamp('last_seen_at', { withTimezone: true }).notNull().defaultNow(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    uniqueIndex('mobile_devices_live_token_key')
      .on(t.membershipId, t.expoToken)
      .where(sql`${t.revokedAt} is null`),
    index('mobile_devices_user_idx').on(t.companyId, t.userId),
  ],
);

/**
 * The first answer to a mobile write, by (company, membership, Idempotency-Key). A retry of the
 * same key gets this answer back instead of a second record.
 */
export const mobileIdempotency = pgTable(
  'mobile_idempotency',
  {
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    membershipId: text('membership_id')
      .notNull()
      .references(() => memberships.id, { onDelete: 'restrict' }),
    key: text('key').notNull(),
    /** `POST /driver/loads/:id/documents` — a key reused on another route is refused. */
    route: text('route').notNull(),
    statusCode: integer('status_code').notNull().default(200),
    /** Null while the first request is still running. */
    response: jsonb('response'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
  },
  (t) => [uniqueIndex('mobile_idempotency_key').on(t.companyId, t.membershipId, t.key)],
);

/** One push attempt per device per notification. */
export const mobilePushLog = pgTable(
  'mobile_push_log',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    notificationId: text('notification_id').notNull(),
    deviceId: text('device_id').notNull(),
    /** sent · error */
    status: text('status').notNull(),
    error: text('error'),
    ticketId: text('ticket_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('mobile_push_log_notification_idx').on(t.companyId, t.notificationId)],
);

// ------------------------------------------------------------------ later phases (created in 0081)

export const conversations = pgTable(
  'conversations',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** load · case · request · direct · department */
    kind: text('kind').notNull(),
    subjectType: text('subject_type'),
    subjectId: text('subject_id'),
    department: text('department'),
    title: text('title').notNull().default(''),
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('conversations_subject_idx').on(t.companyId, t.subjectType, t.subjectId)],
);

export const conversationParticipants = pgTable(
  'conversation_participants',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict' }),
    userId: text('user_id'),
    driverId: text('driver_id'),
    role: text('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
    lastReadAt: timestamp('last_read_at', { withTimezone: true }),
    leftAt: timestamp('left_at', { withTimezone: true }),
  },
  (t) => [
    index('conversation_participants_conversation_idx').on(t.conversationId),
    index('conversation_participants_user_idx').on(t.companyId, t.userId),
  ],
);

export const messages = pgTable(
  'messages',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => conversations.id, { onDelete: 'restrict' }),
    senderUserId: text('sender_user_id'),
    senderDriverId: text('sender_driver_id'),
    body: text('body').notNull().default(''),
    /** stored_files ids. */
    attachments: jsonb('attachments')
      .notNull()
      .default(sql`'[]'::jsonb`),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
  },
  (t) => [
    index('messages_conversation_idx').on(t.conversationId, t.createdAt),
    uniqueIndex('messages_idempotency_key')
      .on(t.companyId, t.conversationId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

export const fleetBreakdowns = pgTable(
  'fleet_breakdowns',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** BD-0001 */
    number: text('number').notNull(),
    driverId: text('driver_id'),
    truckId: text('truck_id'),
    trailerId: text('trailer_id'),
    loadId: text('load_id'),
    category: text('category').notNull(),
    description: text('description').notNull().default(''),
    /** { text, lat, lng, source, captured_at } */
    location: jsonb('location'),
    /** received · assigned · shop_arranged · in_repair · ready · closed */
    status: text('status').notNull().default('received'),
    assignedUserId: text('assigned_user_id'),
    assignedUserName: text('assigned_user_name'),
    vendorId: text('vendor_id'),
    /** 0082: the shop's name as chosen (the vendor row may be renamed later). */
    vendorName: text('vendor_name'),
    workOrderId: text('work_order_id'),
    estimateCents: bigint('estimate_cents', { mode: 'number' }),
    /** 0082: the flag this breakdown opened on its load (load_problems), closed with the case. */
    loadProblemId: text('load_problem_id'),
    files: jsonb('files')
      .notNull()
      .default(sql`'[]'::jsonb`),
    history: jsonb('history')
      .notNull()
      .default(sql`'[]'::jsonb`),
    source: text('source').notNull().default('driver_app'),
    idempotencyKey: text('idempotency_key'),
    createdByUserId: text('created_by_user_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('fleet_breakdowns_number_key').on(t.companyId, t.number),
    index('fleet_breakdowns_status_idx').on(t.companyId, t.status),
    index('fleet_breakdowns_driver_idx').on(t.companyId, t.driverId),
    uniqueIndex('fleet_breakdowns_idempotency_key')
      .on(t.companyId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);

/**
 * A pointer from the driver to a record the app filed in another module's table (0082): a
 * company-card receipt (a draft Fleet expense) or a safety report (an accident, a roadside
 * inspection or a Driver Relations request). It lets "my receipts" and "my reports" list exactly
 * the driver's own records without trusting anything the phone sends.
 */
export const driverAppSubmissions = pgTable(
  'driver_app_submissions',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    driverId: text('driver_id').notNull(),
    membershipId: text('membership_id'),
    /** company_expense · safety_report */
    kind: text('kind').notNull(),
    subkind: text('subkind'),
    /** fleet_expense · accident · roadside_inspection · driver_relation_request */
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    targetNumber: text('target_number'),
    detail: jsonb('detail')
      .notNull()
      .default(sql`'{}'::jsonb`),
    idempotencyKey: text('idempotency_key'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    index('driver_app_submissions_driver_idx').on(t.companyId, t.driverId, t.kind, t.createdAt),
    uniqueIndex('driver_app_submissions_idempotency_key')
      .on(t.companyId, t.driverId, t.idempotencyKey)
      .where(sql`${t.idempotencyKey} is not null`),
  ],
);
