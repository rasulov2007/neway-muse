import { describe, expect, it } from 'vitest';
import type { DashboardPeriodQuery } from '@neway/shared';
import { ReportingPeriodService } from './reporting-period.service';

const service = new ReportingPeriodService();
const chicago = { timezone: 'America/Chicago', weekStart: 1 };
/** Sunday, Sep 6 2026, 07:00 Chicago (12:00 UTC). */
const NOW = new Date('2026-09-06T12:00:00.000Z');
const EN = '–';

const q = (period: DashboardPeriodQuery['period'], from?: string, to?: string) => ({
  period,
  from,
  to,
});

describe('ReportingPeriodService.resolve', () => {
  it('today: company-local today vs yesterday', () => {
    const r = service.resolve(q('today'), chicago, NOW);
    expect(r).toMatchObject({
      preset: 'today',
      from: '2026-09-06',
      to: '2026-09-06',
      label: 'Today · Sep 6',
      isComplete: false,
      timezone: 'America/Chicago',
      weekStart: 1,
      comparison: { from: '2026-09-05', to: '2026-09-05', label: 'Sep 5, 2026' },
    });
  });

  it('this_week (Monday start): week start through today vs same span of previous week', () => {
    const r = service.resolve(q('this_week'), chicago, NOW);
    expect(r).toMatchObject({
      from: '2026-08-31',
      to: '2026-09-06',
      isComplete: false,
      comparison: { from: '2026-08-24', to: '2026-08-30' },
    });
    expect(r.label).toBe(`Aug 31 ${EN} Sep 6, 2026`);
  });

  it('this_week (Sunday start): Sunday today is a one-day week so far', () => {
    const r = service.resolve(q('this_week'), { ...chicago, weekStart: 0 }, NOW);
    expect(r).toMatchObject({
      from: '2026-09-06',
      to: '2026-09-06',
      comparison: { from: '2026-08-30', to: '2026-08-30' },
      weekStart: 0,
    });
  });

  it('last_week: previous full week vs the week before, complete', () => {
    const r = service.resolve(q('last_week'), chicago, NOW);
    expect(r).toMatchObject({
      from: '2026-08-24',
      to: '2026-08-30',
      isComplete: true,
      comparison: { from: '2026-08-17', to: '2026-08-23' },
    });
  });

  it('last_week (Sunday start)', () => {
    const r = service.resolve(q('last_week'), { ...chicago, weekStart: 0 }, NOW);
    expect(r).toMatchObject({
      from: '2026-08-30',
      to: '2026-09-05',
      comparison: { from: '2026-08-23', to: '2026-08-29' },
    });
  });

  it('this_month: 1st through today vs same day span of previous month', () => {
    const r = service.resolve(q('this_month'), chicago, NOW);
    expect(r).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-06',
      isComplete: false,
      comparison: { from: '2026-08-01', to: '2026-08-06' },
    });
    expect(r.label).toBe(`Sep 1 ${EN} Sep 6, 2026`);
  });

  it('this_month: comparison span is clamped to the shorter previous month', () => {
    const r = service.resolve(q('this_month'), chicago, new Date('2026-03-31T18:00:00.000Z'));
    expect(r).toMatchObject({
      from: '2026-03-01',
      to: '2026-03-31',
      comparison: { from: '2026-02-01', to: '2026-02-28' },
    });
    expect(r.label).toBe('Mar 2026');
  });

  it('last_month: previous full month vs the month before', () => {
    const r = service.resolve(q('last_month'), chicago, NOW);
    expect(r).toMatchObject({
      from: '2026-08-01',
      to: '2026-08-31',
      label: 'Aug 2026',
      isComplete: true,
      comparison: { from: '2026-07-01', to: '2026-07-31', label: 'Jul 2026' },
    });
  });

  it('last_month crosses the year boundary', () => {
    const r = service.resolve(q('last_month'), chicago, new Date('2027-01-15T12:00:00.000Z'));
    expect(r).toMatchObject({
      from: '2026-12-01',
      to: '2026-12-31',
      comparison: { from: '2026-11-01', to: '2026-11-30' },
    });
  });

  it('custom: inclusive range vs immediately preceding range of equal length', () => {
    const r = service.resolve(q('custom', '2026-09-01', '2026-09-07'), chicago, NOW);
    expect(r).toMatchObject({
      from: '2026-09-01',
      to: '2026-09-07',
      isComplete: false,
      comparison: { from: '2026-08-25', to: '2026-08-31' },
    });
    expect(r.label).toBe(`Sep 1 ${EN} Sep 7, 2026`);
  });

  it('custom: a complete 10-day range', () => {
    const r = service.resolve(q('custom', '2026-08-10', '2026-08-19'), chicago, NOW);
    expect(r.isComplete).toBe(true);
    expect(r.comparison).toMatchObject({ from: '2026-07-31', to: '2026-08-09' });
  });

  it('custom without dates throws (the query schema rejects it upstream)', () => {
    expect(() => service.resolve(q('custom'), chicago, NOW)).toThrow(RangeError);
  });

  it('rejects an invalid weekStart', () => {
    expect(() => service.resolve(q('today'), { ...chicago, weekStart: 7 }, NOW)).toThrow(
      RangeError,
    );
  });
});

describe('timezone boundaries', () => {
  /** 23:30 on Sep 6 in Chicago (CDT, UTC-5) is already Sep 7 in UTC. */
  const LATE = new Date('2026-09-07T04:30:00.000Z');

  it('today is resolved in the company timezone, not UTC', () => {
    expect(service.resolve(q('today'), chicago, LATE).from).toBe('2026-09-06');
    expect(service.resolve(q('today'), { timezone: 'UTC', weekStart: 1 }, LATE).from).toBe(
      '2026-09-07',
    );
    expect(service.today('Asia/Tokyo', LATE)).toBe('2026-09-07');
  });

  it('toUtcBounds converts local midnights to UTC instants', () => {
    expect(
      service.toUtcBounds({ from: '2026-09-06', to: '2026-09-06' }, 'America/Chicago'),
    ).toEqual({ fromUtc: '2026-09-06T05:00:00.000Z', toUtcExclusive: '2026-09-07T05:00:00.000Z' });
    expect(service.toUtcBounds({ from: '2026-09-06', to: '2026-09-06' }, 'UTC')).toEqual({
      fromUtc: '2026-09-06T00:00:00.000Z',
      toUtcExclusive: '2026-09-07T00:00:00.000Z',
    });
  });

  it('toUtcBounds is correct across a DST transition (Nov 1 2026, CDT -> CST)', () => {
    expect(
      service.toUtcBounds({ from: '2026-11-01', to: '2026-11-01' }, 'America/Chicago'),
    ).toEqual({ fromUtc: '2026-11-01T05:00:00.000Z', toUtcExclusive: '2026-11-02T06:00:00.000Z' });
  });

  it('isComplete uses the company-local today', () => {
    const range = { from: '2026-09-06', to: '2026-09-06' };
    expect(service.isComplete(range, 'America/Chicago', LATE)).toBe(false);
    expect(service.isComplete(range, 'UTC', LATE)).toBe(true);
  });
});

describe('weeks', () => {
  it('weekOf with Monday and Sunday week starts', () => {
    expect(service.weekOf('2026-09-06', 1)).toEqual({
      weekStart: '2026-08-31',
      weekEnd: '2026-09-06',
    });
    expect(service.weekOf('2026-08-31', 1)).toEqual({
      weekStart: '2026-08-31',
      weekEnd: '2026-09-06',
    });
    expect(service.weekOf('2026-09-06', 0)).toEqual({
      weekStart: '2026-09-06',
      weekEnd: '2026-09-12',
    });
    expect(service.weekOf('2026-09-05', 0)).toEqual({
      weekStart: '2026-08-30',
      weekEnd: '2026-09-05',
    });
    expect(service.weekOf('2026-09-05', 6)).toEqual({
      weekStart: '2026-09-05',
      weekEnd: '2026-09-11',
    });
  });

  it('comparisonFor returns an equal-length preceding range', () => {
    expect(service.comparisonFor({ from: '2026-09-01', to: '2026-09-30' })).toEqual({
      from: '2026-08-02',
      to: '2026-08-31',
    });
  });

  it('trailing 8 weeks end with the week containing the range end; the selected week is highlighted', () => {
    const weeks = service.trailingWeeks(service.resolve(q('this_week'), chicago, NOW), 8, NOW);
    expect(weeks).toHaveLength(8);
    expect(weeks.map((w) => w.weekStart)).toEqual([
      '2026-07-13',
      '2026-07-20',
      '2026-07-27',
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
    ]);
    expect(weeks.map((w) => w.highlighted)).toEqual([
      false,
      false,
      false,
      false,
      false,
      false,
      false,
      true,
    ]);
    expect(weeks.map((w) => w.isComplete)).toEqual([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
    expect(weeks[7]).toMatchObject({ weekEnd: '2026-09-06', label: `Aug 31 ${EN} Sep 6, 2026` });
  });

  it('trailing weeks for last_week highlight only that week', () => {
    const weeks = service.trailingWeeks(service.resolve(q('last_week'), chicago, NOW), 8, NOW);
    expect(weeks[7]?.weekStart).toBe('2026-08-24');
    expect(weeks.filter((w) => w.highlighted).map((w) => w.weekStart)).toEqual(['2026-08-24']);
    expect(weeks.every((w) => w.isComplete)).toBe(true);
  });

  it('trailing weeks for a month anchor on the earlier of month end and today', () => {
    const lastMonth = service.trailingWeeks(service.resolve(q('last_month'), chicago, NOW), 8, NOW);
    expect(lastMonth[7]?.weekStart).toBe('2026-08-31');
    expect(lastMonth.filter((w) => w.highlighted).map((w) => w.weekStart)).toEqual([
      '2026-07-27',
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
    ]);
    const thisMonth = service.trailingWeeks(service.resolve(q('this_month'), chicago, NOW), 8, NOW);
    expect(thisMonth[7]?.weekStart).toBe('2026-08-31');
    expect(thisMonth.filter((w) => w.highlighted)).toHaveLength(1);
  });

  it('trailing weeks respect a custom count', () => {
    const weeks = service.trailingWeeks(service.resolve(q('today'), chicago, NOW), 3, NOW);
    expect(weeks.map((w) => w.weekStart)).toEqual(['2026-08-17', '2026-08-24', '2026-08-31']);
  });
});

describe('dispatchWeeks', () => {
  it('a 5-week month shows weeks 2-5 (Mondays inside August 2026)', () => {
    const weeks = service.dispatchWeeks(service.resolve(q('last_month'), chicago, NOW), NOW);
    expect(weeks.map((w) => w.weekStart)).toEqual([
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
    ]);
    expect(weeks.map((w) => w.isComplete)).toEqual([true, true, true, false]);
    expect(weeks.every((w) => w.highlighted)).toBe(true);
  });

  it('a 4-week month shows all four weeks (Mondays inside September 2026)', () => {
    const october = new Date('2026-10-10T12:00:00.000Z');
    const weeks = service.dispatchWeeks(
      service.resolve(q('last_month'), chicago, october),
      october,
    );
    expect(weeks.map((w) => w.weekStart)).toEqual([
      '2026-09-07',
      '2026-09-14',
      '2026-09-21',
      '2026-09-28',
    ]);
    expect(weeks.every((w) => w.isComplete)).toBe(true);
  });

  it('this_month stops at today and falls back to the week containing the 1st early in the month', () => {
    const late = new Date('2026-09-25T12:00:00.000Z');
    const weeks = service.dispatchWeeks(service.resolve(q('this_month'), chicago, late), late);
    expect(weeks.map((w) => w.weekStart)).toEqual(['2026-09-07', '2026-09-14', '2026-09-21']);

    const early = service.dispatchWeeks(service.resolve(q('this_month'), chicago, NOW), NOW);
    expect(early.map((w) => w.weekStart)).toEqual(['2026-08-31']);
  });

  it('weekly presets show the selected week plus the 3 before it', () => {
    const thisWeek = service.dispatchWeeks(service.resolve(q('this_week'), chicago, NOW), NOW);
    expect(thisWeek.map((w) => w.weekStart)).toEqual([
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
    ]);
    const lastWeek = service.dispatchWeeks(service.resolve(q('last_week'), chicago, NOW), NOW);
    expect(lastWeek.map((w) => w.weekStart)).toEqual([
      '2026-08-03',
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
    ]);
    expect(lastWeek.map((w) => w.highlighted)).toEqual([false, false, false, true]);
  });

  it('today and custom presets show the 4 weeks ending with the range end', () => {
    const today = service.dispatchWeeks(service.resolve(q('today'), chicago, NOW), NOW);
    expect(today.map((w) => w.weekStart)).toEqual([
      '2026-08-10',
      '2026-08-17',
      '2026-08-24',
      '2026-08-31',
    ]);
    const custom = service.dispatchWeeks(
      service.resolve(q('custom', '2026-07-01', '2026-07-20'), chicago, NOW),
      NOW,
    );
    expect(custom.map((w) => w.weekStart)).toEqual([
      '2026-06-29',
      '2026-07-06',
      '2026-07-13',
      '2026-07-20',
    ]);
  });
});

describe('labelFor', () => {
  it('formats ranges, whole months, single days and today', () => {
    expect(service.labelFor({ from: '2026-09-01', to: '2026-09-07' })).toBe(
      `Sep 1 ${EN} Sep 7, 2026`,
    );
    expect(service.labelFor({ from: '2026-09-01', to: '2026-09-30' })).toBe('Sep 2026');
    expect(service.labelFor({ from: '2026-02-01', to: '2026-02-28' })).toBe('Feb 2026');
    expect(service.labelFor({ from: '2026-02-01', to: '2026-02-27' })).toBe(
      `Feb 1 ${EN} Feb 27, 2026`,
    );
    expect(service.labelFor({ from: '2026-09-06', to: '2026-09-06' }, 'today')).toBe(
      'Today · Sep 6',
    );
    expect(service.labelFor({ from: '2026-09-05', to: '2026-09-05' })).toBe('Sep 5, 2026');
    expect(service.labelFor({ from: '2025-12-29', to: '2026-01-04' })).toBe(
      `Dec 29, 2025 ${EN} Jan 4, 2026`,
    );
  });
});
