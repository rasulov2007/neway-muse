import { date, index, integer, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { companies } from './roster';

/**
 * Company info (owner, 2026-10-19). One profile row per company - the fields brokers and the W-9
 * ask for, the addresses and the trailer yards - kept as one versioned record so a stale save is
 * refused, never merged. Migration 0066.
 */
export const companyProfiles = pgTable('company_profiles', {
  companyId: text('company_id')
    .primaryKey()
    .references(() => companies.id, { onDelete: 'restrict' }),
  record: jsonb('record').notNull().default({}),
  version: integer('version').notNull().default(1),
  updatedBy: text('updated_by'),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

/**
 * The company's own papers: W-9, MC authority, certificate of insurance, NOA … Every upload is a
 * row; a newer one of the same kind replaces it on the page and both stay. Void, never delete.
 */
export const companyDocuments = pgTable(
  'company_documents',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    kind: text('kind').notNull(),
    title: text('title').notNull().default(''),
    fileId: text('file_id').notNull(),
    fileName: text('file_name').notNull().default(''),
    issuedOn: date('issued_on'),
    expiresOn: date('expires_on'),
    note: text('note'),
    uploadedBy: text('uploaded_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
  },
  (t) => [index('company_documents_company_kind_idx').on(t.companyId, t.kind)],
);
