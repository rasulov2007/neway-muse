import { z } from 'zod';
import { EMPLOYEE_DEPARTMENTS } from '../people/employee.js';

/**
 * PTO: balances derived from a ledger, not typed into a field.
 *
 * A balance nobody can reconcile is a balance nobody can defend when an employee disputes it. So
 * every hour that moves — accrued, used, adjusted — is a row, and the balance is their sum. That is
 * the same discipline the accounting module applies to money, for the same reason.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');

export const PTO_REQUEST_STATUSES = [
  'draft',
  'submitted',
  'approved',
  'rejected',
  'cancelled',
] as const;
export type PtoRequestStatus = (typeof PTO_REQUEST_STATUSES)[number];

export const PTO_TRANSITIONS: Record<PtoRequestStatus, readonly PtoRequestStatus[]> = {
  draft: ['submitted', 'cancelled'],
  submitted: ['approved', 'rejected', 'cancelled'],
  approved: ['cancelled'],
  rejected: [],
  cancelled: [],
};

export function ptoTransitions(from: PtoRequestStatus): readonly PtoRequestStatus[] {
  return PTO_TRANSITIONS[from] ?? [];
}

/** Statuses that hold hours against a balance: submitted is pending, approved is spent. */
export const PENDING_PTO_STATUSES: readonly PtoRequestStatus[] = ['submitted'];
export const COMMITTED_PTO_STATUSES: readonly PtoRequestStatus[] = ['approved'];

export const PTO_POLICY_KINDS = [
  'vacation',
  'sick',
  'personal',
  'bereavement',
  'jury_duty',
  'unpaid',
  'other',
] as const;
export type PtoPolicyKind = (typeof PTO_POLICY_KINDS)[number];

export const PTO_ACCRUAL_PERIODS = ['weekly', 'biweekly', 'monthly', 'annually'] as const;

export const PTO_TRANSACTION_KINDS = ['accrual', 'usage', 'adjustment', 'carryover'] as const;
export type PtoTransactionKind = (typeof PTO_TRANSACTION_KINDS)[number];

export const PtoPolicySchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.enum(PTO_POLICY_KINDS),
  accrualHoursPerPeriod: z.number(),
  period: z.enum(PTO_ACCRUAL_PERIODS),
  maxBalanceHours: z.number().nullable(),
  carryoverHours: z.number().nullable(),
  allowsNegativeBalance: z.boolean(),
  isActive: z.boolean(),
});
export type PtoPolicyRecord = z.infer<typeof PtoPolicySchema>;

export const CreatePtoPolicySchema = z.object({
  name: z.string().trim().min(1, 'A name is required').max(60),
  kind: z.enum(PTO_POLICY_KINDS),
  accrualHoursPerPeriod: z.number().min(0).max(400).default(0),
  period: z.enum(PTO_ACCRUAL_PERIODS).default('monthly'),
  maxBalanceHours: z.number().min(0).max(4000).nullable().default(null),
  carryoverHours: z.number().min(0).max(4000).nullable().default(null),
  allowsNegativeBalance: z.boolean().default(false),
});
export type CreatePtoPolicyRequest = z.infer<typeof CreatePtoPolicySchema>;

export const PtoRequestSchema = z.object({
  id: z.string(),
  requestNumber: z.string(),
  employeeId: z.string(),
  employeeName: z.string(),
  employeeNumber: z.string(),
  department: z.enum(EMPLOYEE_DEPARTMENTS),
  policyId: z.string(),
  policyName: z.string(),
  policyKind: z.enum(PTO_POLICY_KINDS),
  startsOn: isoDate,
  endsOn: isoDate,
  hours: z.number(),
  status: z.enum(PTO_REQUEST_STATUSES),
  reason: z.string().nullable(),
  notes: z.string().nullable(),
  approverEmployeeId: z.string().nullable(),
  approverName: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  createdAt: z.string(),
});
export type PtoRequestRecord = z.infer<typeof PtoRequestSchema>;

export const CreatePtoRequestSchema = z
  .object({
    employeeId: z.string().min(1, 'An employee is required'),
    policyId: z.string().min(1, 'A PTO type is required'),
    startsOn: isoDate,
    endsOn: isoDate,
    hours: z.number().positive('Hours must be more than zero').max(2000),
    reason: z.string().trim().max(400).nullable().default(null),
    notes: z.string().trim().max(2000).nullable().default(null),
    /** Save without sending it for approval. */
    asDraft: z.boolean().default(false),
  })
  .refine((v) => v.endsOn >= v.startsOn, {
    message: 'The end date cannot be before the start date',
    path: ['endsOn'],
  });
export type CreatePtoRequestRequest = z.infer<typeof CreatePtoRequestSchema>;

export const DecidePtoRequestSchema = z.object({
  status: z.enum(PTO_REQUEST_STATUSES),
  /** Required to reject: an employee is owed a reason. */
  note: z.string().trim().max(400).nullable().default(null),
  /** Approve knowingly past the balance, when policy permits it. Recorded as an override. */
  overrideBalance: z.boolean().default(false),
});
export type DecidePtoRequestRequest = z.infer<typeof DecidePtoRequestSchema>;

export const AdjustPtoBalanceSchema = z.object({
  employeeId: z.string().min(1),
  policyId: z.string().min(1),
  hours: z.number().refine((v) => v !== 0, 'An adjustment of zero changes nothing'),
  effectiveOn: isoDate,
  reason: z.string().trim().min(1, 'An adjustment must say why').max(400),
});
export type AdjustPtoBalanceRequest = z.infer<typeof AdjustPtoBalanceSchema>;

export interface PtoTransactionRecord {
  id: string;
  kind: PtoTransactionKind;
  hours: number;
  effectiveOn: string;
  requestId: string | null;
  reason: string | null;
  actorName: string | null;
  createdAt: string;
}

/**
 * One person's standing under one policy.
 *
 * `pending` is held separately from `balance` because hours in a submitted request are neither
 * spent nor available — showing them as either misleads whoever is deciding.
 */
export interface PtoBalance {
  policyId: string;
  policyName: string;
  policyKind: PtoPolicyKind;
  accrued: number;
  used: number;
  adjusted: number;
  /** accrued + adjusted − used. */
  balance: number;
  pending: number;
  /** balance − pending: what could still be booked today. */
  available: number;
}

export function computeBalance(
  transactions: readonly { kind: PtoTransactionKind; hours: number }[],
  pendingHours: number,
): Omit<PtoBalance, 'policyId' | 'policyName' | 'policyKind'> {
  let accrued = 0;
  let used = 0;
  let adjusted = 0;
  for (const t of transactions) {
    if (t.kind === 'accrual' || t.kind === 'carryover') accrued += t.hours;
    else if (t.kind === 'usage') used += Math.abs(t.hours);
    else adjusted += t.hours;
  }
  const balance = round(accrued + adjusted - used);
  return {
    accrued: round(accrued),
    used: round(used),
    adjusted: round(adjusted),
    balance,
    pending: round(pendingHours),
    available: round(balance - pendingHours),
  };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

// -------------------------------------------------------------------------------------- conflicts

export type PtoConflictSeverity = 'blocking' | 'warning';

export interface PtoConflict {
  key: string;
  severity: PtoConflictSeverity;
  message: string;
}

export interface ConflictInput {
  hours: number;
  available: number;
  allowsNegativeBalance: boolean;
  startsOn: string;
  endsOn: string;
  /** Other requests for the same person that are not rejected or cancelled. */
  overlapping: { requestNumber: string; startsOn: string; endsOn: string; status: string }[];
  /** People in the same department already off across this range. */
  departmentAbsences: { employeeName: string; startsOn: string; endsOn: string }[];
  /** Attendance already recorded inside the range, which a later booking would contradict. */
  recordedAttendanceDays: number;
}

/**
 * What is wrong with this request.
 *
 * Only an insufficient balance blocks, and only when policy forbids going negative. Everything
 * else is a warning: a team being thin on a given week is a judgement for a manager, not a rule for
 * software to enforce silently.
 */
export function detectPtoConflicts(input: ConflictInput): PtoConflict[] {
  const conflicts: PtoConflict[] = [];

  if (input.hours > input.available) {
    const short = round(input.hours - input.available);
    conflicts.push({
      key: 'insufficient_balance',
      severity: input.allowsNegativeBalance ? 'warning' : 'blocking',
      message: `${short} hours more than the ${input.available} available under this policy.`,
    });
  }

  if (input.overlapping.length > 0) {
    conflicts.push({
      key: 'overlapping_request',
      severity: 'warning',
      message: `Overlaps ${input.overlapping.length} existing request${input.overlapping.length === 1 ? '' : 's'}: ${input.overlapping
        .map((r) => `${r.requestNumber} (${r.status})`)
        .join(', ')}.`,
    });
  }

  const days = inclusiveDays(input.startsOn, input.endsOn);
  if (days > 15) {
    conflicts.push({
      key: 'long_absence',
      severity: 'warning',
      message: `${days} consecutive days away. Cover will need arranging.`,
    });
  }

  if (input.departmentAbsences.length >= 3) {
    conflicts.push({
      key: 'department_thin',
      severity: 'warning',
      message: `${input.departmentAbsences.length} others in the same department are already off across these dates.`,
    });
  }

  if (input.recordedAttendanceDays > 0) {
    conflicts.push({
      key: 'attendance_recorded',
      severity: 'warning',
      message: `${input.recordedAttendanceDays} day${input.recordedAttendanceDays === 1 ? ' has' : 's have'} attendance already recorded inside this range.`,
    });
  }

  return conflicts;
}

/**
 * Calendar days covered by a leave range, counting both ends.
 *
 * Distinct from the compliance engine's `daysBetween`, which is a difference: one day off is one
 * day of leave, not zero. Conflating the two would understate every request by a day.
 */
export function inclusiveDays(startsOn: string, endsOn: string): number {
  const start = Date.parse(`${startsOn}T00:00:00Z`);
  const end = Date.parse(`${endsOn}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return 0;
  return Math.round((end - start) / 86_400_000) + 1;
}

export const PtoQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(25),
  search: z.string().trim().max(120).optional(),
  employeeId: z.string().max(40).optional(),
  department: z.enum(EMPLOYEE_DEPARTMENTS).optional(),
  status: z.enum(PTO_REQUEST_STATUSES).optional(),
  policyId: z.string().max(40).optional(),
  from: isoDate.optional(),
  to: isoDate.optional(),
  sort: z.enum(['startsOn', 'employeeName', 'status', 'hours']).default('startsOn'),
  sortDir: z.enum(['asc', 'desc']).default('desc'),
});
export type PtoQuery = z.infer<typeof PtoQuerySchema>;

export interface PtoSummary {
  pending: number;
  approvedThisMonth: number;
  upcoming: number;
  outToday: number;
  /** Total hours still awaiting a decision. */
  pendingHours: number;
}
