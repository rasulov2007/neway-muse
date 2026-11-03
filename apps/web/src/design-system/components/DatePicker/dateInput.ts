import { isValid, parse, startOfDay } from 'date-fns';

/**
 * The ways a person writes a date by hand; tried in order, first full match wins. The two-digit
 * year goes first because date-fns reads "26" against "yyyy" as the year 26.
 */
export const DATE_INPUT_FORMATS = [
  'M/d/yy',
  'MM/dd/yyyy',
  'M/d/yyyy',
  'yyyy-MM-dd',
  'MMM d yyyy',
  'MMM d, yyyy',
  'MMMM d yyyy',
  'MMMM d, yyyy',
  'd MMM yyyy',
  // Eight digits typed with no slashes at all: 11252029.
  'MMddyyyy',
] as const;

export const DATE_PARSE_ERROR = 'Enter a date like 09/11/2026';

export const ISO_FORMAT = 'yyyy-MM-dd';

/** Reads typed or pasted text as a date; `null` when no listed format matches. */
export function parseDateInput(text: string, referenceDate: Date = new Date()): Date | null {
  const trimmed = text.trim().replace(/\s+/g, ' ');
  if (!trimmed) return null;
  for (const pattern of DATE_INPUT_FORMATS) {
    const parsed = parse(trimmed, pattern, referenceDate);
    if (isValid(parsed) && parsed.getFullYear() >= 1000) return startOfDay(parsed);
  }
  return null;
}

/** Accepts a Date or an ISO `yyyy-MM-dd` string; anything unreadable is "no value". */
export function toDateValue(value: Date | string | null | undefined): Date | undefined {
  if (!value) return undefined;
  if (value instanceof Date) return isValid(value) ? value : undefined;
  const parsed = parse(value, ISO_FORMAT, new Date());
  return isValid(parsed) ? parsed : undefined;
}
