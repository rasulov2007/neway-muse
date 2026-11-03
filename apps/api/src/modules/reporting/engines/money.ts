/**
 * Shared arithmetic helpers for the reporting engines. Every function is total: it never
 * returns NaN or Infinity, and division by zero (or by null) yields `null`, which the engines
 * surface as an honest "unknown" rather than a fake zero (docs/DASHBOARD.md §4).
 */

/** Rounds `value` half away from zero to `decimals` places, normalizing `-0` to `0`. */
export function roundTo(value: number, decimals: number): number {
  if (!Number.isFinite(value)) return 0;
  const factor = 10 ** decimals;
  const sign = value < 0 ? -1 : 1;
  // Strip binary float noise (10.005 * 100 === 1000.4999999999999) before rounding so that
  // values that are exactly half a cent in decimal round up as accountants expect.
  const scaled = Number((Math.abs(value) * factor).toPrecision(15));
  const rounded = (sign * Math.round(scaled)) / factor;
  return rounded === 0 ? 0 : rounded;
}

/** Rounds a dollar amount to cents. */
export function roundMoney(value: number): number {
  return roundTo(value, 2);
}

/** Rounds a ratio (RPM, CPM, PPM, price per gallon) to 4 decimals. */
export function roundRatio(value: number): number {
  return roundTo(value, 4);
}

/** Rounds a percentage to 1 decimal. */
export function roundPct(value: number): number {
  return roundTo(value, 1);
}

/** Sums finite numbers; non-finite entries are ignored so a bad row cannot poison a total. */
export function sum(values: readonly number[]): number {
  let total = 0;
  for (const value of values) {
    if (Number.isFinite(value)) total += value;
  }
  return total;
}

/** Divides, returning `null` when either side is null or the denominator is zero. */
export function safeDivide(numerator: number | null, denominator: number | null): number | null {
  if (numerator === null || denominator === null) return null;
  if (denominator === 0 || !Number.isFinite(numerator) || !Number.isFinite(denominator)) {
    return null;
  }
  const result = numerator / denominator;
  return Number.isFinite(result) ? result : null;
}

/** `part / whole * 100` rounded to 1 decimal, or `null` when the whole is null or zero. */
export function pct(part: number | null, whole: number | null): number | null {
  const ratio = safeDivide(part, whole);
  return ratio === null ? null : roundPct(ratio * 100);
}

/** `a - b`, or `null` when either operand is null. */
export function subtract(a: number | null, b: number | null): number | null {
  if (a === null || b === null) return null;
  return a - b;
}

/** Applies `round` to a nullable value, passing `null` through. */
export function roundNullable(value: number | null, round: (v: number) => number): number | null {
  return value === null ? null : round(value);
}
