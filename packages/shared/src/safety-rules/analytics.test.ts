// ACCEPTANCE M1–M5 — analytics rules with small synthetic sets (SPEC §7.14). M6 (no dual axes, a table for every
// chart, tooltips) is a screen rule and is checked in the web tests.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { analytics, monthsOf, zonedMonth } from './analytics.js';
import type { DateRange } from './board.js';
import { resetRulesClock, setRulesClock } from './time.js';
import { FIXTURE_CLOCK, truthCase } from './test-fixtures/helpers.js';
import { seedState } from './test-fixtures/seed.js';
import type { AccidentCase, PreventValue, SafetyRulesState } from './types.js';

beforeAll(() => setRulesClock(() => FIXTURE_CLOCK));
afterAll(() => resetRulesClock());

const RANGE: DateRange = { key: 'custom', from: '2026-07-01T04:00:00.000Z', to: '2026-10-19T17:00:00.000Z' };

function state(cases: AccidentCase[], mileage: SafetyRulesState['mileage'] = []): SafetyRulesState {
  return { people: [], drivers: [{ id: 'd1', name: 'Pat Driver' } as SafetyRulesState['drivers'][number]], trucks: [], trailers: [], loads: [], assignments: [], cases, claims: [], tasks: [], evidence: [], events: [], workOrders: [], bills: [], downtime: [], mileage };
}
let n = 0;
function mk(at: string, edit: (c: AccidentCase) => void = () => {}): AccidentCase {
  n += 1;
  return truthCase((c) => {
    c.id = `a${n}`;
    c.number = `ACC-T-${String(n).padStart(3, '0')}`;
    c.occurredAt = at;
    c.submittedAt = at;
    edit(c);
  });
}
const prevent = (v: PreventValue) => (c: AccidentCase) => {
  c.determinations.preventability = { value: v };
};
const opts = { canSeeRestricted: true, zone: 'America/New_York' };

describe('month buckets are Eastern', () => {
  it('an accident at 11:30 PM Eastern on Sep 30 is a September case', () => {
    expect(zonedMonth('2026-10-01T03:30:00.000Z')).toBe('2026-09');
    expect(monthsOf(RANGE.from, RANGE.to)).toEqual(['2026-07', '2026-08', '2026-09', '2026-10']);
  });
});

describe('M1 rate per 1M miles only for months with odometer coverage ≥ 70%', () => {
  const cases = [mk('2026-08-10T15:00:00.000Z'), mk('2026-08-20T15:00:00.000Z'), mk('2026-09-10T15:00:00.000Z')];
  const a = analytics(
    state(cases, [
      { month: '2026-08', miles: 1_000_000, coverage: 0.69 },
      { month: '2026-09', miles: 500_000, coverage: 0.7 },
    ]),
    RANGE,
    opts,
  );
  it('0.69 → no rate, shaded with the reason', () => {
    expect(a.ratePerMonth.find((r) => r.month === '2026-08')).toMatchObject({ value: null, coverage: 0.69, note: 'Odometer coverage 69% — below 70%' });
  });
  it('0.70 → rate shown', () => {
    expect(a.ratePerMonth.find((r) => r.month === '2026-09')).toMatchObject({ value: 2, coverage: 0.7 });
  });
  it('overall rate uses only qualifying months and says k of n', () => {
    expect(a.kpis.ratePerMillionMiles).toEqual({ value: 2, dotValue: 0, qualifyingMonths: 1, totalMonths: 4 });
  });
  it('no qualifying month → no rate, with a reason', () => {
    const b = analytics(state(cases, [{ month: '2026-08', miles: 1_000_000, coverage: 0.5 }]), RANGE, opts);
    expect(b.kpis.ratePerMillionMiles).toMatchObject({ value: null, reason: 'Odometer coverage below 70% in every month', qualifyingMonths: 0 });
    expect(analytics(state(cases), RANGE, opts).kpis.ratePerMillionMiles).toMatchObject({ value: null, reason: 'No mileage data' });
  });
});

describe('M2 preventable share excludes the not decided', () => {
  it('3 preventable, 1 non-preventable, 2 not determined → 75%, 2 not decided', () => {
    const cs = [
      mk('2026-09-01T15:00:00.000Z', prevent('preventable')),
      mk('2026-09-02T15:00:00.000Z', prevent('preventable')),
      mk('2026-09-03T15:00:00.000Z', prevent('preventable')),
      mk('2026-09-04T15:00:00.000Z', prevent('non_preventable')),
      mk('2026-09-05T15:00:00.000Z'),
      mk('2026-09-06T15:00:00.000Z'),
    ];
    const a = analytics(state(cs), RANGE, opts);
    expect(a.kpis.preventableShare).toEqual({ value: 0.75, preventable: 3, decided: 4, notDecided: 2, caseIds: cs.slice(0, 3).map((c) => c.id) });
  });
});

describe('M3 driver insights count only cases that are not non-preventable', () => {
  it('two non-preventable cases of one driver → no driver insight, still in Repeat involvement', () => {
    const both = (c: AccidentCase) => {
      c.driverId = 'd1';
      c.type = 'Backing';
      c.determinations.preventability = { value: 'non_preventable' };
    };
    const cs = [mk('2026-09-01T15:00:00.000Z', both), mk('2026-09-20T15:00:00.000Z', both)];
    const a = analytics(state(cs), RANGE, opts);
    expect(a.insights.filter((i) => i.id.startsWith('driver:'))).toEqual([]);
    expect(a.repeatInvolvement).toEqual([{ kind: 'driver', id: 'd1', label: 'Pat Driver', cases: 2, preventable: 0, caseIds: cs.map((c) => c.id), numbers: cs.map((c) => c.number) }]);
  });
  it('two preventable cases of the same type → the pattern-not-fault insight', () => {
    const both = (c: AccidentCase) => {
      c.driverId = 'd1';
      c.type = 'Backing';
      c.determinations.preventability = { value: 'preventable' };
    };
    const cs = [mk('2026-09-01T15:00:00.000Z', both), mk('2026-09-20T15:00:00.000Z', both)];
    const ins = analytics(state(cs), RANGE, opts).insights.find((i) => i.id.startsWith('driver:'));
    expect(ins?.text).toBe('Pat Driver: 2 cases of the same type (“Backing”) within 12 months (non-preventable cases excluded). Review suggested; this is a pattern to check, not a finding of fault.');
    expect(ins?.caseIds).toEqual(cs.map((c) => c.id));
  });
});

describe('M4 small-sample banner below 12 cases', () => {
  const many = (k: number) => Array.from({ length: k }, (_, i) => mk(`2026-09-${String(i + 1).padStart(2, '0')}T15:00:00.000Z`));
  it('11 → banner', () => expect(analytics(state(many(11)), RANGE, opts).sample).toEqual({ cases: 11, smallSample: true }));
  it('12 → none', () => expect(analytics(state(many(12)), RANGE, opts).sample).toEqual({ cases: 12, smallSample: false }));
  it('drafts and test records are not counted', () => {
    const cs = [mk('2026-09-01T15:00:00.000Z'), mk('2026-09-02T15:00:00.000Z', (c) => { c.stage = 'draft'; }), mk('2026-09-03T15:00:00.000Z', (c) => { c.isTest = true; })];
    expect(analytics(state(cs), RANGE, opts).kpis.accidents).toBe(1);
  });
});

describe('M5 every chart mark and insight drills down to exactly the case ids in its bucket', () => {
  const s = seedState();
  const range: DateRange = { key: '12m', from: new Date(FIXTURE_CLOCK - 365 * 86_400_000).toISOString(), to: new Date(FIXTURE_CLOCK).toISOString() };
  const a = analytics(s, range, opts);
  const inRange = new Set(s.cases.filter((c) => c.stage !== 'draft' && !c.isTest && c.occurredAt >= range.from && c.occurredAt <= range.to).map((c) => c.id));
  const byId = new Map(s.cases.map((c) => [c.id, c] as const));
  it('partitions (month, type, preventability, cash month) cover every case once', () => {
    for (const buckets of [a.byMonth, a.byType, a.preventability, a.cashByMonth ?? [], a.ratePerMonth]) {
      const all = buckets.flatMap((b) => b.caseIds);
      expect(new Set(all).size).toBe(all.length);
      expect(new Set(all)).toEqual(inRange);
    }
  });
  it('each bucket holds exactly the cases that match it', () => {
    for (const b of a.byType) expect(b.caseIds.every((id) => byId.get(id)?.type === b.type) && b.caseIds.length === b.count).toBe(true);
    for (const b of a.preventability) expect(b.caseIds.every((id) => byId.get(id)?.determinations.preventability.value === b.outcome) && b.caseIds.length === b.count).toBe(true);
    for (const b of a.byMonth) expect(b.caseIds.length).toBe(b.minor + b.moderate + b.serious + b.critical);
    for (const b of a.whereByCorridor) expect(b.caseIds.length).toBe(b.count);
    for (const b of a.downtimeByTruck) expect(b.caseIds.every((id) => byId.get(id)?.truckId === b.truckId)).toBe(true);
  });
  it('every insight names its case ids, all from the range (driver ones from the 12 months)', () => {
    expect(a.insights.length).toBeGreaterThan(0);
    for (const i of a.insights) {
      expect(i.caseIds.length).toBeGreaterThan(0);
      expect(i.caseIds.every((id) => byId.has(id))).toBe(true);
    }
  });
  it('a role without money gets no money, the counts unchanged', () => {
    const b = analytics(s, range, { ...opts, seeMoney: false });
    expect([b.kpis.netCostCents, b.cashByMonth, b.estimateVsFinal, b.followThrough.recoveriesCents]).toEqual([null, null, null, null]);
    expect(b.kpis.accidents).toBe(a.kpis.accidents);
    expect(JSON.stringify(b.insights)).not.toMatch(/\$/);
  });
});
