/**
 * How close a dated document is to expiring, as one colour band — the single rule every expiry
 * pill, chip and row in the product reads (owner, 2026-10-08).
 *
 * Bands are measured in CALENDAR months from Eastern today, not in 30-day blocks:
 *
 * | Expires on                    | Tone       | Word                        |
 * |-------------------------------|------------|-----------------------------|
 * | before today                  | `expired`  | "Expired"                   |
 * | today … today + 1 month       | `danger`   | "Expires today" / "in N days" |
 * | … today + 2 months            | `warning`  | "Expires in N days"         |
 * | … today + 3 months            | `info`     | "Expires in N days"         |
 * | later                         | `normal`   | "Valid"                     |
 * | no expiry date                | `none`     | "No expiry"                 |
 *
 * A document is still valid ON its expiry date, so `expiresOn === today` is "Expires today"
 * (danger), and it reads "Expired" from the next day. Each boundary is inclusive: exactly one month
 * out is still danger, the day after is warning.
 *
 * This only decides what a screen SHOWS. Whether an item is `expiring` for notifications and
 * escalation is still the compliance engine's lead-day ladder (see `engine.ts`).
 */
import { addMonthsClamped } from '../dates.js';
import { daysBetween } from './engine.js';

export type ExpiryTone = 'none' | 'normal' | 'info' | 'warning' | 'danger' | 'expired';

export interface ExpiryToneResult {
  tone: ExpiryTone;
  /** Calendar days from today to the expiry date; negative once past; null with no date. */
  daysLeft: number | null;
  /** The word the badge shows. */
  label: string;
}

function inDays(n: number): string {
  if (n === 0) return 'Expires today';
  if (n === 1) return 'Expires in 1 day';
  return `Expires in ${n} days`;
}

export function expiryTone(expiresOn: string | null | undefined, today: string): ExpiryToneResult {
  if (!expiresOn) return { tone: 'none', daysLeft: null, label: 'No expiry' };
  const daysLeft = daysBetween(today, expiresOn);
  if (daysLeft === null) return { tone: 'none', daysLeft: null, label: 'No expiry' };
  if (daysLeft < 0) return { tone: 'expired', daysLeft, label: 'Expired' };
  // Plain string comparison is safe: both sides are YYYY-MM-DD.
  if (expiresOn <= addMonthsClamped(today, 1)) return { tone: 'danger', daysLeft, label: inDays(daysLeft) };
  if (expiresOn <= addMonthsClamped(today, 2)) return { tone: 'warning', daysLeft, label: inDays(daysLeft) };
  if (expiresOn <= addMonthsClamped(today, 3)) return { tone: 'info', daysLeft, label: inDays(daysLeft) };
  return { tone: 'normal', daysLeft, label: 'Valid' };
}

/** True for the tones that are shown as a warning about the date (everything but valid / none). */
export function isExpiryAlert(tone: ExpiryTone): boolean {
  return tone === 'info' || tone === 'warning' || tone === 'danger' || tone === 'expired';
}
