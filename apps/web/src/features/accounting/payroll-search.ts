import { z } from 'zod';
import { searchText } from '@/features/fleet/search-fields';

/**
 * The URL is the state.
 *
 * These live apart from the page component so a page file exports only components — Fast Refresh
 * cannot preserve state across an edit to a module that mixes the two.
 */

export const payrollSearchSchema = z.object({
  period: searchText,
});
