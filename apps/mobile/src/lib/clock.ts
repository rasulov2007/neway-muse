import { t } from '../i18n/core';

/**
 * The business clock.
 *
 * Every clock in the product is US Eastern (America/New_York), never the phone's zone (CLAUDE.md).
 * "Now" comes from the server: each API answer carries a Date header, and the difference from the
 * phone's clock is kept so a phone set to the wrong time still shows the TMS's time. A stop keeps
 * its own zone for appointments, shown with its abbreviation and with Eastern beside it.
 */
export const BUSINESS_ZONE = 'America/New_York';

let skewMs = 0;

/** Records the server's time from a response's Date header. */
export function noteServerDate(header: string | null | undefined, receivedAt = Date.now()): void {
  if (!header) return;
  const server = Date.parse(header);
  if (Number.isNaN(server)) return;
  // The header has second precision; ignore sub-second noise so the clock does not jitter.
  const next = server - receivedAt;
  if (Math.abs(next - skewMs) > 1500) skewMs = next;
}

export function now(): Date {
  return new Date(Date.now() + skewMs);
}

function parts(date: Date, zone: string, options: Intl.DateTimeFormatOptions): Record<string, string> {
  const out: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-US', { timeZone: zone, ...options }).formatToParts(date)) {
    out[p.type] = p.value;
  }
  return out;
}

/** "EDT", "CST" … Some Android builds only know "GMT-5"; that is still honest. */
export function zoneAbbreviation(date: Date, zone: string): string {
  return parts(date, zone, { timeZoneName: 'short' }).timeZoneName ?? zone;
}

/** "Tue, Oct 27" in Eastern. */
export function headerDate(date: Date = now()): string {
  const p = parts(date, BUSINESS_ZONE, { weekday: 'short', month: 'short', day: 'numeric' });
  return `${p.weekday}, ${p.month} ${p.day}`;
}

/** "10:24 AM EDT" in Eastern. */
export function headerTime(date: Date = now()): string {
  return `${timeIn(date, BUSINESS_ZONE)} ${zoneAbbreviation(date, BUSINESS_ZONE)}`;
}

export function timeIn(date: Date, zone: string): string {
  const p = parts(date, zone, { hour: 'numeric', minute: '2-digit', hour12: true });
  return `${p.hour}:${p.minute} ${p.dayPeriod}`;
}

/** "Oct 23" in the given zone. */
export function dayIn(date: Date, zone: string): string {
  const p = parts(date, zone, { month: 'short', day: 'numeric' });
  return `${p.month} ${p.day}`;
}

/** A stop appointment in the stop's own zone: "Oct 23, 4:00 AM CDT". */
export function inStopZone(iso: string | null | undefined, zone: string | null | undefined): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const z = zone || BUSINESS_ZONE;
  return `${dayIn(date, z)}, ${timeIn(date, z)} ${zoneAbbreviation(date, z)}`;
}

/** The same instant on the business clock, for beside a stop time: "5:00 AM EDT". */
export function inEastern(iso: string | null | undefined, withDay = false): string | null {
  if (!iso) return null;
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return null;
  const time = `${timeIn(date, BUSINESS_ZONE)} ${zoneAbbreviation(date, BUSINESS_ZONE)}`;
  return withDay ? `${dayIn(date, BUSINESS_ZONE)}, ${time}` : time;
}

/** Whether two zones agree at this instant (then the Eastern line is not repeated). */
export function sameOffset(iso: string, zone: string): boolean {
  const date = new Date(iso);
  return zoneAbbreviation(date, zone) === zoneAbbreviation(date, BUSINESS_ZONE);
}

/** The Eastern calendar day, YYYY-MM-DD. */
export function easternDay(date: Date = now()): string {
  const p = parts(date, BUSINESS_ZONE, { year: 'numeric', month: '2-digit', day: '2-digit' });
  return `${p.year}-${p.month}-${p.day}`;
}

/** Morning / afternoon / evening on the business clock. */
export function greeting(date: Date = now()): string {
  const hour = Number(parts(date, BUSINESS_ZONE, { hour: 'numeric', hourCycle: 'h23' }).hour);
  if (hour < 12) return t('Good morning');
  if (hour < 17) return t('Good afternoon');
  return t('Good evening');
}

/** Adds days to a YYYY-MM-DD key without touching any zone. */
export function addDays(day: string, days: number): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const t = new Date(Date.UTC(y, m - 1, d + days));
  return t.toISOString().slice(0, 10);
}

/** The Monday that starts the pay week holding this Eastern day. */
export function weekStart(day: string): string {
  const [y, m, d] = day.split('-').map(Number) as [number, number, number];
  const dow = new Date(Date.UTC(y, m - 1, d)).getUTCDay(); // 0 = Sunday
  return addDays(day, dow === 0 ? -6 : 1 - dow);
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** "Oct 19 – 25, 2026" or "Sep 28 – Oct 4, 2026". */
export function weekLabel(start: string): string {
  const end = addDays(start, 6);
  const [sy, sm, sd] = start.split('-').map(Number) as [number, number, number];
  const [ey, em, ed] = end.split('-').map(Number) as [number, number, number];
  const left = `${MONTHS[sm - 1]} ${sd}`;
  const right = sm === em ? `${ed}` : `${MONTHS[em - 1]} ${ed}`;
  return sy === ey ? `${left} – ${right}, ${ey}` : `${left}, ${sy} – ${right}, ${ey}`;
}

/** "9:12 AM" today, "Yesterday", or "Mon, Oct 21" — for inbox and notification rows. */
export function relativeStamp(iso: string, reference: Date = now()): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  const today = easternDay(reference);
  const day = easternDay(date);
  if (day === today) return timeIn(date, BUSINESS_ZONE);
  if (day === addDays(today, -1)) return t('Yesterday');
  const p = parts(date, BUSINESS_ZONE, { weekday: 'short', month: 'short', day: 'numeric' });
  return `${p.weekday}, ${p.month} ${p.day}`;
}
