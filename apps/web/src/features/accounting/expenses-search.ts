import { z } from 'zod';
import { searchText, searchPage } from '@/features/fleet/search-fields';

/**
 * The URL is the state.
 *
 * These live apart from the page component so a page file exports only components — Fast Refresh
 * cannot preserve state across an edit to a module that mixes the two.
 */

export const expensesSearchSchema = z.object({
  q: searchText,
  fp: searchText,
  category: searchText,
  unit: searchText,
  driver: searchText,
  vendor: searchText,
  source: searchText,
  burden: searchText,
  status: searchText,
  tab: searchText,
  page: searchPage,
});
