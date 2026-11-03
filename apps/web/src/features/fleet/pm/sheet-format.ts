import type { PmBoardRow } from '@neway/shared';
import { COMPANY_TZ, nowIso, today as companyToday } from '@/lib/clock';
import { formatDate } from '@/lib/format';

const n = (v: number) => v.toLocaleString('en-US');

/** `CT` / `ET` for the zone chip beside a time field. */
export function tzShort(zone: string = COMPANY_TZ): string {
  const part =
    new Intl.DateTimeFormat('en-US', { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(new Date())
      .find((p) => p.type === 'timeZoneName')?.value ?? 'CT';
  return part
    .replace(/^C[SD]T$/, 'CT')
    .replace(/^E[SD]T$/, 'ET')
    .replace(/^M[SD]T$/, 'MT')
    .replace(/^P[SD]T$/, 'PT');
}

/** `Sep 6` - the company-zone date without its year. */
export function shortDate(iso: string): string {
  return formatDate(iso).replace(/, \d{4}$/, '');
}

/** `Today` or `Fri`, in the company zone. */
export function stopDay(iso: string): string {
  if (iso.slice(0, 10) === companyToday()) return 'Today';
  return new Intl.DateTimeFormat('en-US', { timeZone: COMPANY_TZ, weekday: 'short' }).format(
    new Date(iso),
  );
}

/** The due status in words, with its size (mockup B's "still shows Overdue 5,221 mi"). */
export function dueWord(row: PmBoardRow): string {
  switch (row.dueStatus) {
    case 'overdue':
      return `Overdue ${n(Math.max(0, -(row.milesRemaining ?? 0)))} mi`;
    case 'overdue_at_least':
      return `Overdue ≥ ${n(row.milesOverAtReading ?? 0)} mi`;
    case 'due_soon':
      return `Due soon · ${n(row.milesRemaining ?? 0)} mi left`;
    case 'ok':
      return 'OK';
    case 'no_reading':
      return 'No reading';
    case 'no_baseline':
      return 'No service on record';
    case 'no_interval':
      return 'No interval set';
  }
}

/** Now, as a `datetime-local` value in the company zone. */
export function nowWall(): string {
  return isoToZonedWall(nowIso());
}

/** The next whole hour two hours out, company time: a sensible first slot. */
export function defaultSlot(): string {
  const d = new Date(nowIso());
  d.setUTCMinutes(0, 0, 0);
  d.setUTCHours(d.getUTCHours() + 2);
  return isoToZonedWall(d.toISOString());
}

function zoneOffsetMs(at: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value ?? 0);
  const wall = Date.UTC(
    get('year'),
    get('month') - 1,
    get('day'),
    get('hour'),
    get('minute'),
    get('second'),
  );
  return wall - Math.floor(at.getTime() / 1000) * 1000;
}

/**
 * A `datetime-local` value read as a wall-clock time in the company zone, as an instant.
 *
 * The browser's own zone is not the business's: a dispatcher in Tashkent books a shop in Texas.
 * Every time field on these sheets is company time (the chip beside it says so), so the value is
 * converted here rather than by `new Date(value)`, which would read it in the browser's zone.
 */
export function zonedToIso(wall: string, zone: string = COMPANY_TZ): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(wall);
  if (!m) return null;
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  let instant = guess - zoneOffsetMs(new Date(guess), zone);
  const again = zoneOffsetMs(new Date(instant), zone);
  if (guess - again !== instant) instant = guess - again;
  return new Date(instant).toISOString();
}

/** The reverse: an instant as a `datetime-local` value in the company zone. */
export function isoToZonedWall(iso: string, zone: string = COMPANY_TZ): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return '';
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(at);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '00';
  return `${get('year')}-${get('month')}-${get('day')}T${get('hour')}:${get('minute')}`;
}

/** A shop's name with its city, unless the name already says where it is. */
export function shopLabel(shop: {
  name: string;
  city: string | null;
  state: string | null;
}): string {
  if (!shop.city || shop.name.toLowerCase().includes(shop.city.toLowerCase())) return shop.name;
  return `${shop.name}, ${shop.city}${shop.state ? `, ${shop.state}` : ''}`;
}
