/**
 * The one formatter for a stop's time (P0.4).
 *
 * A time is always shown in the zone of the place it happened, with that zone's abbreviation
 * on it - `2:25 AM EDT` - so two dispatchers in two cities read the same words. The tooltip
 * carries the same instant on the company clock (Chicago) and on the Tashkent clock the night
 * desk works by. Nothing here ever prints a raw ISO string: a person who sees
 * `2026-09-18T07:25:00.000Z` has been handed a bug, not a time.
 */
/**
 * The clock everybody reads: US Eastern.
 *
 * The Tashkent desk works Eastern hours and every screen shows Eastern first, whatever the
 * browser's own zone is. A stop keeps its own zone for the appointment somebody typed and the
 * arrival somebody recorded; that is shown beside the Eastern time, never instead of it.
 */
export const HOME_ZONE = 'America/New_York';
export const NIGHT_DESK_ZONE = 'Asia/Tashkent';
const LOCALE = 'en-US';

export interface FormattedInstant {
  /** `2:25 AM EDT` */
  time: string;
  /** `Sep 18` */
  day: string;
  /** `Thu, Sep 18` */
  weekday: string;
  /** `Sep 18, 2:25 AM EDT` */
  text: string;
  /** `EDT`, `CST`, `GMT+5` … */
  zone: string;
  /** The same instant on the company's clock and on the night desk's, one line each. */
  tooltip: string;
}

const UNKNOWN: FormattedInstant = {
  time: 'Time unknown',
  day: '',
  weekday: '',
  text: 'Time unknown',
  zone: '',
  tooltip: 'No time recorded',
};

function parse(iso: string | null | undefined): Date | null {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? null : date;
}

function usable(zone: string | null | undefined): string | null {
  if (!zone) return null;
  try {
    new Intl.DateTimeFormat(LOCALE, { timeZone: zone });
    return zone;
  } catch {
    return null;
  }
}

/** `EDT` for an instant in a zone; `GMT+5` where the locale has no abbreviation. */
export function zoneAbbreviation(date: Date, zone: string): string {
  return (
    new Intl.DateTimeFormat(LOCALE, { timeZone: zone, timeZoneName: 'short' })
      .formatToParts(date)
      .find((part) => part.type === 'timeZoneName')?.value ?? ''
  );
}

function clock(date: Date, zone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: zone, hour: 'numeric', minute: '2-digit' }).format(date);
}

function dayOf(date: Date, zone: string): string {
  return new Intl.DateTimeFormat(LOCALE, { timeZone: zone, month: 'short', day: 'numeric' }).format(date);
}

function weekdayOf(date: Date, zone: string): string {
  return new Intl.DateTimeFormat(LOCALE, {
    timeZone: zone,
    weekday: 'short',
    month: 'short',
    day: 'numeric',
  }).format(date);
}

/** `2:25 AM EDT` - the time with its zone, nothing else. */
export function timeInZone(iso: string | null | undefined, zone: string | null | undefined): string {
  const date = parse(iso);
  const tz = usable(zone);
  if (!date) return UNKNOWN.time;
  if (!tz) return `${clock(date, 'UTC')} UTC · zone unknown`;
  return `${clock(date, tz)} ${zoneAbbreviation(date, tz)}`;
}

/**
 * Everything a screen needs to show one instant in one place. `zone` is the stop's; when it is
 * missing the time is shown in UTC and says so, which is a fault a person can see and fix.
 */
export function formatInstant(
  iso: string | null | undefined,
  zone: string | null | undefined,
  options: { homeZone?: string; deskZone?: string } = {},
): FormattedInstant {
  const date = parse(iso);
  if (!date) return UNKNOWN;
  const home = usable(options.homeZone ?? HOME_ZONE) ?? HOME_ZONE;
  const desk = usable(options.deskZone ?? NIGHT_DESK_ZONE) ?? NIGHT_DESK_ZONE;
  const local = usable(zone);
  /*
   * Eastern is what is printed; the stop's own clock is what is hovered. One appointment then
   * reads the same everywhere it appears, and the person who wants to know what the shipper's
   * wall clock said still has it, labelled as the stop's.
   */
  const abbreviation = zoneAbbreviation(date, home);
  const time = `${clock(date, home)} ${abbreviation}`;
  const day = dayOf(date, home);
  const tooltipLines = [
    ...(local && local !== home
      ? [`${weekdayOf(date, local)}, ${clock(date, local)} ${zoneAbbreviation(date, local)} - stop local`]
      : []),
    `${weekdayOf(date, home)}, ${time} - Eastern${local ? '' : ' (stop zone unknown)'}`,
    `${weekdayOf(date, desk)}, ${clock(date, desk)} ${zoneAbbreviation(date, desk)} - Tashkent`,
  ];
  return {
    time,
    day,
    weekday: weekdayOf(date, home),
    text: `${day}, ${time}`,
    zone: abbreviation,
    tooltip: tooltipLines.join('\n'),
  };
}

/**
 * `Sep 18, 8:00 – 10:00 AM EDT` for a window; `Sep 18, 8:00 AM EDT (no window)` when the
 * customer gave one time; `Appointment not set` when nothing was given.
 */
export function formatAppointment(stop: {
  appointmentStartAt: string | null | undefined;
  appointmentEndAt: string | null | undefined;
  appointmentNoWindow?: boolean;
  timezone: string | null | undefined;
}): string {
  const start = parse(stop.appointmentStartAt);
  if (!start) return 'Appointment not set';
  const tz = HOME_ZONE;
  const local = usable(stop.timezone);
  // Eastern first; the stop's own clock after it when it differs, so the person on the phone with
  // the shipper has the number the shipper is looking at.
  const stopLocal =
    local && local !== tz ? ` · ${clock(start, local)} ${zoneAbbreviation(start, local)} stop local` : '';
  const suffix = local ? '' : ' · stop zone unknown';
  const end = parse(stop.appointmentEndAt);
  const abbreviation = zoneAbbreviation(start, tz);
  const day = dayOf(start, tz);
  if (stop.appointmentNoWindow || !end || end.getTime() <= start.getTime()) {
    return `${day}, ${clock(start, tz)} ${abbreviation} (no window)${stopLocal}${suffix}`;
  }
  const sameDay = dayOf(end, tz) === day;
  const endText = sameDay ? clock(end, tz) : `${dayOf(end, tz)}, ${clock(end, tz)}`;
  return `${day}, ${clock(start, tz)} – ${endText} ${abbreviation}${stopLocal}${suffix}`;
}

/**
 * The local wall-clock parts of an instant in a zone, for a form input: `2026-09-18` and
 * `02:25`. The inverse, `instantFromLocal`, turns what the person typed back into UTC.
 */
export function localParts(
  iso: string | null | undefined,
  zone: string | null | undefined,
): { date: string; time: string } | null {
  const date = parse(iso);
  const tz = usable(zone);
  if (!date || !tz) return null;
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return { date: `${get('year')}-${get('month')}-${get('day')}`, time: `${get('hour')}:${get('minute')}` };
}

/**
 * UTC for a wall-clock date and time in a zone. Solved by offset search rather than a library:
 * the zone's offset at the guessed instant is read back through Intl, and the guess corrected
 * once (twice across a DST change). Returns null for a date or time that does not parse.
 */
export function instantFromLocal(
  date: string,
  time: string,
  zone: string | null | undefined,
): string | null {
  const tz = usable(zone);
  const [y, m, d] = date.split('-').map((n) => Number.parseInt(n, 10));
  const [hh, mm] = time.split(':').map((n) => Number.parseInt(n, 10));
  if (!tz || [y, m, d, hh, mm].some((n) => n === undefined || Number.isNaN(n))) return null;
  const asUtc = Date.UTC(y!, m! - 1, d!, hh!, mm!, 0, 0);
  let guess = asUtc;
  for (let i = 0; i < 3; i += 1) {
    const offset = offsetMinutes(new Date(guess), tz);
    const next = asUtc - offset * 60_000;
    if (next === guess) break;
    guess = next;
  }
  return new Date(guess).toISOString();
}

/** The zone's offset from UTC at an instant, in minutes east of Greenwich. */
export function offsetMinutes(date: Date, zone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: zone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  }).formatToParts(date);
  const get = (type: string) => Number.parseInt(parts.find((p) => p.type === type)?.value ?? '0', 10);
  const local = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'));
  return Math.round((local - date.getTime()) / 60_000);
}

/** True when the text looks like a raw ISO timestamp - the thing user-facing copy must not carry. */
export function looksLikeRawIso(text: string): boolean {
  return /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(text);
}
