import { z } from 'zod';
import { searchText, searchPage } from '@/features/fleet/search-fields';

/**
 * The URL is the state.
 *
 * These live apart from the page component so a page file exports only components — Fast Refresh
 * cannot preserve state across an edit to a module that mixes the two.
 */

export const invoicesSearchSchema = z.object({
  q: searchText,
  /** 'queue' = the billing queue; anything else = the invoice list with its own filters. */
  tab: searchText,
  view: searchText,
  customer: searchText,
  bucket: searchText,
  ids: searchText,
  sort: searchText,
  page: searchPage,
  /** The invoice date range, YYYY-MM-DD, both ends included; absent = all dates (owner, 2026-10-23). */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().catch(undefined),
});

export type InvoicesSearch = z.infer<typeof invoicesSearchSchema>;

