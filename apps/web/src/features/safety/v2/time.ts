import { now } from '@/lib/clock';

/**
 * Wall-clock times typed into Safety forms are US Eastern (owner, 2026-09-25), never the
 * browser's zone. A `datetime-local` input carries no zone, so these two functions do the
 * conversion explicitly, DST included.
 */

const TZ = 'America/New_York';

const parts = new Intl.DateTimeFormat('en-US', {
  timeZone: TZ,
  hourCycle: 'h23',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
  hour: '2-digit',
  minute: '2-digit',
  second: '2-digit',
});

function wall(at: Date): { y: number; m: number; d: number; h: number; mi: number; s: number } {
  const get = (type: string) => Number(parts.formatToParts(at).find((p) => p.type === type)?.value ?? 0);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

/** An instant as the `YYYY-MM-DDTHH:mm` an Eastern clock on the wall shows. */
export function toEasternInput(iso: string | Date | null | undefined): string {
  if (!iso) return '';
  const at = typeof iso === 'string' ? new Date(iso) : iso;
  if (Number.isNaN(at.getTime())) return '';
  const w = wall(at);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${w.y}-${pad(w.m)}-${pad(w.d)}T${pad(w.h)}:${pad(w.mi)}`;
}

/** `YYYY-MM-DDTHH:mm` read on an Eastern wall clock, as an ISO instant. */
export function fromEasternInput(value: string): string | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(value);
  if (!m) return null;
  const target = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]));
  // Two passes settle the offset, including the hour around a DST change.
  let guess = target;
  for (let i = 0; i < 2; i += 1) {
    const w = wall(new Date(guess));
    const shown = Date.UTC(w.y, w.m - 1, w.d, w.h, w.mi);
    guess += target - shown;
  }
  return new Date(guess).toISOString();
}

/** Now, on the Eastern wall clock, for a form default. */
export function easternNowInput(): string {
  return toEasternInput(now());
}
