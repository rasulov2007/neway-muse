/**
 * What someone typed as miles between oil changes. Thousands may be left off (owner, 2026-10-10):
 * "30" is 30,000, "25k" is 25,000, "30,000" is 30,000. Null when it is not a plausible interval.
 */
export function oilIntervalMiles(typed: string): number | null {
  const clean = typed.trim().toLowerCase().replace(/[,\s]/g, '').replace(/mi$/, '');
  const thousands = clean.endsWith('k');
  const value = Number(thousands ? clean.slice(0, -1) : clean);
  if (!clean || !Number.isFinite(value) || value <= 0) return null;
  const miles = Math.round(thousands || value < 1_000 ? value * 1_000 : value);
  return miles >= 5_000 && miles <= 100_000 ? miles : null;
}
