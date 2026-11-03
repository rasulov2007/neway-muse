import { z } from 'zod';
import { isIsoCalendarDate } from '../dates.js';

/**
 * The employee: this carrier's workforce identity.
 *
 * Three things in this system describe a person and none of them is interchangeable with another:
 *
 *   User      an account that can sign in.       Not every employee has one.
 *   Employee  a person the company employs.      This record.
 *   Driver    a commercial driving profile.      Not every employee has one; a driver need not
 *                                                be an employee (an owner-operator is a contractor).
 *
 * The employee is the parent. `userId` points at the account when there is one, `drivers.employee_id`
 * points back here when the person drives. Keeping them apart is what lets an employee be Active
 * while their driver availability is Off duty and their login is Disabled — three true statements
 * about the same person at the same moment.
 *
 * The shape follows the contract already committed in docs/DATABASE.md §3.3 rather than a new one,
 * including the two history tables, because Phase 11 (recruiting, onboarding, attendance, PTO,
 * performance) is specified there as keying on `employee_id`. That id is the stable reference those
 * modules will use and nothing here may change it.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const dateOfBirthField = isoDate.refine((v) => isIsoCalendarDate(v), 'Date of birth is not a valid date');

/**
 * Employment lifecycle.
 *
 * `active`, `on_leave` and `terminated` come from the committed schema. `suspended` and `archived`
 * are added for the deactivate and archive actions: suspension is a temporary stop with the job
 * still held, archival removes someone from working lists without ending their history. There is
 * deliberately no `deleted` — an employee with operational history is never destroyed.
 */
export const EMPLOYEE_STATUSES = [
  'active',
  'on_leave',
  'suspended',
  'terminated',
  'archived',
] as const;
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number];

/** Statuses that mean this person is not currently working. Hidden from the list unless asked. */
export const INACTIVE_EMPLOYEE_STATUSES: readonly EmployeeStatus[] = ['terminated', 'archived'];

export const EMPLOYMENT_TYPES = ['full_time', 'part_time', 'contractor', 'temporary'] as const;
export type EmploymentType = (typeof EMPLOYMENT_TYPES)[number];

/**
 * Departments, reusing the set the rest of the application already uses rather than introducing a
 * parallel vocabulary. `dispatch` is what the brief calls Operations and `management` is what it
 * calls Administration; renaming them here would leave two names for one department.
 */
export const EMPLOYEE_DEPARTMENTS = [
  'dispatch',
  'safety',
  'maintenance',
  'accounting',
  'hr',
  'fleet',
  'management',
  // Every request from the Driver Care page (owner, 2026-10-06).
  'driver_relations',
] as const;
export type EmployeeDepartment = (typeof EMPLOYEE_DEPARTMENTS)[number];

export const DEPARTMENT_LABELS: Record<EmployeeDepartment, string> = {
  dispatch: 'Dispatch',
  safety: 'Safety',
  maintenance: 'Maintenance',
  accounting: 'Accounting',
  hr: 'Human Resources',
  fleet: 'Fleet',
  management: 'Administration',
  driver_relations: 'Driver Relations',
};

/**
 * Positions are stored as text, not as an enum, because a carrier renames and invents job titles
 * and should not need a migration to do it. This list is what the create form offers; a position
 * outside it is accepted.
 */
export const COMMON_POSITIONS = [
  'Driver',
  'Dispatcher',
  'Updater',
  'Safety Manager',
  'Safety Coordinator',
  'Maintenance Manager',
  'Mechanic',
  'Accountant',
  'Payroll Specialist',
  'HR Manager',
  'Recruiter',
  'Operations Manager',
  'Administrator',
] as const;

/**
 * How a person is paid.
 *
 * `null` is a real answer and the common one for drivers: their compensation is the pay plan on the
 * driver profile, and settlement is calculated from it. Copying that rate here would create a second
 * number that can disagree with the one the driver is actually paid by.
 */
export const PAY_TYPES = ['salary', 'hourly', 'commission'] as const;
export type PayType = (typeof PAY_TYPES)[number];

/**
 * What each pay type is called on screen (owner, 2026-10-26). `salary` is the fixed weekly base and
 * is shown as "Fixed"; the stored value is unchanged so no history row has to be rewritten.
 */
export const PAY_TYPE_LABELS: Record<PayType, string> = {
  commission: 'Commission (KPI)',
  salary: 'Fixed',
  hourly: 'Hourly',
};

/**
 * The pay type follows the department (owner, 2026-10-26): Dispatch is paid on commission (the KPI
 * pay plan), every other department is Fixed. It is not a choice on any form, and the server
 * refuses a pay type that disagrees with the department.
 */
export function payTypeForDepartment(department: EmployeeDepartment): 'commission' | 'salary' {
  return department === 'dispatch' ? 'commission' : 'salary';
}

/** Drivers are paid from the pay plan on their driver profile, never from the employee record. */
export function isDriverPosition(position: string | null | undefined): boolean {
  return (position ?? '').trim() === 'Driver';
}

/**
 * The pay type an employee row must carry, or why the one asked for is refused. `requested`
 * undefined / null means "derive it". A driver row carries none.
 */
export function resolvePayType(input: {
  department: EmployeeDepartment;
  position?: string | null;
  requested?: PayType | null;
}): { ok: true; payType: PayType | null } | { ok: false; message: string } {
  if (isDriverPosition(input.position)) {
    return input.requested == null
      ? { ok: true, payType: null }
      : { ok: false, message: 'Drivers are paid from the pay plan on their driver profile, not a pay type here.' };
  }
  const expected = payTypeForDepartment(input.department);
  if (input.requested == null || input.requested === expected) return { ok: true, payType: expected };
  return {
    ok: false,
    message: `${DEPARTMENT_LABELS[input.department]} is paid ${PAY_TYPE_LABELS[expected]}; ${PAY_TYPE_LABELS[input.requested]} is not allowed for this department.`,
  };
}

export const EmployeeSchema = z.object({
  id: z.string(),
  employeeNumber: z.string(),
  firstName: z.string(),
  middleName: z.string().nullable(),
  lastName: z.string(),
  preferredName: z.string().nullable(),
  name: z.string(),
  workEmail: z.string(),
  personalEmail: z.string().nullable(),
  phone: z.string(),
  secondaryPhone: z.string().nullable(),
  department: z.enum(EMPLOYEE_DEPARTMENTS),
  position: z.string(),
  managerEmployeeId: z.string().nullable(),
  /** Denormalised for display only; the relationship is `managerEmployeeId`. */
  managerName: z.string().nullable(),
  location: z.string().nullable(),
  hireDate: isoDate,
  terminationDate: isoDate.nullable(),
  status: z.enum(EMPLOYEE_STATUSES),
  employmentType: z.enum(EMPLOYMENT_TYPES),
  payType: z.enum(PAY_TYPES).nullable(),
  /** Null when no rate is recorded here. Never zero, which would read as "unpaid". */
  payRate: z.number().nullable(),
  timezone: z.string(),
  /** The sign-in account, when this person has one. Most drivers do not. */
  userId: z.string().nullable(),
  /** The driving profile, when this person drives. Set from the driver side. */
  driverId: z.string().nullable(),
  emergencyContactName: z.string().nullable(),
  emergencyContactPhone: z.string().nullable(),
  emergencyContactRelationship: z.string().nullable(),
  notes: z.string().nullable(),
  /**
   * Whether this person has filled in Complete your profile (owner, 2026-10-26). Only set on the
   * list when it was asked for with `scope`: `complete` = their account submitted the profile,
   * `asked` = they have an account that has not submitted it, `no_account` = no sign-in yet.
   */
  profileState: z.enum(['complete', 'asked', 'no_account']).optional(),
  /** Personal data (2026-10-26). Null for readers without the sensitive personnel codes. */
  dateOfBirth: z.string().nullable().optional(),
  /** Passport / ID number. Masked like the date of birth. */
  idNumber: z.string().nullable().optional(),
  homeAddress: z.string().nullable().optional(),
  /** Free text, e.g. "6 PM – 6 AM Eastern". */
  shiftTime: z.string().nullable().optional(),
  /** True when the date of birth and ID number were withheld from this reader. */
  personalMasked: z.boolean().optional(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type EmployeeRecord = z.infer<typeof EmployeeSchema>;

export const CreateEmployeeSchema = z.object({
  firstName: z.string().trim().min(1, 'First name is required').max(40),
  middleName: z.string().trim().max(40).nullable().default(null),
  lastName: z.string().trim().min(1, 'Last name is required').max(40),
  preferredName: z.string().trim().max(40).nullable().default(null),
  workEmail: z.email('That is not a valid email address'),
  personalEmail: z
    .union([z.email(), z.literal('')])
    .nullable()
    .default(null),
  phone: z.string().trim().min(7, 'A contact number is required').max(20),
  secondaryPhone: z.string().trim().max(20).nullable().default(null),
  department: z.enum(EMPLOYEE_DEPARTMENTS),
  /** The title. Optional since 2026-10-26; no title is stored as ''. */
  position: z.string().trim().max(60).default(''),
  managerEmployeeId: z.string().nullable().default(null),
  location: z.string().trim().max(60).nullable().default(null),
  hireDate: isoDate,
  employmentType: z.enum(EMPLOYMENT_TYPES),
  payType: z.enum(PAY_TYPES).nullable().default(null),
  payRate: z.number().positive().nullable().default(null),
  timezone: z.string().trim().max(60).default('America/Chicago'),
  emergencyContactName: z.string().trim().max(80).nullable().default(null),
  emergencyContactPhone: z.string().trim().max(20).nullable().default(null),
  emergencyContactRelationship: z.string().trim().max(40).nullable().default(null),
  notes: z.string().trim().max(2000).nullable().default(null),
  dateOfBirth: dateOfBirthField.nullable().optional(),
  idNumber: z.string().trim().max(40).nullable().optional(),
  homeAddress: z.string().trim().max(200).nullable().optional(),
  shiftTime: z.string().trim().max(60).nullable().optional(),
});
export type CreateEmployeeRequest = z.infer<typeof CreateEmployeeSchema>;

/**
 * The Create employee dialog (owner, 2026-10-26): the same record with Shift time required. The
 * driver and hiring paths create employees through the service with the looser schema above.
 */
export const CreateStaffEmployeeSchema = CreateEmployeeSchema.extend({
  shiftTime: z.string().trim().min(1, 'Shift time is required').max(60),
});

/**
 * Complete your profile (owner, 2026-10-26): what a person may say about themselves the first time
 * they sign in. Department, title, role, status, hire date and pay are not here - those stay with
 * HR and the administrator. `.strict()` so a body that tries to send them is refused outright
 * rather than silently ignored.
 */
export const SelfProfileSchema = z
  .object({
    fullName: z
      .string()
      .trim()
      .max(81)
      .refine((v) => v.split(/\s+/).filter(Boolean).length >= 2, 'Enter your first and last name'),
    nickname: z.string().trim().max(40).nullable().default(null),
    dateOfBirth: dateOfBirthField.nullable().default(null),
    idNumber: z.string().trim().max(40).nullable().default(null),
    homeAddress: z.string().trim().max(200).nullable().default(null),
    phone: z.string().trim().min(7, 'A phone number is required').max(20),
    secondaryPhone: z.string().trim().max(20).nullable().default(null),
    shiftTime: z.string().trim().min(1, 'Shift time is required').max(60),
    location: z.string().trim().max(60).nullable().default(null),
    /**
     * The version the form was filled from: the employee record's `updatedAt`, or null when the
     * person has no record yet. A stale value is refused with 409, never overwritten.
     */
    expectedUpdatedAt: z.string().nullable().default(null),
  })
  .strict();
export type SelfProfileRequest = z.input<typeof SelfProfileSchema>;

/** What the Complete your profile page reads. Only the caller's own record, never pay or role. */
export interface SelfProfile {
  /** True while the gate holds this session on the profile page. */
  required: boolean;
  completedAt: string | null;
  /** The sign-in email; shown read-only. */
  email: string;
  employee: {
    fullName: string;
    nickname: string | null;
    dateOfBirth: string | null;
    idNumber: string | null;
    homeAddress: string | null;
    phone: string;
    secondaryPhone: string | null;
    shiftTime: string | null;
    location: string | null;
    updatedAt: string;
  } | null;
}

/**
 * Department and title a self-completed record starts with, from the role the administrator gave
 * the account (owner, 2026-10-26). The first matching role wins in this order; a role with no
 * mapping leaves the title empty and the department Administration for HR to correct.
 */
const ROLE_PLACEMENT: ReadonlyArray<{ role: string; department: EmployeeDepartment; title: string }> = [
  { role: 'dispatch_lead', department: 'dispatch', title: 'Dispatch Lead' },
  { role: 'dispatcher', department: 'dispatch', title: 'Dispatcher' },
  { role: 'safety_manager', department: 'safety', title: 'Safety Manager' },
  { role: 'hr_manager', department: 'hr', title: 'HR Manager' },
  { role: 'accounting', department: 'accounting', title: '' },
  { role: 'fleet_manager', department: 'fleet', title: 'Fleet Manager' },
  { role: 'maintenance', department: 'maintenance', title: '' },
  { role: 'driver_relations', department: 'driver_relations', title: '' },
  { role: 'operations_manager', department: 'management', title: 'Operations Manager' },
];

export function placementForRoles(roleCodes: readonly string[]): {
  department: EmployeeDepartment;
  title: string;
  payType: 'commission' | 'salary';
  mapped: boolean;
} {
  const hit = ROLE_PLACEMENT.find((p) => roleCodes.includes(p.role));
  const department = hit?.department ?? 'management';
  return { department, title: hit?.title ?? '', payType: payTypeForDepartment(department), mapped: Boolean(hit) };
}

/**
 * Whether a session is held on Complete your profile. Administrators, the company owner and the
 * platform admin are never held; nor is anybody who already has an employee record.
 */
export function profileGateApplies(input: {
  enabled: boolean;
  roles: readonly string[];
  isOwner: boolean;
  isPlatformAdmin: boolean;
  hasEmployee: boolean;
  completedAt: Date | string | null;
}): boolean {
  if (!input.enabled) return false;
  if (input.isOwner || input.isPlatformAdmin || input.roles.includes('administrator')) return false;
  return !input.hasEmployee && !input.completedAt;
}

export type ProfileStatus = 'complete' | 'pending' | 'exempt';

/**
 * A dispatcher, as every dispatcher picker sees one (2026-09-21).
 *
 * There is no separate dispatcher table: a dispatcher is an employee whose position is
 * Dispatcher (or names dispatching), and the employee id is the stable id an assignment stores.
 * Renaming the employee renames them everywhere; making them inactive keeps them on the records
 * they are already on and off every picker for new work.
 */
export const DispatcherSchema = z.object({
  id: z.string(),
  employeeNumber: z.string(),
  name: z.string(),
  status: z.enum(EMPLOYEE_STATUSES),
  /** True while new assignments may name them. */
  active: z.boolean(),
  position: z.string(),
  /** The nickname, shown in place of the name where one is set (owner, 2026-10-26). */
  nickname: z.string().nullable().optional(),
  /** First and last name, for the tooltip beside a nickname. */
  fullName: z.string().optional(),
});
export type Dispatcher = z.infer<typeof DispatcherSchema>;

/** Whether an employee's position makes them a dispatcher. Text, so a renamed title still counts. */
export function isDispatcherPosition(position: string): boolean {
  return /dispatch/i.test(position);
}

/**
 * Whether an employee is offered as a recruiter (owner, 2026-10-07): their position names
 * recruiting (Recruiter, Senior Recruiter …). Department alone is not enough: HR also holds
 * quality staff who never take a lead.
 */
export function isRecruiterPosition(position: string): boolean {
  return /recruit/i.test(position);
}

export const UpdateEmployeeSchema = CreateEmployeeSchema.partial();
export type UpdateEmployeeRequest = z.infer<typeof UpdateEmployeeSchema>;

/**
 * Moving someone: position, department, manager or location.
 *
 * Separate from a general edit because these four are the ones that close a row in
 * `position_history` and open a new one. A correction to a misspelt surname should not look like a
 * promotion in the employment record.
 */
export const ReassignEmployeeSchema = z
  .object({
    position: z.string().trim().min(1).max(60).optional(),
    department: z.enum(EMPLOYEE_DEPARTMENTS).optional(),
    managerEmployeeId: z.string().nullable().optional(),
    location: z.string().trim().max(60).nullable().optional(),
    effectiveFrom: isoDate.optional(),
    reason: z.string().trim().max(400).nullable().default(null),
  })
  .refine(
    (v) =>
      v.position !== undefined ||
      v.department !== undefined ||
      v.managerEmployeeId !== undefined ||
      v.location !== undefined,
    { message: 'Nothing was changed' },
  );
export type ReassignEmployeeRequest = z.infer<typeof ReassignEmployeeSchema>;

export const ChangeEmployeeStatusSchema = z.object({
  status: z.enum(EMPLOYEE_STATUSES),
  /** Required when ending employment: a termination with no stated reason is not defensible. */
  reason: z.string().trim().max(400).nullable().default(null),
  effectiveOn: isoDate.optional(),
});
export type ChangeEmployeeStatusRequest = z.infer<typeof ChangeEmployeeStatusSchema>;

export const SetCompensationSchema = z.object({
  payType: z.enum(PAY_TYPES),
  payRate: z.number().positive(),
  effectiveFrom: isoDate,
  reason: z.string().trim().max(400).nullable().default(null),
});
export type SetCompensationRequest = z.infer<typeof SetCompensationSchema>;

export interface PositionHistoryEntry {
  id: string;
  employeeId: string;
  position: string;
  department: EmployeeDepartment;
  managerEmployeeId: string | null;
  managerName: string | null;
  location: string | null;
  effectiveFrom: string;
  effectiveTo: string | null;
  reason: string | null;
}

export interface CompensationHistoryEntry {
  id: string;
  employeeId: string;
  payType: PayType;
  payRate: number;
  effectiveFrom: string;
  reason: string | null;
}

export const EMPLOYEE_SORT_FIELDS = [
  'name',
  'employeeNumber',
  'department',
  'position',
  'status',
  'hireDate',
] as const;
export type EmployeeSortField = (typeof EMPLOYEE_SORT_FIELDS)[number];

/** Server-side paging, filtering and sorting: this list is expected to reach thousands of rows. */
export const EmployeeQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().max(120).optional(),
  status: z.enum(EMPLOYEE_STATUSES).optional(),
  department: z.enum(EMPLOYEE_DEPARTMENTS).optional(),
  position: z.string().trim().max(60).optional(),
  employmentType: z.enum(EMPLOYMENT_TYPES).optional(),
  location: z.string().trim().max(60).optional(),
  managerEmployeeId: z.string().max(40).optional(),
  /** `driver` restricts to employees with a driving profile; `staff` to those without. */
  workforce: z.enum(['driver', 'staff']).optional(),
  /**
   * The Employees page's own view (owner, 2026-10-26): `profile_complete` = staff whose account
   * has submitted Complete your profile; `profile_incomplete` = every other staff row. Both leave
   * drivers out (any position starting with "driver", any case). Unset = unchanged, for every
   * other consumer of this list (pickers, team names, commission splits …).
   */
  scope: z.enum(['profile_complete', 'profile_incomplete']).optional(),
  hiredFrom: isoDate.optional(),
  hiredTo: isoDate.optional(),
  sort: z.enum(EMPLOYEE_SORT_FIELDS).default('name'),
  sortDir: z.enum(['asc', 'desc']).default('asc'),
  includeInactive: z
    .union([z.boolean(), z.literal('true'), z.literal('false')])
    .transform((v) => v === true || v === 'true')
    .default(false),
});
export type EmployeeQuery = z.infer<typeof EmployeeQuerySchema>;

export interface EmployeePage {
  data: EmployeeRecord[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * The workforce summary strip.
 *
 * Every figure is a count the server actually ran, and each carries the filter that reproduces it,
 * so a tile and the list it opens cannot disagree. A category the model cannot answer is absent
 * rather than reported as zero — zero means "none", not "unknown".
 */
export interface WorkforceSummary {
  total: number;
  byStatus: { status: EmployeeStatus; count: number }[];
  byDepartment: { department: EmployeeDepartment; count: number }[];
  drivers: number;
  staff: number;
  /** Only when the summary was asked for with `scope`: the size of each Employees page view. */
  profileViews?: { complete: number; incomplete: number };
}

/** Employment is not a free-for-all: these are the moves the lifecycle allows. */
export const EMPLOYEE_TRANSITIONS: Record<EmployeeStatus, readonly EmployeeStatus[]> = {
  active: ['on_leave', 'suspended', 'terminated'],
  on_leave: ['active', 'suspended', 'terminated'],
  suspended: ['active', 'on_leave', 'terminated'],
  terminated: ['archived', 'active'],
  archived: ['active'],
};

export function employeeTransitions(from: EmployeeStatus): readonly EmployeeStatus[] {
  return EMPLOYEE_TRANSITIONS[from] ?? [];
}

/** A termination or an archival must say why; the others may. */
export function statusChangeNeedsReason(to: EmployeeStatus): boolean {
  return to === 'terminated' || to === 'suspended';
}
