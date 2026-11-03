import { formatIsoDate } from '@/lib/format';

/**
 * The dispatcher pay review reads the commission KPI's exceptions as the server words them and
 * sorts them into the cards the review shows. Nothing is dropped: a note this does not recognise
 * becomes a generic card with its full text.
 */

export type CommissionNote =
  | { kind: 'allocation'; name: string; text: string }
  | { kind: 'grid'; payroll: { start: string; end: string } | null; board: { start: string; end: string } | null; text: string }
  | { kind: 'miles'; text: string }
  | { kind: 'other'; text: string };

const RANGE = /\((\d{4}-\d{2}-\d{2}) – (\d{4}-\d{2}-\d{2})\)/g;

export function classifyCommissionNote(text: string): CommissionNote {
  const unattributed = /^Not attributed: (.+?) \(-?[\d.]+\)/.exec(text);
  if (unattributed) return { kind: 'allocation', name: unattributed[1]!, text };
  if (/is not the four-week block the dispatch board uses/.test(text)) {
    const ranges = [...text.matchAll(RANGE)].map((m) => ({ start: m[1]!, end: m[2]! }));
    return { kind: 'grid', payroll: ranges[0] ?? null, board: ranges[1] ?? null, text };
  }
  if (/have gross above the floor but no miles/.test(text)) return { kind: 'miles', text };
  return { kind: 'other', text };
}

/** `Sep 27 – Oct 24, 2026`; the year is said once when both ends share it, and left off with `year: false`. */
export function formatDayRange(start: string, end: string, options: { year?: boolean } = {}): string {
  const withYear = options.year ?? true;
  const strip = (s: string) => s.replace(/, \d{4}$/, '');
  const a = formatIsoDate(start);
  const b = formatIsoDate(end);
  if (!withYear) return `${strip(a)} – ${strip(b)}`;
  return start.slice(0, 4) === end.slice(0, 4) ? `${strip(a)} – ${b}` : `${a} – ${b}`;
}

/** "solo" → "Solo". */
export const capitalise = (s: string) => (s ? s[0]!.toUpperCase() + s.slice(1) : s);

/** Dollars typed in a field → cents, or null when the field is empty or not a number. */
export function toCents(value: string): number | null {
  if (value.trim() === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? Math.round(n * 100) : null;
}
