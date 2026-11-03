/**
 * Display formatting helpers shared by every module.
 *
 * All date/time output is rendered in the company timezone (America/Chicago) through
 * `Intl.DateTimeFormat` so the UI shows the same wall-clock time regardless of the viewer's
 * browser timezone. Money is always US dollars.
 */
import { formatDistanceStrict, formatDistanceToNowStrict } from 'date-fns';

export const COMPANY_TIMEZONE = 'America/New_York';
export const LOCALE = 'en-US';

export type DateInput = Date | string | number;

function toDate(input: DateInput): Date {
  return input instanceof Date ? input : new Date(input);
}

function isValid(date: Date): boolean {
  return !Number.isNaN(date.getTime());
}

const moneyFormatter = new Intl.NumberFormat(LOCALE, {
  style: 'currency',
  currency: 'USD',
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const numberFormatters = new Map<string, Intl.NumberFormat>();

function numberFormatter(minDigits: number, maxDigits: number): Intl.NumberFormat {
  const key = `${minDigits}:${maxDigits}`;
  let formatter = numberFormatters.get(key);
  if (!formatter) {
    formatter = new Intl.NumberFormat(LOCALE, {
      minimumFractionDigits: minDigits,
      maximumFractionDigits: maxDigits,
    });
    numberFormatters.set(key, formatter);
  }
  return formatter;
}

export interface MoneyOptions {
  /** `$84.3K` / `$1.2M` instead of the full amount. */
  compact?: boolean;
}

/** `$84,250.00`, or `$84.3K` with `{ compact: true }`. Negative values render as `-$1,200.00`. */
export function formatMoney(amount: number, options: MoneyOptions = {}): string {
  if (!Number.isFinite(amount)) return '—';
  if (options.compact) {
    const abs = Math.abs(amount);
    const sign = amount < 0 ? '-' : '';
    if (abs >= 1_000_000_000) return `${sign}$${trimTrailingZero(abs / 1_000_000_000)}B`;
    if (abs >= 1_000_000) return `${sign}$${trimTrailingZero(abs / 1_000_000)}M`;
    if (abs >= 1_000) return `${sign}$${trimTrailingZero(abs / 1_000)}K`;
    return `${sign}$${trimTrailingZero(abs)}`;
  }
  return moneyFormatter.format(amount);
}

function trimTrailingZero(value: number): string {
  return numberFormatter(0, 1).format(value);
}

/** `421,500` — integers by default; pass `digits` to keep decimals (`formatNumber(6.42, 1)` → `6.4`). */
export function formatNumber(value: number, digits = 0): string {
  if (!Number.isFinite(value)) return '—';
  return numberFormatter(digits, digits).format(value);
}

/** `421,500 mi` */
export function formatMiles(miles: number): string {
  if (!Number.isFinite(miles)) return '—';
  return `${formatNumber(Math.round(miles))} mi`;
}

export interface PercentOptions {
  /** Decimal places (default 1). */
  digits?: number;
  /** Prefix positive values with `+` (default true). */
  signed?: boolean;
}

/**
 * `+4.2%` / `-1.8%` / `0.0%`. The input is already a percentage (4.2 → `+4.2%`), not a ratio.
 * Pass a number as the second argument for the digit count, or an options object.
 */
export function formatPercent(
  value: number,
  digitsOrOptions: number | PercentOptions = {},
): string {
  if (!Number.isFinite(value)) return '—';
  const options: PercentOptions =
    typeof digitsOrOptions === 'number' ? { digits: digitsOrOptions } : digitsOrOptions;
  const digits = options.digits ?? 1;
  const signed = options.signed ?? true;
  const rounded = Number(value.toFixed(digits));
  const body = numberFormatter(digits, digits).format(Math.abs(rounded));
  if (rounded < 0) return `-${body}%`;
  if (rounded > 0 && signed) return `+${body}%`;
  return `${body}%`;
}

const dateFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: COMPANY_TIMEZONE,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
});

// A time always says which clock it is on - `EDT` / `EST` - so a reader in Tashkent and one in
// Chicago never wonder whose 8:00 AM this is.
const dateTimeFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: COMPANY_TIMEZONE,
  month: 'short',
  day: 'numeric',
  year: 'numeric',
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

const timeFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: COMPANY_TIMEZONE,
  hour: 'numeric',
  minute: '2-digit',
  timeZoneName: 'short',
});

/** `Sep 6, 2026` in the company timezone. */
export function formatDate(input: DateInput): string {
  const date = toDate(input);
  return isValid(date) ? dateFormatter.format(date) : '—';
}

const isoDateFormatter = new Intl.DateTimeFormat(LOCALE, {
  timeZone: 'UTC',
  year: 'numeric',
  month: 'short',
  day: 'numeric',
});

/**
 * `Sep 1, 2026` for a calendar date (`YYYY-MM-DD`).
 *
 * Unlike `formatDate`, this does not convert timezones. A credential expiry is a calendar date,
 * not an instant: converting it into the company timezone renders 2026-09-01 as "Aug 31, 2026"
 * for anyone west of UTC, which is a day's difference on a document that gates dispatch.
 */
export function formatIsoDate(date: string | null | undefined): string {
  if (!date) return '—';
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match) return '—';
  const time = Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(time) ? '—' : isoDateFormatter.format(time);
}

/** `Sep 6, 2026, 2:14 PM` in the company timezone. */
export function formatDateTime(input: DateInput): string {
  const date = toDate(input);
  return isValid(date) ? dateTimeFormatter.format(date) : '—';
}

/** `2:14 PM` in the company timezone. */
export function formatTime(input: DateInput): string {
  const date = toDate(input);
  return isValid(date) ? timeFormatter.format(date) : '—';
}

const RELATIVE_UNITS: Array<[RegExp, string]> = [
  [/ seconds?\b/, ' s'],
  [/ minutes?\b/, ' min'],
  [/ hours?\b/, ' h'],
  [/ days?\b/, ' d'],
  [/ months?\b/, ' mo'],
  [/ years?\b/, ' y'],
];

export interface RelativeOptions {
  /** Reference point; defaults to the real current time. */
  now?: DateInput;
}

/** `3 min ago` / `in 2 h`, built on date-fns strict distance. */
export function formatRelative(input: DateInput, options: RelativeOptions = {}): string {
  const date = toDate(input);
  if (!isValid(date)) return '—';
  const distance =
    options.now === undefined
      ? formatDistanceToNowStrict(date, { addSuffix: true })
      : formatDistanceStrict(date, toDate(options.now), { addSuffix: true });
  return RELATIVE_UNITS.reduce((text, [pattern, short]) => text.replace(pattern, short), distance);
}

/** Rate per mile: `$2.50`. */
export function formatRpm(rate: number): string {
  if (!Number.isFinite(rate)) return '—';
  return moneyFormatter.format(rate);
}

/** `Sarah Chen` → `SC`; single names give one letter; empty gives `?`. */
export function initials(name: string): string {
  const parts = name
    .trim()
    .split(/\s+/)
    .filter((part) => part.length > 0 && /[\p{L}\p{N}]/u.test(part));
  if (parts.length === 0) return '?';
  const first = parts[0] ?? '';
  const last = parts.length > 1 ? (parts[parts.length - 1] ?? '') : '';
  return `${first.charAt(0)}${last.charAt(0)}`.toUpperCase();
}

/** `+13125550142` → `(312) 555-0142`; other inputs are returned unchanged. */
export function formatPhone(e164: string): string {
  const digits = e164.replace(/\D/g, '');
  const national = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
  if (national.length !== 10) return e164;
  return `(${national.slice(0, 3)}) ${national.slice(3, 6)}-${national.slice(6)}`;
}

/** `135` → `2h 15m`; `45` → `45m`; `1500` → `1d 1h`. */
export function formatDuration(minutes: number): string {
  if (!Number.isFinite(minutes)) return '—';
  const total = Math.max(0, Math.round(minutes));
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const mins = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return mins > 0 ? `${hours}h ${mins}m` : `${hours}h`;
  return `${mins}m`;
}

/**
 * A typed amount as a number.
 *
 * People type money the way it is written: `$5,503.00`, `5 503,00`, `1.2k` in a hurry. A number
 * input refuses most of that and silently keeps nothing, so the field takes text and this reads
 * it — currency symbols, thousands separators and spaces dropped, the last separator treated as
 * the decimal point. Anything that is not a number comes back null rather than 0, because a price
 * nobody could read is not free.
 */
export function parseMoney(input: string): number | null {
  const cleaned = input.replace(/[^\d.,-]/g, '').trim();
  if (cleaned === '' || cleaned === '-') return null;

  const lastComma = cleaned.lastIndexOf(',');
  const lastDot = cleaned.lastIndexOf('.');
  const decimalAt = Math.max(lastComma, lastDot);
  // Two separators, or one with exactly two digits behind it: that one is the decimal point.
  const isDecimal =
    decimalAt > -1 && lastComma > -1 !== lastDot > -1
      ? cleaned.length - decimalAt - 1 <= 2
      : decimalAt > -1;

  const whole = isDecimal ? cleaned.slice(0, decimalAt) : cleaned;
  const fraction = isDecimal ? cleaned.slice(decimalAt + 1) : '';
  const value = Number(`${whole.replace(/[.,]/g, '')}.${fraction.replace(/[.,]/g, '') || '0'}`);
  return Number.isFinite(value) ? value : null;
}
