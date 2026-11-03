import { boolean, index, integer, jsonb, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { companies } from './roster';

/**
 * Loads (migration 0033).
 *
 * The columns are what the server enforces, filters and joins on. `record` is the whole load
 * document as the application reads it - stops, documents, notes, timeline, money - so the shape
 * the screens and the pure rules already work on is stored whole, and a field-by-field comparison
 * with the snapshot it replaced can be exact. Every write bumps `version`; a write that names an
 * older version is refused, which is how two dispatchers editing one load find out.
 */
export const loads = pgTable(
  'loads',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    loadNumber: text('load_number').notNull(),
    status: text('status').notNull(),
    dispatcherId: text('dispatcher_id').notNull().default(''),
    /** The second owner of a rolling load (rule 1.7); null until somebody is named. */
    updaterId: text('updater_id'),
    driverId: text('driver_id'),
    truckId: text('truck_id'),
    trailerId: text('trailer_id'),
    /** Seeded or generated rather than booked: hidden from every screen and count by default. */
    isDemo: boolean('is_demo').notNull().default(false),
    version: integer('version').notNull().default(1),
    record: jsonb('record').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('loads_company_number_key').on(t.companyId, t.loadNumber),
    index('loads_company_status_idx').on(t.companyId, t.status),
    index('loads_company_driver_idx').on(t.companyId, t.driverId),
    index('loads_company_truck_idx').on(t.companyId, t.truckId),
    index('loads_company_updated_idx').on(t.companyId, t.updatedAt),
  ],
);

export type LoadRow = typeof loads.$inferSelect;
