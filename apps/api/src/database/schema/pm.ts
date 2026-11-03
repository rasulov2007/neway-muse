import { boolean, date, index, integer, numeric, pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { companies } from './roster';

/**
 * Oil change / PM (docs/pm-module/02-pm-spec.md §3).
 *
 * The service catalog, the intervals, the odometer history and the cached verdict. The verdict is
 * written only by the calculation service; every screen reads it, so two screens cannot disagree
 * about the same truck. Nothing here is deleted: a plan is voided, a reading is voided, a status
 * is recomputed.
 */

export const pmServices = pgTable(
  'pm_services',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    code: text('code').notNull(),
    name: text('name').notNull(),
    resetsInterval: boolean('resets_interval').notNull().default(true),
    defaultIntervalMiles: integer('default_interval_miles'),
    defaultIntervalDays: integer('default_interval_days'),
    defaultIntervalHours: integer('default_interval_hours'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('pm_services_code_key').on(t.companyId, t.code)],
);

export const pmPlans = pgTable(
  'pm_plans',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    serviceCode: text('service_code').notNull(),
    /** `group` or `unit`. A unit plan always wins over its group plan. */
    scope: text('scope').notNull(),
    groupName: text('group_name'),
    unitId: text('unit_id'),
    intervalMiles: integer('interval_miles').notNull(),
    intervalDays: integer('interval_days'),
    intervalHours: integer('interval_hours'),
    dueSoonMiles: integer('due_soon_miles'),
    dueSoonDays: integer('due_soon_days'),
    reason: text('reason'),
    setBy: text('set_by').notNull(),
    setByName: text('set_by_name').notNull().default(''),
    setAt: timestamp('set_at', { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [index('pm_plans_company_idx').on(t.companyId, t.serviceCode)],
);

export const odometerReadings = pgTable(
  'odometer_readings',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    unitId: text('unit_id').notNull(),
    readingAt: timestamp('reading_at', { withTimezone: true }).notNull(),
    /** The calendar date of the reading in the company's timezone. */
    readingDate: date('reading_date').notNull(),
    odometerMiles: integer('odometer_miles').notNull(),
    engineHours: numeric('engine_hours', { precision: 10, scale: 1 }),
    /** eld · invoice · manual · import */
    source: text('source').notNull(),
    /** ok · conflict · void */
    status: text('status').notNull().default('ok'),
    conflictReason: text('conflict_reason'),
    conflictWith: integer('conflict_with'),
    photoId: text('photo_id'),
    note: text('note'),
    /** Imported without an export time: a last known value that never yields a due status. */
    ageUnknown: boolean('age_unknown').notNull().default(false),
    createdBy: text('created_by').notNull(),
    createdByName: text('created_by_name').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidReason: text('void_reason'),
  },
  (t) => [index('odometer_readings_unit_idx').on(t.companyId, t.unitId, t.readingAt)],
);

export const pmStatus = pgTable(
  'pm_status',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    unitId: text('unit_id').notNull(),
    serviceCode: text('service_code').notNull(),
    lastServiceId: text('last_service_id'),
    lastServiceAt: timestamp('last_service_at', { withTimezone: true }),
    lastServiceOdometer: integer('last_service_odometer'),
    lastServiceSource: text('last_service_source'),
    intervalMiles: integer('interval_miles'),
    intervalDays: integer('interval_days'),
    intervalHours: integer('interval_hours'),
    planOrigin: text('plan_origin'),
    planId: text('plan_id'),
    dueSoonMiles: integer('due_soon_miles'),
    dueSoonDays: integer('due_soon_days'),
    nextServiceOdometer: integer('next_service_odometer'),
    nextServiceDate: date('next_service_date'),
    milesSinceService: integer('miles_since_service'),
    milesRemaining: integer('miles_remaining'),
    daysSinceService: integer('days_since_service'),
    daysRemaining: integer('days_remaining'),
    avgMilesPerDay: numeric('avg_miles_per_day', { precision: 10, scale: 1 }),
    avgBasis: text('avg_basis'),
    estimatedDueDate: date('estimated_due_date'),
    dueStatus: text('due_status').notNull(),
    dueBasis: text('due_basis'),
    milesOverAtReading: integer('miles_over_at_reading'),
    readingId: text('reading_id'),
    readingAt: timestamp('reading_at', { withTimezone: true }),
    readingOdometer: integer('reading_odometer'),
    readingSource: text('reading_source'),
    readingAgeHours: numeric('reading_age_hours', { precision: 10, scale: 1 }),
    readingStale: boolean('reading_stale').notNull().default(false),
    readingAgeUnknown: boolean('reading_age_unknown').notNull().default(false),
    computedAt: timestamp('computed_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('pm_status_unit_service_key').on(t.companyId, t.unitId, t.serviceCode),
    index('pm_status_due_idx').on(t.companyId, t.serviceCode, t.dueStatus),
  ],
);
