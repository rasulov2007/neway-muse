import { payPeriodLabel } from '@neway/shared';
import { formatIsoDate } from '@/lib/format';

/**
 * A pay period as a person reads it (owner, 2026-10-21): the real window, Monday noon to Monday
 * noon US Eastern - "Mon Oct 12, 12:00 PM – Mon Oct 19, 12:00 PM ET". A statement made before
 * the window was recorded shows its days and the instant it was cut off instead.
 */
export function payWindowLabel(p: { periodStart?: string; periodEnd?: string; start?: string; end?: string; startsAt?: string | null; cutoffAt: string }): string {
  const start = p.start ?? p.periodStart ?? '';
  const end = p.end ?? p.periodEnd ?? '';
  if (p.startsAt) return payPeriodLabel({ start, end, startsAt: p.startsAt, cutoffAt: p.cutoffAt, timezone: 'America/New_York' });
  return `${formatIsoDate(start)} – ${formatIsoDate(end)}`;
}

/** An instant on the Eastern clock: "Mon Oct 19, 7:30 PM ET". */
export function easternInstant(iso: string): string {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', weekday: 'short', month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', hour12: true }).formatToParts(new Date(iso));
  const get = (type: string) => parts.find((x) => x.type === type)?.value ?? '';
  return `${get('weekday')} ${get('month')} ${get('day')}, ${get('year')}, ${get('hour')}:${get('minute')} ${get('dayPeriod')} ET`;
}
