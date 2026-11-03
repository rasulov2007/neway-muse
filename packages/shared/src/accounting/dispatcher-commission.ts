/**
 * What Staff Payroll records for a dispatcher, and where it came from.
 *
 * There is **no commission formula here**. A dispatcher's pay is the DISP-KPI-01 calculation in
 * `packages/shared/src/dispatch/policy.ts`, run per truck per week by the dispatch board and
 * summed by the Salary Report. Payroll asks for that answer and keeps it; this file only
 * describes the shape of the answer so payroll, the API contract and the screen agree on it.
 *
 * This used to hold a second, independent formula — a flat percentage of each load's gross. It
 * was a test fixture that got as far as the product, and two formulas for one number is one
 * formula too many: the Commission page, the Salary Report and Payroll must be the same
 * calculation or they will drift apart and nobody will know which is right.
 *
 * The KPI is a **truck-week** figure: a gross tier, an RPM rule and an RPM bonus for one truck for
 * one week, under the policy version in force that week. A four-week payroll period is therefore
 * the sum of its truck-weeks — never one tier applied to four weeks of combined gross, and never a
 * percentage applied to each load on its own.
 */

/** One truck, one week, priced by the commission KPI. */
export interface CommissionTruckWeek {
  weekStart: string;
  truckUnit: string | null;
  driverName: string;
  /** Solo or team, decided by whether the week had a co-driver. */
  unit: 'solo' | 'team';
  /** Linehaul gross for the truck-week. Fuel surcharge, detention and reimbursements are out. */
  grossCents: number;
  /** Loaded miles for the week; the denominator of the weighted RPM. */
  miles: number;
  /** Weighted RPM (gross ÷ miles), rounded for display only. */
  rpm: number | null;
  basePct: number;
  bonusPct: number;
  /** `ok`, `below_floor`, `reduced`, `no_payment`, `needs_miles`, `junior`, `no_gross`. */
  status: string;
  tier: string;
  calculatedCents: number;
  /** What is actually paid: the calculation, or an administrator's override of it. */
  payableCents: number;
  overrideCents: number | null;
  overrideReason: string | null;
  /** The arithmetic in words, as the board and the salary report print it. */
  formula: string;
  policyVersion: string;
}

/** A monthly bonus or penalty an administrator approved, kept apart from the weekly KPI. */
export interface CommissionAdjustmentLine {
  kind: string;
  amountCents: number;
  month: string;
  reason: string;
}

/** What one dispatcher earned in one payroll period, and how it was arrived at. */
export interface DispatcherCommissionBreakdown {
  employeeId: string;
  /** The board's dispatcher key: an employee, or a shared team name. */
  dispatcherId: string | null;
  dispatcherName: string;
  periodStart: string;
  periodEnd: string;
  /** This person's share of the period: commission plus approved bonuses less penalties. */
  payableCents: number;
  commissionCents: number;
  bonusesCents: number;
  penaltiesCents: number;
  /** Their percentage of a shared team, or null when the whole team is one person. */
  sharePct: number | null;
  /** Every policy version that priced a week in this period. */
  policyVersions: string[];
  /** Truck-weeks above the floor with no miles: earned, but not yet priced. */
  needsMiles: number;
  weeks: Array<{ weekStart: string; grossCents: number; commissionCents: number; trucks: number }>;
  trucks: CommissionTruckWeek[];
  adjustments: CommissionAdjustmentLine[];
  /** What a person has to resolve before this period can be finalized. */
  exceptions: string[];
}
