/**
 * What a driver is owed for the freight they moved.
 *
 * A settlement is not a payroll run. It is the calculation of transportation earnings for a period,
 * and the whole value of it is that a driver can see *why* the number is what it is. So this engine
 * returns every line it used, with the arithmetic attached to each one — not a total with a
 * breakdown reconstructed afterwards for display.
 *
 * Honesty rules:
 *  - A load whose pay cannot be computed is **excluded and named**, never counted as zero. A driver
 *    silently paid nothing for a load is the fastest way to lose one.
 *  - Deductions never take a settlement below zero. A negative net is reported as a shortfall the
 *    carrier must decide about, with the deduction reduced to what was actually available.
 *  - Escrow is withheld, not earned. It is a separate line because the carrier owes it back.
 */

export const PAY_KINDS = ['per_mile', 'percent_of_linehaul', 'flat_rate', 'hourly'] as const;
export type PayKind = (typeof PAY_KINDS)[number];

export interface PayPlan {
  kind: PayKind;
  /** Cents per mile, a percentage (0–100), a flat amount per load, or an hourly rate. */
  rate: number;
}

/** `settlement_lines.kind` in docs/DATABASE.md §3.14. */
export const SETTLEMENT_LINE_KINDS = [
  'load_pay',
  'accessorial',
  'reimbursement',
  'bonus',
  'deduction',
  'escrow',
  'advance',
  'adjustment',
] as const;
export type SettlementLineKind = (typeof SETTLEMENT_LINE_KINDS)[number];

export interface SettlementLine {
  kind: SettlementLineKind;
  loadId: string | null;
  loadNumber: string | null;
  description: string;
  /** Positive adds to the driver, negative takes away. Signed so the column sums to the net. */
  amount: number;
  /** The arithmetic, in words. This is what makes the number arguable. */
  basis: string;
}

export interface SettleableLoad {
  id: string;
  loadNumber: string;
  deliveredOn: string;
  originLabel: string;
  destinationLabel: string;
  loadedMiles: number | null;
  emptyMiles: number | null;
  /** Linehaul only — accessorials are paid separately where the charge says so. */
  linehaulRevenue: number | null;
  /** Charges on the load flagged `payable_to_driver`. */
  driverAccessorials: Array<{ description: string; amount: number }>;
  /** Hours worked, for an hourly plan. Null when nobody recorded any. */
  hours?: number | null;
}

export interface DeductionInput {
  kind: 'escrow' | 'insurance' | 'lease' | 'advance_repayment' | 'other';
  description: string;
  amountPerPeriod: number;
  /** Remaining balance on the plan; the deduction never exceeds it. */
  balance?: number | null;
}

export interface SettlementInput {
  driverId: string;
  driverName: string;
  payPlan: PayPlan;
  periodStart: string;
  periodEnd: string;
  loads: readonly SettleableLoad[];
  deductions: readonly DeductionInput[];
  /** One-off adjustments a person entered, positive or negative. */
  adjustments: ReadonlyArray<{ description: string; amount: number; reason: string }>;
}

export interface ExcludedLoad {
  loadId: string;
  loadNumber: string;
  /** What was missing, so somebody can go and fix it rather than guess. */
  reason: string;
}

export interface SettlementResult {
  driverId: string;
  driverName: string;
  periodStart: string;
  periodEnd: string;
  lines: SettlementLine[];
  /** Earnings before anything is taken off. */
  gross: number;
  /** Deductions other than escrow, as a positive number. */
  deductions: number;
  escrow: number;
  adjustments: number;
  net: number;
  /** Loads that could not be paid, named with why. */
  excluded: ExcludedLoad[];
  /** Loads that produced pay. */
  paidLoads: number;
  totalMiles: number;
  /**
   * Set when deductions had to be reduced because there was not enough to take them from. The
   * carrier has to decide what happens to the remainder; it is not silently forgiven or carried.
   */
  shortfall: number | null;
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Driver pay for one load under one plan.
 *
 * Returns null with a reason rather than zero when the plan's input is missing, because a per-mile
 * driver with no miles recorded has not earned nothing — the miles have not been recorded.
 */
export function loadPay(
  load: SettleableLoad,
  plan: PayPlan,
): { amount: number; basis: string } | { amount: null; reason: string } {
  switch (plan.kind) {
    case 'per_mile': {
      // Paid on every mile turned, loaded and empty. A driver repositioning for the carrier's
      // benefit is working, and a plan that pays only loaded miles has to say so explicitly.
      const loaded = load.loadedMiles;
      if (loaded === null) {
        return { amount: null, reason: 'No loaded miles recorded on the load' };
      }
      const miles = loaded + (load.emptyMiles ?? 0);
      return {
        amount: round(miles * plan.rate),
        basis: `${miles.toLocaleString('en-US')} mi × $${plan.rate.toFixed(2)}/mi`,
      };
    }
    case 'percent_of_linehaul': {
      const linehaul = load.linehaulRevenue;
      if (linehaul === null) {
        return { amount: null, reason: 'No linehaul revenue recorded on the load' };
      }
      return {
        amount: round(linehaul * (plan.rate / 100)),
        basis: `${plan.rate}% of $${linehaul.toFixed(2)} linehaul`,
      };
    }
    case 'flat_rate':
      return { amount: round(plan.rate), basis: `Flat $${plan.rate.toFixed(2)} per load` };
    case 'hourly': {
      const hours = load.hours;
      if (hours === null || hours === undefined) {
        return { amount: null, reason: 'No hours recorded against the load' };
      }
      return {
        amount: round(hours * plan.rate),
        basis: `${hours} h × $${plan.rate.toFixed(2)}/h`,
      };
    }
    default:
      return { amount: null, reason: 'This driver has no pay plan on record' };
  }
}

/**
 * Calculates a settlement.
 *
 * Every figure is reachable from the lines: sum the positive lines for gross, the negative ones for
 * what was taken off, and the two agree with `net` by construction rather than by a second
 * calculation that could drift from the first.
 */
export function calculateSettlement(input: SettlementInput): SettlementResult {
  const lines: SettlementLine[] = [];
  const excluded: ExcludedLoad[] = [];
  let totalMiles = 0;
  let paidLoads = 0;

  for (const load of input.loads) {
    const pay = loadPay(load, input.payPlan);
    if (pay.amount === null) {
      excluded.push({ loadId: load.id, loadNumber: load.loadNumber, reason: pay.reason });
      continue;
    }
    paidLoads += 1;
    totalMiles += (load.loadedMiles ?? 0) + (load.emptyMiles ?? 0);
    lines.push({
      kind: 'load_pay',
      loadId: load.id,
      loadNumber: load.loadNumber,
      description: `${load.originLabel} → ${load.destinationLabel}`,
      amount: pay.amount,
      basis: pay.basis,
    });

    for (const accessorial of load.driverAccessorials) {
      if (accessorial.amount === 0) continue;
      lines.push({
        kind: 'accessorial',
        loadId: load.id,
        loadNumber: load.loadNumber,
        description: accessorial.description,
        amount: round(accessorial.amount),
        basis: 'Charge on the load marked payable to the driver',
      });
    }
  }

  for (const adjustment of input.adjustments) {
    if (adjustment.amount === 0) continue;
    lines.push({
      kind: 'adjustment',
      loadId: null,
      loadNumber: null,
      description: adjustment.description,
      amount: round(adjustment.amount),
      basis: adjustment.reason,
    });
  }

  const gross = round(lines.reduce((sum, l) => (l.amount > 0 ? sum + l.amount : sum), 0));
  const negativeAdjustments = round(
    lines.reduce((sum, l) => (l.amount < 0 ? sum + Math.abs(l.amount) : sum), 0),
  );

  // Deductions come off what is actually there. Taking more than the settlement holds would push a
  // driver negative for work they did, which is a decision for a person, not an arithmetic result.
  let available = round(gross - negativeAdjustments);
  let deductions = 0;
  let escrow = 0;
  let requested = 0;

  for (const plan of input.deductions) {
    const cap =
      plan.balance === null || plan.balance === undefined
        ? plan.amountPerPeriod
        : Math.min(plan.amountPerPeriod, plan.balance);
    if (cap <= 0) continue;
    requested = round(requested + cap);

    const taken = round(Math.min(cap, Math.max(0, available)));
    if (taken <= 0) continue;
    available = round(available - taken);

    if (plan.kind === 'escrow') escrow = round(escrow + taken);
    else deductions = round(deductions + taken);

    lines.push({
      kind:
        plan.kind === 'escrow'
          ? 'escrow'
          : plan.kind === 'advance_repayment'
            ? 'advance'
            : 'deduction',
      loadId: null,
      loadNumber: null,
      description: plan.description,
      amount: -taken,
      basis:
        taken < cap
          ? `$${cap.toFixed(2)} scheduled; $${taken.toFixed(2)} available this period`
          : `$${cap.toFixed(2)} per period`,
    });
  }

  const shortfall = requested > deductions + escrow ? round(requested - deductions - escrow) : null;
  const net = round(gross - negativeAdjustments - deductions - escrow);

  return {
    driverId: input.driverId,
    driverName: input.driverName,
    periodStart: input.periodStart,
    periodEnd: input.periodEnd,
    lines,
    gross,
    deductions,
    escrow,
    adjustments: round(-negativeAdjustments),
    net,
    excluded,
    paidLoads,
    totalMiles,
    shortfall,
  };
}

/** `settlements.status` in docs/DATABASE.md §3.14, plus the review step the brief asks for. */
export const SETTLEMENT_STATUSES = [
  'draft',
  'pending_review',
  'finalized',
  'paid',
  'reversed',
] as const;
export type SettlementStatus = (typeof SETTLEMENT_STATUSES)[number];

export const SETTLEMENT_FLOW: Record<SettlementStatus, readonly SettlementStatus[]> = {
  draft: ['pending_review'],
  pending_review: ['finalized', 'draft'],
  // Finalised lines are locked; correcting one means reversing and re-running, not editing.
  finalized: ['paid', 'reversed'],
  paid: ['reversed'],
  reversed: [],
};

export function settlementTransitions(status: SettlementStatus): readonly SettlementStatus[] {
  return SETTLEMENT_FLOW[status] ?? [];
}
