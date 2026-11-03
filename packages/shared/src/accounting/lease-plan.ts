import { z } from 'zod';

/**
 * Lease owner charges (owner's Rent/Lease Contractor sheet, 2026-10-12), taken on settlements.
 *
 * Three ways a lease or owner driver runs:
 *  - `lease_owner`   — rents the company's tractor (Lease owner);
 *  - `lease_to_own`  — leases the company's tractor towards owning it (Leasing to owner);
 *  - `owner_truck`   — runs their own truck (Owner truck): only the dispatch fee, insurance, IFTA
 *                      and trailer rent.
 *
 * The tractor lease follows the truck's odometer (Samsara) through four tiers, and the
 * maintenance fee is charged per mile driven in the week, at a higher rate once the truck is past
 * 130,000 miles. Both are figured from the odometer at the end of the settlement week, so a draft
 * statement always shows today's number and the approved one keeps the number it was paid on.
 * Every charge can be switched off or changed per driver; the dispatch fee is optional.
 */

export const LEASE_PLAN_KINDS = ['lease_owner', 'lease_to_own', 'owner_truck'] as const;
export type LeasePlanKind = (typeof LEASE_PLAN_KINDS)[number];
export const LEASE_PLAN_LABEL: Record<LeasePlanKind, string> = {
  lease_owner: 'Lease owner',
  lease_to_own: 'Leasing to owner',
  owner_truck: 'Owner truck',
};

export const LeaseTierSchema = z.object({
  /** Up to and including this odometer reading; null = and above. */
  upToMiles: z.number().int().positive().nullable(),
  weeklyCents: z.number().int().min(0),
});

export const LeaseFixedChargeSchema = z.object({
  code: z.string().trim().min(1).max(40),
  label: z.string().trim().min(1).max(80),
  cents: z.number().int().min(0),
  cadence: z.enum(['weekly', 'monthly']),
  enabled: z.boolean(),
});

export const LeasePlanSchema = z.object({
  kind: z.enum(LEASE_PLAN_KINDS),
  tractorLease: z.object({ enabled: z.boolean(), tiers: z.array(LeaseTierSchema).min(1).max(10) }),
  dispatchFee: z.object({ enabled: z.boolean(), percent: z.number().min(0).max(100) }),
  maintenanceFee: z.object({
    enabled: z.boolean(),
    centsPerMile: z.number().min(0).max(1000),
    /** The rate once the truck's odometer is past `thresholdMiles`. */
    highCentsPerMile: z.number().min(0).max(1000),
    thresholdMiles: z.number().int().min(0),
  }),
  fixedCharges: z.array(LeaseFixedChargeSchema).max(30),
});
export type LeasePlan = z.infer<typeof LeasePlanSchema>;

export const DEFAULT_LEASE_TIERS: LeasePlan['tractorLease']['tiers'] = [
  { upToMiles: 200_000, weeklyCents: 115_000 },
  { upToMiles: 400_000, weeklyCents: 105_000 },
  { upToMiles: 650_000, weeklyCents: 95_000 },
  { upToMiles: null, weeklyCents: 85_000 },
];

/** The sheet's fixed charges. */
export const DEFAULT_LEASE_FIXED_CHARGES: LeasePlan['fixedCharges'] = [
  { code: 'trailer_rent', label: 'Trailer rent', cents: 22_000, cadence: 'weekly', enabled: true },
  { code: 'office_supplies', label: 'Office supplies', cents: 8_500, cadence: 'weekly', enabled: true },
  { code: 'ifta', label: 'IFTA (fuel tax)', cents: 3_500, cadence: 'weekly', enabled: true },
  { code: 'insurance', label: 'Commercial insurance (AL, PD, Cargo)', cents: 50_000, cadence: 'weekly', enabled: true },
  { code: 'occupational_accident', label: 'Occupational accident insurance', cents: 12_500, cadence: 'monthly', enabled: true },
  { code: 'tablet', label: 'Tablet / carrier fee', cents: 3_000, cadence: 'monthly', enabled: true },
  { code: 'toll_device', label: 'Toll device fee', cents: 4_500, cadence: 'monthly', enabled: true },
];

/** Security deposit: $3,000 at $350 a week until funded. */
export const LEASE_SECURITY_DEPOSIT = { targetCents: 300_000, perSettlementCents: 35_000 } as const;

const OWNER_TRUCK_CHARGES = new Set(['trailer_rent', 'ifta', 'insurance']);

export function defaultLeasePlan(kind: LeasePlanKind): LeasePlan {
  const ownTruck = kind === 'owner_truck';
  return {
    kind,
    tractorLease: { enabled: !ownTruck, tiers: DEFAULT_LEASE_TIERS.map((t) => ({ ...t })) },
    dispatchFee: { enabled: true, percent: 20 },
    maintenanceFee: { enabled: !ownTruck, centsPerMile: 13, highCentsPerMile: 20, thresholdMiles: 130_000 },
    // Owner truck pays only the dispatch fee, insurance, IFTA and trailer rent (owner, 2026-10-12).
    fixedCharges: DEFAULT_LEASE_FIXED_CHARGES.map((c) => ({ ...c, enabled: ownTruck ? OWNER_TRUCK_CHARGES.has(c.code) : c.enabled })),
  };
}

/** The tier the truck is in at this odometer reading. */
export function leaseTierFor(tiers: LeasePlan['tractorLease']['tiers'], odometer: number): { index: number; weeklyCents: number } {
  const sorted = [...tiers].sort((a, b) => (a.upToMiles ?? Infinity) - (b.upToMiles ?? Infinity));
  const index = sorted.findIndex((t) => t.upToMiles === null || odometer <= t.upToMiles);
  const tier = sorted[index === -1 ? sorted.length - 1 : index]!;
  return { index: index === -1 ? sorted.length - 1 : index, weeklyCents: tier.weeklyCents };
}

/** What the truck's odometer said for a settlement week, from the ELD readings. */
export interface WeekOdometer {
  unitNumber: string | null;
  /** Latest reading at or before the week's end. */
  endMiles: number | null;
  /** Latest reading before the week began; null when the truck has no earlier reading. */
  startMiles: number | null;
  endReadAt: string | null;
  /**
   * Miles the driver drove the company's trucks in the week, when the week holds more than one
   * truck assignment (each counted inside its own window). Absent: `endMiles - startMiles`.
   */
  miles?: number | null;
}

/** Said on a statement whose driver had no truck in the pay week (owner, 2026-10-22). */
export const NO_TRUCK_LEASE_NOTE = 'No truck assigned during this week — lease charges not taken';

/** A truck assignment as the lease rule reads it: calendar days, `endedOn` null while it runs. */
export interface LeaseAssignment {
  truckId: string;
  assignedOn: string;
  endedOn: string | null;
}

/**
 * The part of each truck assignment that falls in a pay week (owner, 2026-10-22): lease charges
 * are taken for a week only when the driver had a truck in it. The pay week runs Monday noon to
 * Monday noon (pay-period.ts) and an assignment's days are read at that same cutoff, so a truck
 * handed over on the Monday a week starts belongs to the new week and one dropped that Monday
 * does not. Any overlap is the whole week - the weekly charges are not prorated. Each window is
 * clamped to the week's days, for the odometer readings the maintenance fee is figured from.
 */
export function leaseAssignmentsInWeek<T extends LeaseAssignment>(
  assignments: readonly T[],
  period: { start: string; end: string },
): Array<T & { from: string; to: string }> {
  return assignments
    .filter((a) => a.assignedOn <= period.end && (a.endedOn === null || (a.endedOn > period.start && a.endedOn > a.assignedOn)))
    .sort((a, b) => a.assignedOn.localeCompare(b.assignedOn))
    .map((a) => ({ ...a, from: a.assignedOn > period.start ? a.assignedOn : period.start, to: a.endedOn !== null && a.endedOn < period.end ? a.endedOn : period.end }));
}

export interface LeaseChargeLine {
  code: string;
  description: string;
  cents: number;
  basis: string;
}

/**
 * The lease charges of one week. Returns the lines and, separately, what could not be figured
 * (no odometer for the truck): a charge that depends on miles is never guessed.
 */
export function leaseCharges(
  plan: LeasePlan,
  input: {
    grossCents: number;
    periodStart: string;
    periodEnd: string;
    odometer: WeekOdometer | null;
    /**
     * The loads' gross the driver's pay was figured on, and what the pay plan already kept of it
     * (a percentage plan below 100%). The dispatch fee is the company's cut of the load gross, so
     * what the pay plan already kept counts towards it - never taken twice (owner, 2026-10-29).
     * Absent: the pay was the whole gross and the fee is figured on `grossCents`.
     */
    loadGrossCents?: number;
    keptCents?: number;
  },
): { lines: LeaseChargeLine[]; problems: string[]; notes: string[] } {
  const lines: LeaseChargeLine[] = [];
  const problems: string[] = [];
  const notes: string[] = [];
  const money = (c: number) => `$${(c / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  const odo = input.odometer;
  const unit = odo?.unitNumber ? `unit ${odo.unitNumber}` : 'the truck';
  if (plan.tractorLease.enabled) {
    if (odo?.endMiles === null || odo?.endMiles === undefined) problems.push(`No odometer reading for ${unit} by ${input.periodEnd}: the tractor lease tier cannot be figured.`);
    else {
      const tier = leaseTierFor(plan.tractorLease.tiers, odo.endMiles);
      lines.push({ code: 'tractor_lease', description: `Tractor lease · tier ${tier.index + 1}`, cents: tier.weeklyCents, basis: `${odo.endMiles.toLocaleString('en-US')} mi on ${unit}` });
    }
  }
  if (plan.maintenanceFee.enabled) {
    if (odo?.endMiles === null || odo?.endMiles === undefined || odo.startMiles === null) problems.push(`No odometer readings for ${unit} at both ends of the week: the maintenance fee cannot be figured.`);
    else {
      const miles = Math.max(0, odo.miles ?? odo.endMiles - odo.startMiles);
      const high = odo.endMiles > plan.maintenanceFee.thresholdMiles;
      const rate = high ? plan.maintenanceFee.highCentsPerMile : plan.maintenanceFee.centsPerMile;
      const cents = Math.round(miles * rate);
      if (cents > 0) lines.push({ code: 'maintenance_fee', description: 'Maintenance fee', cents, basis: `${miles.toLocaleString('en-US')} mi × $${(rate / 100).toFixed(2)}/mi${high ? ` · past ${plan.maintenanceFee.thresholdMiles.toLocaleString('en-US')} mi` : ''}` });
    }
  }
  const base = input.loadGrossCents ?? input.grossCents;
  if (plan.dispatchFee.enabled && plan.dispatchFee.percent > 0 && base > 0) {
    const fee = Math.round((base * plan.dispatchFee.percent) / 100);
    const kept = Math.max(0, input.keptCents ?? 0);
    const cents = fee - kept;
    if (cents > 0) {
      const less = kept > 0 ? ` less ${money(kept)} already kept by the load pay` : '';
      lines.push({ code: 'dispatch_fee', description: 'Dispatch fee', cents, basis: `${plan.dispatchFee.percent}% of ${money(base)} gross${less}` });
    } else {
      notes.push(`Dispatch fee not taken: the load pay already keeps ${money(kept)} of the ${money(base)} gross, at least the ${plan.dispatchFee.percent}% fee.`);
    }
  }
  for (const c of plan.fixedCharges) {
    if (!c.enabled || c.cents <= 0) continue;
    if (c.cadence === 'monthly') {
      // Charged once a month: in the week that holds the 1st.
      const first = `${input.periodEnd.slice(0, 8)}01`;
      if (!(first >= input.periodStart && first <= input.periodEnd)) continue;
    }
    lines.push({ code: c.code, description: c.label, cents: c.cents, basis: c.cadence });
  }
  return { lines, problems, notes };
}
