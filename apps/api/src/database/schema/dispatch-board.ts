import { date, index, integer, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { companies } from './roster';

/**
 * The dispatch boards' typed layer (owner's brief, 2026-09-22).
 *
 * The loads say what a driver's day is; these tables hold what a person typed over it - a
 * status, a trailer number, an ETA, a weekly amount - one row per driver, day and column. A
 * row with a null value is an explicit empty: the automatic value stays hidden. A cell that is
 * not here shows the automatic value. Yesterday's typed cells carry into today by being the
 * latest row on or before the day, so nothing is copied at midnight and a value keeps the
 * timestamp it was typed at.
 */
export const dispatchBoardCells = pgTable(
  'dispatch_board_cells',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    driverId: text('driver_id').notNull(),
    day: date('day').notNull(),
    column: text('column').notNull(),
    value: text('value'),
    formula: text('formula'),
    setBy: text('set_by').notNull(),
    setByName: text('set_by_name').notNull().default(''),
    setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [
    uniqueIndex('dispatch_board_cells_key').on(t.companyId, t.driverId, t.day, t.column),
    index('dispatch_board_cells_day_idx').on(t.companyId, t.day),
  ],
);

/** A Sheets tint on a cell, stored so everyone sees it. Tint 0 rows are deleted. */
export const dispatchBoardFills = pgTable(
  'dispatch_board_fills',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    driverId: text('driver_id').notNull(),
    day: date('day').notNull(),
    column: text('column').notNull(),
    tint: integer('tint').notNull(),
    setBy: text('set_by').notNull(),
    setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('dispatch_board_fills_key').on(t.companyId, t.driverId, t.day, t.column)],
);

/** Every typed change, newest first on the history popup; the basis of undo. Never edited. */
export const dispatchBoardEdits = pgTable(
  'dispatch_board_edits',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    driverId: text('driver_id').notNull(),
    day: date('day').notNull(),
    column: text('column').notNull(),
    oldValue: text('old_value'),
    newValue: text('new_value'),
    by: text('by').notNull(),
    byName: text('by_name').notNull().default(''),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    source: text('source').notNull().default('user'),
  },
  (t) => [index('dispatch_board_edits_driver_idx').on(t.companyId, t.driverId, t.at)],
);
