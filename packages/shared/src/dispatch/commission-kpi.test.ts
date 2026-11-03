import { describe, expect, it } from 'vitest';
import { DEFAULT_POLICY, dispatcherCommission, type CommissionInput } from './policy';
import { daysWorked, planAdjustedCents } from './board';

/**
 * DISP-KPI-01, checked against the figures the owner supplied with the policy document.
 *
 * Every case states the money, not a rate, because the money is what a dispatcher is paid and
 * what the Commission page, the Salary Report and Staff Payroll must all agree on. Miles are
 * derived from the RPM being tested so the weighted RPM is exactly the figure named.
 */
const dollars = (n: number) => Math.round(n * 100);
const at = (unit: 'solo' | 'team', gross: number, rpm: number | null, extra: Partial<CommissionInput> = {}) =>
  dispatcherCommission({ unit, grossCents: dollars(gross), miles: rpm === null ? null : gross / rpm, ...extra });

describe('DISP-KPI-01: the cases the owner gave', () => {
  it('pays a solo week of $9,200 a flat 1 % under the soft floor', () => {
    const r = at('solo', 9_200, 3.1);
    expect(r.amountCents).toBe(dollars(92));
    expect(r.status).toBe('below_floor');
    // Below the floor the RPM is not consulted at all, however good or bad it is.
    expect(at('solo', 9_200, 2.1).amountCents).toBe(dollars(92));
    expect(at('solo', 9_200, null).amountCents).toBe(dollars(92));
  });

  it('reduces a solo week of $11,000 at RPM $2.70 to 1 %', () => {
    const r = at('solo', 11_000, 2.7);
    expect(r.amountCents).toBe(dollars(110));
    expect(r.status).toBe('reduced');
    expect(r.bonusPct).toBe(0);
  });

  it('pays nothing for a solo week of $11,000 at RPM $2.49', () => {
    const r = at('solo', 11_000, 2.49);
    expect(r.amountCents).toBe(0);
    expect(r.status).toBe('no_payment');
  });

  it('pays a clean solo week of $12,000 at RPM $3.50 the tier plus the bonus: 1.75 + 0.25 = 2.00 %', () => {
    const r = at('solo', 12_000, 3.5);
    expect(r.basePct).toBe(1.75);
    expect(r.bonusPct).toBe(0.25);
    expect(r.pct).toBe(2);
    expect(r.amountCents).toBe(dollars(240));
  });

  it('withholds only the bonus when that week has a verified complaint', () => {
    const r = at('solo', 12_000, 3.5, { complaint: true });
    expect(r.basePct).toBe(1.75);
    expect(r.bonusPct).toBe(0);
    expect(r.bonusWithheld).toBe(true);
    expect(r.amountCents).toBe(dollars(210));
  });

  it('pays a clean team week of $18,000 at RPM $4.00: 1.75 + 0.25 = 2.00 %', () => {
    const r = at('team', 18_000, 4);
    expect(r.pct).toBe(2);
    expect(r.amountCents).toBe(dollars(360));
  });
});

describe('DISP-KPI-01: the boundaries', () => {
  it('puts every solo gross tier on its exact threshold', () => {
    const rate = (gross: number) => at('solo', gross, 6).basePct;
    expect(at('solo', 9_999.99, 6).pct).toBe(1);
    expect(rate(10_000)).toBe(1.5);
    expect(rate(11_999.99)).toBe(1.5);
    expect(rate(12_000)).toBe(1.75);
    expect(rate(14_000)).toBe(2);
    expect(rate(16_000)).toBe(2.25);
    expect(rate(18_000)).toBe(2.5);
    expect(rate(20_000)).toBe(2.75);
    expect(rate(22_000)).toBe(3);
    expect(rate(100_000)).toBe(3);
  });

  it('puts every team gross tier on its exact threshold', () => {
    const rate = (gross: number) => at('team', gross, 6).basePct;
    expect(at('team', 15_999.99, 6).pct).toBe(1);
    expect(rate(16_000)).toBe(1.5);
    expect(rate(18_000)).toBe(1.75);
    expect(rate(20_000)).toBe(2);
    expect(rate(22_000)).toBe(2.25);
    expect(rate(24_000)).toBe(2.5);
    expect(rate(26_000)).toBe(2.75);
    expect(rate(28_000)).toBe(3);
  });

  it('treats the RPM thresholds as exact, never as a rounded display figure', () => {
    // $2.796 prints as $2.80 at two decimals; the rule is about the real number.
    expect(at('solo', 14_000, 2.796).status).toBe('reduced');
    expect(at('solo', 14_000, 2.8).status).toBe('ok');
    expect(at('solo', 14_000, 2.5).status).toBe('reduced');
    expect(at('solo', 14_000, 2.4999).status).toBe('no_payment');
    expect(at('team', 20_000, 2.9999).status).toBe('reduced');
    expect(at('team', 20_000, 3).status).toBe('ok');
  });

  it('starts each RPM bonus band exactly where it is written, and only above the gross threshold', () => {
    expect(at('solo', 11_999.99, 5).bonusPct).toBe(0); // below the $12,000 bonus threshold
    expect(at('solo', 12_000, 3.4999).bonusPct).toBe(0);
    expect(at('solo', 12_000, 3.5).bonusPct).toBe(0.25);
    expect(at('solo', 12_000, 4).bonusPct).toBe(0.5);
    expect(at('solo', 12_000, 4.5).bonusPct).toBe(0.75);
    expect(at('solo', 12_000, 5).bonusPct).toBe(1);
    expect(at('team', 17_999.99, 6).bonusPct).toBe(0);
    expect(at('team', 18_000, 3.9999).bonusPct).toBe(0);
    expect(at('team', 18_000, 4).bonusPct).toBe(0.25);
    expect(at('team', 18_000, 4.5).bonusPct).toBe(0.5);
    expect(at('team', 18_000, 5).bonusPct).toBe(0.75);
    expect(at('team', 18_000, 5.5).bonusPct).toBe(1);
  });

  it('says a week is unpriced rather than free when the miles are missing or zero', () => {
    const missing = at('solo', 12_500, null);
    expect(missing.status).toBe('needs_miles');
    expect(missing.amountCents).toBe(0);
    expect(dispatcherCommission({ unit: 'solo', grossCents: dollars(12_500), miles: 0 }).status).toBe('needs_miles');
    // A week with no gross is genuinely nothing, and says so differently.
    expect(at('solo', 0, 3).status).toBe('no_gross');
  });
});

describe('DISP-KPI-01: a four-week period is the sum of its truck-weeks', () => {
  /** Four solo weeks that would fall in very different tiers if they were added up first. */
  const weeks = [
    { gross: 9_200, rpm: 3.1 },   // below the floor → 1 % → $92.00
    { gross: 11_000, rpm: 2.7 },  // RPM reduced → 1 % → $110.00
    { gross: 12_000, rpm: 3.5 },  // 1.75 + 0.25 → $240.00
    { gross: 18_000, rpm: 4.6 },  // 2.50 + 0.75 → $585.00
  ];

  it('prices every week on its own and adds the results', () => {
    const results = weeks.map((w) => at('solo', w.gross, w.rpm));
    expect(results.map((r) => r.amountCents)).toEqual([dollars(92), dollars(110), dollars(240), dollars(585)]);
    const period = results.reduce((sum, r) => sum + r.amountCents, 0);
    expect(period).toBe(dollars(1_027));
  });

  it('is not the same as one tier applied to four weeks of combined gross', () => {
    const combined = weeks.reduce((sum, w) => sum + w.gross, 0); // $50,200
    const miles = weeks.reduce((sum, w) => sum + w.gross / w.rpm, 0);
    const asOneWeek = dispatcherCommission({ unit: 'solo', grossCents: dollars(combined), miles });
    // The combined figure lands in the top tier and pays far more than the weeks really earned:
    // 3 % of $50,200 is $1,506, against the $1,027 the four weeks actually earned week by week.
    expect(asOneWeek.pct).toBe(3);
    expect(asOneWeek.amountCents).toBe(dollars(1_506));
    expect(asOneWeek.amountCents).toBeGreaterThan(dollars(1_027));
    // Which is exactly why payroll must aggregate priced weeks, not gross.
    expect(asOneWeek.amountCents).not.toBe(dollars(1_027));
  });

  it('is not the same as a flat percentage of each load', () => {
    const combined = weeks.reduce((sum, w) => sum + w.gross, 0);
    expect(Math.round(combined * 100 * 0.05)).not.toBe(dollars(1_027));
  });
});

describe('the weekly target and the short week', () => {
  it('removes a day for HOME, VACATION, SHOP, STOP and NO ANSWER, but not for REST', () => {
    expect(daysWorked(['ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE'])).toBe(7);
    expect(daysWorked(['REST', 'ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE'])).toBe(7);
    for (const off of ['HOME', 'VACATION', 'SHOP', 'STOP', 'NO ANSWER']) {
      expect(daysWorked([off, 'ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE', 'ENROUTE']), off).toBe(6);
    }
  });

  it('scales the plan against the days actually worked', () => {
    // $8,000 against a $10,000 goal over 4 of 7 days is ahead of plan, not behind it.
    expect(planAdjustedCents(dollars(8_000), dollars(10_000), 4)).toBe(228_571);
  });

  it('does NOT move a tier or a bonus threshold: those are absolute weekly figures', () => {
    // A short week that earned $9,200 is still below the $10,000 floor, whatever the target was.
    expect(at('solo', 9_200, 4).status).toBe('below_floor');
    expect(DEFAULT_POLICY.solo.goal).toBe(10_000);
    expect(DEFAULT_POLICY.team.goal).toBe(16_000);
    expect(DEFAULT_POLICY.workDays).toBe(5);
  });
});

describe('the monthly bonuses and penalties are reference figures, not automatic money', () => {
  it('carries the complete table from the policy document', () => {
    expect(DEFAULT_POLICY.laneBonus).toEqual([
      { above: 75_000, amount: 1_000 },
      { above: 150_000, amount: 2_000 },
      { above: 200_000, amount: 3_000 },
    ]);
    expect(DEFAULT_POLICY.penalties).toEqual([
      { code: 'dnu', label: 'Do Not Use (DNU) status', amount: 1_000 },
      { code: 'driver_departure', label: 'Driver departure due to dispatcher', amount: 500 },
      { code: 'freight_guard', label: 'Freight Guard report', amount: 4_000 },
    ]);
  });

  it('never adds them to a weekly commission by itself', () => {
    // A $200,000 month does not change what any single week pays; the bonus is approved and
    // posted by a person, once, against the month it belongs to.
    expect(at('solo', 22_000, 5).amountCents).toBe(dollars(880));
  });
});
