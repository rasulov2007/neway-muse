import { relations, sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';

/**
 * The roster tables: companies, trucks, drivers.
 *
 * Ids are `text`, not generated uuids, because the operational records this fleet already carries
 * (loads, work orders, fuel, settlements) reference units as `trk_2785` and drivers as `drv_0142`.
 * Issuing new surrogate keys here would orphan every one of those references. New records get a new
 * id in the same sequence.
 *
 * Nothing is ever hard-deleted. A truck is sold and a driver is terminated; both keep their
 * operational history, which is what the audit, the settlement and the accident file all depend on.
 */

export const companies = pgTable('companies', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  timezone: text('timezone').notNull().default('America/New_York'),
  weekStart: text('week_start').notNull().default('monday'),
  /** Deactivated by a platform administrator: hidden, kept, reversible. Its people cannot sign in. */
  deactivatedAt: timestamp('deactivated_at', { withTimezone: true }),
  deactivatedReason: text('deactivated_reason'),
  deactivatedBy: text('deactivated_by'),
  /** Reply-To on recruiting / accounting emails (0079): the company's own mailbox. Null = none. */
  recruitingReplyTo: text('recruiting_reply_to'),
  accountingReplyTo: text('accounting_reply_to'),
  /** The prospective employer's confidential fax number on SPH requests (0080; set by Safety). */
  sphConfidentialFax: text('sph_confidential_fax'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const trucks = pgTable(
  'trucks',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    unitNumber: text('unit_number').notNull(),
    vin: text('vin').notNull(),
    year: integer('year').notNull(),
    make: text('make').notNull(),
    model: text('model').notNull(),
    plate: text('plate'),
    plateState: text('plate_state'),
    color: text('color'),
    status: text('status').notNull(),
    health: text('health').notNull(),
    ownership: text('ownership').notNull(),
    /** The customer's ownership group (NWF, Ryder, M&K): what a group PM plan keys on. */
    groupName: text('group_name'),
    /** `us` or `lessor`: who is responsible for the unit's PM (docs/pm-module §3.8). */
    pmResponsibility: text('pm_responsibility').notNull().default('us'),
    lessorName: text('lessor_name'),
    odometer: integer('odometer').notNull(),
    odometerAt: timestamp('odometer_at', { withTimezone: true }).notNull(),
    // numeric, not float: engine hours are billed against and must not drift.
    engineHours: numeric('engine_hours', { precision: 10, scale: 1 }).notNull(),
    inServiceDate: date('in_service_date'),
    currentDriverId: text('current_driver_id'),
    currentTrailerId: text('current_trailer_id'),
    currentLoadId: text('current_load_id'),
    location: jsonb('location'),
    nextServiceOdometer: integer('next_service_odometer').notNull(),
    nextServiceDate: date('next_service_date').notNull(),
    nextServiceType: text('next_service_type').notNull(),
    telematicsProvider: text('telematics_provider').notNull(),
    telematicsStatus: text('telematics_status').notNull(),
    /** Which integration account, and which vehicle in it, this truck is. Set by a sync. */
    telematicsAccountId: text('telematics_account_id'),
    telematicsExternalId: text('telematics_external_id'),
    telematicsSyncedAt: timestamp('telematics_synced_at', { withTimezone: true }),
    mpg30d: numeric('mpg_30d', { precision: 5, scale: 2 }).notNull().default('0'),
    mpg90d: numeric('mpg_90d', { precision: 5, scale: 2 }).notNull().default('0'),
    idlePercent30d: numeric('idle_percent_30d', { precision: 5, scale: 2 }).notNull().default('0'),
    idlePercent90d: numeric('idle_percent_90d', { precision: 5, scale: 2 }).notNull().default('0'),
    homeTerminal: text('home_terminal'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /** Accident & Claims v2 (0071): daily contribution for the lost-revenue estimate (not cash); null = settings fallback. */
    dailyContributionCents: bigint('daily_contribution_cents', { mode: 'number' }),
  },
  (table) => [
    // Two trucks cannot share a unit number or a VIN inside one carrier. Enforced here as well as
    // in the service, because a check that lives only in application code is a check that a second
    // caller can skip.
    uniqueIndex('trucks_company_unit_number_key').on(table.companyId, table.unitNumber),
    uniqueIndex('trucks_company_vin_key').on(table.companyId, sql`upper(${table.vin})`),
    index('trucks_company_status_idx').on(table.companyId, table.status),
    index('trucks_company_driver_idx').on(table.companyId, table.currentDriverId),
    index('trucks_telematics_external_idx').on(
      table.companyId,
      table.telematicsAccountId,
      table.telematicsExternalId,
    ),
  ],
);

export const drivers = pgTable(
  'drivers',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    driverNumber: text('driver_number').notNull(),
    /**
     * The workforce record for this person, when there is one.
     *
     * Nullable both ways round: an owner-operator drives under contract and is not an employee,
     * and most employees do not drive. The employee is the parent identity; this is the link back
     * to it, and it is the only join between the two — neither table copies the other's fields.
     */
    employeeId: text('employee_id'),
    firstName: text('first_name').notNull(),
    lastName: text('last_name').notNull(),
    phone: text('phone').notNull(),
    /** A second number and what it is (cell, home, spouse, dispatch-only); both optional. */
    secondaryPhone: text('secondary_phone'),
    secondaryPhoneLabel: text('secondary_phone_label'),
    email: text('email').notNull(),
    driverType: text('driver_type').notNull(),
    cdlState: text('cdl_state').notNull(),
    cdlClass: text('cdl_class').notNull(),
    cdlEndorsements: jsonb('cdl_endorsements')
      .notNull()
      .default(sql`'[]'::jsonb`),
    cdlExpiresOn: date('cdl_expires_on').notNull(),
    cdlStatus: text('cdl_status').notNull(),
    /*
     * Nullable on purpose. A driver file imported from a system that never held a medical-card
     * date arrives without one, and the honest record of that is an empty column beside a
     * `missing` status - not a date somebody invented to satisfy a constraint.
     */
    medicalCardExpiresOn: date('medical_card_expires_on'),
    medicalCardStatus: text('medical_card_status').notNull(),
    /**
     * Date of birth (migration 0075, owner 2026-10-25). Nullable: drivers already on the roster
     * have none recorded. Personal data, kept with the licence group for masking.
     */
    dateOfBirth: date('date_of_birth'),
    hireDate: date('hire_date').notNull(),
    status: text('status').notNull(),
    dispatcherId: text('dispatcher_id').notNull(),
    dispatcherName: text('dispatcher_name').notNull(),
    currentTruckId: text('current_truck_id'),
    currentTrailerId: text('current_trailer_id'),
    homeCity: text('home_city').notNull(),
    homeState: text('home_state').notNull(),
    safetyScore: numeric('safety_score', { precision: 5, scale: 1 }).notNull().default('100'),
    safetyEvents30d: integer('safety_events_30d').notNull().default(0),
    payPlanKind: text('pay_plan_kind').notNull(),
    /** Null until the rate is known; zero would read as a driver who is paid nothing. */
    payPlanRate: numeric('pay_plan_rate', { precision: 8, scale: 4 }),
    preferredLanguage: text('preferred_language').notNull().default('en'),
    /**
     * Archived (migration 0039, owner 2026-10-02): hidden from the Drivers page and every driver
     * picker, kept, reversible, audited. The status is left as it was; restoring clears all three.
     */
    archivedAt: timestamp('archived_at', { withTimezone: true }),
    archivedReason: text('archived_reason'),
    archivedBy: text('archived_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('drivers_company_number_key').on(table.companyId, table.driverNumber),
    uniqueIndex('drivers_company_email_key').on(table.companyId, sql`lower(${table.email})`),
    index('drivers_company_status_idx').on(table.companyId, table.status),
    index('drivers_company_truck_idx').on(table.companyId, table.currentTruckId),
    index('drivers_company_employee_idx').on(table.companyId, table.employeeId),
  ],
);

/**
 * A truck knows its driver and a driver knows its truck. Both sides are written in one transaction
 * so the pairing cannot end up disagreeing with itself; `flag_unpaired` in the seed check proves it.
 */
export const truckRelations = relations(trucks, ({ one }) => ({
  company: one(companies, { fields: [trucks.companyId], references: [companies.id] }),
  driver: one(drivers, { fields: [trucks.currentDriverId], references: [drivers.id] }),
}));

export const driverRelations = relations(drivers, ({ one }) => ({
  company: one(companies, { fields: [drivers.companyId], references: [companies.id] }),
  truck: one(trucks, { fields: [drivers.currentTruckId], references: [trucks.id] }),
}));

export const companyRelations = relations(companies, ({ many }) => ({
  trucks: many(trucks),
  drivers: many(drivers),
}));

export type TruckRow = typeof trucks.$inferSelect;
export type NewTruckRow = typeof trucks.$inferInsert;
export type DriverRow = typeof drivers.$inferSelect;

/** One vacation per row (0062): open while ended_on is null; the days away decide the return test. */
export const driverVacations = pgTable(
  'driver_vacations',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    driverId: text('driver_id').notNull(),
    startedOn: date('started_on').notNull(),
    endedOn: date('ended_on'),
    note: text('note'),
    startedBy: text('started_by').notNull().default(''),
    endedBy: text('ended_by'),
    /** Planned; never ends the vacation by itself (0063). */
    expectedReturnOn: date('expected_return_on'),
    version: integer('version').notNull().default(1),
    /** A vacation entered by mistake is cancelled with a reason, never deleted (0063). */
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    cancelledBy: text('cancelled_by'),
    cancelReason: text('cancel_reason'),
    /** A request from the driver app (0081, used from M3): requested · approved · rejected · cancelled; null = entered by the office. */
    requestStatus: text('request_status'),
    requestedAt: timestamp('requested_at', { withTimezone: true }),
    requestedByDriver: boolean('requested_by_driver').notNull().default(false),
    decidedBy: text('decided_by'),
    decidedAt: timestamp('decided_at', { withTimezone: true }),
    decidedReason: text('decided_reason'),
    truckParkedAt: timestamp('truck_parked_at', { withTimezone: true }),
    truckParkedBy: text('truck_parked_by'),
    truckParkedNote: text('truck_parked_note'),
    keysHandedAt: timestamp('keys_handed_at', { withTimezone: true }),
    /** 0082: the last day the driver asked for (a request's `startedOn` is its first day). */
    requestedEndOn: date('requested_end_on'),
    /** 0082: the driver's photo of the parked truck (stored_files), and who confirmed it: driver · office. */
    truckParkedFileId: text('truck_parked_file_id'),
    truckParkedSource: text('truck_parked_source'),
    keysHandedBy: text('keys_handed_by'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('driver_vacations_driver_idx').on(t.companyId, t.driverId, t.startedOn)],
);
export type DriverVacationRow = typeof driverVacations.$inferSelect;

/**
 * Team or Solo (0074, owner 2026-10-25): one row per driver per pairing, both sides sharing
 * `pair_id`. Open while ended_on is null (at most one per driver, by the unique index); ended_on
 * is the first solo day. Never deleted.
 */
export const driverTeams = pgTable(
  'driver_teams',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id').notNull(),
    pairId: text('pair_id').notNull(),
    driverId: text('driver_id').notNull(),
    partnerId: text('partner_id').notNull(),
    startedOn: date('started_on').notNull(),
    endedOn: date('ended_on'),
    note: text('note'),
    startedBy: text('started_by').notNull().default(''),
    endedBy: text('ended_by'),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    endReason: text('end_reason'),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('driver_teams_open_key').on(t.companyId, t.driverId).where(sql`${t.endedOn} IS NULL`),
    index('driver_teams_driver_idx').on(t.companyId, t.driverId, t.startedOn),
    index('driver_teams_pair_idx').on(t.companyId, t.pairId),
  ],
);
export type DriverTeamRow = typeof driverTeams.$inferSelect;
export type NewDriverRow = typeof drivers.$inferInsert;

/**
 * How a driver is paid (2026-09-21): method, payee, bank and account, currency, frequency and the
 * signed authorization. Account and routing numbers never leave the server unmasked.
 */
export const driverPaymentDetails = pgTable(
  'driver_payment_details',
  {
    driverId: text('driver_id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    paymentMethod: text('payment_method').notNull(),
    payeeName: text('payee_name'),
    bankName: text('bank_name'),
    accountType: text('account_type'),
    routingNumber: text('routing_number'),
    accountNumber: text('account_number'),
    currency: text('currency').notNull().default('USD'),
    payFrequency: text('pay_frequency').notNull().default('weekly'),
    authorizationFileId: text('authorization_file_id'),
    authorizationFileName: text('authorization_file_name'),
    version: integer('version').notNull().default(1),
    updatedBy: text('updated_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('driver_payment_details_company_idx').on(t.companyId)],
);
