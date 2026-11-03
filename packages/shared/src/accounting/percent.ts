/**
 * Percent representation (section 5). A pay-plan rate is stored and shown as a PERCENT: 30 means
 * 30%, 0.3 means 0.3%. A multiplier (0.3 = 30%) never enters storage. The roster's legacy
 * figures were typed without that rule, so a percentage under 1 is ambiguous - it may be a
 * multiplier somebody meant as 30% - and is flagged for confirmation, never reinterpreted.
 */

/** Cents earned from a percent rate on a base, half-up to the cent. */
export function applyPercent(baseCents: number, percent: number): number {
  return Math.round((baseCents * percent) / 100);
}

/** `0.3` -> `0.3%`, `30` -> `30%`; never more than four decimals. */
export function formatPercent(percent: number): string {
  return `${Number(percent.toFixed(4))}%`;
}

/** What the person typed, as a percent; blank or NaN is null. */
export function parsePercentInput(text: string): number | null {
  const n = Number.parseFloat(text.replace(/%/g, '').trim());
  return Number.isFinite(n) && n >= 0 ? n : null;
}

export interface RateReading {
  /** The rate as stored, read as a percent. */
  percent: number;
  /** True when the figure could also have been meant as a multiplier (0 < rate < 1). */
  ambiguous: boolean;
  asPercent: string;
  asMultiplier: string;
}

/** Reads a roster percentage and says whether it needs a person's confirmation. */
export function readRosterPercent(rate: number): RateReading {
  const ambiguous = rate > 0 && rate < 1;
  return { percent: rate, ambiguous, asPercent: formatPercent(rate), asMultiplier: formatPercent(rate * 100) };
}
