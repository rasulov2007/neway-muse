import { z } from 'zod';

import { searchPage, searchText } from './search-fields';

/** A calendar date (`2026-10-05`) in the company's timezone, degrading to "not set". */
const searchDate = z
  .union([z.string(), z.number()])
  .transform(String)
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value))
  .optional()
  .catch(undefined);

/** The Fuel page URL. */
export const fuelSearchSchema = z.object({
  /** `invoices` shows one row per fill; anything else is the transactions list. */
  tab: z.enum(['transactions', 'invoices']).optional().catch(undefined),
  /** The date range, inclusive, in Eastern calendar dates. Absent = the last 30 days. */
  from: searchDate,
  to: searchDate,
  q: searchText,
  unit: searchText,
  state: searchText,
  vendor: searchText,
  product: searchText,
  flagged: searchText,
  page: searchPage,
});

export type FuelSearch = z.infer<typeof fuelSearchSchema>;
