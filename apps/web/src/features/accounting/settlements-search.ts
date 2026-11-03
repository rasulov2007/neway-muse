import { z } from 'zod';
import { searchText, searchPage } from '@/features/fleet/search-fields';

/**
 * The URL is the state.
 *
 * These live apart from the page component so a page file exports only components — Fast Refresh
 * cannot preserve state across an edit to a module that mixes the two.
 */

export const settlementsSearchSchema = z.object({
  q: searchText,
  status: searchText,
  driver: searchText,
  shortfall: searchText,
  excluded: searchText,
  ids: searchText,
  page: searchPage,
});
