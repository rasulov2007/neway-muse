import { index, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { companies } from './roster';

/**
 * Saved report configurations.
 *
 * A saved report stores the *configuration*, never the results: filters, grouping, sort and range.
 * Reopening it re-runs the report against current data, which is the only behaviour that makes
 * sense — a stored result set is a screenshot that quietly goes stale and then gets quoted in a
 * meeting.
 */
export const savedReports = pgTable(
  'saved_reports',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    reportKey: text('report_key').notNull(),
    /** Filters, grouping, sort and date range — everything needed to reproduce the view. */
    config: jsonb('config').notNull(),
    ownerUserId: text('owner_user_id'),
    ownerName: text('owner_name').notNull(),
    lastRunAt: timestamp('last_run_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('saved_reports_company_name_key').on(table.companyId, table.name),
    index('saved_reports_company_report_idx').on(table.companyId, table.reportKey),
  ],
);

export type SavedReportRow = typeof savedReports.$inferSelect;
