import { z } from 'zod';
import { searchText, searchPage } from '@/features/fleet/search-fields';

/**
 * The URL is the state, so a filtered list is a link somebody can send.
 *
 * Kept apart from the page component: Fast Refresh cannot preserve state across an edit to a
 * module that exports both components and plain values.
 */

export const reimbursementsSearchSchema = z.object({
  q: searchText,
  fp: searchText,
  status: searchText,
  driver: searchText,
  truck: searchText,
  category: searchText,
  open: searchText,
  page: searchPage,
});
