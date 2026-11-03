import { stopHandlingOf, type StopHandling } from './model.js';
import type { RateConfirmationExtract, RcStop } from './rate-confirmation.js';
import { routeLine, type ChosenRoute } from './route-options.js';

/**
 * The load message a dispatcher sends the driver on Telegram, built from the RC the reader just
 * read (owner, 2026-10-17). Laid out the way the dispatchers already write it by hand; anything
 * the RC does not say is left out rather than guessed, and the dispatcher edits the text before
 * copying it.
 */

/** The company's charges when a driver misses these (owner's message, 2026-10-17). */
export const DRIVER_MESSAGE_CHARGES: readonly { label: string; amount: number }[] = [
  { label: 'on time', amount: 300 },
  { label: 'update', amount: 300 },
  { label: 'Tracking accept', amount: 300 },
  { label: 'Freight picture', amount: 100 },
];

const RULE = '——————————';

/** 2026-10-07 → 10/07/2026 */
function usDate(iso: string | null): string | null {
  const m = iso ? /^(\d{4})-(\d{2})-(\d{2})/.exec(iso) : null;
  return m ? `${m[2]}/${m[3]}/${m[1]}` : null;
}

/** 14:30 → 02:30 PM */
function clock(hhmm: string | null): string | null {
  const m = hhmm ? /^(\d{1,2}):(\d{2})/.exec(hhmm) : null;
  if (!m) return null;
  const h = Number(m[1]);
  return `${String(h % 12 === 0 ? 12 : h % 12).padStart(2, '0')}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
}

function money(n: number): string {
  return Number.isInteger(n) ? `$${n}` : `$${n.toFixed(2)}`;
}

function stopBlock(s: RcStop): string[] {
  const when = [usDate(s.date), [clock(s.time), clock(s.endTime)].filter(Boolean).join(' - ')].filter(Boolean).join('  ');
  const cityLine = [s.city, [s.state, s.zip].filter(Boolean).join(' ')].filter(Boolean).join(', ');
  return [`${s.kind === 'pickup' ? 'PU' : 'DEL'}:${when ? ` ${when}` : ''}`, s.facilityName, s.street, cityLine || null].filter((l): l is string => Boolean(l && l.trim()));
}

/**
 * What the message may say about money (owner, 2026-10-23). A company driver is paid by the
 * company's plan, so their message carries no Rate line at all; an owner operator or lease driver
 * sees the rate they are paid on - the For driver rate when the load has one, never more than it.
 */
export interface DriverMessageOptions {
  /** The driver is a company driver: leave the Rate line out. */
  hideRate?: boolean;
  /** The rate to print instead of the RC's total (the For driver rate); null prints none. */
  rate?: number | null;
  /**
   * Live or drop at the first pickup and the last delivery (owner, 2026-10-25): the message
   * opens with "LIVE / DROP". Absent leaves the line out; a side not given reads LIVE.
   */
  handling?: { pickup?: StopHandling | null; delivery?: StopHandling | null } | null;
  /**
   * Empty (deadhead) miles on the load (owner, 2026-10-25). Above zero, the miles read
   * Empty / Loaded / Total, the total being the two together; `rc.miles` is the loaded figure.
   */
  emptyMiles?: number | null;
  /**
   * The road the dispatcher chose from TollGuru's options (owner, 2026-10-27): one line right
   * after the stops block - road, miles, tolls. Absent or null leaves the line out.
   */
  route?: Pick<ChosenRoute, 'via' | 'miles' | 'tollCost'> | null;
  /** "Need Trailer" right above LIVE / DROP (owner, 2026-10-29: on every booked load's message). */
  needTrailer?: boolean;
}

/** "LIVE / DROP": first pickup, then last delivery, upper case. */
export function handlingLine(handling: NonNullable<DriverMessageOptions['handling']>): string {
  return `${stopHandlingOf({ handling: handling.pickup }).toUpperCase()} / ${stopHandlingOf({ handling: handling.delivery }).toUpperCase()}`;
}

/** The miles lines: Empty only when there are empty miles, Total = loaded + empty. */
function milesLines(loaded: number | null, empty: number | null | undefined): string[] {
  const dh = empty !== null && empty !== undefined && Number.isFinite(empty) && empty > 0 ? empty : 0;
  const lines: string[] = [];
  if (dh > 0) lines.push(`Empty: ${dh} miles`);
  if (loaded !== null) lines.push(`Loaded: ${loaded} miles`, `Total: ${loaded + dh} miles`);
  return lines;
}

export function driverMessageFromRc(rc: RateConfirmationExtract, options: DriverMessageOptions = {}): string {
  const lines: string[] = [];
  // Load # first, LIVE / DROP right under it (owner, 2026-10-26).
  if (rc.brokerLoadNumber) lines.push(`Load # ${rc.brokerLoadNumber}`);
  if (options.needTrailer) lines.push('Need Trailer');
  if (options.handling) lines.push(handlingLine(options.handling));
  if (rc.equipment === 'reefer') lines.push(`Reefer${rc.temperature ? ` ${rc.temperature}` : ''}`);
  else if (rc.equipment === 'flatbed') lines.push('Flatbed');
  if (rc.hazmat) lines.push('HAZMAT');
  const puRef = rc.stops.find((s) => s.kind === 'pickup' && s.reference)?.reference;
  if (puRef) lines.push('', `PU # ${puRef}`);
  lines.push('', RULE);
  rc.stops.forEach((s, i) => {
    if (i > 0) lines.push('');
    lines.push(...stopBlock(s));
  });
  lines.push(`${RULE}-`);
  if (options.route) lines.push(routeLine(options.route));
  const rate = options.rate !== undefined ? options.rate : rc.totalRate;
  if (!options.hideRate && rate !== null) lines.push(`Rate: ${money(rate)}`);
  lines.push(...milesLines(rc.miles, options.emptyMiles));
  lines.push(RULE, '', 'Charge if no»⛔️', ...DRIVER_MESSAGE_CHARGES.map((c) => `⏺${c.label}: ${money(c.amount)}`), '', 'please confirm ✅');
  return lines.join('\n');
}
