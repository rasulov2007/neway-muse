import { describe, expect, it } from 'vitest';
import {
  assignmentInForce,
  onBoardFrom,
  planHistoryBackfill,
  presenceInWeek,
  presenceOnDay,
  withoutTrucklessTeams,
  type HistoryBackfillInput,
} from './roster-history';

const row = (rosterId: string, effectiveFrom: string, dispatcherId: string, at = `${effectiveFrom}T12:00:00Z`) => ({
  rosterId,
  effectiveFrom,
  at,
  dispatcherId,
  dispatcherName: dispatcherId.toUpperCase(),
  truckUnit: null,
  coDriver: null,
  payTag: null,
});

describe('assignmentInForce', () => {
  const history = [row('r', '2026-09-21', 'adam'), row('r', '2026-10-01', 'lily')];

  it('a move mid-history: earlier weeks keep the old team, the move counts from its own date', () => {
    expect(assignmentInForce(history, '2026-09-27')?.dispatcherId).toBe('adam'); // last week's Sunday
    expect(assignmentInForce(history, '2026-09-30')?.dispatcherId).toBe('adam'); // the day before the move
    expect(assignmentInForce(history, '2026-10-01')?.dispatcherId).toBe('lily');
    expect(assignmentInForce(history, '2026-10-04')?.dispatcherId).toBe('lily'); // this week's Sunday
  });

  it('nothing in force before the first assignment', () => {
    expect(assignmentInForce(history, '2026-09-20')).toBeNull();
  });

  it('two moves on one date: the later save wins', () => {
    const same = [row('r', '2026-10-01', 'adam', '2026-10-01T10:00:00Z'), row('r', '2026-10-01', 'lily', '2026-10-01T11:00:00Z')];
    expect(assignmentInForce(same, '2026-10-01')?.dispatcherId).toBe('lily');
    expect(assignmentInForce([...same].reverse(), '2026-10-01')?.dispatcherId).toBe('lily');
  });
});

describe('presence on the boards', () => {
  it('a new driver added Thursday: absent last week, present this whole week on the weekly board', () => {
    const r = { onBoardFrom: onBoardFrom([row('r', '2026-10-01', 'adam')]), unassignedFrom: null };
    expect(presenceInWeek(r, '2026-09-21')).toBe('not-yet');
    expect(presenceInWeek(r, '2026-09-28')).toBe('on');
    expect(presenceInWeek(r, '2026-10-05')).toBe('on');
  });

  it('a new driver on the daily board: not on yesterday, on today', () => {
    const r = { onBoardFrom: '2026-10-01', unassignedFrom: null };
    expect(presenceOnDay(r, '2026-09-30')).toBe('not-yet');
    expect(presenceOnDay(r, '2026-10-01')).toBe('on');
  });

  it('data already on a week keeps the row there', () => {
    const r = { onBoardFrom: '2026-10-01', unassignedFrom: null };
    expect(presenceInWeek(r, '2026-09-21', true)).toBe('on');
    expect(presenceOnDay(r, '2026-09-30', true)).toBe('on');
  });

  it('unassigned from a week: gone from that week on, still in earlier weeks', () => {
    const r = { onBoardFrom: '2026-09-21', unassignedFrom: '2026-09-28' };
    expect(presenceInWeek(r, '2026-09-21')).toBe('on');
    expect(presenceInWeek(r, '2026-09-28')).toBe('unassigned');
    expect(presenceInWeek(r, '2026-10-05')).toBe('unassigned');
    expect(presenceOnDay(r, '2026-09-27')).toBe('on');
    expect(presenceOnDay(r, '2026-09-29')).toBe('unassigned');
  });

  it('a row with no history at all is on every date (how it read before the history was complete)', () => {
    const r = { onBoardFrom: null, unassignedFrom: null };
    expect(presenceInWeek(r, '2020-01-06')).toBe('on');
    expect(presenceOnDay(r, '2020-01-06')).toBe('on');
  });
});

describe('planHistoryBackfill', () => {
  const current = (id: string, createdOn: string, dispatcherId = 'lily') => ({
    id,
    createdOn,
    dispatcherId,
    dispatcherName: dispatcherId.toUpperCase(),
    truckUnit: '101',
    coDriver: null,
    payTag: null,
  });

  it('a row without history gets one first assignment = its current team, dated the Monday of its first data', () => {
    const input: HistoryBackfillInput = {
      rows: [current('a', '2026-09-23')],
      history: [],
      firstData: new Map([['a', '2026-09-16']]),
    };
    expect(planHistoryBackfill(input)).toEqual([
      expect.objectContaining({ rosterId: 'a', effectiveFrom: '2026-09-14', reason: 'no-history', dispatcherId: 'lily', truckUnit: '101' }),
    ]);
  });

  it('no data: dated the Monday of the day the row was made', () => {
    const plan = planHistoryBackfill({ rows: [current('a', '2026-09-24')], history: [], firstData: new Map() });
    expect(plan[0]!.effectiveFrom).toBe('2026-09-21');
  });

  it('history that starts after the first data gets a first row with the values history began with', () => {
    const plan = planHistoryBackfill({
      rows: [current('a', '2026-09-24', 'lily')],
      history: [row('a', '2026-09-24', 'adam'), row('a', '2026-09-30', 'lily')],
      firstData: new Map([['a', '2026-09-21']]),
    });
    expect(plan).toEqual([expect.objectContaining({ effectiveFrom: '2026-09-21', reason: 'starts-late', dispatcherId: 'adam' })]);
  });

  it('skips a row whose history already reaches back, so a second run plans nothing', () => {
    const input: HistoryBackfillInput = {
      rows: [current('a', '2026-09-24'), current('b', '2026-09-24')],
      history: [row('a', '2026-09-21', 'lily')],
      firstData: new Map([['b', '2026-09-22']]),
    };
    const first = planHistoryBackfill(input);
    expect(first.map((p) => p.rosterId)).toEqual(['b']);
    const again = planHistoryBackfill({
      ...input,
      history: [...input.history, ...first.map((p) => ({ ...p, at: '2026-10-01T00:00:00Z' }))],
    });
    expect(again).toEqual([]);
  });

  it('after the backfill a move only changes the move week on: the scenario the owner reported', () => {
    // A roster-import driver with no history, moved from ADAM to LILY on Thursday 2026-10-01.
    const plan = planHistoryBackfill({ rows: [current('a', '2026-09-22', 'adam')], history: [], firstData: new Map() });
    const history = [...plan.map((p) => ({ ...p, at: '2026-10-01T09:00:00Z' })), row('a', '2026-10-01', 'lily')];
    expect(assignmentInForce(history, '2026-09-27')?.dispatcherId).toBe('adam');
    expect(assignmentInForce(history, '2026-10-04')?.dispatcherId).toBe('lily');
  });
});

describe('a dispatcher is on the boards once a truck is assigned (owner, 2026-10-26)', () => {
  const r = (id: string, dispatcherId: string, truckUnit: string | null, money = 0) => ({ id, dispatcherId, truckUnit, money });
  const ids = (rows: { id: string }[]) => rows.map((x) => x.id);

  it('leaves out a team none of whose rows has a truck', () => {
    expect(ids(withoutTrucklessTeams([r('a', 'new', null), r('b', 'new', '  '), r('c', 'old', '0033')]))).toEqual(['c']);
  });

  it('keeps a truckless driver inside a team that has a truck', () => {
    expect(ids(withoutTrucklessTeams([r('a', 'mix', null), r('b', 'mix', '0033')]))).toEqual(['a', 'b']);
  });

  it('keeps a team that holds work anyway (a past week with money)', () => {
    const rows = [r('a', 'paid', null, 1500), r('b', 'none', null)];
    expect(ids(withoutTrucklessTeams(rows, (x) => x.money !== 0))).toEqual(['a']);
  });

  it('never drops Unassigned drivers (no team)', () => {
    expect(ids(withoutTrucklessTeams([r('a', '', null)]))).toEqual(['a']);
  });
});
