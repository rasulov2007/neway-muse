import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { companies } from './roster';

/**
 * Bytes people attach to records that still live in the workspace snapshot (work order invoices,
 * load paperwork).
 *
 * They used to be base64 inside the snapshot itself, which made every save and every boot carry
 * every file ever uploaded. The row is the index; the bytes sit in document storage under
 * `storageKey`, exactly like compliance documents.
 */
export const storedFiles = pgTable(
  'stored_files',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    sizeBytes: integer('size_bytes').notNull().default(0),
    storageKey: text('storage_key').notNull(),
    uploadedBy: text('uploaded_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /** Soft delete (0076): an administrator's, for an unattached file only. The bytes are never removed. */
    deletedAt: timestamp('deleted_at', { withTimezone: true }),
    deletedBy: text('deleted_by'),
    deleteReason: text('delete_reason'),
  },
  (t) => [
    index('stored_files_company_idx').on(t.companyId),
    index('stored_files_company_deleted_idx').on(t.companyId, t.deletedAt),
  ],
);
