import { bigint, boolean, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { companies } from './roster';

/**
 * NeWay AI (owner, 2026-10-20). Conversations belong to one person in one company and are never
 * shown to anyone else; switching company shows that company's chats only. Migration 0067.
 */
export const aiConversations = pgTable(
  'ai_conversations',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    userId: text('user_id').notNull(),
    title: text('title').notNull().default('New chat'),
    model: text('model').notNull(),
    /** Nothing a confirmed proposal would do runs while this is on (default on). */
    dryRun: boolean('dry_run').notNull().default(true),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    archivedAt: timestamp('archived_at', { withTimezone: true }),
  },
  (t) => [index('ai_conversations_owner_idx').on(t.companyId, t.userId, t.updatedAt)],
);

/**
 * One message as the person saw it (text and cards), plus the API turn it came from (`api`) so
 * the next request carries the conversation - tool calls and results included.
 */
export const aiMessages = pgTable(
  'ai_messages',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    conversationId: text('conversation_id')
      .notNull()
      .references(() => aiConversations.id, { onDelete: 'restrict' }),
    role: text('role').notNull(),
    text: text('text').notNull().default(''),
    cards: jsonb('cards').notNull().default([]),
    attachments: jsonb('attachments').notNull().default([]),
    api: jsonb('api').notNull().default([]),
    model: text('model'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_messages_conversation_idx').on(t.conversationId, t.createdAt)],
);

/**
 * What the assistant proposes to do, stored so the confirmation is bound to exactly these
 * records, versions and destination - and re-checked when it runs. `fingerprint` names what it
 * would do, so the same action proposed twice is recognised as the same.
 */
export const aiProposals = pgTable(
  'ai_proposals',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    userId: text('user_id').notNull(),
    conversationId: text('conversation_id').notNull(),
    action: text('action').notNull(),
    params: jsonb('params').notNull(),
    card: jsonb('card').notNull(),
    status: text('status').notNull().default('awaiting'),
    fingerprint: text('fingerprint').notNull(),
    result: jsonb('result'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedBy: text('decided_by'),
  },
  (t) => [index('ai_proposals_conversation_idx').on(t.conversationId)],
);

/** Every model call's tokens and cost, for the monthly cap. */
export const aiUsage = pgTable(
  'ai_usage',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    userId: text('user_id').notNull(),
    conversationId: text('conversation_id'),
    model: text('model').notNull(),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    /** Millionths of a dollar. */
    costMicros: bigint('cost_micros', { mode: 'number' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('ai_usage_company_idx').on(t.companyId, t.createdAt)],
);
