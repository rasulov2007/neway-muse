import { addDays, weekStartMonday } from '@neway/shared';
import { ApiError } from '@/lib/api-client';
import { formatIsoDate, formatMoney } from '@/lib/format';

/**
 * The non-component half of the Recruiting kit: money that may be unknown, errors beside their
 * fields, a retry key per form, and the one reporting period every tab reads.
 */

// ------------------------------------------------------------------------------- formatting

export function money(value: number): string {
  return formatMoney(value);
}

/** A money figure that may be unknown: a dash, never $0.00, when it cannot be computed. */
export function moneyOrDash(value: number | null | undefined): string {
  return value === null || value === undefined ? '—' : formatMoney(value);
}

/** The first message the server gave for each field, for errors shown beside their inputs. */
export function fieldErrors(error: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (error instanceof ApiError) {
    for (const issue of error.issues) {
      const key = issue.path || '_';
      if (!out[key]) out[key] = issue.message;
    }
  }
  return out;
}

/** A retry key for one form: made once, sent with every resend of the same save. */
export function newClientKey(): string {
  return (globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random()}`).replace(
    /[^A-Za-z0-9_-]/g,
    '',
  );
}

// ---------------------------------------------------------------------------------- period

export type PeriodKey = 'week' | 'month' | 'last_month' | '30d' | '90d' | 'year';
export const PERIOD_LABELS: Record<PeriodKey, string> = {
  week: 'This week',
  month: 'This month',
  last_month: 'Last month',
  '30d': 'Last 30 days',
  '90d': 'Last 90 days',
  year: 'This year',
};

/** The one reporting period every Recruiting tab reads: a preset, or a custom range. */
export interface Period {
  key: PeriodKey | 'custom';
  from: string;
  to: string;
}

function lastDayOfMonth(isoMonth: string): string {
  const [y, m] = isoMonth.split('-').map(Number) as [number, number];
  const day = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return `${isoMonth}-${String(day).padStart(2, '0')}`;
}

export function presetRange(key: PeriodKey, today: string): { from: string; to: string } {
  switch (key) {
    case 'week':
      return { from: weekStartMonday(today), to: today };
    case 'month':
      return { from: `${today.slice(0, 8)}01`, to: today };
    case 'last_month': {
      const prev = addDays(`${today.slice(0, 8)}01`, -1);
      return { from: `${prev.slice(0, 8)}01`, to: lastDayOfMonth(prev.slice(0, 7)) };
    }
    case '30d':
      return { from: addDays(today, -29), to: today };
    case '90d':
      return { from: addDays(today, -89), to: today };
    case 'year':
      return { from: `${today.slice(0, 4)}-01-01`, to: today };
  }
}

const ISO = /^\d{4}-\d{2}-\d{2}$/;

/** Reads the period from the URL: `from`+`to` for a custom range, else `period`, else this month. */
export function periodFromSearch(
  search: { period?: string; from?: string; to?: string },
  today: string,
): Period {
  if (search.from && search.to && ISO.test(search.from) && ISO.test(search.to) && search.from <= search.to) {
    return { key: 'custom', from: search.from, to: search.to };
  }
  const key = (Object.keys(PERIOD_LABELS) as PeriodKey[]).find((k) => k === search.period) ?? 'month';
  return { key, ...presetRange(key, today) };
}

/** "Sep 1 – 30, 2026", or the full form when the months or years differ. */
export function rangeLabel(from: string, to: string): string {
  const f = formatIsoDate(from);
  const t = formatIsoDate(to);
  if (from.slice(0, 7) === to.slice(0, 7)) {
    const [month] = f.split(' ');
    return `${month} ${Number(from.slice(8))} – ${Number(to.slice(8))}, ${to.slice(0, 4)}`;
  }
  if (from.slice(0, 4) === to.slice(0, 4)) {
    return `${f.replace(/,? \d{4}$/, '')} – ${t}`;
  }
  return `${f} – ${t}`;
}
