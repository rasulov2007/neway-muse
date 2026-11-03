import { describe, expect, it } from 'vitest';
import { applyPercent, formatPercent, parsePercentInput, readRosterPercent } from './percent.js';
import { earningsPreview, explainLoadPay, type SettleableLoadV2 } from './settlement-rules.js';
import { defaultSwitches, type ProfileVersion } from './driver-account.js';

/**
 * Section 5: a percent is a percent. 0.3 is 0.3%, 30 is 30%, and a multiplier 0.3 (= 30%) is
 * flagged as ambiguous, never silently promoted. Linehaul and gross bases are different bases.
 * The dollar figures are fixtures, not any load's real revenue.
 */
const load = (over: Partial<SettleableLoadV2> = {}): SettleableLoadV2 => ({
  id: 'l', loadNumber: 'L-1', completedAt: '2026-09-25T15:00:00Z', originLabel: 'A', destinationLabel: 'B', loadedMiles: 1000, emptyMiles: 0,
  grossCents: 500_000, linehaulCents: 450_000, driverIds: ['d1'],
  accessorials: [{ id: 'a', type: 'detention', description: 'Detention', amountCents: 50_000, allocation: { chargeId: 'a', treatment: 'in_percentage_base', mode: 'full', value: 100, nature: 'earning', recipients: ['d1'] } }],
  funded: true, status: 'closed', ...over,
});
const profile = (kind: ProfileVersion['loadedPlan']['kind'], rate: number): ProfileVersion => ({ effectiveFrom: '2026-01-01', contractType: 'CD', switches: defaultSwitches('CD'), loadedPlan: { kind, rate }, emptyPlan: { kind: 'none', rate: 0 }, escrow: { targetCents: 0, perSettlementCents: 0, openingBalanceCents: 0, openingReconciled: true }, byId: 'u', byName: 'u', at: '2026-01-01T00:00:00Z' });

describe('percent representation', () => {
  it('0.3 is 0.3%, 30 is 30%, and a multiplier is flagged', () => {
    expect(applyPercent(500_000, 0.3)).toBe(1_500);
    expect(applyPercent(500_000, 30)).toBe(150_000);
    expect(formatPercent(0.3)).toBe('0.3%');
    expect(formatPercent(30)).toBe('30%');
    expect(readRosterPercent(0.3)).toMatchObject({ ambiguous: true, asPercent: '0.3%', asMultiplier: '30%' });
    expect(readRosterPercent(30).ambiguous).toBe(false);
  });
  it('round-trips input and display', () => {
    expect(parsePercentInput('0.3%')).toBe(0.3);
    expect(parsePercentInput('30')).toBe(30);
    expect(parsePercentInput('')).toBeNull();
    expect(formatPercent(parsePercentInput('0.3%')!)).toBe('0.3%');
  });
  it('linehaul basis pays on linehaul only; gross basis includes accessorials placed in the base', () => {
    const linehaul = explainLoadPay(load(), 'd1', profile('percent_of_linehaul', 30), { teamBaseMileageSplit: 'each_full' });
    const gross = explainLoadPay(load(), 'd1', profile('percent_of_gross', 30), { teamBaseMileageSplit: 'each_full' });
    expect(linehaul.lines[0]!.cents).toBe(135_000);
    expect(gross.lines[0]!.cents).toBe(150_000);
  });
  it('an ambiguous rate previews the figure but blocks finalisation with both readings', () => {
    const p = earningsPreview(load(), 'd1', profile('percent_of_linehaul', 0.3), { teamBaseMileageSplit: 'each_full' }, true);
    expect(p.cents).toBe(1_350);
    expect(p.blockers[0]).toContain('30%');
  });
  it('team drivers on a percentage plan share one percentage, never two full ones', () => {
    const team = load({ driverIds: ['d1', 'd2'] });
    const a = explainLoadPay(team, 'd1', profile('percent_of_gross', 30), { teamBaseMileageSplit: 'each_full' }).lines[0]!.cents;
    const b = explainLoadPay(team, 'd2', profile('percent_of_gross', 30), { teamBaseMileageSplit: 'each_full' }).lines[0]!.cents;
    expect(a + b).toBe(150_000);
  });
});

describe('a team load says how its share was figured', () => {
  // The statement that prompted this: basis $3,000, rate 25%, earnings $375 - correct, but a
  // driver reading it cannot see where the other half went.
  const team = load({ linehaulCents: 300_000, grossCents: 300_000, accessorials: [], driverIds: ['d1', 'd2'] });

  it('records the amount before the share and how many drivers shared it', () => {
    const line = explainLoadPay(team, 'd1', profile('percent_of_linehaul', 25), { teamBaseMileageSplit: 'each_full' }).lines[0]!;
    expect(line.payBasisCents).toBe(300_000);
    expect(line.teamShare).toEqual({ drivers: 2, beforeShareCents: 75_000 });
    expect(line.cents).toBe(37_500);
  });

  it('does not change what either driver is paid', () => {
    const a = explainLoadPay(team, 'd1', profile('percent_of_linehaul', 25), { teamBaseMileageSplit: 'each_full' }).lines[0]!;
    const b = explainLoadPay(team, 'd2', profile('percent_of_linehaul', 25), { teamBaseMileageSplit: 'each_full' }).lines[0]!;
    expect(a.cents + b.cents).toBe(75_000);
  });

  it('leaves a solo load without a share', () => {
    const line = explainLoadPay(load({ accessorials: [] }), 'd1', profile('percent_of_linehaul', 25), { teamBaseMileageSplit: 'each_full' }).lines[0]!;
    expect(line.teamShare ?? null).toBeNull();
  });
});
