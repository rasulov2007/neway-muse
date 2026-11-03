import { z } from 'zod';

/**
 * Driver vacations (owner, 2026-10-16/17). A driver on vacation is not inactive: the status is
 * `vacation`, the days away count from the start, and the return says whether the company's
 * vacation-return drug test is due before the next load.
 *
 * Day count: calendar days from the start date to the actual return date (or to today, US Eastern,
 * while still away). Sep 1 → Oct 1 is 30 days. The expected return is a plan only: it never ends a
 * vacation by itself.
 */

/**
 * Days away from which the COMPANY POLICY asks for a drug test before the next load (owner,
 * 2026-10-16). This is the company's own vacation-return check - not a DOT return-to-duty
 * programme, and not the same question as whether the driver left the random testing pool.
 */
export const RETURN_DRUG_TEST_AFTER_DAYS = 30;

export const DRIVER_VACATION_STATES = ['away', 'returned', 'cancelled'] as const;
export type DriverVacationState = (typeof DRIVER_VACATION_STATES)[number];

export interface DriverVacationView {
  id: string;
  driverId: string;
  driverName: string;
  driverNumber: string | null;
  unitNumber: string | null;
  dispatcherName: string | null;
  phone: string | null;
  state: DriverVacationState;
  startedOn: string;
  expectedReturnOn: string | null;
  /** The actual return; null while away. */
  endedOn: string | null;
  /** Calendar days from the start to the actual return, or to today while away. */
  daysAway: number;
  /** Days away reached RETURN_DRUG_TEST_AFTER_DAYS (company policy). */
  drugTestRequired: boolean;
  note: string | null;
  startedBy: string;
  endedBy: string | null;
  cancelledAt: string | null;
  cancelledBy: string | null;
  cancelReason: string | null;
  version: number;
}

export interface DriverVacationList {
  today: string;
  testAfterDays: number;
  away: DriverVacationView[];
  /** Back in the last 30 days, newest first. */
  returned: DriverVacationView[];
  counts: { away: number; returningThisWeek: number; away30Plus: number };
}

/** Whole days between two YYYY-MM-DD dates (to minus from), never negative. */
export function vacationDaysBetween(from: string, to: string): number {
  const a = Date.UTC(Number(from.slice(0, 4)), Number(from.slice(5, 7)) - 1, Number(from.slice(8, 10)));
  const b = Date.UTC(Number(to.slice(0, 4)), Number(to.slice(5, 7)) - 1, Number(to.slice(8, 10)));
  return Math.max(0, Math.round((b - a) / 86_400_000));
}

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const note = z.string().trim().max(500).nullish().transform((v) => v || null);

export const StartVacationSchema = z
  .object({ startedOn: isoDate, expectedReturnOn: isoDate.nullish().transform((v) => v ?? null), note })
  .refine((v) => !v.expectedReturnOn || v.expectedReturnOn >= v.startedOn, { message: 'The expected return cannot be before the start', path: ['expectedReturnOn'] });
export type StartVacationInput = z.input<typeof StartVacationSchema>;

export const UpdateVacationSchema = z.object({
  version: z.number().int().min(1),
  startedOn: isoDate.optional(),
  expectedReturnOn: isoDate.nullable().optional(),
  // Absent = unchanged (a date edit must not clear the note); null or empty clears it.
  note: z.string().trim().max(500).nullable().optional(),
});
export type UpdateVacationInput = z.input<typeof UpdateVacationSchema>;

export const RecordVacationReturnSchema = z.object({ version: z.number().int().min(1), returnedOn: isoDate });
export type RecordVacationReturnInput = z.input<typeof RecordVacationReturnSchema>;

export const CancelVacationSchema = z.object({ version: z.number().int().min(1), reason: z.string().trim().min(3, 'Say why it is cancelled').max(500) });
export type CancelVacationInput = z.input<typeof CancelVacationSchema>;
