import { z } from 'zod';
import type { DispatcherCommissionBreakdown } from './dispatcher-commission.js';

/**
 * Staff payroll periods (§11). Dispatchers are paid commission on four-week periods - not
 * calendar months - anchored on a Monday the company chooses; other staff on a fixed salary at
 * a configured frequency. No tax or statutory deduction is computed here: those rules are not
 * supplied, and a number nobody confirmed is worse than a blank.
 */

const DAY = 86_400_000;
function addDays(day: string, n: number): string {
  return new Date(Date.parse(`${day}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
}

/** The four-week period containing `day`, counted from `anchorMonday` (a Monday). */
export function fourWeekPeriodFor(day: string, anchorMonday: string): { start: string; end: string; index: number } {
  const anchor = Date.parse(`${anchorMonday}T00:00:00Z`);
  const at = Date.parse(`${day}T00:00:00Z`);
  const index = Math.floor((at - anchor) / (28 * DAY));
  const start = addDays(anchorMonday, index * 28);
  return { start, end: addDays(start, 27), index };
}

export const StaffPayPlanSchema = z.object({
  kind: z.enum(['salary', 'dispatcher_commission']),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  effectiveTo: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  currency: z.string().length(3).default('USD'),
  /** Salary per pay period, cents; null on a commission plan. */
  salaryCents: z.number().int().min(0).nullable().default(null),
  frequency: z.enum(['weekly', 'biweekly', 'four_weekly', 'monthly']).default('four_weekly'),
  /** Commission base and rate as the owner states them; recorded, shown, not turned into a formula until the dispatch policy confirms one. */
  commissionBase: z.enum(['gross', 'linehaul', 'net_revenue']).nullable().default(null),
  commissionRatePercent: z.number().min(0).max(100).nullable().default(null),
  /** Commission: which dispatch policy version applies; null = the one in force. Formula lives there. */
  commissionPolicyVersion: z.string().nullable().default(null),
  /** Shared credit between dispatchers on one load: unresolved → null blocks approval of shared loads. */
  sharedCreditRule: z.enum(['split_equal', 'primary_only']).nullable().default(null),
  /**
   * When a person with the authority to say so confirmed these terms, and who.
   *
   * A commission plan pays nothing until this is set. The terms can be recorded and shown before
   * then — that is how the owner reviews them — but an unconfirmed rate never becomes money.
   */
  rateConfirmedAt: z.string().nullable().default(null),
  rateConfirmedBy: z.string().nullable().default(null),
  /** Why this plan was written, kept with the version it belongs to. */
  reason: z.string().nullable().default(null),
});
export type StaffPayPlanInput = z.infer<typeof StaffPayPlanSchema>;

export interface PayrollLineInput {
  employeeId: string;
  employeeName: string;
  role: string;
  plan: StaffPayPlanInput | null;
  /** Commission for the period, cents; null when the plan cannot produce one. */
  commissionCents: number | null;
  /**
   * Where that figure came from. `computed` is the plan applied to the period's loads; `manual`
   * is a figure a person entered with a reason, which survives a regenerate so an override is
   * not silently undone.
   */
  commissionSource?: 'computed' | 'manual' | null;
  /** The loads behind a computed figure, and the ones that could not be attributed. */
  commissionDetail?: DispatcherCommissionBreakdown | null;
  /** Why a manual figure was entered, and by whom. */
  commissionReason?: string | null;
  bonusCents: number;
  advanceCents: number;
  adjustments: Array<{ description: string; cents: number; reason: string; approvedBy: string }>;
}

export interface PayrollLineResult extends PayrollLineInput {
  baseCents: number;
  grossCents: number;
  netCents: number;
  exceptions: string[];
}

/** One period's lines, each explained; exceptions block only the line they belong to. */
export function computePayrollLines(lines: PayrollLineInput[]): { lines: PayrollLineResult[]; grossCents: number; netCents: number; blocked: number } {
  const out = lines.map((l): PayrollLineResult => {
    const exceptions: string[] = [];
    let base = 0;
    if (!l.plan) exceptions.push('No pay plan in force (Needs configuration).');
    else if (l.plan.kind === 'salary') {
      if (l.plan.salaryCents === null) exceptions.push('Salary amount not configured.');
      else base = l.plan.salaryCents;
    } else {
      // A computed figure explains itself; when it could not be computed the reasons come from
      // the calculation rather than a single generic sentence, so the reader knows what to fix.
      if (l.commissionCents === null) {
        const why = l.commissionDetail?.exceptions ?? [];
        if (why.length > 0) exceptions.push(...why);
        else exceptions.push('Dispatcher commission formula not available for this period (Needs configuration).');
      } else base = l.commissionCents;
    }
    const adj = l.adjustments.reduce((s, a) => s + a.cents, 0);
    const gross = base + l.bonusCents + adj;
    const net = gross - l.advanceCents;
    return { ...l, baseCents: base, grossCents: gross, netCents: net, exceptions };
  });
  return { lines: out, grossCents: out.reduce((s, l) => s + l.grossCents, 0), netCents: out.reduce((s, l) => s + l.netCents, 0), blocked: out.filter((l) => l.exceptions.length > 0).length };
}
