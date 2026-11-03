/**
 * Calendar-date arithmetic on `YYYY-MM-DD` strings.
 *
 * Every date here is a calendar date, not an instant: no timezone is involved, so a date computed
 * on the server and one computed in the browser always agree.
 */

const ISO_DATE = /^(\d{4})-(\d{2})-(\d{2})$/;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, '0');
}

/**
 * `isoDate` moved by `months` calendar months, with the day clamped to the end of the target
 * month: 2024-02-29 + 12 → 2025-02-28, 2026-01-31 + 1 → 2026-02-28. Negative months go back.
 *
 * Throws on a value that is not a `YYYY-MM-DD` date, because a silently wrong expiry is worse than
 * a loud one.
 */
export function addMonthsClamped(isoDate: string, months: number): string {
  const match = ISO_DATE.exec(isoDate);
  if (!match) throw new Error(`Not a calendar date: ${isoDate}`);
  const year = Number(match[1]);
  const month = Number(match[2]) - 1;
  const day = Number(match[3]);
  const total = year * 12 + month + Math.trunc(months);
  const targetYear = Math.floor(total / 12);
  const targetMonth = total - targetYear * 12;
  // Day 0 of the next month is the last day of this one.
  const lastDay = new Date(Date.UTC(targetYear, targetMonth + 1, 0)).getUTCDate();
  return `${pad(targetYear, 4)}-${pad(targetMonth + 1)}-${pad(Math.min(day, lastDay))}`;
}

/** True when `value` is a well-formed `YYYY-MM-DD` calendar date. */
export function isIsoCalendarDate(value: string | null | undefined): value is string {
  if (!value) return false;
  const match = ISO_DATE.exec(value);
  if (!match) return false;
  const d = new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  return d.getUTCMonth() === Number(match[2]) - 1 && d.getUTCDate() === Number(match[3]);
}
