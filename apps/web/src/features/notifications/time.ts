import { formatDate, formatTime } from '@/lib/format';

const DAY_MS = 86_400_000;

/**
 * `Today, 10:24 AM` / `Yesterday, 5:32 PM` / `Sep 4, 9:15 AM`.
 *
 * The calendar day is decided by comparing the formatted date strings rather than the raw
 * timestamps, so "today" means today in the company timezone that `formatDate` already applies,
 * not in whatever timezone the viewer's browser happens to sit in.
 */
export function eventTime(at: string, now: Date = new Date()): string {
  const date = new Date(at);
  if (Number.isNaN(date.getTime())) return '—';

  const day = formatDate(date);
  const time = formatTime(date);
  if (day === formatDate(now)) return `Today, ${time}`;
  if (day === formatDate(new Date(now.getTime() - DAY_MS))) return `Yesterday, ${time}`;

  // Older than yesterday: the year is noise inside an operational feed, so drop it.
  return `${day.replace(/,\s*\d{4}$/, '')}, ${time}`;
}
