/**
 * Staff payroll, which is not driver settlement.
 *
 * A settlement calculates what a driver earned moving freight. Payroll processes what an employee is
 * paid for a pay period: gross, withholdings, net. The brief is emphatic about keeping them apart
 * and so is the schema — `settlements` keys on `driver_id`, `payslips` on `employee_id`.
 *
 * Honesty rules:
 *  - **Tax is not computed here.** Real withholding depends on filing status, allowances, state and
 *    year-specific tables this system does not hold. A payslip carries whatever withholding was
 *    recorded against it; nothing is estimated, because a guessed tax figure ends up on somebody's
 *    W-2.
 *  - A period with unresolved critical exceptions cannot be finalised. Silently paying through a
 *    duplicate or a negative net is worse than being late.
 */

/** `payroll_periods.status` in docs/DATABASE.md §3.14, plus the review steps the brief asks for. */
export const PAYROLL_STATUSES = [
  'open',
  'calculating',
  'review',
  'approved',
  'finalized',
  'paid',
  'closed',
] as const;
export type PayrollStatus = (typeof PAYROLL_STATUSES)[number];

export const PAYROLL_FLOW: Record<PayrollStatus, readonly PayrollStatus[]> = {
  open: ['calculating'],
  calculating: ['review', 'open'],
  review: ['approved', 'open'],
  approved: ['finalized', 'review'],
  // Finalised posts to the ledger; from there the only moves are paying it or closing it.
  finalized: ['paid'],
  paid: ['closed'],
  closed: [],
};

export function payrollTransitions(status: PayrollStatus): readonly PayrollStatus[] {
  return PAYROLL_FLOW[status] ?? [];
}

/** Statuses after which a payslip is locked and only an adjustment can change it. */
export function payrollLocked(status: PayrollStatus): boolean {
  return status === 'finalized' || status === 'paid' || status === 'closed';
}

export interface PayslipInput {
  id: string;
  employeeId: string;
  employeeName: string;
  /** `employee` withholds tax; `contractor` does not. */
  workerType: 'employee' | 'contractor';
  basePay: number;
  bonuses: number;
  /** Withheld tax, as recorded. Null when nobody has recorded any. */
  taxWithheld: number | null;
  /** Other withholdings — benefits, garnishments. */
  deductions: number;
  /** Hours worked, where the role is paid hourly. Null when the role is salaried. */
  hours: number | null;
  hourly: boolean;
}

export interface PayslipResult extends PayslipInput {
  gross: number;
  net: number;
  /** True when this payslip alone stops the period being finalised. */
  blocking: boolean;
}

export const PAYROLL_EXCEPTION_KINDS = [
  'missing_hours',
  'missing_tax',
  'negative_net',
  'duplicate_worker',
  'no_earnings',
  'unapproved_adjustment',
] as const;
export type PayrollExceptionKind = (typeof PAYROLL_EXCEPTION_KINDS)[number];

export interface PayrollException {
  kind: PayrollExceptionKind;
  severity: 'critical' | 'warning';
  /** Payslip ids behind it, so the count and the list cannot disagree. */
  ids: string[];
  label: string;
  /** Why it matters, in money or in consequence. */
  reason: string;
}

export interface PayrollResult {
  payslips: PayslipResult[];
  gross: number;
  taxWithheld: number;
  deductions: number;
  net: number;
  workers: number;
  exceptions: PayrollException[];
  /** False while any critical exception stands. */
  canFinalize: boolean;
  /** Named when tax could not be totalled, so the figure is never quietly understated. */
  taxUnavailableFor: string[];
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Runs a payroll period and finds what is wrong with it.
 *
 * The exceptions are the reason this is an engine rather than a sum. A payroll that pays a
 * duplicate worker, pays a negative net, or pays an hourly employee with no hours recorded is a
 * payroll that will be corrected afterwards by hand, which is the expensive way.
 */
export function runPayroll(
  payslips: readonly PayslipInput[],
  adjustments: ReadonlyArray<{ payslipId: string; approved: boolean; description: string }> = [],
): PayrollResult {
  const results: PayslipResult[] = [];
  const exceptions: PayrollException[] = [];

  const missingHours: string[] = [];
  const missingTax: string[] = [];
  const negativeNet: string[] = [];
  const noEarnings: string[] = [];

  const seenWorkers = new Map<string, string[]>();

  for (const slip of payslips) {
    const gross = round(slip.basePay + slip.bonuses);
    const net = round(gross - (slip.taxWithheld ?? 0) - slip.deductions);

    if (slip.hourly && (slip.hours === null || slip.hours <= 0)) missingHours.push(slip.id);
    // A contractor has no withholding by design; an employee with none is an omission.
    if (slip.workerType === 'employee' && slip.taxWithheld === null) missingTax.push(slip.id);
    if (net < 0) negativeNet.push(slip.id);
    if (gross <= 0) noEarnings.push(slip.id);

    const bucket = seenWorkers.get(slip.employeeId);
    if (bucket) bucket.push(slip.id);
    else seenWorkers.set(slip.employeeId, [slip.id]);

    results.push({
      ...slip,
      gross,
      net,
      blocking: net < 0 || (slip.hourly && (slip.hours === null || slip.hours <= 0)),
    });
  }

  const duplicates = [...seenWorkers.values()].filter((ids) => ids.length > 1).flat();
  const unapproved = adjustments.filter((a) => !a.approved).map((a) => a.payslipId);

  const add = (
    kind: PayrollExceptionKind,
    severity: PayrollException['severity'],
    ids: string[],
    label: string,
    reason: string,
  ) => {
    if (ids.length === 0) return;
    exceptions.push({ kind, severity, ids, label, reason });
  };

  add(
    'duplicate_worker',
    'critical',
    duplicates,
    'payslips for a worker who already has one this period',
    'Finalising would pay the same person twice, and the ledger would carry the cost twice with it.',
  );
  add(
    'negative_net',
    'critical',
    negativeNet,
    'payslips calculate to a negative net',
    'Deductions exceed the gross. Somebody has to decide what carries forward before this is paid.',
  );
  add(
    'missing_hours',
    'critical',
    missingHours,
    'hourly workers have no hours recorded',
    'An hourly worker with no hours is not a worker who earned nothing; the hours have not been entered.',
  );
  add(
    'missing_tax',
    'warning',
    missingTax,
    'employee payslips have no withholding recorded',
    'Nothing here estimates tax. A payslip with no withholding recorded will pay the full gross.',
  );
  add(
    'no_earnings',
    'warning',
    noEarnings,
    'payslips have no earnings at all',
    'They will pay nothing. Remove them, or record what is owed.',
  );
  add(
    'unapproved_adjustment',
    'warning',
    unapproved,
    'adjustments have not been approved',
    'An unapproved adjustment is a change nobody has signed off, sitting inside a payment run.',
  );

  const taxKnown = results.filter((r) => r.taxWithheld !== null);

  return {
    payslips: results,
    gross: round(results.reduce((sum, r) => sum + r.gross, 0)),
    taxWithheld: round(taxKnown.reduce((sum, r) => sum + (r.taxWithheld ?? 0), 0)),
    deductions: round(results.reduce((sum, r) => sum + r.deductions, 0)),
    net: round(results.reduce((sum, r) => sum + r.net, 0)),
    workers: seenWorkers.size,
    exceptions,
    canFinalize: !exceptions.some((e) => e.severity === 'critical'),
    taxUnavailableFor: results.filter((r) => r.taxWithheld === null).map((r) => r.id),
  };
}
