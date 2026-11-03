import { z } from 'zod';
import type { DriverVacationView } from '../roster/vacation.js';
import type { SafetyDocument, SafetyDrugTest, SafetyTimelineEntry } from './cases.js';

/**
 * Vacation return reviews (owner, 2026-10-17). COMPANY POLICY: a driver away 30+ days is drug
 * tested before the next load, and Safety records whether the driver is cleared. This is not the
 * DOT substance-abuse return-to-duty programme, and it does not decide whether the driver left
 * the random testing pool. Clearance is shown, not enforced on load assignment (owner decision,
 * 2026-10-17).
 */

/**
 * Where a review stands, read from the records (never stored):
 * - test_required: no test on file for this vacation
 * - appointment_scheduled: a test is scheduled, nothing collected (an appointment is not a result)
 * - result_pending: collected, the result is not in
 * - result_received: a result is recorded and Safety has not decided
 * - cleared: Safety approved the return
 * - not_cleared: the result does not allow approval (positive, refused, cancelled) - handled by the existing testing process
 */
export const VACATION_RETURN_STATES = ['test_required', 'appointment_scheduled', 'result_pending', 'result_received', 'cleared', 'not_cleared'] as const;
export type VacationReturnState = (typeof VACATION_RETURN_STATES)[number];

export const VACATION_RETURN_STATE_LABEL: Record<VacationReturnState, string> = {
  test_required: 'Test required',
  appointment_scheduled: 'Appointment scheduled',
  result_pending: 'Result pending',
  result_received: 'Result received',
  cleared: 'Cleared',
  not_cleared: 'Not cleared',
};

/** The Accounting expense the review's cost was attributed to: an existing record, never made here. */
export interface VacationReturnExpense {
  id: string;
  expenseNumber: string;
  onDate: string;
  description: string;
  amountCents: number;
  status: string;
  payer: string | null;
  burden: string;
  vendorName: string | null;
}

export interface VacationReturnRow {
  vacation: DriverVacationView;
  reviewId: string | null;
  reviewNumber: string | null;
  state: VacationReturnState;
}

export interface VacationReturnDetail extends VacationReturnRow {
  reviewVersion: number | null;
  /** The vacation-return test for this vacation; result redacted without safety_testing.view. */
  test: SafetyDrugTest | null;
  documents: SafetyDocument[];
  completedAt: string | null;
  completedBy: string | null;
  outcome: string | null;
  /** Null when nothing was attributed; restricted (null) without accounting.view. */
  expense: VacationReturnExpense | null;
  expenseRestricted: boolean;
  history: SafetyTimelineEntry[];
  /** The driver's CDL / medical card problems today; empty = documents valid. */
  documentProblems: string[];
  /** What still blocks Approve clearance, in words. */
  approveBlockers: string[];
}

export interface VacationReturnList {
  today: string;
  rows: VacationReturnRow[];
  counts: { awaitingReview: number; testPending: number; clearedThisWeek: number };
}

export const ScheduleVacationTestSchema = z.object({ scheduledAt: z.string().min(10).max(40).nullish().transform((v) => v ?? null) });
export type ScheduleVacationTestInput = z.input<typeof ScheduleVacationTestSchema>;

export const ApproveVacationReturnSchema = z.object({ version: z.number().int().min(1), outcome: z.string().trim().min(3, 'Write what was reviewed').max(2000) });
export type ApproveVacationReturnInput = z.input<typeof ApproveVacationReturnSchema>;

export const AttributeVacationExpenseSchema = z.object({ version: z.number().int().min(1), expenseId: z.string().min(1).nullable() });
export type AttributeVacationExpenseInput = z.input<typeof AttributeVacationExpenseSchema>;
