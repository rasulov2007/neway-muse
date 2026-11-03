/**
 * One clock for the whole product.
 *
 * Before this module every screen decided for itself what "now" meant, and most of them read a
 * constant pinned to September 6, 2026. That is why the walk-around board offered "Aug 31 – Sep 6"
 * as this week, why odometers were "as of Sep 6", and why Take out of service defaulted to a date
 * eleven days in the past. A number that is wrong everywhere in the same way is not a display bug;
 * it is a missing dependency, so here it is.
 *
 * Two rules, from the Fleet specification §13.3:
 *
 * 1. **"Now" is the server's clock**, not the browser's. A laptop with a slow clock must not make
 *    a work order look late. Every API response carries a `Date` header, so the first one teaches
 *    us the difference and we carry it from then on. Until a response arrives we use the browser
 *    clock, which is right to within seconds on a machine that has ever synced.
 * 2. **Business dates are `America/Chicago` dates**, because that is where the company keeps its
 *    books. "Today" at 11pm in Chicago is still today for a driver in Los Angeles.
 *
 * Tests freeze the clock with {@link setClockForTests}; nothing else may reach past these
 * functions to `Date.now()` for a business decision.
 */

/** The company's timezone. Report periods, "today" and every calendar date are measured in it. */
// Eastern (owner, 2026-09-25): the whole product, boards and books included. See CLAUDE.md.
export const COMPANY_TZ = 'America/New_York';

/** `2026-09-17` — a calendar date, not an instant. */
export type IsoDate = string;

/** Server time minus browser time, in milliseconds. Zero until a response tells us otherwise. */
let skewMs = 0;

/** Set by tests only. When it holds a value, that value *is* now. */
let frozenMs: number | null = null;

/**
 * Teach the clock the server's time from a response's `Date` header.
 *
 * The header has one-second resolution, so a skew under two seconds is rounding, not drift, and we
 * ignore it rather than jitter every render. Called from the API client on every response, which
 * means a server that is restarted with a corrected clock is followed within one request.
 */
export function syncClockFromHeader(header: string | null | undefined): void {
  if (!header) return;
  const serverMs = Date.parse(header);
  if (!Number.isFinite(serverMs)) return;
  const observed = serverMs - Date.now();
  if (Math.abs(observed) < 2_000) skewMs = 0;
  else skewMs = observed;
}

/** How far the browser's clock is behind the server's, in milliseconds. For diagnostics. */
export function clockSkewMs(): number {
  return skewMs;
}

/** Now, on the server's clock. */
export function now(): Date {
  return new Date(nowMs());
}

/** Now in milliseconds, on the server's clock. */
export function nowMs(): number {
  return frozenMs ?? Date.now() + skewMs;
}

/** Now as an ISO instant, on the server's clock. */
export function nowIso(): string {
  return now().toISOString();
}

const DATE_PARTS = new Intl.DateTimeFormat('en-CA', {
  timeZone: COMPANY_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * The calendar date of an instant in the company's timezone.
 *
 * `Intl` rather than a fixed offset: Chicago is UTC−5 in summer and UTC−6 in winter, and the
 * constant this replaces was pinned to the summer offset, so every date it produced between
 * November and March was an hour's worth of wrong — which, at 11pm, is a whole day.
 */
export function companyDateOf(at: Date | number | string): IsoDate {
  const date = typeof at === 'string' ? new Date(at) : at instanceof Date ? at : new Date(at);
  if (Number.isNaN(date.getTime())) return '';
  return DATE_PARTS.format(date);
}

/** Today's date in the company's timezone. */
export function today(): IsoDate {
  return companyDateOf(now());
}

/**
 * Freeze the clock, or let it run again with `null`.
 *
 * Only tests call this. It takes an ISO instant so a test can say what it means: `'2026-09-16T08:10:00-05:00'`.
 */
export function setClockForTests(at: string | Date | null): void {
  if (at === null) {
    frozenMs = null;
    return;
  }
  const ms = at instanceof Date ? at.getTime() : Date.parse(at);
  frozenMs = Number.isFinite(ms) ? ms : null;
}
