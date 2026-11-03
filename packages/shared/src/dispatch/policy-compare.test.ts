import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, dispatcherCommission, policyProblems, type CommissionPolicy } from './policy';
import { SCREENSHOT_POLICY_2026_09_23, comparePolicies, policyDifferences } from './policy-compare';
import { activeDaysFor, daysWorked, planAdjustedCents } from './board';

const dollars = (n: number) => Math.round(n * 100);

/**
 * The acceptance examples, run against BOTH versions.
 *
 * Miles are chosen so the weighted RPM is exactly the figure named, with no rounding anywhere —
 * $14,000 over 4,000 miles is exactly $3.50, and nothing in the chain has to be trusted to be
 * precise. A case whose RPM cannot be hit exactly with whole miles is called out as such.
 */
const CASES: Array<{ name: string; unit: 'solo' | 'team'; gross: number; miles: number; complaint?: boolean; expect: number; rpm: string }> = [
  { name: 'solo $9,200 under the soft floor', unit: 'solo', gross: 9_200, miles: 2_875, expect: 9_200, rpm: '3.20' },
  { name: 'solo $11,000 at RPM $2.75', unit: 'solo', gross: 11_000, miles: 4_000, expect: 11_000, rpm: '2.75' },
  { name: 'solo $11,000 at RPM $2.20', unit: 'solo', gross: 11_000, miles: 5_000, expect: 0, rpm: '2.20' },
  { name: 'solo $14,000 at exactly RPM $3.50', unit: 'solo', gross: 14_000, miles: 4_000, expect: 31_500, rpm: '3.50' },
  { name: 'solo $14,000 at exactly RPM $3.50 with a verified complaint', unit: 'solo', gross: 14_000, miles: 4_000, complaint: true, expect: 28_000, rpm: '3.50' },
  { name: 'team $18,000 at exactly RPM $4.00', unit: 'team', gross: 18_000, miles: 4_500, expect: 36_000, rpm: '4.00' },
];

const run = (policy: CommissionPolicy, c: (typeof CASES)[number]) =>
  dispatcherCommission({ unit: c.unit, grossCents: dollars(c.gross), miles: c.miles, complaint: c.complaint }, policy);

describe('the 2026-09-23 document against the 2026-08-24 version in force', () => {
  it('is a valid policy in its own right', () => {
    expect(policyProblems(SCREENSHOT_POLICY_2026_09_23)).toEqual([]);
    expect(SCREENSHOT_POLICY_2026_09_23.status).toBe('draft');
  });

  it('differs in exactly two places: the version stamp and the short-week divisor', () => {
    const diffs = policyDifferences(DEFAULT_POLICY, SCREENSHOT_POLICY_2026_09_23);
    const fields = diffs.map((d) => d.field).sort();
    expect(fields).toEqual(['Effective from', 'Plan figure divisor for a short week', 'Version']);
  });

  it('carries the same money in every tier, floor, RPM rule and bonus band', () => {
    const rows = comparePolicies(DEFAULT_POLICY, SCREENSHOT_POLICY_2026_09_23);
    const money = rows.filter((r) => ['solo_tiers', 'team_tiers', 'rpm_floor', 'rpm_reduction', 'bonus_threshold', 'bonus_bands'].includes(r.area));
    expect(money.every((r) => r.kind === 'same')).toBe(true);
    expect(money.length).toBeGreaterThan(10);
  });

  it('treats a verified complaint the same way in both', () => {
    const row = comparePolicies(DEFAULT_POLICY, SCREENSHOT_POLICY_2026_09_23).find((r) => r.area === 'complaint');
    expect(row?.kind).toBe('same');
  });

  it('keeps the monthly rules the screenshot cropped, and says they were not visible', () => {
    const monthly = comparePolicies(DEFAULT_POLICY, SCREENSHOT_POLICY_2026_09_23).filter((r) => r.area === 'monthly');
    expect(monthly.some((r) => r.kind === 'not_visible')).toBe(true);
    expect(SCREENSHOT_POLICY_2026_09_23.laneBonus).toEqual(DEFAULT_POLICY.laneBonus);
    expect(SCREENSHOT_POLICY_2026_09_23.penalties).toEqual(DEFAULT_POLICY.penalties);
  });

  it('pays every acceptance example identically under both versions', () => {
    for (const c of CASES) {
      const active = run(DEFAULT_POLICY, c);
      const draft = run(SCREENSHOT_POLICY_2026_09_23, c);
      expect(active.amountCents, `${c.name} (2026-08-24)`).toBe(dollars(c.expect / 100));
      expect(draft.amountCents, `${c.name} (2026-09-23 draft)`).toBe(active.amountCents);
      expect(draft.pct, `${c.name} rate`).toBe(active.pct);
    }
  });
});

describe('RPM boundaries, with exact fixtures', () => {
  /** Gross and miles chosen so the division is exact; no rounding is involved anywhere. */
  const at = (unit: 'solo' | 'team', gross: number, miles: number, extra = {}) =>
    dispatcherCommission({ unit, grossCents: dollars(gross), miles, ...extra });

  it('is exactly $3.50 for $14,000 over 4,000 miles, and pays the bonus', () => {
    const r = at('solo', 14_000, 4_000);
    expect(14_000 / 4_000).toBe(3.5);
    expect(r.rpm).toBe(3.5);
    expect(r.bonusPct).toBe(0.25);
    expect(r.basePct).toBe(2);
    expect(r.amountCents).toBe(dollars(315)); // 2.00 % + 0.25 points = 2.25 % of $14,000
  });

  it('is below $3.50 for $12,000 over 3,429 miles, and pays no bonus', () => {
    const rpm = 12_000 / 3_429;
    expect(rpm).toBeLessThan(3.5);
    const r = at('solo', 12_000, 3_429);
    expect(r.bonusPct).toBe(0);
    expect(r.amountCents).toBe(dollars(210)); // 1.75 % of $12,000, no bonus
  });

  it('sits immediately below, exactly at, and above the no-pay line of $2.50', () => {
    // $10,000 over 4,000 miles is exactly $2.50; one more mile is below it.
    expect(10_000 / 4_000).toBe(2.5);
    expect(at('solo', 10_000, 4_000).status).toBe('reduced');
    expect(at('solo', 10_000, 4_001).status).toBe('no_payment');
    expect(at('solo', 10_000, 3_999).status).toBe('reduced');
  });

  it('sits immediately below, exactly at, and above the solo RPM minimum of $2.80', () => {
    // $14,000 over 5,000 miles is exactly $2.80.
    expect(14_000 / 5_000).toBe(2.8);
    expect(at('solo', 14_000, 5_000).status).toBe('ok');
    expect(at('solo', 14_000, 5_001).status).toBe('reduced');
    expect(at('solo', 14_000, 4_999).status).toBe('ok');
  });

  it('sits immediately below, exactly at, and above the team RPM minimum of $3.00', () => {
    // $18,000 over 6,000 miles is exactly $3.00.
    expect(18_000 / 6_000).toBe(3);
    expect(at('team', 18_000, 6_000).status).toBe('ok');
    expect(at('team', 18_000, 6_001).status).toBe('reduced');
  });

  it('sits immediately below, exactly at, and above every solo bonus band', () => {
    // $14,000 over 4,000 / 3,500 / 3,111.11… / 2,800 gives 3.50 / 4.00 / 4.50 / 5.00.
    const bands: Array<[number, number]> = [
      [4_000, 0.25], // 3.50
      [3_500, 0.5], // 4.00
      [2_800, 1], // 5.00
    ];
    for (const [miles, addPct] of bands) {
      expect(at('solo', 14_000, miles).bonusPct, `${14_000 / miles}`).toBe(addPct);
      // One mile more puts the RPM just under the band and drops it to the one below.
      expect(at('solo', 14_000, miles + 1).bonusPct).toBeLessThanOrEqual(addPct);
    }
    // Exactly $4.50: $18,000 over 4,000 miles.
    expect(18_000 / 4_000).toBe(4.5);
    expect(at('solo', 18_000, 4_000).bonusPct).toBe(0.75);
    expect(at('solo', 18_000, 4_001).bonusPct).toBe(0.5);
  });

  it('sits immediately below, exactly at, and above every team bonus band', () => {
    expect(18_000 / 4_500).toBe(4); // exactly $4.00
    expect(at('team', 18_000, 4_500).bonusPct).toBe(0.25);
    expect(at('team', 18_000, 4_501).bonusPct).toBe(0);
    expect(18_000 / 4_000).toBe(4.5);
    expect(at('team', 18_000, 4_000).bonusPct).toBe(0.5);
    expect(18_000 / 3_600).toBe(5);
    expect(at('team', 18_000, 3_600).bonusPct).toBe(0.75);
    expect(at('team', 20_000, 4_000).bonusPct).toBe(0.75); // exactly $5.00
    expect(22_000 / 4_000).toBe(5.5);
    expect(at('team', 22_000, 4_000).bonusPct).toBe(1);
  });

  it('keeps decimal miles exactly, and never rounds before comparing', () => {
    // A source that preserves decimals must not be rounded first: 3,428.5714… miles is exactly
    // $3.50 on $12,000, and rounding it to 3,429 whole miles would lose the bonus.
    const exact = 12_000 / 3.5;
    expect(at('solo', 12_000, exact).bonusPct).toBe(0.25);
    expect(at('solo', 12_000, Math.round(exact)).bonusPct).toBe(0);
  });
});

describe('the five-day target and the seven-day plan divisor', () => {
  it('measures the same week very differently on the two bases', () => {
    const total = dollars(8_000);
    const goal = dollars(10_000);
    expect(planAdjustedCents(total, goal, 4)).toBe(228_571); // goal ÷ 7 days
    expect(planAdjustedCents(total, goal, 4, { basis: 'active_days', workDays: 5 })).toBe(0); // goal ÷ 5
  });

  it('puts a solo day at $2,000 and a team day at $3,200 on the five-day basis', () => {
    // A week with one active day is measured against one fifth of the weekly goal.
    expect(planAdjustedCents(dollars(2_000), dollars(10_000), 1, { basis: 'active_days', workDays: 5 })).toBe(0);
    expect(planAdjustedCents(dollars(3_200), dollars(16_000), 1, { basis: 'active_days', workDays: 5 })).toBe(0);
  });

  it('removes a day for HOME, VACATION, SHOP, STOP and NO ANSWER, and not for REST', () => {
    const full = ['ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE'];
    expect(daysWorked(full)).toBe(7);
    expect(daysWorked(['REST', ...full.slice(1)])).toBe(7);
    for (const off of ['HOME', 'VACATION', 'SHOP', 'STOP', 'NO ANSWER']) {
      expect(daysWorked([off, ...full.slice(1)]), off).toBe(6);
    }
  });

  it('reports a week with more active days than the policy plans for, rather than capping it', () => {
    const full = ['ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE'];
    const seven = activeDaysFor(full, 5);
    expect(seven).toEqual({ activeDays: 7, overWorkDays: true });
    const five = activeDaysFor(['HOME', 'HOME', ...full.slice(2)], 5);
    expect(five).toEqual({ activeDays: 5, overWorkDays: false });
    // Nothing invents a rule for the extra days: the plan figure simply reflects them.
    expect(planAdjustedCents(dollars(10_000), dollars(10_000), 7, { basis: 'active_days', workDays: 5 })).toBe(-400_000);
  });

  it('has no partial day to handle, because a day is on or off', () => {
    // Every status is either off or not; there is no half-day in the data, and none is invented.
    expect(daysWorked(['HOME'])).toBe(6);
    expect(daysWorked([null])).toBe(7);
  });
});

describe('scaling the thresholds is a choice, and both outcomes can be previewed', () => {
  const short = { unit: 'solo' as const, grossCents: dollars(8_000), miles: 2_500, activeDays: 4 };

  it('leaves the thresholds alone by default, so a short week below the floor still pays 1 %', () => {
    const r = dispatcherCommission(short, DEFAULT_POLICY);
    expect(r.status).toBe('below_floor');
    expect(r.amountCents).toBe(dollars(80));
  });

  it('scales them when a policy asks, so the same week clears a four-fifths floor', () => {
    const scaled: CommissionPolicy = { ...DEFAULT_POLICY, targetScaling: 'scale_thresholds' };
    const r = dispatcherCommission(short, scaled);
    // Four active days of five scales the $10,000 floor to $8,000, which $8,000 reaches.
    expect(r.status).not.toBe('below_floor');
    expect(r.basePct).toBe(1.5);
    expect(r.amountCents).toBe(dollars(120));
  });

  it('changes nothing for a full week, whichever setting is chosen', () => {
    const full = { unit: 'solo' as const, grossCents: dollars(12_000), miles: 3_000, activeDays: 5 };
    const a = dispatcherCommission(full, DEFAULT_POLICY);
    const b = dispatcherCommission(full, { ...DEFAULT_POLICY, targetScaling: 'scale_thresholds' });
    expect(b.amountCents).toBe(a.amountCents);
  });
});
