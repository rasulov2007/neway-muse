import { index, integer, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { loads } from './loads';
import { companies } from './roster';

/**
 * Flags on loads (migration 0034, business rule 1.10).
 *
 * A flag is a person saying "this load needs a person". It is open until somebody closes it
 * with a note saying what was done, and the load stays in front of everybody until then.
 * Closed flags are kept.
 */
export const loadProblems = pgTable(
  'load_problems',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    loadId: text('load_id')
      .notNull()
      .references(() => loads.id, { onDelete: 'restrict' }),
    loadNumber: text('load_number').notNull(),
    kind: text('kind').notNull(),
    note: text('note').notNull(),
    openedById: text('opened_by_id').notNull(),
    openedByName: text('opened_by_name').notNull(),
    openedAt: timestamp('opened_at', { withTimezone: true }).notNull().defaultNow(),
    closedById: text('closed_by_id'),
    closedByName: text('closed_by_name'),
    closedAt: timestamp('closed_at', { withTimezone: true }),
    closeNote: text('close_note'),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    index('load_problems_company_open_idx').on(t.companyId, t.closedAt),
    index('load_problems_load_idx').on(t.loadId),
  ],
);

export type LoadProblemRow = typeof loadProblems.$inferSelect;
