import { z } from 'zod';
import { FLEET_SPEND_PERIODS, FLEET_UNIT_TYPES, TIRE_WINDOWS, type FleetSpendPeriod } from '@neway/shared';
import { searchText } from './search-fields';

/**
 * The Fleet expense summary URL.
 *
 * Both filters live in the URL so a figure somebody is looking at can be sent as a link and lands
 * on the same figure, and so every drilldown carries the same period and units it was counted in.
 * A malformed value degrades to the default rather than an error screen, as on every fleet page.
 */
export const expenseSearchSchema = z.object({
  /** Week / month / quarter / year to date; the API defaults to year when absent. */
  period: z.enum(FLEET_SPEND_PERIODS).optional().catch(undefined),
  /** Comma-separated unit ids; absent means the whole fleet. */
  units: searchText,
  /** All units, trucks or trailers; the API defaults to all. */
  unitType: z.enum(FLEET_UNIT_TYPES).optional().catch(undefined),
  /** With period=week: the Monday of the week shown; absent means the current week. */
  /** Any day of the chosen period (week, month, quarter or year); absent = the current one. */
  at: z.string().regex(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/).optional().catch(undefined),
  week: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  /**
   * Maintenance only (the default, absent from the URL) or all fleet costs - parking, washes,
   * tolls and the rest of Fleet Expenses beside the repairs (owner, 2026-10-12).
   */
  scope: z.enum(['maintenance', 'all']).optional().catch(undefined),
  /** The Tire replacement page's rolling window: 30 days / 90 days / 12 months (default 12 months). */
  window: z.enum(TIRE_WINDOWS).optional().catch(undefined),
});

export type ExpenseSearch = z.infer<typeof expenseSearchSchema>;

export function parseUnits(value: string | undefined): string[] {
  return value ? value.split(',').filter(Boolean) : [];
}

/** The first day of the period that holds `iso`. */
export function periodStart(period: Exclude<FleetSpendPeriod, 'week'>, iso: string): string {
  const y = iso.slice(0, 4);
  const m = Number(iso.slice(5, 7));
  if (period === 'month') return `${y}-${String(m).padStart(2, '0')}-01`;
  if (period === 'quarter') return `${y}-${String(Math.floor((m - 1) / 3) * 3 + 1).padStart(2, '0')}-01`;
  return `${y}-01-01`;
}
