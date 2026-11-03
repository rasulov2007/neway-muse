import { t } from '../i18n/core';

/** Money as the TMS stores it, never recomputed: cents → "$1,842.50", negative "-$400.00". */
export function moneyCents(cents: number | null | undefined): string {
  if (cents === null || cents === undefined || Number.isNaN(cents)) return '';
  return moneyDollars(cents / 100);
}

export function moneyDollars(amount: number | null | undefined, digits = 2): string {
  if (amount === null || amount === undefined || Number.isNaN(amount)) return '';
  const sign = amount < 0 ? '-' : '';
  return `${sign}$${Math.abs(amount).toLocaleString('en-US', { minimumFractionDigits: digits, maximumFractionDigits: digits })}`;
}

/** "Oct 30, 2026" from a business date (YYYY-MM-DD), without any zone arithmetic. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function dayLabel(day: string | null | undefined): string {
  if (!day || !/^\d{4}-\d{2}-\d{2}/.test(day)) return day ?? '';
  const [y, m, d] = day.slice(0, 10).split('-').map(Number) as [number, number, number];
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

export function weekdayOf(day: string): string {
  const [y, m, d] = day.slice(0, 10).split('-').map(Number) as [number, number, number];
  return t(WEEKDAYS[new Date(Date.UTC(y, m - 1, d)).getUTCDay()]!);
}

/** Inclusive number of calendar days between two business dates. */
export function daysBetween(from: string, to: string): number {
  const a = Date.parse(`${from.slice(0, 10)}T00:00:00Z`);
  const b = Date.parse(`${to.slice(0, 10)}T00:00:00Z`);
  return Math.round((b - a) / 86_400_000) + 1;
}

/** "snake_case" → "Snake case" for a server word the app has no label for. */
export function humanize(word: string | null | undefined): string {
  if (!word) return '';
  const s = word.replace(/[_-]+/g, ' ').trim();
  return s.charAt(0).toUpperCase() + s.slice(1);
}

/** "2h 15m", "3d 4h", "12m" since an instant (by the business clock passed in). */
export function ageSince(iso: string | null | undefined, nowMs: number): string | null {
  if (!iso) return null;
  const t = Date.parse(iso.length === 10 ? `${iso}T00:00:00Z` : iso);
  if (Number.isNaN(t)) return null;
  const mins = Math.max(0, Math.round((nowMs - t) / 60_000));
  if (mins < 60) return `${mins}m`;
  const hours = Math.floor(mins / 60);
  if (hours < 48) return `${hours}h ${mins % 60}m`;
  const days = Math.floor(hours / 24);
  return `${days}d ${hours % 24}h`;
}
