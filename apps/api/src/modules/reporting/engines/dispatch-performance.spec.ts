import { describe, expect, it } from 'vitest';
import type { DispatchTeamWeek } from '../facts';
import {
  computeDispatchPerformance,
  countRpmBuckets,
  estimateFullWeekGross,
  rpmBucketFor,
} from './dispatch-performance';

function teamWeek(overrides: Partial<DispatchTeamWeek>): DispatchTeamWeek {
  return {
    teamId: 'team_a',
    teamName: 'Team A',
    weekStart: '2026-08-24',
    gross: 10000,
    loads: 5,
    activeTrucks: 4,
    truckDays: 70,
    activeTruckDays: 63,
    miles: 5000,
    truckRpms: [2.1, 1.9],
    ...overrides,
  };
}

const complete = { weekStart: '2026-08-24', isComplete: true, elapsedDays: 7 };
const current = { weekStart: '2026-08-31', isComplete: false, elapsedDays: 4 };

describe('rpmBucketFor', () => {
  it('assigns boundary values to the inclusive lower bucket edge', () => {
    expect(rpmBucketFor(1.4999)).toBe('lt150');
    expect(rpmBucketFor(1.5)).toBe('b150to200');
    expect(rpmBucketFor(1.9999)).toBe('b150to200');
    expect(rpmBucketFor(2)).toBe('b200to250');
    expect(rpmBucketFor(2.4999)).toBe('b200to250');
    expect(rpmBucketFor(2.5)).toBe('gte250');
    expect(rpmBucketFor(9)).toBe('gte250');
  });

  it('counts buckets and skips non-finite values', () => {
    expect(countRpmBuckets([1, 1.5, 2, 2.5, 3, Number.NaN, Number.POSITIVE_INFINITY])).toEqual({
      lt150: 1,
      b150to200: 1,
      b200to250: 1,
      gte250: 2,
    });
  });
});

describe('estimateFullWeekGross', () => {
  it('projects an incomplete week and labels it estimated', () => {
    expect(estimateFullWeekGross(4000, current)).toEqual({ value: 7000, estimated: true });
  });

  it('returns the actual gross for a complete week', () => {
    expect(estimateFullWeekGross(4000, complete)).toEqual({ value: 4000, estimated: false });
  });

  it('clamps elapsedDays into 1..7 so it never divides by zero', () => {
    expect(estimateFullWeekGross(700, { ...current, elapsedDays: 0 })).toEqual({
      value: 4900,
      estimated: true,
    });
    expect(estimateFullWeekGross(700, { ...current, elapsedDays: 12 })).toEqual({
      value: 700,
      estimated: true,
    });
  });
});

describe('computeDispatchPerformance', () => {
  const rows: DispatchTeamWeek[] = [
    teamWeek({ teamId: 'team_a', teamName: 'Team A', weekStart: '2026-08-24', gross: 10000 }),
    teamWeek({
      teamId: 'team_a',
      teamName: 'Team A',
      weekStart: '2026-08-31',
      gross: 4000,
      loads: 2,
      activeTrucks: 2,
      truckDays: 40,
      activeTruckDays: 30,
      miles: 2000,
      truckRpms: [1.2, 2.6],
    }),
    teamWeek({
      teamId: 'team_b',
      teamName: 'Team B',
      weekStart: '2026-08-24',
      gross: 12000,
      truckRpms: [2.5],
    }),
    teamWeek({
      teamId: 'team_b',
      teamName: 'Team B',
      weekStart: '2026-08-31',
      gross: 1000,
      truckRpms: [1.5],
    }),
    teamWeek({ teamId: 'team_b', teamName: 'Team B', weekStart: '2026-07-01', gross: 99999 }), // not listed
  ];

  it('computes per-week ratios and activeDaysPct', () => {
    const result = computeDispatchPerformance(rows, [complete, current]);
    const a = result.teams.find((t) => t.teamId === 'team_a');
    expect(a?.byWeek[0]).toMatchObject({
      weekStart: '2026-08-24',
      gross: 10000,
      loads: 5,
      activeTrucks: 4,
      activeDaysPct: 90,
      rpm: 2,
      grossPerTruck: 2500,
      rpmBuckets: { lt150: 0, b150to200: 1, b200to250: 1, gte250: 0 },
      cumulativeGross: 10000,
    });
    expect(a?.byWeek[1]).toMatchObject({
      activeDaysPct: 75,
      rpm: 2,
      grossPerTruck: 2000,
      cumulativeGross: 14000,
    });
  });

  it('labels the incomplete week as estimated and keeps estimates out of totals', () => {
    const result = computeDispatchPerformance(rows, [complete, current]);
    const a = result.teams.find((t) => t.teamId === 'team_a');
    expect(a?.byWeek[0]?.estimatedFullWeekGross).toEqual({ value: 10000, estimated: false });
    expect(a?.byWeek[1]?.estimatedFullWeekGross).toEqual({ value: 7000, estimated: true });
    expect(a?.totals.gross).toBe(14000);
    expect(a?.totals.loads).toBe(7);
  });

  it('ranks teams by total gross and ignores weeks outside the list', () => {
    const result = computeDispatchPerformance(rows, [complete, current]);
    expect(result.teams.map((t) => [t.teamId, t.rank, t.totals.gross])).toEqual([
      ['team_a', 1, 14000],
      ['team_b', 2, 13000],
    ]);
  });

  it('aggregates RPM buckets across teams for the latest week', () => {
    const result = computeDispatchPerformance(rows, [complete, current]);
    expect(result.latestWeekStart).toBe('2026-08-31');
    expect(result.rpmBucketsTotal).toEqual({ lt150: 1, b150to200: 1, b200to250: 0, gte250: 1 });
  });

  it('fills a zero row for a team missing a listed week, with null ratios', () => {
    const result = computeDispatchPerformance([rows[0] as DispatchTeamWeek], [complete, current]);
    const a = result.teams[0];
    expect(a?.byWeek).toHaveLength(2);
    expect(a?.byWeek[1]).toMatchObject({
      gross: 0,
      activeDaysPct: null,
      rpm: null,
      grossPerTruck: null,
      estimatedFullWeekGross: { value: 0, estimated: true },
    });
    expect(JSON.stringify(result)).not.toContain('NaN');
  });

  it('handles empty input', () => {
    const result = computeDispatchPerformance([], []);
    expect(result).toEqual({
      weeks: [],
      teams: [],
      latestWeekStart: null,
      rpmBucketsTotal: { lt150: 0, b150to200: 0, b200to250: 0, gte250: 0 },
    });
  });
});
