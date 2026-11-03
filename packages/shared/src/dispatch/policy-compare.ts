/**
 * The policy document dated 2026-09-23, and what it changes.
 *
 * The owner supplied a screenshot of DISP-KPI-01 version 2026-09-23. The version in force is
 * 2026-08-24. This file writes the screenshot's rules down as a **draft** — a version an
 * administrator can read, compare and activate, which never prices a week until they do — and
 * gives a field-by-field comparison so the decision is made on differences rather than on trust.
 *
 * Two things the comparison has to be careful about:
 *
 * - **The screenshot is cropped.** Its "Monthly bonuses and penalties" table is cut off. The draft
 *   therefore carries the monthly rules from the version in force unchanged, and the comparison
 *   reports them as "not visible in the screenshot" rather than as "removed". A cropped image is
 *   not evidence that a rule was deleted.
 * - **A tier list and a soft floor are not the same shape.** The document's first row, "positive
 *   gross below the floor pays 1 %", is the soft floor here, not a tier starting at zero. The
 *   money is identical; the comparison says so instead of reporting a phantom difference.
 */
import { DEFAULT_POLICY, type CommissionPolicy } from './policy.js';

/**
 * DISP-KPI-01 as the 2026-09-23 screenshot states it, as a draft.
 *
 * Every figure below is from the document. Where the document is silent — the monthly bonus and
 * penalty amounts, which are cropped — the values in force are carried forward untouched.
 */
export const SCREENSHOT_POLICY_2026_09_23: CommissionPolicy = {
  ref: 'DISP-KPI-01',
  version: '2026-09-23',
  effectiveFrom: '2026-09-23',
  status: 'draft',
  workDays: 5,
  // The document describes a five-active-day target, so the plan figure is measured against the
  // days the week was expected to run rather than across all seven.
  planAdjBasis: 'active_days',
  // The document does not say whether a short week also moves the tier and bonus thresholds.
  // It stays at the behaviour in force; an administrator can preview the other and choose.
  targetScaling: 'display_only',
  rpmNoPay: 2.5,
  belowFloorPct: 1,
  reducedPct: 1,
  juniorPct: 1,
  solo: {
    goal: 10_000,
    softFloor: 10_000,
    rpmMin: 2.8,
    bonusFrom: 12_000,
    tiers: [
      { from: 10_000, pct: 1.5, name: 'Base / Target' },
      { from: 12_000, pct: 1.75, name: 'Strong' },
      { from: 14_000, pct: 2.0, name: 'Advanced' },
      { from: 16_000, pct: 2.25, name: 'Elite' },
      { from: 18_000, pct: 2.5, name: 'Elite+' },
      { from: 20_000, pct: 2.75, name: 'Elite++' },
      { from: 22_000, pct: 3.0, name: 'Peak' },
    ],
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
    tiers: [
      { from: 16_000, pct: 1.5, name: 'Base / Target' },
      { from: 18_000, pct: 1.75, name: 'Strong' },
      { from: 20_000, pct: 2.0, name: 'Advanced' },
      { from: 22_000, pct: 2.25, name: 'Elite' },
      { from: 24_000, pct: 2.5, name: 'Elite+' },
      { from: 26_000, pct: 2.75, name: 'Elite++' },
      { from: 28_000, pct: 3.0, name: 'Peak' },
    ],
    rpmBonus: [
      { from: 4.0, addPct: 0.25 },
      { from: 4.5, addPct: 0.5 },
      { from: 5.0, addPct: 0.75 },
      { from: 5.5, addPct: 1.0 },
    ],
  },
  // Cropped in the screenshot: carried forward from the version in force, unchanged.
  laneBonus: DEFAULT_POLICY.laneBonus,
  penalties: DEFAULT_POLICY.penalties,
};

export interface PolicyDifference {
  area:
    | 'identity'
    | 'solo_tiers'
    | 'team_tiers'
    | 'rpm_floor'
    | 'rpm_reduction'
    | 'bonus_threshold'
    | 'bonus_bands'
    | 'complaint'
    | 'active_day_target'
    | 'monthly';
  field: string;
  /** What the version in force says. */
  active: string;
  /** What the other version says. */
  other: string;
  /** Same money, different shape, or a real change. */
  kind: 'same' | 'changed' | 'not_visible';
  note?: string;
}

const money = (n: number) => `$${n.toLocaleString('en-US')}`;
const tiersOf = (p: CommissionPolicy, unit: 'solo' | 'team') =>
  p[unit].tiers.map((t) => `${money(t.from)}=${t.pct.toFixed(2)}%`).join(', ');
const bandsOf = (p: CommissionPolicy, unit: 'solo' | 'team') =>
  p[unit].rpmBonus.map((b) => `${b.from.toFixed(2)}→+${b.addPct.toFixed(2)}`).join(', ');

/**
 * Every field of one policy against another, in the areas the owner asked about.
 *
 * `active` is the version in force; `other` is the one being considered. Rows marked `same` are
 * reported too — a comparison that only lists differences cannot be checked for completeness.
 */
export function comparePolicies(active: CommissionPolicy, other: CommissionPolicy): PolicyDifference[] {
  const rows: PolicyDifference[] = [];
  const add = (area: PolicyDifference['area'], field: string, a: string, b: string, note?: string) =>
    rows.push({ area, field, active: a, other: b, kind: a === b ? 'same' : 'changed', note });

  add('identity', 'Reference', active.ref, other.ref);
  add('identity', 'Version', active.version, other.version);
  add('identity', 'Effective from', active.effectiveFrom, other.effectiveFrom);

  for (const unit of ['solo', 'team'] as const) {
    const area = unit === 'solo' ? 'solo_tiers' : 'team_tiers';
    add(area, `${unit} gross tiers`, tiersOf(active, unit), tiersOf(other, unit));
    add(area, `${unit} soft floor`, money(active[unit].softFloor), money(other[unit].softFloor));
    rows.push({
      area,
      field: `${unit}: gross below the floor`,
      active: `${active.belowFloorPct.toFixed(2)}% (soft floor, RPM not consulted)`,
      other: `${other.belowFloorPct.toFixed(2)}% (soft floor, RPM not consulted)`,
      kind: active.belowFloorPct === other.belowFloorPct ? 'same' : 'changed',
      note: "The document's first row - positive gross below the floor pays 1 % - is the soft floor, not a tier starting at zero. Same money, different shape.",
    });
    add('rpm_reduction', `${unit} RPM minimum for the tier`, `$${active[unit].rpmMin.toFixed(2)}`, `$${other[unit].rpmMin.toFixed(2)}`);
    add('bonus_threshold', `${unit} RPM bonus from gross`, money(active[unit].bonusFrom), money(other[unit].bonusFrom));
    add('bonus_bands', `${unit} RPM bonus bands`, bandsOf(active, unit), bandsOf(other, unit));
    add('active_day_target', `${unit} weekly target`, money(active[unit].goal), money(other[unit].goal));
  }

  add('rpm_floor', 'RPM below which nothing is paid', `$${active.rpmNoPay.toFixed(2)}`, `$${other.rpmNoPay.toFixed(2)}`);
  add('rpm_reduction', 'Reduced rate between the no-pay line and the minimum', `${active.reducedPct.toFixed(2)}%`, `${other.reducedPct.toFixed(2)}%`);
  add('rpm_reduction', 'Junior flat rate', `${active.juniorPct.toFixed(2)}%`, `${other.juniorPct.toFixed(2)}%`);

  rows.push({
    area: 'complaint',
    field: 'A verified complaint',
    active: 'Withholds the RPM bonus only; the gross tier is untouched',
    other: 'Withholds the RPM bonus only; the gross tier is untouched',
    kind: 'same',
    note: 'Both state the same treatment, and the engine implements it that way.',
  });

  add('active_day_target', 'Active days in the target', String(active.workDays), String(other.workDays));
  rows.push({
    area: 'active_day_target',
    field: 'Plan figure divisor for a short week',
    active: (active.planAdjBasis ?? 'seven_day') === 'active_days' ? `goal ÷ ${active.workDays} active days` : 'goal ÷ 7 days of the week',
    other: (other.planAdjBasis ?? 'seven_day') === 'active_days' ? `goal ÷ ${other.workDays} active days` : 'goal ÷ 7 days of the week',
    kind: (active.planAdjBasis ?? 'seven_day') === (other.planAdjBasis ?? 'seven_day') ? 'same' : 'changed',
    note: 'The real difference between the two documents: both describe a five-active-day target, but the boards have always divided the goal across seven days.',
  });
  rows.push({
    area: 'active_day_target',
    field: 'Does a short week move the commission thresholds?',
    active: active.targetScaling ?? 'display_only',
    other: other.targetScaling ?? 'display_only',
    kind: (active.targetScaling ?? 'display_only') === (other.targetScaling ?? 'display_only') ? 'same' : 'changed',
    note: 'Neither document says. It is an explicit administrator setting with a preview of both outcomes, never assumed.',
  });

  const laneOf = (p: CommissionPolicy) => p.laneBonus.map((l) => `>${money(l.above)}:+${money(l.amount)}`).join(', ');
  const penOf = (p: CommissionPolicy) => p.penalties.map((x) => `${x.code}:-${money(x.amount)}`).join(', ');
  rows.push({
    area: 'monthly',
    field: 'Monthly lane bonuses',
    active: laneOf(active),
    other: laneOf(other),
    kind: laneOf(active) === laneOf(other) ? 'not_visible' : 'changed',
    note: 'Cropped in the screenshot. Carried forward from the version in force unchanged - a cropped image is not evidence that a rule was removed.',
  });
  rows.push({
    area: 'monthly',
    field: 'Monthly penalties',
    active: penOf(active),
    other: penOf(other),
    kind: penOf(active) === penOf(other) ? 'not_visible' : 'changed',
    note: 'Cropped in the screenshot. Carried forward unchanged.',
  });
  rows.push({
    area: 'monthly',
    field: 'How a monthly bonus or penalty is applied',
    active: 'Never automatically: a person approves and posts one row against the month',
    other: 'Never automatically: a person approves and posts one row against the month',
    kind: 'same',
  });

  return rows;
}

/** Only the rows that are genuinely different, for a reader who wants the short answer. */
export function policyDifferences(active: CommissionPolicy, other: CommissionPolicy): PolicyDifference[] {
  return comparePolicies(active, other).filter((r) => r.kind === 'changed');
}
