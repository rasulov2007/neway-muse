/**
 * Pure calendar helpers over `YYYY-MM-DD` strings. Dates are treated as UTC midnights for
 * arithmetic, which is safe because only whole days are ever added or compared; timezone
 * conversion happens exclusively in `localDateOf` and `localMidnightToUtc`.
 */

export type IsoDate = string;

const DAY_MS = 86_400_000;
const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const MONTH_SHORT = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

/** Parses `YYYY-MM-DD` to its UTC-midnight epoch milliseconds; throws on malformed input. */
export function parseIsoDate(iso: IsoDate): number {
  const m = ISO_DATE.exec(iso);
  if (!m) throw new RangeError(`Invalid ISO date: ${iso}`);
  const ms = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
  if (formatIsoDate(ms) !== iso) throw new RangeError(`Invalid calendar date: ${iso}`);
  return ms;
}

/** Formats UTC-midnight epoch milliseconds as `YYYY-MM-DD`. */
export function formatIsoDate(ms: number): IsoDate {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}-${pad2(d.getUTCMonth() + 1)}-${pad2(d.getUTCDate())}`;
}

/** Year, month (1-12) and day of a `YYYY-MM-DD` string. */
export function partsOf(iso: IsoDate): { year: number; month: number; day: number } {
  const d = new Date(parseIsoDate(iso));
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

/** Adds (or subtracts) whole calendar days. */
export function addDays(iso: IsoDate, days: number): IsoDate {
  return formatIsoDate(parseIsoDate(iso) + days * DAY_MS);
}

/** Day of week, 0 = Sunday ... 6 = Saturday. */
export function dayOfWeek(iso: IsoDate): number {
  return new Date(parseIsoDate(iso)).getUTCDay();
}

/** Number of calendar days in the inclusive range `[from, to]`. */
export function daysInclusive(from: IsoDate, to: IsoDate): number {
  return Math.round((parseIsoDate(to) - parseIsoDate(from)) / DAY_MS) + 1;
}

/** Lexicographic min of two ISO dates (valid because the format is zero-padded). */
export function minDate(a: IsoDate, b: IsoDate): IsoDate {
  return a <= b ? a : b;
}

/** First day of the month containing `iso`. */
export function startOfMonth(iso: IsoDate): IsoDate {
  const { year, month } = partsOf(iso);
  return formatIsoDate(Date.UTC(year, month - 1, 1));
}

/** Last day of the month containing `iso`. */
export function endOfMonth(iso: IsoDate): IsoDate {
  const { year, month } = partsOf(iso);
  return formatIsoDate(Date.UTC(year, month, 0));
}

/** Adds whole months, clamping the day to the target month's length. */
export function addMonths(iso: IsoDate, months: number): IsoDate {
  const { year, month, day } = partsOf(iso);
  const first = Date.UTC(year, month - 1 + months, 1);
  const lastDay = new Date(Date.UTC(year, month + months, 0)).getUTCDate();
  return formatIsoDate(first + (Math.min(day, lastDay) - 1) * DAY_MS);
}

/** True when `[from, to]` is exactly one whole calendar month. */
export function isWholeMonth(from: IsoDate, to: IsoDate): boolean {
  return from === startOfMonth(from) && to === endOfMonth(from);
}

/** "Sep 6" */
export function monthDay(iso: IsoDate): string {
  const { month, day } = partsOf(iso);
  return `${MONTH_SHORT[month - 1]} ${day}`;
}

/** "Sep 6, 2026" */
export function monthDayYear(iso: IsoDate): string {
  return `${monthDay(iso)}, ${partsOf(iso).year}`;
}

/** "Sep 2026" */
export function monthYear(iso: IsoDate): string {
  const { year, month } = partsOf(iso);
  return `${MONTH_SHORT[month - 1]} ${year}`;
}

interface WallClock {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Wall-clock fields of `instant` in `timeZone`. */
function wallClock(instant: number, timeZone: string): WallClock {
  const out: WallClock = { year: 0, month: 0, day: 0, hour: 0, minute: 0, second: 0 };
  for (const part of formatterFor(timeZone).formatToParts(new Date(instant))) {
    const value = Number(part.value);
    switch (part.type) {
      case 'year':
        out.year = value;
        break;
      case 'month':
        out.month = value;
        break;
      case 'day':
        out.day = value;
        break;
      case 'hour':
        out.hour = value === 24 ? 0 : value;
        break;
      case 'minute':
        out.minute = value;
        break;
      case 'second':
        out.second = value;
        break;
      default:
        break;
    }
  }
  return out;
}

/** The wall clock of `instant` in `timeZone`, re-read as if it were UTC. */
function wallClockAsUtc(instant: number, timeZone: string): number {
  const w = wallClock(instant, timeZone);
  return Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
}

/** Company-local calendar day of an instant. */
export function localDateOf(instant: Date, timeZone: string): IsoDate {
  const w = wallClock(instant.getTime(), timeZone);
  return `${w.year}-${pad2(w.month)}-${pad2(w.day)}`;
}

/** UTC instant of local midnight at the start of `iso` in `timeZone` (DST-safe). */
export function localMidnightToUtc(iso: IsoDate, timeZone: string): Date {
  const guess = parseIsoDate(iso);
  const offset = wallClockAsUtc(guess, timeZone) - guess;
  let instant = guess - offset;
  const offsetAtInstant = wallClockAsUtc(instant, timeZone) - instant;
  if (offsetAtInstant !== offset) instant = guess - offsetAtInstant;
  return new Date(instant);
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}
