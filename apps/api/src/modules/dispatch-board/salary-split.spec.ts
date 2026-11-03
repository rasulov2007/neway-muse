import { describe, expect, it } from 'vitest';
import { splitTeamPay, type AllocationRow } from './salary.service';

/** A pair board split 50/50, except the weeks one of the pair ran it alone. */

const PAIR = [
  { employeeId: 'emp_marshall', name: 'MARSHALL', sharePct: 50 },
  { employeeId: 'emp_leo', name: 'LEO', sharePct: 50 },
];
const solo = (who: 0 | 1) => [{ ...PAIR[who]!, sharePct: 100 }];
const row = (effectiveFrom: string, shares: AllocationRow['shares']): AllocationRow => ({ dispatcherId: 'team_ml', effectiveFrom, shares });
const WEEKS = ['2026-09-07', '2026-09-14', '2026-09-21', '2026-09-28'].map((weekStart) => ({ weekStart, commissionCents: 100_00 }));
const byName = (r: ReturnType<typeof splitTeamPay>) => Object.fromEntries((r?.allocation ?? []).map((a) => [a.name, a.payableCents]));

describe('splitTeamPay', () => {
  it('splits every week 50/50 when the pair worked together', () => {
    const r = splitTeamPay([row('2026-06-15', PAIR)], 'team_ml', '2026-10-04', WEEKS, 0);
    expect(byName(r)).toEqual({ MARSHALL: 200_00, LEO: 200_00 });
    expect(r?.allocation?.map((a) => a.sharePct)).toEqual([50, 50]);
  });

  it('pays a solo week in full to whoever ran it, and the pair split again after', () => {
    // Newest first, as the query returns them.
    const rows = [row('2026-10-05', PAIR), row('2026-09-14', solo(1)), row('2026-09-07', solo(0)), row('2026-06-15', PAIR)];
    const r = splitTeamPay(rows, 'team_ml', '2026-10-04', WEEKS, 0);
    expect(byName(r)).toEqual({ MARSHALL: 100_00, LEO: 300_00 });
    expect(Object.fromEntries((r?.allocation ?? []).map((a) => [a.name, a.sharePct]))).toEqual({ MARSHALL: 25, LEO: 75 });
    // The following period is back to 50/50.
    expect(byName(splitTeamPay(rows, 'team_ml', '2026-11-01', WEEKS.map((w, i) => ({ ...w, weekStart: `2026-10-${String(5 + i * 7).padStart(2, '0')}` })), 0))).toEqual({ MARSHALL: 200_00, LEO: 200_00 });
  });

  it('splits monthly adjustments by the split in force at the end', () => {
    const rows = [row('2026-09-28', solo(1)), row('2026-06-15', PAIR)];
    const r = splitTeamPay(rows, 'team_ml', '2026-10-04', WEEKS, 10_00);
    expect(byName(r)).toEqual({ MARSHALL: 150_00, LEO: 260_00 });
  });

  it('always adds up to the team total to the cent', () => {
    const odd = WEEKS.map((w) => ({ ...w, commissionCents: 333 }));
    const r = splitTeamPay([row('2026-06-15', PAIR)], 'team_ml', '2026-10-04', odd, -1);
    expect((r?.allocation ?? []).reduce((t, a) => t + a.payableCents, 0)).toBe(333 * 4 - 1);
  });

  it('asks for an allocation when a split does not total 100 %', () => {
    const r = splitTeamPay([row('2026-09-14', [{ ...PAIR[0]!, sharePct: 60 }]), row('2026-06-15', PAIR)], 'team_ml', '2026-10-04', WEEKS, 0);
    expect(r?.allocation).toBeNull();
    expect(splitTeamPay([], 'team_ml', '2026-10-04', WEEKS, 0)).toBeNull();
  });
});
