// ACCEPTANCE F1–F3 at rule level (board KPI aggregates, DOT register list, Needs attention) and the board
// part of H5-R. Expected values from the fixture JSON (`board`, `attention`), money × 100.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { boardSummary, makeRange, type RangeKey } from './board.js';
import { byId, needsAttention } from './rules.js';
import { resetRulesClock, setRulesClock } from './time.js';
import { EXPECTED, FIXTURE_CLOCK } from './test-fixtures/helpers.js';
import { seedState } from './test-fixtures/seed.js';
import type { SafetyRulesState } from './types.js';

let s: SafetyRulesState;
beforeAll(() => {
  setRulesClock(() => FIXTURE_CLOCK);
  s = seedState();
});
afterAll(() => resetRulesClock());

const RANGES: [RangeKey, string][] = [
  ['90d', 'F1'],
  ['30d', 'F2'],
  ['12m', 'F2'],
  ['ytd', 'F2'],
];

describe('ACCEPTANCE F1/F2 — board KPI tiles per range (Safety Manager)', () => {
  it.each(RANGES)('%s (%s)', (key) => {
    const e = EXPECTED.board[key];
    const b = boardSummary(s, makeRange(key), { canSeeRestricted: true });
    expect({
      from: b.from, to: b.to, openCases: b.openCases, serious: b.serious, awaitingInvestigation: b.awaitingInvestigation,
      reported: b.reported, priorPeriod: b.priorPeriod, trucksDownNow: b.trucksDownNow, truckDaysInRange: +b.truckDaysInRange.toFixed(2),
      needsAttention: b.needsAttention, overdueTasks: b.overdueTasks, urgent: b.urgent, openClaims: b.openClaims,
      ourCostToCome: b.ourCostToComeCents, insurerReserves: b.insurerReservesCents, netCost: b.netCostCents, spent: b.spentCents,
      recovered: b.recoveredCents, lostRevenueNotCash: b.lostRevenueNotCashCents, dotRegister: b.dotRegister,
    }).toEqual({
      ...e,
      ourCostToCome: e.ourCostToCome * 100, insurerReserves: e.insurerReserves * 100, netCost: e.netCost * 100, spent: e.spent * 100,
      recovered: e.recovered * 100, lostRevenueNotCash: e.lostRevenueNotCash * 100,
    });
    expect(b.restrictedClaimsExcluded).toBe(0);
  });

  it('F1 90-day tiles read as in ACCEPTANCE', () => {
    const b = boardSummary(s, makeRange('90d'), { canSeeRestricted: true });
    expect([b.openCases, b.serious, b.awaitingInvestigation]).toEqual([3, 2, 0]);
    expect([b.reported, b.priorPeriod]).toEqual([7, 4]);
    expect([b.trucksDownNow, b.truckDaysInRange.toFixed(2)]).toEqual([1, '34.42']);
    expect([b.needsAttention, b.overdueTasks, b.urgent]).toEqual([8, 3, 3]);
    expect([b.openClaims, b.ourCostToComeCents, b.insurerReservesCents]).toEqual([8, 18_600_00, 193_540_00]);
    expect([b.netCostCents, b.spentCents, b.recoveredCents, b.lostRevenueNotCashCents]).toEqual([47_290_00, 58_580_00, 30_190_00, 21_180_00]);
  });

  it('F6 DOT register: 90 days and 12 months', () => {
    expect(boardSummary(s, makeRange('90d'), { canSeeRestricted: true }).dotRegister).toEqual(['ACC-2026-018', 'ACC-2026-016', 'ACC-2026-015', 'ACC-2026-013']);
    expect(boardSummary(s, makeRange('12m'), { canSeeRestricted: true }).dotRegister).toHaveLength(11);
  });
});

describe('ACCEPTANCE F3 — Needs attention, exactly 8 in order', () => {
  it('F3 matches the fixture list (tone, reason, title, accident, claim, due)', () => {
    const got = needsAttention(s).map((a) => ({
      tone: a.tone,
      reason: a.reason,
      title: a.title,
      accident: a.caseId ? (byId(s.cases, a.caseId)?.number ?? null) : null,
      claim: a.claimId ? (byId(s.claims, a.claimId)?.number ?? null) : null,
      due: a.due ?? null,
    }));
    expect(got).toEqual(EXPECTED.attention);
    expect(got).toHaveLength(8);
  });
});

describe('P1 — YTD starts at Eastern midnight (CLAUDE.md: every business date is US Eastern)', () => {
  it('Eastern YTD starts 2026-01-01 05:00Z and yields the same F2 YTD numbers as the fixture', () => {
    const r = makeRange('ytd', undefined, 'America/New_York');
    expect(r.from).toBe('2026-01-01T05:00:00.000Z');
    const e = EXPECTED.board.ytd;
    const b = boardSummary(s, r, { canSeeRestricted: true });
    expect([b.reported, b.priorPeriod, +b.truckDaysInRange.toFixed(2), b.netCostCents, b.spentCents, b.recoveredCents, b.lostRevenueNotCashCents]).toEqual([
      e.reported, e.priorPeriod, e.truckDaysInRange, e.netCost * 100, e.spent * 100, e.recovered * 100, e.lostRevenueNotCash * 100,
    ]);
    expect(b.dotRegister).toEqual(e.dotRegister);
  });
});

describe('H5-R board as Dispatch (no safety.restricted)', () => {
  it('H5-R our cost to come 16,100 · insurer reserves 111,040 · net cost 90 days 44,790', () => {
    const b = boardSummary(s, makeRange('90d'), { canSeeRestricted: false });
    expect(b.ourCostToComeCents).toBe(16_100_00);
    expect(b.insurerReservesCents).toBe(111_040_00);
    expect(b.netCostCents).toBe(44_790_00);
    expect(b.restrictedClaimsExcluded).toBe(1);
    expect(b.openClaims).toBe(8); // the claim still exists (number/type/status are not restricted)
  });
});
