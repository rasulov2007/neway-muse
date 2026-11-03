import { z } from 'zod';

/**
 * The dispatcher compensation policy (DISP-KPI-01) as data, and the one engine that reads it.
 *
 * Money is integer cents throughout. The policy is a versioned document: the board, the salary
 * report and the Commission page all read the version in force for the week they show, so an
 * edit to the rules today never rewrites a finalized week.
 */

export type UnitType = 'solo' | 'team';

export interface GrossTier {
  /** Weekly gross, in whole dollars, from which this tier applies (inclusive). */
  from: number;
  /** Base rate on gross, in percent, e.g. 2.25. */
  pct: number;
  name: string;
}

export interface RpmBand {
  /** Weighted RPM from which the bonus applies (inclusive). */
  from: number;
  /** Percentage points added to the base rate. */
  addPct: number;
}

export interface UnitRules {
  /** Weekly target per truck. */
  goal: number;
  /** Below this gross the truck pays the flat below-floor rate; no RPM rules apply. */
  softFloor: number;
  /** RPM below this (but at/above rpmNoPay) caps the base rate at the reduced rate. */
  rpmMin: number;
  /** Gross from which the RPM bonus can apply. */
  bonusFrom: number;
  /** Ascending by `from`; the first tier starts at `softFloor`. */
  tiers: GrossTier[];
  /** Ascending by `from`. */
  rpmBonus: RpmBand[];
}

export interface LaneBonusTier {
  /** Monthly lane volume above which the bonus applies. */
  above: number;
  amount: number;
}

export interface PenaltyRule {
  code: 'dnu' | 'driver_departure' | 'freight_guard';
  label: string;
  amount: number;
}

export type PolicyStatus = 'active' | 'draft';
export type PlanAdjBasis = 'seven_day' | 'active_days';
export type TargetScaling = 'display_only' | 'scale_thresholds';

export interface CommissionPolicy {
  ref: string;
  version: string;
  effectiveFrom: string;
  /** `draft` is written down for review and never prices a week. */
  status?: PolicyStatus;
  workDays: number;
  /** How a short week scales the plan figure the board shows. */
  planAdjBasis?: PlanAdjBasis;
  /** Whether a short week also moves the commission thresholds. */
  targetScaling?: TargetScaling;
  /** RPM below this, at or above the floor, pays nothing. */
  rpmNoPay: number;
  /** The flat rate below the soft floor. */
  belowFloorPct: number;
  /** The reduced base rate between rpmNoPay and rpmMin. */
  reducedPct: number;
  juniorPct: number;
  solo: UnitRules;
  team: UnitRules;
  laneBonus: LaneBonusTier[];
  penalties: PenaltyRule[];
}

const SOLO_TIERS: GrossTier[] = [
  { from: 10_000, pct: 1.5, name: 'Base / Target' },
  { from: 12_000, pct: 1.75, name: 'Strong' },
  { from: 14_000, pct: 2.0, name: 'Advanced' },
  { from: 16_000, pct: 2.25, name: 'Elite' },
  { from: 18_000, pct: 2.5, name: 'Elite+' },
  { from: 20_000, pct: 2.75, name: 'Elite++' },
  { from: 22_000, pct: 3.0, name: 'Peak' },
];
const TEAM_TIERS: GrossTier[] = [
  { from: 16_000, pct: 1.5, name: 'Base / Target' },
  { from: 18_000, pct: 1.75, name: 'Strong' },
  { from: 20_000, pct: 2.0, name: 'Advanced' },
  { from: 22_000, pct: 2.25, name: 'Elite' },
  { from: 24_000, pct: 2.5, name: 'Elite+' },
  { from: 26_000, pct: 2.75, name: 'Elite++' },
  { from: 28_000, pct: 3.0, name: 'Peak' },
];

/** DISP-KPI-01 as uploaded (the "Updated (6)" document): the policy in force until a version is saved. */
export const DEFAULT_POLICY: CommissionPolicy = {
  ref: 'DISP-KPI-01',
  version: '2026-08-24',
  effectiveFrom: '2026-08-24',
  workDays: 5,
  rpmNoPay: 2.5,
  belowFloorPct: 1,
  reducedPct: 1,
  juniorPct: 1,
  solo: {
    goal: 10_000,
    softFloor: 10_000,
    rpmMin: 2.8,
    bonusFrom: 12_000,
    tiers: SOLO_TIERS,
    rpmBonus: [
      { from: 3.5, addPct: 0.25 },
      { from: 4.0, addPct: 0.5 },
      { from: 4.5, addPct: 0.75 },
      { from: 5.0, addPct: 1.0 },
    ],
  },
  team: {
    goal: 16_000,
    softFloor: 16_000,
    rpmMin: 3.0,
    bonusFrom: 18_000,
    tiers: TEAM_TIERS,
    rpmBonus: [
      { from: 4.0, addPct: 0.25 },
      { from: 4.5, addPct: 0.5 },
      { from: 5.0, addPct: 0.75 },
      { from: 5.5, addPct: 1.0 },
    ],
  },
  laneBonus: [
    { above: 75_000, amount: 1_000 },
    { above: 150_000, amount: 2_000 },
    { above: 200_000, amount: 3_000 },
  ],
  penalties: [
    { code: 'dnu', label: 'Do Not Use (DNU) status', amount: 1_000 },
    { code: 'driver_departure', label: 'Driver departure due to dispatcher', amount: 500 },
    { code: 'freight_guard', label: 'Freight Guard report', amount: 4_000 },
  ],
};

// ------------------------------------------------------------------------------ validation

const money = z.number().finite().min(0);
const pct = z.number().finite().min(0).max(100);

export const GrossTierSchema = z.object({ from: money, pct, name: z.string().trim().min(1).max(40) });
export const RpmBandSchema = z.object({ from: z.number().finite().min(0).max(50), addPct: pct });
export const UnitRulesSchema = z.object({
  goal: money,
  softFloor: money,
  rpmMin: z.number().finite().min(0).max(50),
  bonusFrom: money,
  tiers: z.array(GrossTierSchema).min(1).max(20),
  rpmBonus: z.array(RpmBandSchema).max(20),
});
export const CommissionPolicySchema = z.object({
  ref: z.string().trim().min(1).max(40),
  version: z.string().trim().min(1).max(40),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /**
   * A draft is written down for an administrator to read and compare; it never prices a week.
   * Only an `active` version is ever in force, and activating one is a deliberate act.
   */
  status: z.enum(['active', 'draft']).default('active'),
  workDays: z.number().int().min(1).max(7),
  /**
   * How the weekly plan figure is scaled for a short week.
   *
   * `seven_day` divides the goal across the seven days of the week - what the boards have always
   * shown. `active_days` divides it across the policy's own `workDays`, which is what a document
   * describing a five-active-day target means. The two give different numbers for the same week,
   * so the choice is recorded on the policy instead of being assumed.
   */
  planAdjBasis: z.enum(['seven_day', 'active_days']).default('seven_day'),
  /**
   * Whether a short week also moves the commission thresholds.
   *
   * `display_only` leaves the gross tiers and the bonus thresholds as absolute weekly figures,
   * which is what the engine has always done. `scale_thresholds` would scale them by the days
   * actually worked. The policy document does not say which is intended, so this is an explicit
   * administrator setting with a preview of both, never a silent assumption.
   */
  targetScaling: z.enum(['display_only', 'scale_thresholds']).default('display_only'),
  rpmNoPay: z.number().finite().min(0).max(50),
  belowFloorPct: pct,
  reducedPct: pct,
  juniorPct: pct,
  solo: UnitRulesSchema,
  team: UnitRulesSchema,
  laneBonus: z.array(z.object({ above: money, amount: money })).max(20),
  penalties: z
    .array(
      z.object({
        code: z.enum(['dnu', 'driver_departure', 'freight_guard']),
        label: z.string().trim().min(1).max(80),
        amount: money,
      }),
    )
    .max(20),
});

/** The rules a schema cannot say: thresholds must climb, tiers must not overlap, floors must agree. */
export function policyProblems(p: CommissionPolicy): string[] {
  const out: string[] = [];
  for (const unit of ['solo', 'team'] as const) {
    const u = p[unit];
    const label = unit === 'solo' ? 'Solo' : 'Team';
    u.tiers.forEach((t, i) => {
      const prev = u.tiers[i - 1];
      if (prev && t.from <= prev.from)
        out.push(`${label} gross tier ${i + 1} (${t.name}) must start above tier ${i} ($${prev.from.toLocaleString('en-US')})`);
      if (prev && t.pct < prev.pct)
        out.push(`${label} gross tier ${i + 1} (${t.name}) pays less than tier ${i}`);
    });
    if (u.tiers[0] && u.tiers[0].from !== u.softFloor)
      out.push(`${label} soft floor ($${u.softFloor.toLocaleString('en-US')}) must equal the first gross tier ($${u.tiers[0].from.toLocaleString('en-US')})`);
    if (u.bonusFrom < u.softFloor)
      out.push(`${label} RPM bonus threshold must not be below the soft floor`);
    if (u.rpmMin <= p.rpmNoPay)
      out.push(`${label} RPM minimum ($${u.rpmMin.toFixed(2)}) must be above the no-payment RPM ($${p.rpmNoPay.toFixed(2)})`);
    u.rpmBonus.forEach((b, i) => {
      const prev = u.rpmBonus[i - 1];
      if (prev && b.from <= prev.from)
        out.push(`${label} RPM bonus band ${i + 1} must start above band ${i}`);
      if (prev && b.addPct < prev.addPct)
        out.push(`${label} RPM bonus band ${i + 1} adds less than band ${i}`);
      if (b.from < u.rpmMin) out.push(`${label} RPM bonus band ${i + 1} starts below the RPM minimum`);
    });
    if (u.goal <= 0) out.push(`${label} weekly goal must be positive`);
  }
  p.laneBonus.forEach((l, i) => {
    const prev = p.laneBonus[i - 1];
    if (prev && l.above <= prev.above) out.push(`Lane bonus tier ${i + 1} must start above tier ${i}`);
  });
  return out;
}

// ------------------------------------------------------------------------------ the engine

export interface CommissionInput {
  unit: UnitType;
  /**
   * Days the truck was expected to run this week, after the statuses that remove one.
   *
   * Only read when the policy sets `targetScaling: 'scale_thresholds'`. Absent means "a full
   * week", which is what every caller meant before the setting existed.
   */
  activeDays?: number | null;
  /** Linehaul gross for the truck-week, in cents. */
  grossCents: number;
  /** Miles for the truck-week; null or 0 means "not entered". */
  miles: number | null;
  /** A verified complaint for the week withholds the RPM bonus only. */
  complaint?: boolean;
  /** Junior dispatcher: the flat junior rate, no tiers, no bonus. */
  junior?: boolean;
}

export type CommissionStatus =
  | 'ok'
  | 'no_gross'
  | 'below_floor'
  | 'junior'
  | 'needs_miles'
  | 'no_payment'
  | 'reduced';

export interface CommissionResult {
  status: CommissionStatus;
  amountCents: number;
  /** The rate applied to gross, in percent. */
  pct: number;
  basePct: number;
  bonusPct: number;
  tier: string;
  /** Exact weighted RPM (gross ÷ miles), unrounded; null without miles. */
  rpm: number | null;
  bonusWithheld: boolean;
  /** The written calculation the board shows on hover and the salary report prints. */
  formula: string;
}

export function centsToDollars(cents: number): string {
  return (cents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' });
}

/**
 * How much of the weekly target this week was expected to carry.
 *
 * 1 unless the policy asks for scaled thresholds AND the week is short. A week with MORE active
 * days than the policy's work days is deliberately not capped here: the document does not say
 * what should happen, so the number is reported as it falls and the screen flags it.
 */
export function scaleFor(policy: CommissionPolicy, input: Pick<CommissionInput, 'activeDays'>): number {
  if ((policy.targetScaling ?? 'display_only') !== 'scale_thresholds') return 1;
  const days = input.activeDays;
  if (days === null || days === undefined) return 1;
  const workDays = policy.workDays > 0 ? policy.workDays : 5;
  return days / workDays;
}

/** `pct` of `cents`, rounded to the cent. */
export function pctOfCents(cents: number, pct: number): number {
  return Math.round((cents * pct) / 100);
}

/**
 * Per truck per week. Order: no positive gross → $0; below the soft floor → flat below-floor
 * rate (no RPM rules); junior → flat junior rate; no miles → "Needs miles"; RPM below the
 * no-payment line → $0; RPM below the minimum → reduced rate, no bonus; otherwise the gross tier
 * plus the RPM bonus once gross clears the bonus threshold and no complaint is on record.
 * RPM is compared exactly; only the display rounds it.
 */
export function dispatcherCommission(
  input: CommissionInput,
  policy: CommissionPolicy = DEFAULT_POLICY,
): CommissionResult {
  const { unit, grossCents } = input;
  const rules = policy[unit];
  const gross = grossCents / 100;
  const miles = input.miles !== null && input.miles > 0 ? input.miles : null;
  const rpm = miles !== null ? grossCents / 100 / miles : null;
  const rpmText = rpm === null ? 'no miles' : `RPM $${rpm.toFixed(2)}`;
  const grossText = centsToDollars(grossCents);
  const done = (
    status: CommissionStatus,
    basePct: number,
    bonusPct: number,
    tier: string,
    note: string,
    bonusWithheld = false,
  ): CommissionResult => {
    const rate = basePct + bonusPct;
    const amountCents = pctOfCents(grossCents, rate);
    return {
      status,
      amountCents,
      pct: rate,
      basePct,
      bonusPct,
      tier,
      rpm,
      bonusWithheld,
      formula: `${note} → ${rate.toFixed(2)} % × ${grossText} = ${centsToDollars(amountCents)}`,
    };
  };

  if (grossCents <= 0) {
    return {
      status: 'no_gross',
      amountCents: 0,
      pct: 0,
      basePct: 0,
      bonusPct: 0,
      tier: 'No gross',
      rpm,
      bonusWithheld: false,
      formula: 'No positive gross this week → $0.00',
    };
  }
  if (gross < rules.softFloor * scaleFor(policy, input)) {
    return done(
      'below_floor',
      policy.belowFloorPct,
      0,
      'Below floor',
      `${grossText} below the $${rules.softFloor.toLocaleString('en-US')} floor → flat ${policy.belowFloorPct.toFixed(2)} %`,
    );
  }
  if (input.junior) {
    return done('junior', policy.juniorPct, 0, 'Junior', `Junior dispatcher → flat ${policy.juniorPct.toFixed(2)} %`);
  }
  if (rpm === null) {
    return {
      status: 'needs_miles',
      amountCents: 0,
      pct: 0,
      basePct: 0,
      bonusPct: 0,
      tier: 'Needs miles',
      rpm: null,
      bonusWithheld: false,
      formula: `${grossText} is above the floor but the week has no miles → enter miles to price it`,
    };
  }
  if (rpm < policy.rpmNoPay) {
    return {
      status: 'no_payment',
      amountCents: 0,
      pct: 0,
      basePct: 0,
      bonusPct: 0,
      tier: 'No payment',
      rpm,
      bonusWithheld: false,
      formula: `${rpmText} below $${policy.rpmNoPay.toFixed(2)} → no payment`,
    };
  }
  // A short week can either leave the thresholds where they are (the default, and what the engine
  // has always done) or scale them by the days actually worked. The policy decides; nothing here
  // assumes one. `scale` is 1 unless the policy asks for scaling and the week was short.
  const scale = scaleFor(policy, input);
  const tier = [...rules.tiers].reverse().find((t) => gross >= t.from * scale) ?? rules.tiers[0]!;
  if (rpm < rules.rpmMin) {
    return done(
      'reduced',
      policy.reducedPct,
      0,
      `${tier.name} · RPM reduced`,
      `${tier.name} ${tier.pct.toFixed(2)} % but ${rpmText} below $${rules.rpmMin.toFixed(2)} → reduced to ${policy.reducedPct.toFixed(2)} %`,
    );
  }
  let bonusPct = 0;
  let withheld = false;
  let note = `${tier.name} ${tier.pct.toFixed(2)} %`;
  if (gross >= rules.bonusFrom * scale) {
    const band = [...rules.rpmBonus].reverse().find((b) => rpm >= b.from);
    if (band) {
      if (input.complaint) {
        withheld = true;
        note += ` (RPM bonus +${band.addPct.toFixed(2)} % withheld: complaint on record)`;
      } else {
        bonusPct = band.addPct;
        note += ` + RPM bonus ${band.addPct.toFixed(2)} % (${rpmText})`;
      }
    } else note += ` (${rpmText}, no bonus band)`;
  } else note += ` (${rpmText}; bonus from $${rules.bonusFrom.toLocaleString('en-US')})`;
  return done('ok', tier.pct, bonusPct, tier.name, note, withheld);
}

/**
 * What a truck-week pays once the manual layer is applied (owner, 2026-10-26: "until the gross
 * comes out the commission must be 0").
 *
 * - No override: the calculated amount.
 * - A manual approved **amount**: exactly that amount, gross or not - an administrator typed it on
 *   purpose, and the cell says Manual.
 * - An **adjustment** is added to the calculated amount only while the week has positive gross.
 *   With no gross there is nothing to adjust: it is held (payable $0) and applies by itself once
 *   the week has gross. Before this rule an adjustment on a $0 week wrote a commission by itself.
 */
export function payableCommissionCents(
  calculatedCents: number,
  grossCents: number,
  override: { mode: 'amount' | 'adjustment'; amountCents: number } | null,
): { payableCents: number; adjustmentHeld: boolean } {
  if (override === null) return { payableCents: calculatedCents, adjustmentHeld: false };
  if (override.mode === 'amount') return { payableCents: override.amountCents, adjustmentHeld: false };
  if (grossCents <= 0) return { payableCents: 0, adjustmentHeld: true };
  return { payableCents: calculatedCents + override.amountCents, adjustmentHeld: false };
}

/** Representative rows the Commission page previews before a version is saved. */
export const POLICY_PREVIEW_CASES: { label: string; unit: UnitType; gross: number; rpm: number | null }[] = [
  { label: 'Solo · $9,200 · below floor', unit: 'solo', gross: 9_200, rpm: 3.1 },
  { label: 'Solo · $11,000 · RPM $2.70', unit: 'solo', gross: 11_000, rpm: 2.7 },
  { label: 'Solo · $14,000 · RPM $2.40', unit: 'solo', gross: 14_000, rpm: 2.4 },
  { label: 'Solo · $16,000 · RPM $3.00', unit: 'solo', gross: 16_000, rpm: 3.0 },
  { label: 'Solo · $18,500 · RPM $4.10', unit: 'solo', gross: 18_500, rpm: 4.1 },
  { label: 'Solo · $12,500 · no miles', unit: 'solo', gross: 12_500, rpm: null },
  { label: 'Team · $15,000 · below floor', unit: 'team', gross: 15_000, rpm: 3.2 },
  { label: 'Team · $22,000 · RPM $4.20', unit: 'team', gross: 22_000, rpm: 4.2 },
  { label: 'Team · $29,000 · RPM $5.60', unit: 'team', gross: 29_000, rpm: 5.6 },
];

export function previewCommission(policy: CommissionPolicy) {
  return POLICY_PREVIEW_CASES.map((c) => {
    const grossCents = Math.round(c.gross * 100);
    const miles = c.rpm === null ? null : Math.round(c.gross / c.rpm);
    return { ...c, result: dispatcherCommission({ unit: c.unit, grossCents, miles }, policy) };
  });
}

// ------------------------------------------------------------------------------ contracts

export const PolicyVersionSchema = z.object({
  id: z.string(),
  version: z.string(),
  effectiveFrom: z.string(),
  note: z.string(),
  policy: CommissionPolicySchema,
  createdBy: z.string(),
  createdByName: z.string(),
  createdAt: z.string(),
});
export type PolicyVersion = z.infer<typeof PolicyVersionSchema>;

export const CreatePolicyVersionSchema = z.object({
  version: z.string().trim().min(1).max(40),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  note: z.string().trim().max(500).default(''),
  policy: CommissionPolicySchema,
});
export type CreatePolicyVersionInput = z.infer<typeof CreatePolicyVersionSchema>;

/** The Commission cell's manual layer: a replacement amount or an adjustment, always with a reason. */
export const WeekOverrideSchema = z.object({
  rosterId: z.string(),
  weekStart: z.string(),
  mode: z.enum(['amount', 'adjustment']),
  amountCents: z.number().int(),
  reason: z.string(),
  byName: z.string(),
  at: z.string(),
  version: z.number().int(),
});
export type WeekOverride = z.infer<typeof WeekOverrideSchema>;

export const WriteWeekOverrideSchema = z.object({
  rosterId: z.string().min(1),
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  /** Null removes the override (reset to the calculated value). */
  mode: z.enum(['amount', 'adjustment']).nullable(),
  amountCents: z.number().int().min(-10_000_000).max(10_000_000).optional(),
  reason: z.string().trim().min(3).max(500),
  expectedVersion: z.number().int().nullable().optional(),
});
export type WriteWeekOverrideInput = z.infer<typeof WriteWeekOverrideSchema>;

/** Week eligibility flags an admin sets: the complaint that withholds the RPM bonus, the junior rate. */
export const WriteWeekFlagsSchema = z.object({
  rosterId: z.string().min(1),
  weekStart: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  complaint: z.boolean(),
  junior: z.boolean(),
  reason: z.string().trim().max(500).default(''),
});
export type WriteWeekFlagsInput = z.infer<typeof WriteWeekFlagsSchema>;
