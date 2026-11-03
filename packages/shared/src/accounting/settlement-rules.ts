import { z } from 'zod';
import { instantFromLocal, localParts } from '../loads/format-time.js';
import { NO_TRUCK_LEASE_NOTE, leaseCharges, type WeekOdometer } from './lease-plan.js';
import { type DriverPayPlan, type DriverTx, type EscrowPlan, type ProfileVersion, type RecurringDeduction, debtSummary, escrowSummary, planRecoveries, recurringChargeFor, settleNet } from './driver-account.js';
import { bpsOf, percentOf, splitCents, sumCents } from './money.js';
import { LATE_ACCESSORIAL_SOURCE, parseLateAccessorialKey } from './supplemental-invoice.js';

/**
 * Driver settlements (§8): the period and its cutoff, which loads belong to it, what each load
 * pays under the loaded and empty plans, how accessorials are treated, and the statement's
 * arithmetic down to signed net, payable and carry-forward.
 */

// ------------------------------------------------------------------ periods

export interface SettlementPeriod {
  /** The period's first Monday and the Sunday before its closing Monday: the statement's key and label days. */
  start: string;
  end: string;
  /**
   * The instant the period opens: the cutoff time on its first Monday (Monday 12:00 noon Eastern,
   * owner 2026-10-21). Optional only because records written before it have none.
   */
  startsAt?: string;
  /** The instant the period closes: a load completed at or after it belongs to the next period. */
  cutoffAt: string;
  payDate: string;
  timezone: string;
}

const DAY_MS = 86_400_000;

function isoDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}
function dow(day: string): number {
  return new Date(`${day}T00:00:00Z`).getUTCDay();
}
function addDays(day: string, n: number): string {
  return isoDay(Date.parse(`${day}T00:00:00Z`) + n * DAY_MS);
}

/**
 * The pay period keyed by the Monday–Sunday week containing `day` (a local date), with its
 * window, cutoff and payday. The window runs from the cutoff time on that Monday to the cutoff
 * time on the next Monday, on the company's settlement clock (US Eastern).
 */
export function settlementPeriodFor(day: string, cfg: { timezone: string; cutoffTime: string; payDay: string }): SettlementPeriod {
  const back = (dow(day) + 6) % 7; // Monday = 0
  const start = addDays(day, -back);
  const end = addDays(start, 6);
  const cutoffDay = addDays(end, 1); // the Monday after
  const cutoffAt = instantFromLocal(cutoffDay, cfg.cutoffTime, cfg.timezone) ?? `${cutoffDay}T${cfg.cutoffTime}:00Z`;
  const startsAt = instantFromLocal(start, cfg.cutoffTime, cfg.timezone) ?? `${start}T${cfg.cutoffTime}:00Z`;
  const payOffset: Record<string, number> = { monday: 1, tuesday: 2, wednesday: 3, thursday: 4, friday: 5 };
  const payDate = addDays(end, payOffset[cfg.payDay] ?? 4);
  return { start, end, startsAt, cutoffAt, payDate, timezone: cfg.timezone };
}

/**
 * The period a completed instant belongs to. A load completed on a Monday before the cutoff
 * time belongs to the week that is ending; at the cutoff time exactly it starts the new one
 * (owner, 2026-10-21: 11:59 → previous week, 12:00 → new week).
 */
export function periodForCompletion(completedAt: string, cfg: { timezone: string; cutoffTime: string; payDay: string }): SettlementPeriod {
  const local = localParts(completedAt, cfg.timezone)?.date ?? completedAt.slice(0, 10);
  const week = settlementPeriodFor(local, cfg);
  if (dow(local) === 1) {
    const previous = settlementPeriodFor(addDays(local, -1), cfg);
    if (Date.parse(completedAt) < Date.parse(previous.cutoffAt)) return previous;
  }
  return week;
}

/**
 * Whether a driver transaction falls in the period. One with the instant it happened (a fuel
 * purchase) is placed by the same Monday-noon window as the loads; one with only a date is
 * placed by the period's days.
 */
export function txInPeriod(t: Pick<DriverTx, 'onDate' | 'occurredAt'>, period: Pick<SettlementPeriod, 'start' | 'end' | 'startsAt' | 'cutoffAt'>): boolean {
  if (t.occurredAt && period.startsAt) {
    const at = Date.parse(t.occurredAt);
    return at >= Date.parse(period.startsAt) && at < Date.parse(period.cutoffAt);
  }
  return t.onDate >= period.start && t.onDate <= period.end;
}

/** Cents as a person reads them. A statement is read by the driver it pays. */
function asMoney(cents: number): string {
  return `$${(cents / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ------------------------------------------------------------------ loads and accessorials

export const ACCESSORIAL_TREATMENTS = ['in_percentage_base', 'paid_separately', 'excluded'] as const;
export type AccessorialTreatment = (typeof ACCESSORIAL_TREATMENTS)[number];

export const AccessorialAllocationSchema = z.object({
  chargeId: z.string().min(1),
  /** Included in the percentage base, paid as its own line, or not paid to the driver. */
  treatment: z.enum(ACCESSORIAL_TREATMENTS),
  /** For paid_separately: full amount, a percentage of it, or a fixed amount. */
  mode: z.enum(['full', 'percent', 'fixed']).default('full'),
  value: z.number().finite().min(0).default(100),
  /** Earnings, or a reimbursement of money the recipient paid. */
  nature: z.enum(['earning', 'reimbursement']).default('earning'),
  /** Who gets it; team extra earnings default to both drivers 50/50; a reimbursement to the payer. */
  recipients: z.array(z.string().min(1)).min(1),
  decidedBy: z.string().optional(),
  decidedAt: z.string().optional(),
});
export type AccessorialAllocation = z.infer<typeof AccessorialAllocationSchema>;

export interface SettleableLoadV2 {
  id: string;
  loadNumber: string;
  completedAt: string;
  originLabel: string;
  destinationLabel: string;
  loadedMiles: number;
  emptyMiles: number;
  /** The day the freight went on, so a statement can say when the load ran, not only when it paid. */
  pickedUpOn?: string | null;
  /** Total gross, cents (linehaul + billable accessorials): the percentage base per the owner. */
  grossCents: number;
  /**
   * The linehaul the driver is paid on: the load's For driver rate when it has one, else the real
   * linehaul (owner, 2026-10-23). Every pay plan reads this, never the real figure.
   */
  linehaulCents: number;
  /** The linehaul the broker pays, for the statement's Real column; absent = `linehaulCents`. */
  realLinehaulCents?: number;
  /** The broker's REF number, printed beside the L-number on every line of the load. */
  brokerReference?: string | null;
  /** The load's `updatedAt` as read, so a correction made from the statement is version-checked. */
  loadUpdatedAt?: string | null;
  driverIds: string[];
  /** `amountCents` is the For driver amount; `realAmountCents` the billed one (absent = the same). */
  accessorials: Array<{ id: string; type: string; description: string; amountCents: number; realAmountCents?: number; allocation: AccessorialAllocation | null }>;
  /** Broker/RTS funding state, for the pay-on-funding setting. */
  funded: boolean;
  status: string;
}

export interface EarningLine {
  kind: 'loaded_miles' | 'empty_miles' | 'percentage' | 'flat' | 'accessorial' | 'reimbursement';
  loadId: string | null;
  loadNumber: string | null;
  /** The day the freight was delivered, so a driver can match the line to their week. */
  deliveredOn?: string | null;
  /** The day it was picked up; together with `deliveredOn` this is the load's run. */
  pickedUpOn?: string | null;
  /** City, ST -> City, ST. A driver recognises their week by where they went. */
  route?: string | null;
  /** What the pay was figured on: eligible revenue in cents, or miles. Never both. */
  payBasisCents?: number | null;
  payBasisMiles?: number | null;
  /** The driver's own rate, as they would say it: "30%", "$0.65/mi", "flat". */
  rateLabel?: string | null;
  /**
   * Set when this line is one driver's share of a team load.
   *
   * It records the computation exactly as it ran - the amount before the share was taken and how
   * many drivers it was shared between - so a statement can print "25% of $3,000.00 = $750.00,
   * your 50% team share = $375.00" and never disagree with the cents by rounding differently.
   */
  teamShare?: { drivers: number; beforeShareCents: number } | null;
  /** The broker's REF number of the load, shown with the L-number ("REF 123456 / L-100015"). */
  brokerReference?: string | null;
  /** For an accessorial: the load charge it pays, so the same charge is never paid twice. */
  chargeId?: string | null;
  /** For an accessorial added after its load was settled: the driver transaction that carries it. */
  txId?: string | null;
  description: string;
  cents: number;
  basis: string;
}

export interface LoadPayExplained {
  lines: EarningLine[];
  exceptions: string[];
}

function planPay(plan: DriverPayPlan, miles: number, grossCents: number, label: string, loadNumber: string, loadId: string, kindMiles: 'loaded_miles' | 'empty_miles'): EarningLine | null {
  switch (plan.kind) {
    case 'per_mile': {
      const cents = Math.round(miles * plan.rate * 100);
      return { kind: kindMiles, loadId, loadNumber, description: `${label} · ${miles.toLocaleString()} mi × $${plan.rate.toFixed(2)}`, cents, basis: `${miles} mi × ${plan.rate}`, payBasisMiles: miles, rateLabel: `$${plan.rate.toFixed(2)}/mi` };
    }
    case 'percent_of_gross':
      return { kind: 'percentage', loadId, loadNumber, description: `${label} · ${plan.rate}% of gross`, cents: percentOf(grossCents, plan.rate), basis: `${plan.rate}% × ${asMoney(grossCents)}`, payBasisCents: grossCents, rateLabel: `${plan.rate}%` };
    case 'percent_of_linehaul':
      return { kind: 'percentage', loadId, loadNumber, description: `${label} · ${plan.rate}% of linehaul`, cents: percentOf(grossCents, plan.rate), basis: `${plan.rate}% × linehaul ${asMoney(grossCents)}`, payBasisCents: grossCents, rateLabel: `${plan.rate}%` };
    case 'flat_per_load':
      return { kind: 'flat', loadId, loadNumber, description: `${label} · flat`, cents: Math.round(plan.rate * 100), basis: 'flat', rateLabel: `flat ${asMoney(Math.round(plan.rate * 100))}` };
    case 'none':
      return null;
  }
}

/**
 * What one load pays one driver. Loaded and empty plans are separate; a blank empty plan pays
 * nothing for empty miles. A percentage plan is on total gross, plus whatever accessorials were
 * explicitly put in the base. Team base mileage follows the company setting; unset = exception.
 */
export function explainLoadPay(
  load: SettleableLoadV2,
  driverId: string,
  profile: ProfileVersion,
  cfg: { teamBaseMileageSplit: 'each_full' | 'split_50_50' | null },
): LoadPayExplained {
  const lines: EarningLine[] = [];
  const exceptions: string[] = [];
  const team = load.driverIds.length > 1;
  const baseAccessorials = load.accessorials.filter((a) => a.allocation?.treatment === 'in_percentage_base');
  const baseCents = load.linehaulCents + sumCents(baseAccessorials.map((a) => a.amountCents));

  // Base pay: mileage or percentage. Gross basis = linehaul + accessorials put in the base;
  // linehaul basis (legacy contracts) = linehaul only, accessorials never in the base.
  if (profile.loadedPlan.kind === 'percent_of_gross' || profile.loadedPlan.kind === 'percent_of_linehaul') {
    const base = profile.loadedPlan.kind === 'percent_of_linehaul' ? load.linehaulCents : baseCents;
    const line = planPay(profile.loadedPlan, 0, base, 'Load pay', load.loadNumber, load.id, 'loaded_miles');
    if (line) {
      if (team) {
        // Percentage on a team load: each driver's share of one percentage, never two full ones.
        const [mine] = splitCents(line.cents, load.driverIds.length);
        line.teamShare = { drivers: load.driverIds.length, beforeShareCents: line.cents };
        line.cents = mine ?? 0;
        line.description += ' · team share';
      }
      lines.push(line);
    }
  } else {
    if (team && cfg.teamBaseMileageSplit === null) {
      exceptions.push('Team base-mileage split is not configured (Settings › Accounting).');
    } else {
      const share = team && cfg.teamBaseMileageSplit === 'split_50_50' ? 1 / load.driverIds.length : 1;
      const loaded = planPay(profile.loadedPlan, load.loadedMiles, baseCents, 'Loaded miles', load.loadNumber, load.id, 'loaded_miles');
      const empty = planPay(profile.emptyPlan, load.emptyMiles, baseCents, 'Empty miles', load.loadNumber, load.id, 'empty_miles');
      for (const l of [loaded, empty]) {
        if (!l) continue;
        if (share !== 1) {
          l.teamShare = { drivers: load.driverIds.length, beforeShareCents: l.cents };
          l.cents = splitCents(l.cents, load.driverIds.length)[load.driverIds.indexOf(driverId)] ?? 0;
          l.description += ' · split';
        }
        lines.push(l);
      }
    }
  }
  if (profile.loadedPlan.kind === 'none') exceptions.push('No loaded pay plan on the profile in force.');

  // Accessorials: only the explicitly allocated ones, once.
  for (const a of load.accessorials) {
    const al = a.allocation;
    if (!al) {
      exceptions.push(`${a.description}: Include in driver statement? not decided.`);
      continue;
    }
    if (al.treatment !== 'paid_separately') continue;
    if (!al.recipients.includes(driverId)) continue;
    const gross = al.mode === 'full' ? a.amountCents : al.mode === 'percent' ? percentOf(a.amountCents, al.value) : Math.round(al.value * 100);
    const idx = al.recipients.indexOf(driverId);
    const mine = al.recipients.length > 1 ? (splitCents(gross, al.recipients.length)[idx] ?? 0) : gross;
    lines.push({
      kind: al.nature === 'reimbursement' ? 'reimbursement' : 'accessorial',
      loadId: load.id,
      loadNumber: load.loadNumber,
      description: `${a.description}${al.recipients.length > 1 ? ' · shared' : ''}`,
      chargeId: a.id,
      cents: mine,
      basis: `${al.mode}${al.mode !== 'full' ? ` ${al.value}` : ''}${al.recipients.length > 1 ? ` ÷ ${al.recipients.length}` : ''}`,
    });
  }
  // Every line of this load carries the load's own facts, so a statement can print one row per
  // load: where it went, when it ran, and what the pay was figured on.
  const route = `${load.originLabel} -> ${load.destinationLabel}`.replace(/\s+,/g, ',');
  for (const l of lines) {
    l.brokerReference = load.brokerReference ?? null;
    l.deliveredOn = load.completedAt ? load.completedAt.slice(0, 10) : null;
    l.pickedUpOn = load.pickedUpOn ? load.pickedUpOn.slice(0, 10) : null;
    l.route = route;
  }
  return { lines, exceptions };
}

// ------------------------------------------------------------------ the statement

export interface DeductionLine {
  /** `reversal`: a deduction posted on an earlier statement and reversed, paid back here (negative cents). */
  kind: 'fuel' | 'tolls' | 'advance' | 'manual_charge' | 'recurring' | 'debt_recovery' | 'escrow' | 'carry_forward' | 'reversal' | 'lease';
  description: string;
  cents: number;
  /** The day the charge was incurred, where the record has one; a statement is read by date. */
  onDate?: string | null;
  /** The driver transaction this recovers or charges; one per line, so nothing is taken twice. */
  txId: string | null;
  basis: string;
  /** What the line can be changed through: a lease charge's code or a recurring deduction's id. */
  ref?: string | null;
}

/** A lease charge or recurring deduction left off this week on purpose, so it can be put back. */
export interface SkippedLine {
  kind: 'lease' | 'recurring';
  ref: string;
  description: string;
  /** What it would have been. */
  cents: number;
  reason: string;
}

export interface StatementComputation {
  earnings: EarningLine[];
  deductions: DeductionLine[];
  grossCents: number;
  reimbursementsCents: number;
  deductionsCents: number;
  escrowCents: number;
  netCents: number;
  payableCents: number;
  carryCents: number;
  openingDebtCents: number | null;
  closingDebtCents: number | null;
  escrowBalanceAfterCents: number | null;
  loadCount: number;
  totalMiles: number;
  exceptions: string[];
  excluded: Array<{ loadId: string; loadNumber: string; reason: string }>;
  /** Recoveries to record when the statement is approved: txId → cents. */
  recoveries: Array<{ txId: string; cents: number }>;
  /** New charges this statement created (recurring deductions): what to write as transactions. */
  recurringCharges: Array<{ deductionId: string; cents: number; description: string }>;
  /** Lease owner charges this statement takes (tractor lease, fees, fixed charges), by code. */
  leaseCharges?: Array<{ code: string; cents: number; description: string }>;
  /** Lines skipped this week (owner, 2026-10-20). */
  skipped?: SkippedLine[];
  /** Plain notes printed on the statement, e.g. that no truck was assigned and no lease charge was taken. */
  notes?: string[];
  /**
   * Per load on the statement, the real and the For driver money side by side (owner, 2026-10-23):
   * what Accounting checks and corrects in the drawer. The driver's PDF never prints the real side.
   */
  loadFacts?: LoadPayFacts[];
}

/** One load's money on a statement: what the broker pays and what the driver is paid on. */
export interface LoadPayFacts {
  loadId: string;
  loadNumber: string;
  brokerReference: string | null;
  loadUpdatedAt: string | null;
  realLinehaulCents: number;
  linehaulCents: number;
  accessorials: Array<{ id: string; type: string; description: string; realAmountCents: number; amountCents: number }>;
}

/** The facts of the loads a statement pays, in the order they were given. */
export function loadPayFacts(loads: ReadonlyArray<SettleableLoadV2>): LoadPayFacts[] {
  return loads.map((l) => ({
    loadId: l.id,
    loadNumber: l.loadNumber,
    brokerReference: l.brokerReference ?? null,
    loadUpdatedAt: l.loadUpdatedAt ?? null,
    realLinehaulCents: l.realLinehaulCents ?? l.linehaulCents,
    linehaulCents: l.linehaulCents,
    accessorials: l.accessorials.map((a) => ({ id: a.id, type: a.type, description: a.description, realAmountCents: a.realAmountCents ?? a.amountCents, amountCents: a.amountCents })),
  }));
}

export interface StatementInput {
  driverId: string;
  period: SettlementPeriod;
  profile: ProfileVersion | null;
  loads: SettleableLoadV2[];
  /** The driver's transactions to date (all kinds), for debt, escrow and this week's charges. */
  transactions: DriverTx[];
  recurring: RecurringDeduction[];
  openingDebtCents: number | null;
  /**
   * Approved reimbursements this statement carries: money the driver laid out and is owed back.
   *
   * They are earnings to the driver but not driver pay - no percentage is taken on them and they
   * are not part of the gross a commission is figured on, which is why they arrive here already
   * decided rather than being derived from the loads.
   */
  reimbursements?: ReadonlyArray<{ id: string; loadNumber: string | null; loadId: string | null; description: string; cents: number; onDate: string }>;
  settings: { teamBaseMileageSplit: 'each_full' | 'split_50_50' | null; payOnFundingOnly: boolean | null };
  /** The driver's truck odometer for the week (Samsara), for the lease tier and maintenance fee. */
  odometer?: WeekOdometer | null;
  /** One-week changes to lease charges (skip or another amount). */
  leaseOverrides?: ReadonlyArray<{ periodStart: string; code: string; cents: number; reason: string }>;
  /**
   * Whether the driver had a truck assignment overlapping the pay week (owner, 2026-10-22). False:
   * no lease-sheet line is taken and the statement says why. Absent: not checked (lease taken).
   */
  leaseTruckAssigned?: boolean;
}

/** The whole statement, explained line by line. Pure: nothing is written here. */
export function computeStatement(input: StatementInput): StatementComputation {
  const { period, profile } = input;
  const exceptions: string[] = [];
  const excluded: StatementComputation['excluded'] = [];
  const earnings: EarningLine[] = [];
  if (!profile) exceptions.push('No pay profile in force for this driver: nothing can be paid until one is set.');
  // load:charge pairs a late-accessorial transaction pays (claimed or not), so load pay skips them.
  const lateCarried = new Set(
    input.transactions
      .filter((t) => t.source === LATE_ACCESSORIAL_SOURCE && t.state !== 'void')
      .map((t) => parseLateAccessorialKey(t.sourceKey))
      .filter((k): k is NonNullable<typeof k> => Boolean(k) && k!.driverId === input.driverId)
      .map((k) => `${k.loadId}:${k.chargeId}`),
  );

  for (const load of input.loads) {
    if (!['delivered', 'closed', 'tonu'].includes(load.status)) {
      excluded.push({ loadId: load.id, loadNumber: load.loadNumber, reason: `Load is ${load.status}` });
      continue;
    }
    if (input.settings.payOnFundingOnly === true && !load.funded && profile && profile.contractType !== 'CD') {
      excluded.push({ loadId: load.id, loadNumber: load.loadNumber, reason: 'Not funded yet (pay on funding only)' });
      continue;
    }
    if (!profile) continue;
    const pay = explainLoadPay(load, input.driverId, profile, input.settings);
    // An accessorial added after this load was settled is paid by its own transaction (below),
    // on whichever statement takes it - never again here, even when this statement is reopened.
    earnings.push(...pay.lines.filter((l) => !(l.chargeId && l.loadId && lateCarried.has(`${l.loadId}:${l.chargeId}`))));
    exceptions.push(...pay.exceptions.filter((e) => !load.accessorials.some((a) => lateCarried.has(`${load.id}:${a.id}`) && e.startsWith(`${a.description}:`))));
  }
  // Accessorials that came in after their load's statement was approved (a layover billed on a
  // supplemental invoice): one line each, on the first statement whose pay week is not over when
  // the charge was added. Approval claims the transaction, so it is paid once.
  for (const t of input.transactions) {
    if (t.source !== LATE_ACCESSORIAL_SOURCE || t.state !== 'approved' || t.settlementId) continue;
    const due = t.occurredAt ? Date.parse(t.occurredAt) < Date.parse(period.cutoffAt) : t.onDate <= period.end;
    if (!due) continue;
    const key = parseLateAccessorialKey(t.sourceKey);
    earnings.push({ kind: t.nature === 'reimbursement' ? 'reimbursement' : 'accessorial', loadId: t.loadId, loadNumber: t.loadNumber ?? null, deliveredOn: null, description: t.description, chargeId: key?.chargeId ?? null, txId: t.id, cents: t.amountCents, basis: 'added after the load was settled' });
  }
  // Reimbursements are added after load pay and before anything is taken off: they are their own
  // kind of line, so `grossCents` (and every percentage figured on it) never includes them.
  for (const r of input.reimbursements ?? []) {
    earnings.push({ kind: 'reimbursement', loadId: r.loadId, loadNumber: r.loadNumber, deliveredOn: r.onDate, description: r.description, cents: r.cents, basis: 'reimbursement' });
  }

  const worked = earnings.filter((e) => e.kind !== 'reimbursement' && !e.txId).length > 0;
  // Loads the driver was paid for; a reimbursement attached to a load is not a load they ran.
  const loadCount = new Set(earnings.filter((e) => e.kind !== 'reimbursement' && !e.txId).map((e) => e.loadId).filter(Boolean)).size;
  const totalMiles = input.loads.filter((l) => earnings.some((e) => e.loadId === l.id)).reduce((s, l) => s + l.loadedMiles + l.emptyMiles, 0);

  const grossCents = sumCents(earnings.filter((e) => e.kind !== 'reimbursement').map((e) => e.cents));
  const reimbursementsCents = sumCents(earnings.filter((e) => e.kind === 'reimbursement').map((e) => e.cents));

  // Deductions this week, by the switches in force.
  const deductions: DeductionLine[] = [];
  const sw = profile?.switches;
  const weekTx = input.transactions.filter((t) => txInPeriod(t, period) && t.state !== 'void' && !t.settlementId);
  const takeKind = (kind: DriverTx['kind'], on: boolean | undefined, label: DeductionLine['kind']) => {
    for (const t of weekTx.filter((x) => x.kind === kind && x.state !== 'pending' && x.state !== 'disputed' && x.state !== 'paused')) {
      if (!on || t.companyCost) continue;
      deductions.push({ kind: label, description: t.description, cents: t.amountCents - t.recoveredCents, onDate: t.onDate, txId: t.id, basis: t.source });
    }
  };
  takeKind('fuel', sw?.deductFuel, 'fuel');
  takeKind('tolls', sw?.deductTolls, 'tolls');
  takeKind('advance', sw?.deductApprovedAdvances, 'advance');
  // A charge Accounting adds for this pay week (Add deduction: fuel, damage ...) is taken whole on
  // this week's statement, even when it takes the net below zero; what pay does not cover is carried
  // to the next week as debt (owner, 2026-10-29). A charge spread over several weeks keeps its
  // installments and is recovered from what is left, as before.
  for (const t of weekTx) {
    if (t.kind !== 'manual_charge' || t.state !== 'approved' || t.companyCost) continue;
    if (t.installments && t.installments.total > 1) continue;
    const cents = t.amountCents - t.recoveredCents;
    if (cents <= 0) continue;
    deductions.push({ kind: 'manual_charge', description: t.description, cents, onDate: t.onDate, txId: t.id, basis: t.source });
  }
  // Lease owner charges (owner, 2026-10-12): tractor lease by odometer tier, maintenance per mile,
  // the optional dispatch fee and the sheet's fixed charges. A mileage charge that cannot be
  // figured (no odometer) is an exception, never a guess.
  const leaseOut: NonNullable<StatementComputation['leaseCharges']> = [];
  const skipped: SkippedLine[] = [];
  const notes: string[] = [];
  // Lease charges only while a truck is assigned: no truck in the week, no lease line at all -
  // not a guess at the tier, not an exception to resolve, a note the driver can read.
  if (profile?.lease && input.leaseTruckAssigned === false) notes.push(NO_TRUCK_LEASE_NOTE);
  else if (profile?.lease) {
    // What a percentage load pay already kept of the gross it was figured on (85% pay keeps 15%):
    // the dispatch fee is the company's cut of that gross, so it only takes what is still short of
    // its percentage - never the cut twice (owner, 2026-10-29). Mileage and flat pay keep nothing.
    const keptCents = sumCents(
      earnings
        .filter((e) => e.kind === 'percentage' && !e.txId && typeof e.payBasisCents === 'number')
        .map((e) => Math.max(0, Math.round(e.payBasisCents! / (e.teamShare?.drivers ?? 1)) - e.cents)),
    );
    const lease = leaseCharges(profile.lease, { grossCents, loadGrossCents: grossCents + keptCents, keptCents, periodStart: period.start, periodEnd: period.end, odometer: input.odometer ?? null });
    exceptions.push(...lease.problems);
    notes.push(...lease.notes);
    for (const l of lease.lines) {
      // A one-week change decided by Accounting wins over the plan: skipped (0) or another amount.
      const override = input.leaseOverrides?.find((o) => o.code === l.code && o.periodStart === period.start);
      if (override && override.cents === 0) {
        skipped.push({ kind: 'lease', ref: l.code, description: l.description, cents: l.cents, reason: override.reason });
        continue;
      }
      const cents = override ? override.cents : l.cents;
      // The arithmetic travels with the line, so the statement shows the miles and the tier.
      const shown = override ? `${l.description} (changed this week: ${override.reason})` : l.code === 'tractor_lease' || l.code === 'maintenance_fee' || l.code === 'dispatch_fee' ? `${l.description} (${l.basis})` : l.description;
      deductions.push({ kind: 'lease', description: shown, cents, onDate: period.end, txId: null, basis: l.basis, ref: l.code });
      leaseOut.push({ code: l.code, cents, description: l.description });
    }
  }
  // A deduction reversed after its statement was posted is paid back on the next one, once: the
  // refund is its own transaction, applied by the statement that carries it.
  for (const t of input.transactions) {
    if (t.kind !== 'adjustment' || t.source !== 'recovery_reversal' || t.state !== 'approved' || t.settlementId) continue;
    deductions.push({ kind: 'reversal', description: t.description, cents: -t.amountCents, onDate: t.onDate, txId: t.id, basis: 'deduction reversed' });
  }
  const pendingCount = weekTx.filter((t) => t.state === 'pending').length;
  if (pendingCount > 0) exceptions.push(`${pendingCount} transaction${pendingCount === 1 ? '' : 's'} this week still pending approval.`);

  const recurringCharges: StatementComputation['recurringCharges'] = [];
  if (sw?.recurringDeductions) {
    for (const d of input.recurring) {
      const r = recurringChargeFor(d, { start: period.start, end: period.end }, worked);
      const weekOverride = d.overrides.find((o) => o.periodStart === period.start);
      if (weekOverride && weekOverride.amountCents === 0 && d.status === 'active') {
        skipped.push({ kind: 'recurring', ref: d.id, description: d.label || d.category, cents: d.amountCents, reason: weekOverride.reason });
      }
      if (r.cents > 0) {
        deductions.push({ kind: 'recurring', description: d.label || d.category, cents: r.cents, txId: null, basis: d.cadence + (r.reason ? ` · ${r.reason}` : ''), ref: d.id });
        recurringCharges.push({ deductionId: d.id, cents: r.cents, description: d.label || d.category });
      }
    }
  }

  // Debt recovery from what is left, oldest first; then escrow. A charge already taken as a
  // deduction this week is settled by that line and is not open debt as well.
  const deductedIds = new Set(deductions.map((d) => d.txId).filter(Boolean));
  // A charge timed after this period closes (a Monday-morning fuel purchase dated on the next
  // period's first day is this period's; one after noon is the next one's) is not yet open debt.
  const debt = debtSummary(input.openingDebtCents, input.transactions.filter((t) => !deductedIds.has(t.id) && !(t.occurredAt && Date.parse(t.occurredAt) >= Date.parse(period.cutoffAt))), period.end);
  const afterCharges = grossCents + reimbursementsCents - sumCents(deductions.map((d) => d.cents));
  // Everything still open is recoverable - including a charge raised this week - except what this statement already took as a deduction line.
  const recoveries = planRecoveries(debt.open, Math.max(0, afterCharges));
  for (const r of recoveries) {
    const tx = debt.open.find((t) => t.id === r.txId)!;
    // The evidence a driver needs to check a deduction: what was charged, what earlier statements
    // already took, and what is left after this one.
    deductions.push({ kind: 'debt_recovery', description: `Recovery · ${tx.description}`, cents: r.cents, onDate: tx.onDate, txId: r.txId, basis: `${asMoney(tx.amountCents)} charged · ${asMoney(tx.recoveredCents)} already deducted · ${asMoney(tx.amountCents - tx.recoveredCents - r.cents)} remaining` });
  }
  const afterRecovery = afterCharges - sumCents(recoveries.map((r) => r.cents));

  let escrowCents = 0;
  const esc = profile?.switches.escrowEnabled ? escrowSummary(profile.escrow as EscrowPlan, input.transactions, period.end) : null;
  if (esc) {
    if (esc.balanceCents === null) exceptions.push('Escrow opening balance is not reconciled: escrow is not deducted until it is.');
    else {
      escrowCents = Math.min(esc.nextDeductionCents, Math.max(0, afterRecovery));
      if (escrowCents > 0) deductions.push({ kind: 'escrow', description: `Escrow · to $${(esc.targetCents / 100).toFixed(0)}`, cents: escrowCents, txId: null, basis: `balance ${asMoney(esc.balanceCents)}` });
    }
  }

  const deductionsCents = sumCents(deductions.filter((d) => d.kind !== 'escrow').map((d) => d.cents));
  const netCents = grossCents + reimbursementsCents - deductionsCents - escrowCents;
  const { payableCents, carryCents } = settleNet(netCents);

  const closingDebt = debt.closingCents === null ? null : debt.closingCents - sumCents(recoveries.map((r) => r.cents)) + carryCents;
  return {
    earnings,
    deductions,
    grossCents,
    reimbursementsCents,
    deductionsCents,
    escrowCents,
    netCents,
    payableCents,
    carryCents,
    openingDebtCents: debt.closingCents,
    closingDebtCents: closingDebt,
    escrowBalanceAfterCents: esc && esc.balanceCents !== null ? esc.balanceCents + escrowCents : null,
    loadCount,
    totalMiles,
    exceptions,
    excluded,
    recoveries,
    recurringCharges,
    leaseCharges: leaseOut,
    skipped,
    notes,
    // Only the loads this statement pays: an excluded load is listed with its reason instead.
    loadFacts: loadPayFacts(input.loads.filter((l) => earnings.some((e) => e.loadId === l.id))),
  };
}

/** Batch totals (§8): count, sum of signed net, positive cash out, negative carry - never netted across people. */
export function batchTotals(rows: Array<{ netCents: number; payableCents: number; carryCents: number }>): { count: number; signedNetCents: number; payableCents: number; carryCents: number } {
  return {
    count: rows.length,
    signedNetCents: sumCents(rows.map((r) => r.netCents)),
    payableCents: sumCents(rows.map((r) => r.payableCents)),
    carryCents: sumCents(rows.map((r) => r.carryCents)),
  };
}

export const SETTLEMENT_KINDS = ['cd', 'lo_oo', 'vt'] as const;
export type SettlementKind = (typeof SETTLEMENT_KINDS)[number];
export const SETTLEMENT_KIND_LABEL: Record<SettlementKind, string> = { cd: 'Company drivers (CD)', lo_oo: 'LO & OO', vt: 'Vendors (VT)' };

export function settlementKindFor(contract: 'CD' | 'LO' | 'OO'): SettlementKind {
  return contract === 'CD' ? 'cd' : 'lo_oo';
}

export { bpsOf };

/**
 * What a completed load has earned a driver so far (section 2): the same explanation the
 * statement uses, summarised, with the reason it cannot be finalised when there is one.
 */
export function earningsPreview(
  load: SettleableLoadV2,
  driverId: string,
  profile: ProfileVersion | null,
  cfg: { teamBaseMileageSplit: 'each_full' | 'split_50_50' | null },
  rateAmbiguous: boolean,
): { cents: number | null; lines: EarningLine[]; blockers: string[] } {
  if (!profile) return { cents: null, lines: [], blockers: ['No pay plan on file for this driver.'] };
  if (profile.loadedPlan.kind === 'none') return { cents: null, lines: [], blockers: ['Loaded pay plan is blank.'] };
  const pay = explainLoadPay(load, driverId, profile, cfg);
  const blockers = [...pay.exceptions];
  if (rateAmbiguous) blockers.push(`Rate ${profile.loadedPlan.rate}% needs confirmation: it may have been meant as ${Number((profile.loadedPlan.rate * 100).toFixed(4))}%.`);
  const cents = sumCents(pay.lines.filter((l) => l.kind !== 'reimbursement').map((l) => l.cents));
  return { cents: pay.exceptions.some((e) => e.includes('not configured')) ? null : cents, lines: pay.lines, blockers };
}
