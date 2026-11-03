import { Injectable } from '@nestjs/common';
import type {
  DashboardPeriodPreset,
  DashboardPeriodQuery,
  DateRange,
  ResolvedPeriod,
} from '@neway/shared';
import {
  addDays,
  addMonths,
  dayOfWeek,
  daysInclusive,
  endOfMonth,
  isWholeMonth,
  localDateOf,
  localMidnightToUtc,
  minDate,
  monthDay,
  monthDayYear,
  monthYear,
  startOfMonth,
  type IsoDate,
} from './date-utils';

/** Company reporting settings the period service depends on. */
export interface PeriodSettings {
  /** IANA timezone, e.g. `America/Chicago`. */
  timezone: string;
  /** First day of the reporting week, 0 = Sunday ... 6 = Saturday. */
  weekStart: number;
}

/** A reporting week: 7 days starting on the company `weekStart`. */
export interface WeekRange {
  weekStart: IsoDate;
  weekEnd: IsoDate;
}

/** A reporting week decorated for trend and dispatch widgets. */
export interface ReportingWeek extends WeekRange {
  label: string;
  /** True when the week overlaps the selected period. */
  highlighted: boolean;
  /** True when the week ended before the company-local today. */
  isComplete: boolean;
}

/** UTC instants bounding a company-local date range: `[fromUtc, toUtcExclusive)`. */
export interface UtcBounds {
  fromUtc: string;
  toUtcExclusive: string;
}

const EN_DASH = '–';

/**
 * The only date logic of the reporting domain (docs/DASHBOARD.md §3). Every method is pure:
 * `now` is injected and the company timezone drives the calendar.
 */
@Injectable()
export class ReportingPeriodService {
  /** Resolves a period query to inclusive company-local dates plus its comparison range. */
  resolve(query: DashboardPeriodQuery, settings: PeriodSettings, now = new Date()): ResolvedPeriod {
    const weekStart = normalizeWeekStart(settings.weekStart);
    const today = this.today(settings.timezone, now);
    const { range, comparison } = this.rangesFor(query, today, weekStart);
    return {
      preset: query.period,
      from: range.from,
      to: range.to,
      label: this.labelFor(range, query.period),
      isComplete: range.to < today,
      timezone: settings.timezone,
      comparison: { ...comparison, label: this.labelFor(comparison) },
      weekStart,
    };
  }

  /** The immediately preceding range of equal length. */
  comparisonFor(range: DateRange): DateRange {
    const length = daysInclusive(range.from, range.to);
    return { from: addDays(range.from, -length), to: addDays(range.from, -1) };
  }

  /** The reporting week containing `date`. */
  weekOf(date: IsoDate, weekStart: number): WeekRange {
    const offset = (dayOfWeek(date) - normalizeWeekStart(weekStart) + 7) % 7;
    const start = addDays(date, -offset);
    return { weekStart: start, weekEnd: addDays(start, 6) };
  }

  /**
   * The `count` reporting weeks ending with the week containing the range end (or today,
   * whichever is earlier). Weeks overlapping the selected range are highlighted.
   */
  trailingWeeks(resolved: ResolvedPeriod, count = 8, now = new Date()): ReportingWeek[] {
    const today = this.today(resolved.timezone, now);
    const anchor = this.weekOf(minDate(resolved.to, today), resolved.weekStart);
    return this.weeksEndingAt(anchor.weekStart, count, resolved, today);
  }

  /**
   * The `count` reporting weeks immediately before `week`, oldest first: the equivalent window a
   * trailing-window rollup is compared against. Pure calendar arithmetic — no data is consulted,
   * so the caller decides what an empty span means.
   */
  precedingWeeks(week: WeekRange, count: number): WeekRange[] {
    const weeks: WeekRange[] = [];
    for (let i = count; i >= 1; i -= 1) {
      const weekStart = addDays(week.weekStart, -7 * i);
      weeks.push({ weekStart, weekEnd: addDays(weekStart, 6) });
    }
    return weeks;
  }

  /**
   * Weeks for the dispatch section: in month presets, the reporting weeks starting inside the
   * month up to today (last 4); in every other preset, the selected week plus the 3 before it.
   */
  dispatchWeeks(resolved: ResolvedPeriod, now = new Date()): ReportingWeek[] {
    const today = this.today(resolved.timezone, now);
    if (resolved.preset === 'this_month' || resolved.preset === 'last_month') {
      const monthStart = startOfMonth(resolved.from);
      const limit = minDate(endOfMonth(resolved.from), today);
      let first = this.weekOf(monthStart, resolved.weekStart).weekStart;
      if (first < monthStart) first = addDays(first, 7);
      const starts: IsoDate[] = [];
      for (let start = first; start <= limit; start = addDays(start, 7)) starts.push(start);
      if (starts.length === 0) {
        // The month has not reached its first reporting week yet: show the week containing the 1st.
        starts.push(this.weekOf(monthStart, resolved.weekStart).weekStart);
      }
      const shown = starts.slice(-4);
      const last = shown[shown.length - 1] ?? first;
      return this.weeksEndingAt(last, shown.length, resolved, today);
    }
    const anchorDate =
      resolved.preset === 'this_week' || resolved.preset === 'last_week'
        ? resolved.from
        : minDate(resolved.to, today);
    const anchor = this.weekOf(anchorDate, resolved.weekStart);
    return this.weeksEndingAt(anchor.weekStart, 4, resolved, today);
  }

  /** True when the range ends before the company-local today. */
  isComplete(range: DateRange, timezone: string, now = new Date()): boolean {
    return range.to < this.today(timezone, now);
  }

  /** Converts an inclusive company-local range to UTC instants, once. */
  toUtcBounds(range: DateRange, timezone: string): UtcBounds {
    return {
      fromUtc: localMidnightToUtc(range.from, timezone).toISOString(),
      toUtcExclusive: localMidnightToUtc(addDays(range.to, 1), timezone).toISOString(),
    };
  }

  /** Human label: "Today · Sep 6", "Sep 6, 2026", "Sep 2026", "Sep 1 – Sep 7, 2026". */
  labelFor(range: DateRange, preset?: DashboardPeriodPreset): string {
    if (preset === 'today') return `Today · ${monthDay(range.from)}`;
    if (range.from === range.to) return monthDayYear(range.from);
    if (isWholeMonth(range.from, range.to)) return monthYear(range.from);
    if (range.from.slice(0, 4) === range.to.slice(0, 4)) {
      return `${monthDay(range.from)} ${EN_DASH} ${monthDayYear(range.to)}`;
    }
    return `${monthDayYear(range.from)} ${EN_DASH} ${monthDayYear(range.to)}`;
  }

  /** Company-local calendar day of `now`. */
  today(timezone: string, now = new Date()): IsoDate {
    return localDateOf(now, timezone);
  }

  private rangesFor(
    query: DashboardPeriodQuery,
    today: IsoDate,
    weekStart: number,
  ): { range: DateRange; comparison: DateRange } {
    switch (query.period) {
      case 'today': {
        const range = { from: today, to: today };
        return { range, comparison: this.comparisonFor(range) };
      }
      case 'this_week': {
        const range = { from: this.weekOf(today, weekStart).weekStart, to: today };
        return { range, comparison: shiftDays(range, -7) };
      }
      case 'last_week': {
        const current = this.weekOf(today, weekStart).weekStart;
        const range = { from: addDays(current, -7), to: addDays(current, -1) };
        return { range, comparison: shiftDays(range, -7) };
      }
      case 'this_month': {
        const range = { from: startOfMonth(today), to: today };
        const previousStart = addMonths(range.from, -1);
        const sameSpanEnd = addDays(previousStart, daysInclusive(range.from, range.to) - 1);
        const comparison = {
          from: previousStart,
          to: minDate(sameSpanEnd, endOfMonth(previousStart)),
        };
        return { range, comparison };
      }
      case 'last_month': {
        const from = addMonths(startOfMonth(today), -1);
        const range = { from, to: endOfMonth(from) };
        const previousStart = addMonths(from, -1);
        return { range, comparison: { from: previousStart, to: endOfMonth(previousStart) } };
      }
      case 'custom': {
        if (query.from === undefined || query.to === undefined) {
          throw new RangeError('custom period requires from and to');
        }
        const range = { from: query.from, to: query.to };
        return { range, comparison: this.comparisonFor(range) };
      }
    }
  }

  private weeksEndingAt(
    lastWeekStart: IsoDate,
    count: number,
    range: DateRange,
    today: IsoDate,
  ): ReportingWeek[] {
    const weeks: ReportingWeek[] = [];
    for (let i = count - 1; i >= 0; i -= 1) {
      const weekStart = addDays(lastWeekStart, -7 * i);
      const weekEnd = addDays(weekStart, 6);
      weeks.push({
        weekStart,
        weekEnd,
        label: this.labelFor({ from: weekStart, to: weekEnd }),
        highlighted: weekStart <= range.to && weekEnd >= range.from,
        isComplete: weekEnd < today,
      });
    }
    return weeks;
  }
}

function normalizeWeekStart(weekStart: number): number {
  if (!Number.isInteger(weekStart) || weekStart < 0 || weekStart > 6) {
    throw new RangeError(`weekStart must be an integer 0-6, got ${weekStart}`);
  }
  return weekStart;
}

function shiftDays(range: DateRange, days: number): DateRange {
  return { from: addDays(range.from, days), to: addDays(range.to, days) };
}
