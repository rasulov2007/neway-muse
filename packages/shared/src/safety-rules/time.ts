// Time handling for Accident & Claims v2 (ported from docs/accidents/prototype/src/lib/time.ts).
// Every timestamp is stored in UTC (ISO). Incident times are shown in the incident's local zone;
// system/audit times in US Eastern (company standard), Tashkent as a secondary zone.
//
// Differences from the prototype:
//   - "now" comes from an injectable clock (`setRulesClock`) or an explicit `now` argument — the server
//     injects its own clock; tests freeze it at the fixture instant;
//   - converting a local wall time to UTC follows SPEC §7.15: a time that does not exist (spring-forward gap)
//     is an error, a time that occurs twice (fall-back overlap) needs an explicit choice. The prototype's
//     `localInputToIso` silently picked one (SPEC §11 shortcut 10) and is not ported.

export const EASTERN = 'America/New_York';
export const TASHKENT = 'Asia/Tashkent';

export const HOUR = 3_600_000;
export const DAY = 86_400_000;

/* ------------------------------------------------------------------ clock */
export type RulesClock = () => number;
let clock: RulesClock = () => Date.now();

/** Inject the clock the rules use when no explicit `now` is passed (server clock, or a frozen test clock). */
export function setRulesClock(fn: RulesClock): void {
  clock = fn;
}
/** Restore the default (system) clock. */
export function resetRulesClock(): void {
  clock = () => Date.now();
}
/** Current instant in ms: the explicit value when given, else the injected clock. */
export function rulesNow(now?: number): number {
  return now ?? clock();
}

/* ------------------------------------------------------------------ zones */
export const STATE_TZ: Record<string, string> = {
  AL: 'America/Chicago', AZ: 'America/Phoenix', AR: 'America/Chicago', CA: 'America/Los_Angeles', CO: 'America/Denver',
  CT: 'America/New_York', DE: 'America/New_York', FL: 'America/New_York', GA: 'America/New_York', ID: 'America/Boise',
  IL: 'America/Chicago', IN: 'America/Indiana/Indianapolis', IA: 'America/Chicago', KS: 'America/Chicago', KY: 'America/New_York',
  LA: 'America/Chicago', ME: 'America/New_York', MD: 'America/New_York', MA: 'America/New_York', MI: 'America/Detroit',
  MN: 'America/Chicago', MS: 'America/Chicago', MO: 'America/Chicago', MT: 'America/Denver', NE: 'America/Chicago',
  NV: 'America/Los_Angeles', NH: 'America/New_York', NJ: 'America/New_York', NM: 'America/Denver', NY: 'America/New_York',
  NC: 'America/New_York', ND: 'America/Chicago', OH: 'America/New_York', OK: 'America/Chicago', OR: 'America/Los_Angeles',
  PA: 'America/New_York', RI: 'America/New_York', SC: 'America/New_York', SD: 'America/Chicago', TN: 'America/Chicago',
  TX: 'America/Chicago', UT: 'America/Denver', VT: 'America/New_York', VA: 'America/New_York', WA: 'America/Los_Angeles',
  WV: 'America/New_York', WI: 'America/Chicago', WY: 'America/Denver',
};

export const TZ_CHOICES: { tz: string; label: string }[] = [
  { tz: 'America/New_York', label: 'Eastern' },
  { tz: 'America/Chicago', label: 'Central' },
  { tz: 'America/Denver', label: 'Mountain' },
  { tz: 'America/Phoenix', label: 'Arizona (no DST)' },
  { tz: 'America/Los_Angeles', label: 'Pacific' },
  { tz: 'America/Indiana/Indianapolis', label: 'Indiana (Eastern)' },
  { tz: 'America/Detroit', label: 'Michigan (Eastern)' },
];

export const US_STATES = Object.keys(STATE_TZ).sort();

/** Split-zone states where the default zone can be wrong; the form asks the user to confirm. */
export const SPLIT_ZONE_STATES = ['IN', 'TN', 'KY', 'FL', 'TX', 'MI', 'ND', 'SD', 'NE', 'KS', 'OR', 'ID'];

/** Default zone for a state plus the split-zone hint (ACCEPTANCE A12). */
export function zoneForState(state: string): { tz: string | null; confirmHint: string | null } {
  const st = state.trim().toUpperCase();
  const tz = STATE_TZ[st] ?? null;
  return { tz, confirmHint: tz && SPLIT_ZONE_STATES.includes(st) ? `${st} has more than one time zone — confirm` : null };
}

/** Plain zone name used in messages: "Central", "Eastern", "Mountain", "Pacific"… */
export function zoneName(tz: string): string {
  const fixed: Record<string, string> = {
    'America/New_York': 'Eastern',
    'America/Detroit': 'Eastern',
    'America/Indiana/Indianapolis': 'Eastern',
    'America/Chicago': 'Central',
    'America/Denver': 'Mountain',
    'America/Boise': 'Mountain',
    'America/Phoenix': 'Arizona',
    'America/Los_Angeles': 'Pacific',
    'America/Anchorage': 'Alaska',
    'Pacific/Honolulu': 'Hawaii',
  };
  const known = fixed[tz];
  if (known) return known;
  try {
    const p = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'longGeneric' })
      .formatToParts(new Date(0))
      .find((x) => x.type === 'timeZoneName');
    if (p) return p.value.replace(/ Time$/, '');
  } catch {
    /* unknown zone — fall through */
  }
  return tz;
}

interface WallParts { y: number; mo: number; d: number; h: number; mi: number; s: number }

function parts(ms: number, tz: string): WallParts {
  const f = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  });
  const o: Record<string, string> = {};
  for (const p of f.formatToParts(new Date(ms))) o[p.type] = p.value;
  return { y: Number(o.year), mo: Number(o.month), d: Number(o.day), h: Number(o.hour) % 24, mi: Number(o.minute), s: Number(o.second) };
}

/** Offset of zone tz from UTC at instant ms, in minutes (CDT = -300). */
export function tzOffsetMin(ms: number, tz: string): number {
  const p = parts(ms, tz);
  const asUtc = Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi, p.s);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

export type LocalToUtcResult =
  | { ok: true; iso: string; abbr: string }
  | { ok: false; error: 'invalid'; message: string }
  | { ok: false; error: 'nonexistent'; message: string }
  | { ok: false; error: 'ambiguous'; message: string; options: { iso: string; abbr: string }[] };

/**
 * 'YYYY-MM-DDTHH:mm' wall time in zone tz → UTC (SPEC §7.15).
 * - a time that does not exist (spring-forward gap) → `nonexistent` error;
 * - a time that occurs twice (fall-back overlap) → `ambiguous` with both instants, unless `choose`
 *   says which one the user picked ('earlier' = the first occurrence, e.g. CDT; 'later' = the second, e.g. CST,
 *   or an abbreviation such as 'CDT' / 'CST').
 */
export function localToUtc(local: string, tz: string, choose?: 'earlier' | 'later' | string): LocalToUtcResult {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local ?? '');
  if (!m) return { ok: false, error: 'invalid', message: 'Enter the date and time' };
  const [y, mo, d, h, mi] = [Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5])];
  const wall = Date.UTC(y, mo - 1, d, h, mi);
  const back = new Date(wall);
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== mo - 1 || back.getUTCDate() !== d || h > 23 || mi > 59) {
    return { ok: false, error: 'invalid', message: 'Enter a valid date and time' };
  }
  // Every instant whose wall clock in tz equals `wall`. Offsets around the date cover both sides of a transition.
  const offsets = new Set([tzOffsetMin(wall - DAY, tz), tzOffsetMin(wall, tz), tzOffsetMin(wall + DAY, tz)]);
  const hits = [...offsets]
    .map((off) => wall - off * 60000)
    .filter((t) => {
      const p = parts(t, tz);
      return Date.UTC(p.y, p.mo - 1, p.d, p.h, p.mi) === wall;
    })
    .sort((a, b) => a - b);
  const uniq = hits.filter((t, i) => i === 0 || t !== hits[i - 1]);
  const day = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric' }).format(new Date(wall));
  if (uniq.length === 0) {
    return { ok: false, error: 'nonexistent', message: `This time does not exist in ${zoneName(tz)} time on ${day} — clocks moved forward` };
  }
  const first = uniq[0] as number;
  if (uniq.length === 1) {
    const iso = new Date(first).toISOString();
    return { ok: true, iso, abbr: tzAbbr(iso, tz) };
  }
  const options = uniq.map((t) => {
    const iso = new Date(t).toISOString();
    return { iso, abbr: tzAbbr(iso, tz) };
  });
  if (choose) {
    const pick =
      choose === 'earlier' ? options[0] : choose === 'later' ? options[options.length - 1] : options.find((o) => o.abbr === choose);
    if (pick) return { ok: true, iso: pick.iso, abbr: pick.abbr };
  }
  return {
    ok: false,
    error: 'ambiguous',
    message: `This time occurs twice in ${zoneName(tz)} time on ${day} — clocks moved back. Pick ${options.map((o) => o.abbr).join(' or ')}`,
    options,
  };
}

export function isoToLocalInput(iso: string, tz: string): string {
  const p = parts(Date.parse(iso), tz);
  const z = (n: number) => String(n).padStart(2, '0');
  return `${p.y}-${z(p.mo)}-${z(p.d)}T${z(p.h)}:${z(p.mi)}`;
}

export function tzAbbr(iso: string, tz: string): string {
  if (tz === TASHKENT) return 'Tashkent';
  const f = new Intl.DateTimeFormat('en-US', { timeZone: tz, timeZoneName: 'short' });
  const p = f.formatToParts(new Date(Date.parse(iso))).find((x) => x.type === 'timeZoneName');
  return p ? p.value : '';
}

/* ------------------------------------------------------------------ formatting */
export function fmtDate(iso?: string, tz: string = EASTERN, withYear = true): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat('en-US', { timeZone: tz, month: 'short', day: 'numeric', ...(withYear ? { year: 'numeric' } : {}) }).format(new Date(iso));
}

export function fmtTime(iso?: string, tz: string = EASTERN, abbr = true): string {
  if (!iso) return '—';
  const t = new Intl.DateTimeFormat('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' }).format(new Date(iso));
  return abbr ? `${t} ${tzAbbr(iso, tz)}` : t;
}

export function fmtDateTime(iso?: string, tz: string = EASTERN, withYear = true): string {
  if (!iso) return '—';
  return `${fmtDate(iso, tz, withYear)}, ${fmtTime(iso, tz)}`;
}

/** Same calendar year as now → drop the year. */
export function fmtShort(iso?: string, tz: string = EASTERN, now?: number): string {
  if (!iso) return '—';
  const y = new Date(iso).getUTCFullYear();
  return fmtDate(iso, tz, y !== new Date(rulesNow(now)).getUTCFullYear());
}

export function fmtShortDateTime(iso?: string, tz: string = EASTERN, now?: number): string {
  if (!iso) return '—';
  return `${fmtShort(iso, tz, now)}, ${fmtTime(iso, tz)}`;
}

export function addHours(iso: string, h: number): string {
  return new Date(Date.parse(iso) + h * HOUR).toISOString();
}
export function addDays(iso: string, d: number): string {
  return new Date(Date.parse(iso) + d * DAY).toISOString();
}

export function durationLabel(ms: number): string {
  const neg = ms < 0;
  const a = Math.abs(ms);
  const d = Math.floor(a / DAY), h = Math.floor((a % DAY) / HOUR), m = Math.floor((a % HOUR) / 60000);
  const s = d > 0 ? `${d}d ${h}h` : h > 0 ? `${h}h ${m}m` : `${m}m`;
  return neg ? `-${s}` : s;
}

export function daysBetween(a: string, b?: string, now?: number): number {
  return ((b ? Date.parse(b) : rulesNow(now)) - Date.parse(a)) / DAY;
}

/** Calendar-day difference in zone tz between iso and now. */
export function relDay(iso: string, tz: string = EASTERN, now?: number): number {
  const p1 = parts(Date.parse(iso), tz), p0 = parts(rulesNow(now), tz);
  const d1 = Date.UTC(p1.y, p1.mo - 1, p1.d), d0 = Date.UTC(p0.y, p0.mo - 1, p0.d);
  return Math.round((d1 - d0) / DAY);
}

export function dueLabel(iso?: string, tz: string = EASTERN, now?: number): { text: string; overdue: boolean; soon: boolean } {
  if (!iso) return { text: 'No due date', overdue: false, soon: false };
  const n = rulesNow(now);
  const diff = Date.parse(iso) - n;
  const rd = relDay(iso, tz, n);
  const base = fmtShort(iso, tz, n);
  if (diff < 0) {
    const days = Math.floor(-diff / DAY);
    return { text: days >= 1 ? `${base} · ${days} day${days > 1 ? 's' : ''} overdue` : `${base} · overdue ${durationLabel(-diff)}`, overdue: true, soon: false };
  }
  if (rd === 0) return { text: `Today ${fmtTime(iso, tz)}`, overdue: false, soon: true };
  if (rd === 1) return { text: `${base} · tomorrow`, overdue: false, soon: true };
  return { text: `${base} · in ${rd} days`, overdue: false, soon: false };
}

export function ago(iso: string, now?: number): string {
  const diff = rulesNow(now) - Date.parse(iso);
  if (diff < 60000) return 'just now';
  if (diff < HOUR) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < DAY) return `${Math.floor(diff / HOUR)}h ago`;
  const d = Math.floor(diff / DAY);
  return d === 1 ? 'yesterday' : `${d} days ago`;
}

export function monthKey(iso: string): string {
  return iso.slice(0, 7);
}
export function monthLabel(key: string): string {
  const [y = 0, m = 1] = key.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, 15)).toLocaleString('en-US', { month: 'short', timeZone: 'UTC' }) + (m === 1 ? ` ’${String(y).slice(2)}` : '');
}
