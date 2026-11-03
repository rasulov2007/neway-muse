import { z } from 'zod';
import { searchText } from './search-fields';

/** The PTI board URL. `review` is the unit the Update PTI drawer is open on (§6.1). */
export const ptiSearchSchema = z.object({
  review: searchText,
});

export type PtiSearch = z.infer<typeof ptiSearchSchema>;
