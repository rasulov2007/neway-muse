import { z } from 'zod';
import { LeasePlanSchema } from './lease-plan.js';
import { sumCents } from './money.js';

/**
 * A driver's financial account (§6, §7): the profile that says how the driver is paid and what
 * is deducted, and the transactions that move the balances. Three balances are kept apart and
 * never netted silently: debt (what the driver owes), escrow (what the company holds for the
 * driver) and the period's payable.
 */

// ------------------------------------------------------------------ profile

export const CONTRACT_TYPES = ['CD', 'LO', 'OO'] as const;
export type ContractType = (typeof CONTRACT_TYPES)[number];
export const CONTRACT_LABEL: Record<ContractType, string> = { CD: 'Company driver', LO: 'Lease operator', OO: 'Owner operator' };

export const DEDUCTION_SWITCHES = ['deductFuel', 'deductTolls', 'deductApprovedAdvances', 'recurringDeductions', 'escrowEnabled'] as const;
export type DeductionSwitch = (typeof DEDUCTION_SWITCHES)[number];

export const SwitchesSchema = z.object({
  deductFuel: z.boolean(),
  deductTolls: z.boolean(),
  deductApprovedAdvances: z.boolean(),
  recurringDeductions: z.boolean(),
  escrowEnabled: z.boolean(),
});
export type Switches = z.infer<typeof SwitchesSchema>;

/** CD: fuel and tolls are company costs. LO/OO: deductible, unless the contract says otherwise. */
export function defaultSwitches(contract: ContractType): Switches {
  const owner = contract !== 'CD';
  return { deductFuel: owner, deductTolls: owner, deductApprovedAdvances: true, recurringDeductions: owner, escrowEnabled: false };
}

export const DriverPayPlanSchema = z.object({
  /**
   * `percent_of_gross` is the owner's stated policy (total gross); `percent_of_linehaul` is the
   * legacy contract basis the roster carried - kept, never silently rewritten (section 5).
   */
  kind: z.enum(['per_mile', 'percent_of_gross', 'percent_of_linehaul', 'flat_per_load', 'none']),
  /** Dollars per mile, PERCENT (30 = 30%, 0.3 = 0.3%), or dollars per load. Never a multiplier. */
  rate: z.number().finite().min(0),
});
export type DriverPayPlan = z.infer<typeof DriverPayPlanSchema>;

export const EscrowPlanSchema = z.object({
  targetCents: z.number().int().min(0),
  perSettlementCents: z.number().int().min(0),
  /** Opening balance nobody has reconciled yet is `null`, not zero (§7). */
  openingBalanceCents: z.number().int().nullable(),
  openingReconciled: z.boolean(),
});
export type EscrowPlan = z.infer<typeof EscrowPlanSchema>;

export const ProfileVersionSchema = z.object({
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  contractType: z.enum(CONTRACT_TYPES),
  switches: SwitchesSchema,
  loadedPlan: DriverPayPlanSchema,
  /** A genuinely blank empty plan is `none`: no empty-mile pay, never the loaded rate. */
  emptyPlan: DriverPayPlanSchema,
  escrow: EscrowPlanSchema,
  /** Lease owner / leasing to owner / owner truck charges (owner, 2026-10-12); null for others. */
  lease: LeasePlanSchema.nullable().optional(),
  byId: z.string(),
  byName: z.string(),
  at: z.string(),
  reason: z.string().max(500).optional(),
});
export type ProfileVersion = z.infer<typeof ProfileVersionSchema>;

export interface DriverProfileRecord {
  versions: ProfileVersion[];
  /** When somebody confirmed the percentage the roster carried; null while the figure is ambiguous. */
  rateConfirmedAt?: string | null;
  rateConfirmedBy?: string | null;
  /** Opening debt nobody has reconciled is unknown, not zero. */
  openingDebtCents: number | null;
  openingDebtReconciled: boolean;
  notes: Array<{ id: string; at: string; byName: string; body: string }>;
  /**
   * One week's change to a lease charge (owner, 2026-10-20): skip it this week (0) or take a
   * different amount, with the reason and who decided. The plan itself stays as it is.
   */
  leaseOverrides?: LeaseWeekOverride[];
}

export interface LeaseWeekOverride {
  periodStart: string;
  /** The lease line's code: tractor_lease, maintenance_fee, dispatch_fee or a fixed charge's code. */
  code: string;
  cents: number;
  reason: string;
  byName: string;
  at: string;
}

/** Skip (0) or change one lease charge for one week; null amount removes the change. */
export const LeaseWeekOverrideSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  code: z.string().trim().min(1).max(80),
  cents: z.number().int().min(0).nullable(),
  reason: z.string().trim().min(3, 'Say why (at least 3 characters)').max(300),
});
export type LeaseWeekOverrideInput = z.infer<typeof LeaseWeekOverrideSchema>;

/** One week's change to a recurring deduction: skip (0), another amount, or null to undo. */
export const RecurringWeekOverrideSchema = z.object({
  periodStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  cents: z.number().int().min(0).nullable(),
  reason: z.string().trim().min(3, 'Say why (at least 3 characters)').max(300),
});
export type RecurringWeekOverrideInput = z.infer<typeof RecurringWeekOverrideSchema>;

/** A recurring deduction's amount from now on (every later week). */
export const RecurringAmountSchema = z.object({
  amountCents: z.number().int().positive(),
  label: z.string().trim().max(80).optional(),
  reason: z.string().trim().min(3, 'Say why (at least 3 characters)').max(300),
});
export type RecurringAmountInput = z.infer<typeof RecurringAmountSchema>;

export const UpdateDriverProfileSchema = z.object({
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  contractType: z.enum(CONTRACT_TYPES),
  switches: SwitchesSchema,
  loadedPlan: DriverPayPlanSchema,
  emptyPlan: DriverPayPlanSchema,
  escrow: EscrowPlanSchema,
  lease: LeasePlanSchema.nullable().optional(),
  reason: z.string().trim().max(500).optional(),
  openingDebtCents: z.number().int().nullable().optional(),
  openingDebtReconciled: z.boolean().optional(),
  /** Saving with this true records that the person looked at the rate and confirmed it. */
  confirmRate: z.boolean().optional(),
  /** 0 when no profile has been saved yet (the roster defaults are showing). */
  expectedVersion: z.number().int().min(0),
});
export type UpdateDriverProfileInput = z.infer<typeof UpdateDriverProfileSchema>;

/** The version in force on a date: the latest whose effectiveFrom ≤ date. */
export function profileOn(record: DriverProfileRecord | null | undefined, date: string): ProfileVersion | null {
  if (!record) return null;
  const on = record.versions.filter((v) => v.effectiveFrom <= date).sort((a, b) => b.effectiveFrom.localeCompare(a.effectiveFrom));
  return on[0] ?? null;
}

// ------------------------------------------------------------------ transactions

export const DRIVER_TX_KINDS = [
  'fuel',
  'tolls',
  'advance',
  'manual_charge',
  /** A repair charged to the driver on a work order (source work_order:<id>); held until the driver is told. */
  'repair',
  'reimbursement',
  'adjustment',
  'escrow_deposit',
  'escrow_refund',
  'escrow_offset',
  'debt_recovery',
  'carry_forward',
  'recurring',
] as const;
export type DriverTxKind = (typeof DRIVER_TX_KINDS)[number];

export const DRIVER_TX_STATES = ['pending', 'approved', 'applied', 'disputed', 'paused', 'void'] as const;
export type DriverTxState = (typeof DRIVER_TX_STATES)[number];

/** Which kinds are money the driver owes (recoverable), which are the company's, which are escrow. */
export const TX_TREATMENT: Record<DriverTxKind, 'driver_charge' | 'credit' | 'escrow' | 'recovery' | 'company_cost'> = {
  fuel: 'driver_charge',
  tolls: 'driver_charge',
  advance: 'driver_charge',
  manual_charge: 'driver_charge',
  repair: 'driver_charge',
  recurring: 'driver_charge',
  reimbursement: 'credit',
  adjustment: 'credit',
  escrow_deposit: 'escrow',
  escrow_refund: 'escrow',
  escrow_offset: 'escrow',
  debt_recovery: 'recovery',
  carry_forward: 'driver_charge',
};

export interface DriverTx {
  id: string;
  driverId: string;
  kind: DriverTxKind;
  onDate: string;
  amountCents: number;
  recoveredCents: number;
  state: DriverTxState;
  source: string;
  sourceKey: string;
  truckId: string | null;
  loadId: string | null;
  settlementId: string | null;
  description: string;
  /** A charge the company bears instead of the driver (a CD's fuel): shown apart, never owed. */
  companyCost: boolean;
  reason?: string | null;
  evidenceFileId?: string | null;
  approvedBy?: string | null;
  approvedAt?: string | null;
  /** For a recovery: the charge it recovers. One charge is recovered once. */
  recoversId?: string | null;
  installments?: { total: number; remaining: number; perPeriodCents: number } | null;
  /**
   * Each statement that recovered part of this charge, written once when it is approved: the
   * evidence behind `recoveredCents`, and what a reversal undoes.
   */
  recoveryLog?: RecoveryLogEntry[];
  /** For a charge raised from a Fleet Expense: the expense it came from. */
  fleetExpenseId?: string | null;
  /**
   * The instant it happened, when the source knows it (a fuel purchase). A statement then
   * places it by the Monday-noon pay window instead of by `onDate` alone.
   */
  occurredAt?: string | null;
  /** For a late accessorial (source `late_accessorial`): the load it belongs to, and whether it is earnings or a reimbursement. */
  loadNumber?: string | null;
  nature?: 'earning' | 'reimbursement' | null;
}

export interface RecoveryLogEntry {
  settlementId: string;
  settlementNumber: string | null;
  cents: number;
  at: string;
  reversedAt?: string | null;
  reversedBy?: string | null;
  reason?: string | null;
}

export const ManualChargeSchema = z.object({
  kind: z.enum(['manual_charge', 'reimbursement', 'adjustment', 'advance', 'escrow_refund', 'escrow_offset', 'escrow_deposit']),
  amountCents: z.number().int().positive(),
  onDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  description: z.string().trim().min(2).max(200),
  reason: z.string().trim().min(3).max(1000),
  loadId: z.string().optional(),
  truckId: z.string().optional(),
  evidenceFileId: z.string().optional(),
  approvalRequired: z.boolean().default(false),
  installments: z.number().int().min(1).max(52).optional(),
});
export type ManualChargeInput = z.infer<typeof ManualChargeSchema>;

// ------------------------------------------------------------------ balances

export interface DebtSummary {
  openingCents: number | null;
  newChargesCents: number;
  recoveredCents: number;
  closingCents: number | null;
  /** Charges still open, oldest first. */
  open: DriverTx[];
}

const CHARGE_STATES: ReadonlySet<DriverTxState> = new Set(['approved', 'applied']);

/**
 * Debt = opening + charges − recoveries, where a recovery is `recoveredCents` on the charge it
 * recovers - never a second expense, never counted twice. An unknown opening balance keeps the
 * closing unknown: $___ is not $0.
 */
export function debtSummary(openingCents: number | null, txs: readonly DriverTx[], through?: string): DebtSummary {
  const inRange = txs.filter((t) => (!through || t.onDate <= through) && !t.companyCost);
  const charges = inRange.filter((t) => TX_TREATMENT[t.kind] === 'driver_charge' && CHARGE_STATES.has(t.state));
  // A reconciled opening balance is kept as its own transaction (source `opening`), so it is
  // recovered oldest-first like any charge; the figure on the profile is then documentation.
  const openingTx = charges.filter((t) => t.source === 'opening');
  const opening = openingTx.length > 0 ? sumCents(openingTx.map((t) => t.amountCents)) : openingCents;
  const others = charges.filter((t) => t.source !== 'opening');
  const newCharges = sumCents(others.map((t) => t.amountCents));
  const recovered = sumCents(charges.map((t) => t.recoveredCents));
  const open = charges.filter((t) => t.recoveredCents < t.amountCents).sort((a, b) => a.onDate.localeCompare(b.onDate));
  return {
    openingCents: opening,
    newChargesCents: newCharges,
    recoveredCents: recovered,
    closingCents: opening === null ? null : opening + newCharges - recovered,
    open,
  };
}

export interface EscrowSummary {
  openingCents: number | null;
  depositsCents: number;
  refundsCents: number;
  offsetsCents: number;
  balanceCents: number | null;
  targetCents: number;
  /** The next deduction the plan asks for, from the balance and the target. */
  nextDeductionCents: number;
  /** Deposits − refunds − offsets recorded in this account, whatever the opening. */
  movementsCents: number;
  openingReconciled: boolean;
}

/**
 * Escrow (§7): $350 per settlement until the target; from zero that is seven of $350 then $50.
 * At $2,450 the next is $50; at the target it is 0. Refunds and offsets do not replenish unless
 * policy says so - here they simply lower the balance and the plan resumes deducting.
 */
export function escrowSummary(plan: EscrowPlan | null, txs: readonly DriverTx[], through?: string): EscrowSummary {
  const inRange = txs.filter((t) => (!through || t.onDate <= through) && t.state !== 'void' && t.state !== 'pending');
  const dep = sumCents(inRange.filter((t) => t.kind === 'escrow_deposit').map((t) => t.amountCents));
  const ref = sumCents(inRange.filter((t) => t.kind === 'escrow_refund').map((t) => t.amountCents));
  const off = sumCents(inRange.filter((t) => t.kind === 'escrow_offset').map((t) => t.amountCents));
  const opening = plan ? (plan.openingReconciled ? (plan.openingBalanceCents ?? 0) : plan.openingBalanceCents) : 0;
  const balance = opening === null ? null : opening + dep - ref - off;
  const target = plan?.targetCents ?? 0;
  const per = plan?.perSettlementCents ?? 0;
  const next = balance === null ? 0 : Math.max(0, Math.min(per, target - balance));
  // With no reconciled opening, the movements recorded here still add up: that figure is shown, flagged, never hidden as zero or unknown.
  return { openingCents: opening, depositsCents: dep, refundsCents: ref, offsetsCents: off, balanceCents: balance, movementsCents: dep - ref - off, openingReconciled: opening !== null, targetCents: target, nextDeductionCents: next };
}

/**
 * Plans the recoveries a settlement takes against open debt, oldest first, never more than the
 * charge still owes and never more than the amount available. Returns cents per charge.
 */
export function planRecoveries(open: readonly DriverTx[], availableCents: number): Array<{ txId: string; cents: number }> {
  const out: Array<{ txId: string; cents: number }> = [];
  let left = Math.max(0, availableCents);
  for (const tx of open) {
    if (left <= 0) break;
    const owed = tx.amountCents - tx.recoveredCents;
    const cap = tx.installments ? Math.min(owed, tx.installments.perPeriodCents) : owed;
    const take = Math.min(cap, left);
    if (take > 0) {
      out.push({ txId: tx.id, cents: take });
      left -= take;
    }
  }
  return out;
}

/**
 * The invariant of a negative week (§7): the signed net is shown, cash payable is $0, and the
 * shortfall becomes one carry-forward charge on the driver's account - a balance movement,
 * not a new expense.
 */
export function settleNet(netCents: number): { payableCents: number; carryCents: number } {
  return netCents >= 0 ? { payableCents: netCents, carryCents: 0 } : { payableCents: 0, carryCents: -netCents };
}

// ------------------------------------------------------------------ recurring deductions

export const RECURRING_CATEGORIES = ['occupational_accident', 'insurance', 'ifta', 'trailer_lease', 'prepass', 'bestpass', 'truck_lease', 'tablet', 'other'] as const;
export const RECURRING_LABEL: Record<(typeof RECURRING_CATEGORIES)[number], string> = {
  occupational_accident: 'Occupational accident',
  insurance: 'Insurance',
  ifta: 'IFTA',
  trailer_lease: 'Trailer lease',
  prepass: 'PrePass',
  bestpass: 'BestPass',
  truck_lease: 'Truck lease',
  tablet: 'Tablet',
  other: 'Other',
};

export const RecurringDeductionSchema = z.object({
  category: z.enum(RECURRING_CATEGORIES),
  label: z.string().trim().max(80).optional(),
  cadence: z.enum(['weekly', 'monthly']),
  amountCents: z.number().int().positive(),
  startsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  endsOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().default(null),
  /** Charged in a week with no loads too (LO/OO fixed charges), or only when the driver worked. */
  appliesWhenNoWork: z.boolean().default(true),
  /** Installment plan: total and remaining balance in cents; null = open-ended. */
  totalCents: z.number().int().positive().nullable().default(null),
  status: z.enum(['active', 'paused', 'completed', 'cancelled']).default('active'),
  overrides: z.array(z.object({ periodStart: z.string(), amountCents: z.number().int().min(0), reason: z.string().trim().min(2).max(300) })).default([]),
});
export type RecurringDeductionInput = z.infer<typeof RecurringDeductionSchema>;
export interface RecurringDeduction extends RecurringDeductionInput {
  id: string;
  driverId: string;
  /** Cents already charged under an installment plan. */
  chargedCents: number;
}

/** The amount a recurring deduction charges in a given week, or 0 with the reason it does not. */
export function recurringChargeFor(d: RecurringDeduction, period: { start: string; end: string }, worked: boolean): { cents: number; reason: string | null } {
  if (d.status !== 'active') return { cents: 0, reason: `${d.status}` };
  if (d.startsOn > period.end) return { cents: 0, reason: 'starts later' };
  if (d.endsOn && d.endsOn < period.start) return { cents: 0, reason: 'ended' };
  if (!worked && !d.appliesWhenNoWork) return { cents: 0, reason: 'no work this week' };
  const override = d.overrides.find((o) => o.periodStart === period.start);
  if (override) return { cents: override.amountCents, reason: override.reason };
  if (d.cadence === 'monthly') {
    // Charged in the first week that contains the first of a month.
    const first = period.start.slice(0, 8) + '01';
    const inWeek = (first >= period.start && first <= period.end) || (period.end.slice(0, 7) !== period.start.slice(0, 7) && period.end.slice(0, 8) + '01' <= period.end);
    if (!inWeek) return { cents: 0, reason: 'monthly: not this week' };
  }
  let cents = d.amountCents;
  if (d.totalCents !== null) cents = Math.max(0, Math.min(cents, d.totalCents - d.chargedCents));
  return { cents, reason: cents === 0 ? 'installments complete' : null };
}
