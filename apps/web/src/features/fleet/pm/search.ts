import { z } from 'zod';
import { searchText } from '../search-fields';

/** The Oil change / PM board URL: which sheet is open, and on which unit. */
export const oilChangeSearchSchema = z.object({
  sheet: z.enum(['schedule', 'record']).optional().catch(undefined),
  unit: searchText,
});

export type OilChangeSearch = z.infer<typeof oilChangeSearchSchema>;
