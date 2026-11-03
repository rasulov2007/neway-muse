import { z } from 'zod';

/**
 * The customers page URL contract.
 *
 * Same shape as the dispatch board's: every field optional and `.catch(undefined)` so a
 * hand-edited or stale URL degrades to the unfiltered list instead of throwing.
 */
export const customersSearchSchema = z.object({
  status: z.enum(['active', 'inactive', 'on_hold']).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  /** Customer id of the row open in the drawer. */
  customer: z.string().optional().catch(undefined),
});

export type CustomersSearch = z.infer<typeof customersSearchSchema>;
