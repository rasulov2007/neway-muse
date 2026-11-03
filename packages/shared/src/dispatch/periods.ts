/**
 * The calendars the boards and the salary report count in: Monday weeks, ISO week numbers,
 * 28-day pay periods from the sheet's epoch, and calendar months for bonuses and penalties.
 */

/** Monday of the week the date falls in, as `YYYY-MM-DD`. */
export function weekStartMonday(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = (d.getUTCDay() + 6) % 7; // Monday = 0
  d.setUTCDate(d.getUTCDate() - dow);
  return d.toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** The seven days of a week, Monday first. */
export function weekDays(weekStart: string): string[] {
  return Array.from({ length: 7 }, (_, i) => addDays(weekStart, i));
}

/** ISO-8601 week number and its year, e.g. { year: 2026, week: 38 }. */
export function isoWeek(date: string): { year: number; week: number } {
  const d = new Date(`${date}T00:00:00Z`);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3); // Thursday of this week
  const year = d.getUTCFullYear();
  const jan4 = new Date(Date.UTC(year, 0, 4));
  const week = 1 + Math.round(((d.getTime() - jan4.getTime()) / 86_400_000 - 3 + ((jan4.getUTCDay() + 6) % 7)) / 7);
  return { year, week };
}

/** Pay periods: four continuous weeks, counted from the epoch the sheet used (15 Jun 2026). */
export const PAY_BLOCK_EPOCH = '2026-06-15';

export function payBlockOf(
  weekStart: string,
  epoch = PAY_BLOCK_EPOCH,
): { block: number; week: 1 | 2 | 3 | 4; start: string; end: string } {
  const weeks = Math.round(
    (Date.parse(`${weekStart}T00:00:00Z`) - Date.parse(`${epoch}T00:00:00Z`)) / (7 * 86_400_000),
  );
  const index = Math.floor(weeks / 4);
  const start = addDays(epoch, index * 28);
  return {
    block: index + 1,
    week: ((((weeks % 4) + 4) % 4) + 1) as 1 | 2 | 3 | 4,
    start,
    end: addDays(start, 27),
  };
}

/** The Mondays of the weeks that start inside [start, end]. */
export function weeksBetween(start: string, end: string): string[] {
  const out: string[] = [];
  let w = weekStartMonday(start);
  if (w < start) w = addDays(w, 7);
  while (w <= end) {
    out.push(w);
    w = addDays(w, 7);
  }
  return out;
}

export function monthOf(date: string): string {
  return date.slice(0, 7);
}

export function monthBounds(month: string): { start: string; end: string } {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const start = `${month}-01`;
  const last = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return { start, end: `${month}-${String(last).padStart(2, '0')}` };
}

export function addMonths(month: string, n: number): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + n, 1));
  return d.toISOString().slice(0, 7);
}

export type PeriodKind = 'week' | 'pay_period' | 'month';

/** The bounds of a period of a kind that contains `date`. */
export function periodOf(kind: PeriodKind, date: string): { start: string; end: string; label: string } {
  if (kind === 'week') {
    const start = weekStartMonday(date);
    const iso = isoWeek(start);
    return { start, end: addDays(start, 6), label: `ISO week ${iso.week} · ${start} – ${addDays(start, 6)}` };
  }
  if (kind === 'pay_period') {
    const b = payBlockOf(weekStartMonday(date));
    return { start: b.start, end: b.end, label: `Pay period ${b.block} · ${b.start} – ${b.end}` };
  }
  const m = monthOf(date);
  const { start, end } = monthBounds(m);
  return { start, end, label: `${m} · ${start} – ${end}` };
}

export function shiftPeriod(kind: PeriodKind, start: string, n: number): string {
  if (kind === 'week') return addDays(start, 7 * n);
  if (kind === 'pay_period') return addDays(start, 28 * n);
  return `${addMonths(monthOf(start), n)}-01`;
}
