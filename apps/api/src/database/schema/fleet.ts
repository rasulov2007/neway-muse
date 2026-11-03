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
import { sql } from 'drizzle-orm';
import { companies } from './roster';

/**
 * The fleet's maintenance records, as real rows.
 *
 * Work orders and trailers used to live as JSON inside `app_state`, a key-value blob the browser
 * wrote whole. That made three things impossible at once. The API could not filter what it
 * returned, so every signed-in account received every invoice total in one response; a migration
 * could not touch a work order, because there was no column to alter; and two people saving in the
 * same minute overwrote each other's work, because the unit of writing was the entire workspace.
 *
 * These tables end that. The blob is still read once, by the migration that copies out of it, and
 * nothing in it is deleted.
 */

/** Trucks live in `trucks`; a trailer is its own unit and needs to be addressable by a key. */
export const trailers = pgTable(
  'trailers',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    unitNumber: text('unit_number').notNull(),
    vin: text('vin').notNull().default(''),
    year: integer('year'),
    make: text('make'),
    /** Added 2026-10-22 (0073); null for every trailer recorded before it. */
    model: text('model'),
    /** Dry van, reefer, flatbed — the workspace's own vocabulary, kept as written. */
    type: text('type').notNull().default('dry_van'),
    lengthFt: integer('length_ft'),
    plate: text('plate'),
    plateState: text('plate_state'),
    status: text('status').notNull().default('available'),
    ownership: text('ownership').notNull().default('owned'),
    currentTruckId: text('current_truck_id'),
    currentLoadId: text('current_load_id'),
    /** The annual inspection date the trailer carries. A trailer has no odometer. */
    nextInspectionDate: text('next_inspection_date'),
    homeTerminal: text('home_terminal'),
    /*
     * Where the row came from. `source` names the system it was imported out of and
     * `externalId` is that system's own key, so a second import run recognises its own work and
     * updates it instead of creating a twin. A trailer somebody typed here carries neither.
     */
    source: text('source'),
    externalId: text('external_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    uniqueIndex('trailers_company_unit_number_key').on(t.companyId, t.unitNumber),
    index('trailers_company_idx').on(t.companyId),
  ],
);

/**
 * A work order, against a truck or a trailer.
 *
 * `status` is two values, not six. The shop either has the unit or it is finished, and the six-way
 * status it replaces was carrying two different facts at once: where the work stands, and how far
 * along the shop is. The second is `shop_stage`, which is what a mechanic actually changes during
 * the day, and every change to it is written to `work_order_actions` rather than overwriting the
 * last one.
 *
 * `title` is nullable on purpose. It was a required field that people filled with whatever made
 * the form submit; the label a page shows is now built from the unit and the work type.
 */
export const workOrders = pgTable(
  'work_orders',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** `RO-2026-1041`, kept from the workspace so links and conversations still resolve. */
    number: text('number').notNull(),
    assetType: text('asset_type').notNull(),
    /** The truck or trailer id. Not a foreign key: it points at one of two tables. */
    unitId: text('unit_id').notNull(),
    /** Denormalised so a list reads without a join, and survives a unit being renumbered. */
    unitNumber: text('unit_number').notNull().default(''),
    /** `in_shop` or `completed`. */
    status: text('status').notNull(),
    /** Diagnosing, waiting for approval, waiting for parts, in repair, quality check, ready. */
    shopStage: text('shop_stage'),
    workType: text('work_type').notNull(),
    /** What the shop did. Optional while the unit is in, required to complete. */
    workDone: text('work_done'),
    /** The old free-text field. Nullable: records written before it went away still carry one. */
    title: text('title'),
    shopInAt: timestamp('shop_in_at', { withTimezone: true }).notNull(),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Frozen at completion: completedAt − shopInAt, so a closed record's downtime never moves. */
    downtimeMinutes: integer('downtime_minutes'),
    /** Odometer at the shop visit. Null on a trailer, which has none. */
    odometer: integer('odometer'),
    assignedTo: text('assigned_to'),
    vendorId: text('vendor_id'),
    vendorName: text('vendor_name').notNull().default(''),
    /*
     * Money.
     *
     * Held here because the work order is where an invoice lands, and served only to accounts
     * holding the cost permission — the serialiser omits these fields entirely rather than
     * blanking them, so a mechanic's response has no shape for a total to hide in.
     */
    partsTotal: numeric('parts_total', { precision: 12, scale: 2 }).notNull().default('0'),
    laborTotal: numeric('labor_total', { precision: 12, scale: 2 }).notNull().default('0'),
    feesTotal: numeric('fees_total', { precision: 12, scale: 2 }).notNull().default('0'),
    total: numeric('total', { precision: 12, scale: 2 }).notNull().default('0'),
    invoiceNumber: text('invoice_number'),
    /** File rows in `stored_files`, by id. */
    invoiceFileIds: jsonb('invoice_file_ids').notNull().default([]),
    /** The walk-around defect this order was opened for, when it was (pti_defects.id). */
    defectId: text('defect_id'),
    /**
     * A PM completion (docs/pm-module §3.5): the service this order resets, the odometer read at
     * the service and when it happened. Only a row with `pmServiceCode` is a baseline.
     */
    pmServiceCode: text('pm_service_code'),
    serviceAt: timestamp('service_at', { withTimezone: true }),
    serviceOdometer: integer('service_odometer'),
    /** record_repair · work_order_form · migration · import */
    enteredVia: text('entered_via'),
    /** The invoice's own total, as given; null when the record has none (a missing cost is missing). */
    invoiceTotal: numeric('invoice_total', { precision: 12, scale: 2 }),
    invoiceDate: date('invoice_date'),
    /** Imported spend from before the product: kept on the record, never posted as new spend. */
    historic: boolean('historic').notNull().default(false),
    /** What a person should look at: cost_missing, shop_missing, sheet_arithmetic_stale, … */
    flags: jsonb('flags').notNull().default([]),
    /*
     * The appointment (docs/pm-module §3.7): the same record in status `scheduled`, before the
     * unit arrives. Booking never touches the due status.
     */
    scheduledFor: timestamp('scheduled_for', { withTimezone: true }),
    responsibleUserId: text('responsible_user_id'),
    responsibleName: text('responsible_name'),
    estimatedCost: numeric('estimated_cost', { precision: 12, scale: 2 }),
    noteForShop: text('note_for_shop'),
    notifyDriver: boolean('notify_driver').notNull().default(true),
    notifyDispatcher: boolean('notify_dispatcher').notNull().default(true),
    holdMinutes: integer('hold_minutes'),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    /** Why a completion cost $0: lease · warranty · goodwill · in_house (§6.2). */
    zeroReason: text('zero_reason'),
    /*
     * Who pays (2026-09-24): `company` - an ordinary company expense - or `driver`, charged back
     * to the person. A driver charge only reaches accounting once `driverInformed` is true; while
     * it is false the order carries the `driver_not_informed` flag and the money is held.
     */
    chargeParty: text('charge_party').notNull().default('company'),
    /** How the invoice is settled (0057): 'company_paid' | 'pay_later'; null when not said. */
    paymentTerms: text('payment_terms'),
    chargeDriverId: text('charge_driver_id'),
    chargeDriverName: text('charge_driver_name'),
    driverInformed: boolean('driver_informed'),
    driverInformedAt: timestamp('driver_informed_at', { withTimezone: true }),
    driverInformedBy: text('driver_informed_by'),
    /** A voided completion stays, marked (§6.3); it is no longer a baseline. */
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
    notes: text('notes'),
    /** Set when the workspace JSON was its origin, so a migrated row is never mistaken for entry. */
    migratedFrom: text('migrated_from'),
    createdBy: text('created_by').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    /*
     * Accident & Claims v2 (0071): the accident case the repair belongs to (many per case), the estimates policy
     * (more than the threshold needs N estimates) and the approval with its policy-exception reason. Read and written
     * only by the accidents_v2 endpoints; the shop stage and completion stay this module's own.
     */
    accidentId: text('accident_id'),
    estimatesRequired: integer('estimates_required'),
    approvedCents: bigint('approved_cents', { mode: 'number' }),
    approvedEstimateId: text('approved_estimate_id'),
    approvedBy: text('approved_by'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    policyExceptionReason: text('policy_exception_reason'),
    eta: timestamp('eta', { withTimezone: true }),
  },
  (t) => [
    uniqueIndex('work_orders_company_number_key').on(t.companyId, t.number),
    index('work_orders_accident_idx').on(t.companyId, t.accidentId).where(sql`${t.accidentId} is not null`),
    index('work_orders_company_status_idx').on(t.companyId, t.status),
    index('work_orders_unit_idx').on(t.companyId, t.unitId),
  ],
);

/**
 * Every stage change and note on a work order, newest last.
 *
 * A stage that is only ever overwritten answers "where is it now" and nothing else. The question
 * people actually ask about a truck that has been in a shop for nine days is what has happened to
 * it, and who last heard anything — which is a list, not a field.
 */
export const workOrderActions = pgTable(
  'work_order_actions',
  {
    id: text('id').primaryKey(),
    workOrderId: text('work_order_id')
      .notNull()
      .references(() => workOrders.id, { onDelete: 'cascade' }),
    /** The stage as of this entry, or null for a note that changed nothing. */
    stage: text('stage'),
    note: text('note'),
    /** What happened: `stage_changed`, `note_added`, `completed`, `reopened`, `created`. */
    action: text('action').notNull().default('stage_changed'),
    userId: text('user_id'),
    userName: text('user_name').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('work_order_actions_order_idx').on(t.workOrderId, t.createdAt)],
);

/**
 * Per-unit service intervals, where a unit differs from the company default.
 *
 * One row per unit and only for the ones somebody has set, so the absence of a row means "use the
 * default" rather than "nobody knows". The defaults themselves are company settings, not constants
 * in code, because a carrier changes them and should not need a deploy to do it.
 */
export const unitMaintenanceSettings = pgTable(
  'unit_maintenance_settings',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    assetType: text('asset_type').notNull(),
    unitId: text('unit_id').notNull(),
    oilChangeIntervalMiles: integer('oil_change_interval_miles'),
    pmIntervalMiles: integer('pm_interval_miles'),
    pmIntervalDays: integer('pm_interval_days'),
    annualInspectionMonths: integer('annual_inspection_months'),
    /** Baseline for a unit with no oil-change history yet. */
    lastOilChangeAt: timestamp('last_oil_change_at', { withTimezone: true }),
    lastOilChangeOdometer: integer('last_oil_change_odometer'),
    lastPmAt: timestamp('last_pm_at', { withTimezone: true }),
    lastPmOdometer: integer('last_pm_odometer'),
    lastAnnualInspectionAt: timestamp('last_annual_inspection_at', { withTimezone: true }),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [uniqueIndex('unit_maintenance_settings_unit_key').on(t.companyId, t.assetType, t.unitId)],
);

/**
 * Shops, as records (docs/pm-module §3.6). A picker chooses one; free text is not accepted. The
 * normalized address is what the importer deduplicates on; a draft is an address it could not
 * match, listed for a person to confirm or merge.
 */
export const vendors = pgTable(
  'vendors',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    name: text('name').notNull(),
    /** shop · lessor · other */
    kind: text('kind').notNull().default('shop'),
    addressLine: text('address_line'),
    city: text('city'),
    state: text('state'),
    zip: text('zip'),
    addressNorm: text('address_norm'),
    isOwnYard: boolean('is_own_yard').notNull().default(false),
    paymentTermsDays: integer('payment_terms_days'),
    /** active · draft · inactive */
    status: text('status').notNull().default('active'),
    /** user · import · migration */
    source: text('source').notNull().default('user'),
    legacyVendorId: text('legacy_vendor_id'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    version: integer('version').notNull().default(1),
  },
  (t) => [index('vendors_company_idx').on(t.companyId, t.status)],
);

/** A line on a work order: what was done, under which system, for how much (Fleet package §3.6). */
export const workOrderLines = pgTable(
  'work_order_lines',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    workOrderId: text('work_order_id')
      .notNull()
      .references(() => workOrders.id, { onDelete: 'cascade' }),
    systemCode: text('system_code').notNull(),
    /** repair · pm · tires · fee · other */
    lineKind: text('line_kind').notNull().default('repair'),
    description: text('description'),
    partsAmount: numeric('parts_amount', { precision: 12, scale: 2 }),
    laborAmount: numeric('labor_amount', { precision: 12, scale: 2 }),
    laborHours: numeric('labor_hours', { precision: 8, scale: 2 }),
    totalAmount: numeric('total_amount', { precision: 12, scale: 2 }).notNull().default('0'),
    pmServiceCode: text('pm_service_code'),
    sort: integer('sort').notNull().default(0),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [index('work_order_lines_order_idx').on(t.workOrderId, t.sort)],
);

/**
 * Who is in a truck, since when, and what went with it (2026-09-21).
 *
 * `trucks.current_driver_id` is the pointer; this is the record behind it. A row closes with
 * `ended_on` when the driver leaves or is replaced, and is never deleted.
 */
export const truckDriverAssignments = pgTable(
  'truck_driver_assignments',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    truckId: text('truck_id').notNull(),
    driverId: text('driver_id').notNull(),
    assignedOn: date('assigned_on').notNull(),
    endedOn: date('ended_on'),
    /** [{ item, label, detail, handedOver }] — tablet, GPS and whatever else rides with the unit. */
    equipment: jsonb('equipment').notNull().default([]),
    note: text('note'),
    version: integer('version').notNull().default(1),
    createdBy: text('created_by').notNull().default(''),
    createdByName: text('created_by_name').notNull().default(''),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    endedBy: text('ended_by'),
    endReason: text('end_reason'),
    /** True when the start date was reconstructed (backfill 0047), shown as "about <date>". */
    assignedOnApproximate: boolean('assigned_on_approximate').notNull().default(false),
    /** truck_page · driver_page · truck_create · backfill — where the row came from. */
    source: text('source').notNull().default('truck_page'),
    /** What came back with the unit at drop: [{ item, label, detail, handedOver }] (handedOver = returned). */
    returnedEquipment: jsonb('returned_equipment'),
    dropNote: text('drop_note'),
    endedByName: text('ended_by_name'),
    endedAt: timestamp('ended_at', { withTimezone: true }),
    updatedBy: text('updated_by'),
    updatedByName: text('updated_by_name'),
  },
  (t) => [
    index('truck_driver_assignments_truck_idx').on(t.companyId, t.truckId, t.endedOn),
    index('truck_driver_assignments_driver_idx').on(t.companyId, t.driverId, t.endedOn),
    // One open row per truck and per driver (0047): the database, not the code, keeps the rule.
    uniqueIndex('truck_driver_assignments_open_truck_key')
      .on(t.companyId, t.truckId)
      .where(sql`${t.endedOn} IS NULL`),
    uniqueIndex('truck_driver_assignments_open_driver_key')
      .on(t.companyId, t.driverId)
      .where(sql`${t.endedOn} IS NULL`),
  ],
);

/** Pickup and drop photos of an assignment (0047). Removing one voids it; nothing is deleted. */
export const truckAssignmentPhotos = pgTable(
  'truck_assignment_photos',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    assignmentId: text('assignment_id')
      .notNull()
      .references(() => truckDriverAssignments.id, { onDelete: 'restrict' }),
    /** pickup · drop */
    stage: text('stage').notNull(),
    fileId: text('file_id').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type').notNull(),
    uploadedBy: text('uploaded_by').notNull(),
    uploadedByName: text('uploaded_by_name').notNull(),
    uploadedAt: timestamp('uploaded_at', { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
  },
  (t) => [index('truck_assignment_photos_assignment_idx').on(t.companyId, t.assignmentId)],
);

/**
 * A fleet expense entered by hand (0052): parking, truck wash, tolls and the like. Repairs are not
 * stored here; completed work orders are projected into the expense views. The accounting columns
 * point at the existing bill, payment, driver charge or reimbursement, never at a copy.
 */
export const fleetExpenses = pgTable(
  'fleet_expenses',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    /** EXP-00001, per company. */
    reference: text('reference').notNull(),
    /** draft · recorded · void */
    status: text('status').notNull().default('recorded'),
    truckId: text('truck_id').notNull(),
    unitNumber: text('unit_number').notNull(),
    category: text('category').notNull(),
    expenseDate: date('expense_date').notNull(),
    amountCents: integer('amount_cents').notNull().default(0),
    vendorId: text('vendor_id'),
    vendorName: text('vendor_name'),
    invoiceNumber: text('invoice_number'),
    description: text('description'),
    notes: text('notes'),
    placeName: text('place_name'),
    address: text('address'),
    city: text('city'),
    state: text('state'),
    postalCode: text('postal_code'),
    /** company · driver · owner */
    paidBy: text('paid_by').notNull(),
    payerDriverId: text('payer_driver_id'),
    payerName: text('payer_name'),
    paymentMethod: text('payment_method'),
    paid: boolean('paid').notNull().default(true),
    paymentReference: text('payment_reference'),
    /** company · driver · owner */
    chargeTo: text('charge_to').notNull(),
    chargeDriverId: text('charge_driver_id'),
    chargeDriverName: text('charge_driver_name'),
    chargeCents: integer('charge_cents'),
    chargeReason: text('charge_reason'),
    deductFromSettlement: boolean('deduct_from_settlement').notNull().default(false),
    /** The full EFS code, sealed with the credential vault; only the last four are ever shown. */
    efsCodeSealed: jsonb('efs_code_sealed'),
    efsCodeLast4: text('efs_code_last4'),
    efsIssuedOn: date('efs_issued_on'),
    efsIssuedCents: integer('efs_issued_cents'),
    efsUsedCents: integer('efs_used_cents'),
    efsStatus: text('efs_status'),
    efsReceiptFileId: text('efs_receipt_file_id'),
    acctExpenseId: text('acct_expense_id'),
    acctBillId: text('acct_bill_id'),
    driverTxId: text('driver_tx_id'),
    reimbursementId: text('reimbursement_id'),
    postedAt: timestamp('posted_at', { withTimezone: true }),
    postedBy: text('posted_by'),
    notDuplicateOf: text('not_duplicate_of'),
    isTest: boolean('is_test').notNull().default(false),
    version: integer('version').notNull().default(1),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    createdBy: text('created_by').notNull(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    updatedBy: text('updated_by').notNull(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
  },
  (t) => [
    uniqueIndex('fleet_expenses_company_reference_key').on(t.companyId, t.reference),
    index('fleet_expenses_truck_idx').on(t.companyId, t.truckId, t.expenseDate),
    index('fleet_expenses_date_idx').on(t.companyId, t.expenseDate),
    index('fleet_expenses_charge_driver_idx').on(t.companyId, t.chargeDriverId),
  ],
);

/** Files on a fleet expense (0052). Removing one unlinks it; the stored file is kept. */
export const fleetExpenseFiles = pgTable(
  'fleet_expense_files',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    expenseId: text('expense_id')
      .notNull()
      .references(() => fleetExpenses.id, { onDelete: 'restrict' }),
    fileId: text('file_id').notNull(),
    fileName: text('file_name').notNull(),
    contentType: text('content_type'),
    /** receipt · invoice · efs_receipt · other */
    kind: text('kind').notNull().default('receipt'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    addedBy: text('added_by').notNull(),
    removedAt: timestamp('removed_at', { withTimezone: true }),
    removedBy: text('removed_by'),
    removeReason: text('remove_reason'),
  },
  (t) => [
    index('fleet_expense_files_expense_idx').on(t.companyId, t.expenseId),
    uniqueIndex('fleet_expense_files_live_key').on(t.expenseId, t.fileId).where(sql`${t.removedAt} IS NULL`),
  ],
);

/**
 * Tire positions a repair touched (0058; owner brief, 2026-10-13). `record_kind` + `record_id`
 * name the spend record (a work order, a service record or a fleet expense); `position_id` is one
 * of the 18 positions in @neway/shared's tire layout, or UNASSIGNED. Parsed rows are re-read when
 * the description changes; a manual tag replaces them. Voided, never deleted.
 */
export const repairTireEvents = pgTable(
  'repair_tire_events',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    recordKind: text('record_kind').notNull(),
    recordId: text('record_id').notNull(),
    unitId: text('unit_id').notNull().default(''),
    unitKind: text('unit_kind'),
    positionId: text('position_id').notNull(),
    eventType: text('event_type').notNull(),
    quantity: integer('quantity').notNull().default(1),
    allocatedCostCents: integer('allocated_cost_cents').notNull().default(0),
    source: text('source').notNull(),
    confidence: numeric('confidence', { precision: 3, scale: 2 }).notNull().default('1'),
    note: text('note'),
    parsedFrom: text('parsed_from'),
    /** Tire work order details (0060): new · used · repair · valve · rotate, and what the tire was. */
    action: text('action'),
    brand: text('brand'),
    model: text('model'),
    reason: text('reason'),
    treadRemoved32: numeric('tread_removed_32', { precision: 4, scale: 1 }),
    tireCostCents: integer('tire_cost_cents'),
    laborCents: integer('labor_cents'),
    odometer: integer('odometer'),
    vendorName: text('vendor_name'),
    /** The unit whose work order carried it, when the tire belongs to another (a trailer's tire). */
    recordedOnUnitId: text('recorded_on_unit_id'),
    eventOn: date('event_on'),
    createdBy: text('created_by').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    voidedAt: timestamp('voided_at', { withTimezone: true }),
    voidedBy: text('voided_by'),
    voidReason: text('void_reason'),
  },
  (t) => [index('repair_tire_events_record_idx').on(t.companyId, t.recordKind, t.recordId)],
);
