import { relations, sql } from 'drizzle-orm';
import {
  date,
  index,
  jsonb,
  numeric,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
} from 'drizzle-orm/pg-core';
import { companies, drivers } from './roster';

/**
 * Staff: employees and the two histories that make an employment record defensible.
 *
 * Shapes follow docs/DATABASE.md §3.3, which was committed before this module was written and
 * already specifies every Phase 11 table (recruiting, onboarding, attendance, PTO, performance) as
 * keying on `employee_id`. That id is therefore a published contract: it may be referenced by
 * tables that do not exist yet and must never be reissued.
 *
 * `manager_employee_id` is self-referential and deliberately `ON DELETE SET NULL`-free: employees
 * are not deleted, so the question does not arise. Losing a manager happens through reassignment,
 * which is recorded, not through a cascade, which is not.
 */

export const employees = pgTable(
  'employees',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    employeeNumber: text('employee_number').notNull(),
    firstName: text('first_name').notNull(),
    middleName: text('middle_name'),
    lastName: text('last_name').notNull(),
    preferredName: text('preferred_name'),
    workEmail: text('work_email').notNull(),
    personalEmail: text('personal_email'),
    phone: text('phone').notNull(),
    secondaryPhone: text('secondary_phone'),
    department: text('department').notNull(),
    /**
     * The department record, once Administration owns them. The `department` text column above is
     * kept and still authoritative for existing readers — dropping it would break the workforce,
     * reporting and analytics queries that read it today.
     */
    departmentId: text('department_id'),
    position: text('position').notNull(),
    managerEmployeeId: text('manager_employee_id'),
    location: text('location'),
    hireDate: date('hire_date').notNull(),
    terminationDate: date('termination_date'),
    status: text('status').notNull(),
    employmentType: text('employment_type').notNull(),
    // Nullable on purpose: a driver's compensation is the pay plan on their driving profile, and a
    // copy here would be a second answer to the question "what is this person paid".
    payType: text('pay_type'),
    payRate: numeric('pay_rate', { precision: 12, scale: 2 }),
    timezone: text('timezone').notNull().default('America/New_York'),
    /** The sign-in account, when this person has one. Most drivers do not. */
    userId: text('user_id'),
    emergencyContact: jsonb('emergency_contact'),
    notes: text('notes'),
    /** Personal data (0077): masked for readers without the sensitive personnel codes. */
    dateOfBirth: date('date_of_birth'),
    /** Passport / ID number (0077). Personal data, masked like the date of birth. */
    idNumber: text('id_number'),
    homeAddress: text('home_address'),
    /** Free text, e.g. "6 PM – 6 AM Eastern" (0077). */
    shiftTime: text('shift_time'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('employees_company_number_key').on(table.companyId, table.employeeNumber),
    uniqueIndex('employees_company_work_email_key').on(
      table.companyId,
      sql`lower(${table.workEmail})`,
    ),
    index('employees_company_status_idx').on(table.companyId, table.status),
    index('employees_company_department_idx').on(table.companyId, table.department),
    index('employees_company_manager_idx').on(table.companyId, table.managerEmployeeId),
  ],
);

/**
 * Who someone was, not just who they are.
 *
 * A role change closes the open row and opens a new one; it never overwrites. "Dispatcher until
 * March, Operations Manager since" is a question a payroll dispute, an insurance audit and an
 * unemployment claim all ask, and an employment record that only holds the present cannot answer it.
 */
export const positionHistory = pgTable(
  'position_history',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    employeeId: text('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    position: text('position').notNull(),
    department: text('department').notNull(),
    /**
     * The department record, once Administration owns them. The `department` text column above is
     * kept and still authoritative for existing readers — dropping it would break the workforce,
     * reporting and analytics queries that read it today.
     */
    departmentId: text('department_id'),
    managerEmployeeId: text('manager_employee_id'),
    location: text('location'),
    effectiveFrom: date('effective_from').notNull(),
    /** Null means this is the current assignment. Exactly one open row per employee. */
    effectiveTo: date('effective_to'),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('position_history_employee_idx').on(table.employeeId, table.effectiveFrom)],
);

export const compensationHistory = pgTable(
  'compensation_history',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    employeeId: text('employee_id')
      .notNull()
      .references(() => employees.id, { onDelete: 'restrict' }),
    payType: text('pay_type').notNull(),
    payRate: numeric('pay_rate', { precision: 12, scale: 2 }).notNull(),
    effectiveFrom: date('effective_from').notNull(),
    reason: text('reason'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index('compensation_history_employee_idx').on(table.employeeId, table.effectiveFrom)],
);

/**
 * The audit log, in the shape docs/DATABASE.md §3.16 commits.
 *
 * This is the durable half of an audit trail that until now existed only as session state in the
 * browser. It is deliberately generic — `entity_type` / `entity_id` — so that it is the one audit
 * architecture for the whole product rather than a second one owned by People.
 */
export const auditLogs = pgTable(
  'audit_logs',
  {
    id: text('id').primaryKey(),
    companyId: text('company_id')
      .notNull()
      .references(() => companies.id, { onDelete: 'restrict' }),
    at: timestamp('at', { withTimezone: true }).notNull().defaultNow(),
    actorType: text('actor_type').notNull().default('user'),
    actorId: text('actor_id'),
    actorName: text('actor_name').notNull(),
    action: text('action').notNull(),
    entityType: text('entity_type').notNull(),
    entityId: text('entity_id').notNull(),
    entityLabel: text('entity_label').notNull(),
    /** `[{field, old, new}]` — the shape the committed schema specifies. */
    changes: jsonb('changes')
      .notNull()
      .default(sql`'[]'::jsonb`),
    summary: text('summary').notNull(),
    reason: text('reason'),
  },
  (table) => [
    index('audit_logs_entity_idx').on(table.companyId, table.entityType, table.entityId, table.at),
  ],
);

export const employeeRelations = relations(employees, ({ one, many }) => ({
  company: one(companies, { fields: [employees.companyId], references: [companies.id] }),
  manager: one(employees, {
    fields: [employees.managerEmployeeId],
    references: [employees.id],
    relationName: 'manager',
  }),
  driver: one(drivers, { fields: [employees.id], references: [drivers.employeeId] }),
  positions: many(positionHistory),
  compensation: many(compensationHistory),
}));

export const positionHistoryRelations = relations(positionHistory, ({ one }) => ({
  employee: one(employees, {
    fields: [positionHistory.employeeId],
    references: [employees.id],
  }),
}));

export const compensationHistoryRelations = relations(compensationHistory, ({ one }) => ({
  employee: one(employees, {
    fields: [compensationHistory.employeeId],
    references: [employees.id],
  }),
}));

export type EmployeeRow = typeof employees.$inferSelect;
export type NewEmployeeRow = typeof employees.$inferInsert;
export type PositionHistoryRow = typeof positionHistory.$inferSelect;
export type CompensationHistoryRow = typeof compensationHistory.$inferSelect;
export type AuditLogRow = typeof auditLogs.$inferSelect;
