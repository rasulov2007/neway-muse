/**
 * Money is integer cents everywhere in accounting. Nothing here divides a float and hopes.
 *
 * Rounding is the one rule the owner has to be able to read: half-up on the cent, and where a
 * total is split, the remainder cents go to the earliest recipients, one each, so the parts
 * always add back to the whole (`splitCents`).
 */

export function cents(dollars: number | string | null | undefined): number {
  if (dollars === null || dollars === undefined || dollars === '') return 0;
  const n = typeof dollars === 'string' ? Number.parseFloat(dollars) : dollars;
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100);
}

export function dollars(centsValue: number): number {
  return Math.round(centsValue) / 100;
}

/** `pct` in percent (e.g. 90 → 90%), applied to cents, rounded half-up to the cent. */
export function percentOf(centsValue: number, pct: number): number {
  return Math.round((centsValue * pct) / 100);
}

/** Basis points (9000 = 90%), applied to cents, rounded half-up. */
export function bpsOf(centsValue: number, bps: number): number {
  return Math.round((centsValue * bps) / 10_000);
}

/**
 * Splits cents into `parts` shares by weight (default equal). The shares are floored and the
 * leftover cents are handed out one at a time from the first share, so the sum is exact:
 * 20_001 split 2 → [10_001, 10_000]; $200.00 split 50/50 → $100.00 / $100.00.
 */
export function splitCents(total: number, parts: number, weights?: readonly number[]): number[] {
  if (parts <= 0) return [];
  const w = weights && weights.length === parts ? weights : Array.from({ length: parts }, () => 1);
  const sumW = w.reduce((a, b) => a + b, 0);
  if (sumW <= 0) return Array.from({ length: parts }, () => 0);
  const sign = total < 0 ? -1 : 1;
  const abs = Math.abs(Math.round(total));
  const raw = w.map((x) => Math.floor((abs * x) / sumW));
  let left = abs - raw.reduce((a, b) => a + b, 0);
  for (let i = 0; left > 0; i = (i + 1) % parts) {
    raw[i]! += 1;
    left -= 1;
  }
  return raw.map((x) => x * sign);
}

/** Sums safely, treating anything non-finite as zero. */
export function sumCents(values: readonly (number | null | undefined)[]): number {
  return values.reduce<number>((a, b) => a + (Number.isFinite(b ?? NaN) ? Math.round(b as number) : 0), 0);
}
