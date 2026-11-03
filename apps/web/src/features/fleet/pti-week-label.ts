import { addDays } from '@/demo';

const MONTHS = [
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

/**
 * The name of an inspection period: the dates it covers, with the year.
 *
 * A week number is a private code — two months both have a "Week 1", and nobody reconciling
 * against a calendar or a driver's message can tell which one a row belongs to. The dates can
 * always be matched to a calendar, so they are the label everywhere the period is named.
 *
 * Ranges are written the shortest way that stays unambiguous:
 *
 *   - inside one month — `Sep 7 – 13, 2026`
 *   - across two months — `Aug 31 – Sep 6, 2026`
 *   - across the new year — `Dec 28, 2025 – Jan 3, 2026`
 *
 * Dates are read as plain calendar parts, never through the local time zone: a Monday-start ISO
 * date is a date, and turning it into a `Date` would move it a day west of Greenwich.
 */
export function weekRangeLabel(weekStart: string): string {
  const start = isoParts(weekStart);
  const end = isoParts(addDays(weekStart, 6));
  const from = `${MONTHS[start.month - 1]} ${start.day}`;
  if (start.year !== end.year) {
    return `${from}, ${start.year} – ${MONTHS[end.month - 1]} ${end.day}, ${end.year}`;
  }
  const to = start.month === end.month ? `${end.day}` : `${MONTHS[end.month - 1]} ${end.day}`;
  return `${from} – ${to}, ${end.year}`;
}

function isoParts(date: string): { year: number; month: number; day: number } {
  return {
    year: Number(date.slice(0, 4)),
    month: Number(date.slice(5, 7)),
    day: Number(date.slice(8, 10)),
  };
}
