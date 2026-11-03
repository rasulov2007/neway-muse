import { z } from 'zod';
import { EMPLOYEE_DEPARTMENTS } from '../people/employee.js';

/**
 * Attendance: workforce time, and nothing to do with hours of service.
 *
 * A driver's HOS is a safety record governed by 49 CFR 395 and owned by the ELD; it answers "may
 * this person legally drive". Attendance answers "was this person at work and for how long", which
 * is a payroll and management question. Merging them would put a compliance record under a manager's
 * edit button, so they are kept apart deliberately.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const ATTENDANCE_STATUSES = [
  'present',
  'absent',
  'late',
  'partial',
  'on_leave',
  'holiday',
  'missing',
] as const;
export type AttendanceStatus = (typeof ATTENDANCE_STATUSES)[number];

export const ATTENDANCE_EXCEPTIONS = [
  'missing_in',
  'missing_out',
  'late_arrival',
  'early_departure',
  'excessive_hours',
  'unapproved_overtime',
] as const;
export type AttendanceException = (typeof ATTENDANCE_EXCEPTIONS)[number];

export const ATTENDANCE_EXCEPTION_LABELS: Record<AttendanceException, string> = {
  missing_in: 'No clock in',
  missing_out: 'No clock out',
  late_arrival: 'Late arrival',
  early_departure: 'Early departure',
  excessive_hours: 'Excessive hours',
  unapproved_overtime: 'Unapproved overtime',
};

export const ATTENDANCE_SOURCES = ['manual', 'device', 'system'] as const;

/** The day beyond which hours are overtime. Federal weekly overtime is handled at the week level. */
export const STANDARD_DAY_HOURS = 8;
export const EXCESSIVE_DAY_HOURS = 16;
/** Minutes after the expected start that counts as late. */
export const LATE_THRESHOLD_MINUTES = 10;

export const AttendanceEntrySchema = z.object({
  id: z.string(),
  employeeId: z.string(),
  employeeName: z.string(),
  employeeNumber: z.string(),
  department: z.enum(EMPLOYEE_DEPARTMENTS),
  entryDate: isoDate,
  checkInAt: z.string().nullable(),
  checkOutAt: z.string().nullable(),
  breakMinutes: z.number().int(),
  status: z.enum(ATTENDANCE_STATUSES),
  exception: z.enum(ATTENDANCE_EXCEPTIONS).nullable(),
  exceptionResolvedAt: z.string().nullable(),
  exceptionNote: z.string().nullable(),
  source: z.enum(ATTENDANCE_SOURCES),
  approvedByName: z.string().nullable(),
  approvedAt: z.string().nullable(),
  notes: z.string().nullable(),
  /** Derived, never stored: two places holding the same arithmetic will disagree eventually. */
  workedHours: z.number().nullable(),
  regularHours: z.number().nullable(),
  overtimeHours: z.number().nullable(),
});
export type AttendanceEntryRecord = z.infer<typeof AttendanceEntrySchema>;

export interface HoursBreakdown {
  worked: number | null;
  regular: number | null;
  overtime: number | null;
}

/**
 * Hours for one day.
 *
 * Returns nulls when the day is incomplete rather than guessing an end time. A day with a clock-in
 * and no clock-out has unknown hours; reporting it as zero hides the problem and reporting it as
 * eight invents payroll.
 */
export function computeHours(input: {
  checkInAt: string | null;
  checkOutAt: string | null;
  breakMinutes: number;
}): HoursBreakdown {
  if (!input.checkInAt || !input.checkOutAt) return { worked: null, regular: null, overtime: null };
  const start = new Date(input.checkInAt).getTime();
  const end = new Date(input.checkOutAt).getTime();
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
    return { worked: null, regular: null, overtime: null };
  }
  const minutes = (end - start) / 60_000 - Math.max(0, input.breakMinutes);
  if (minutes <= 0) return { worked: 0, regular: 0, overtime: 0 };
  const worked = Math.round((minutes / 60) * 100) / 100;
  const regular = Math.min(worked, STANDARD_DAY_HOURS);
  return {
    worked,
    regular: Math.round(regular * 100) / 100,
    overtime: Math.round((worked - regular) * 100) / 100,
  };
}

/**
 * What is wrong with this day, if anything.
 *
 * Only one exception is reported — the most consequential — because a row flagged with four
 * problems is a row nobody reads. Order matters: a missing punch outranks lateness.
 */
export function detectException(input: {
  status: AttendanceStatus;
  checkInAt: string | null;
  checkOutAt: string | null;
  breakMinutes: number;
  expectedStartHour?: number;
}): AttendanceException | null {
  if (input.status === 'on_leave' || input.status === 'holiday' || input.status === 'absent') {
    return null;
  }
  if (!input.checkInAt) return 'missing_in';
  if (!input.checkOutAt) return 'missing_out';

  const { worked } = computeHours(input);
  if (worked !== null && worked >= EXCESSIVE_DAY_HOURS) return 'excessive_hours';

  if (input.expectedStartHour !== undefined) {
    const start = new Date(input.checkInAt);
    const minutesLate = (start.getHours() - input.expectedStartHour) * 60 + start.getMinutes();
    if (minutesLate > LATE_THRESHOLD_MINUTES) return 'late_arrival';
  }

  if (worked !== null && worked > STANDARD_DAY_HOURS) return 'unapproved_overtime';
  return null;
}

export const CreateAttendanceEntrySchema = z
  .object({
    employeeId: z.string().min(1, 'An employee is required'),
    entryDate: isoDate,
    checkInAt: z.string().nullable().default(null),
    checkOutAt: z.string().nullable().default(null),
    breakMinutes: z.number().int().min(0).max(720).default(0),
    status: z.enum(ATTENDANCE_STATUSES).default('present'),
    notes: z.string().trim().max(2000).nullable().default(null),
  })
  .refine((v) => !v.checkInAt || !v.checkOutAt || new Date(v.checkOutAt) > new Date(v.checkInAt), {
    message: 'Clock out must be after clock in',
    path: ['checkOutAt'],
  });
export type CreateAttendanceEntryRequest = z.infer<typeof CreateAttendanceEntrySchema>;

export const UpdateAttendanceEntrySchema = z
  .object({
    checkInAt: z.string().nullable().optional(),
    checkOutAt: z.string().nullable().optional(),
    breakMinutes: z.number().int().min(0).max(720).optional(),
    status: z.enum(ATTENDANCE_STATUSES).optional(),
    notes: z.string().trim().max(2000).nullable().optional(),
    /** Every manual correction is audited, so it may carry the reason with it. */
    reason: z.string().trim().max(400).nullable().default(null),
  })
  .refine(
    (v) =>
      !v.checkInAt ||
      !v.checkOutAt ||
      v.checkInAt === null ||
      v.checkOutAt === null ||
      new Date(v.checkOutAt) > new Date(v.checkInAt),
    { message: 'Clock out must be after clock in', path: ['checkOutAt'] },
  );
export type UpdateAttendanceEntryRequest = z.infer<typeof UpdateAttendanceEntrySchema>;

export const ResolveAttendanceExceptionSchema = z.object({
  note: z.string().trim().min(1, 'Say what was done about it').max(400),
});
export type ResolveAttendanceExceptionRequest = z.infer<typeof ResolveAttendanceExceptionSchema>;

export const AttendanceQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(120).optional(),
  employeeId: z.string().max(40).optional(),
  department: z.enum(EMPLOYEE_DEPARTMENTS).optional(),
  status: z.enum(ATTENDANCE_STATUSES).optional(),
  exception: z.enum(ATTENDANCE_EXCEPTIONS).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  /** Only rows whose exception is still open. */
  unresolvedOnly: z
    .union([z.boolean(), z.literal('true'), z.literal('false')])
    .transform((v) => v === true || v === 'true')
    .default(false),
  sort: z.enum(['entryDate', 'employeeName', 'status']).default('entryDate'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});
export type AttendanceQuery = z.infer<typeof AttendanceQuerySchema>;

export interface AttendanceSummary {
  /** The date these figures describe. Everything below is counted for that day only. */
  onDate: string;
  present: number;
  absent: number;
  late: number;
  onLeave: number;
  missingPunch: number;
  overtimeHours: number | null;
  openExceptions: number;
}
