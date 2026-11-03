import { z } from 'zod';

/**
 * URL state for the administration screens.
 *
 * Kept out of the page modules so those files export components only — a module that exports both
 * a component and a plain value breaks React Fast Refresh, which this project has hit once per
 * feature area and fixes the same way each time.
 */
export const adminSearchSchema = z.object({
  page: z.coerce.number().int().min(1).catch(1),
  pageSize: z.coerce.number().int().min(1).max(200).catch(25),
  q: z.string().optional().catch(undefined),
  status: z.string().optional().catch(undefined),
  roleId: z.string().optional().catch(undefined),
  department: z.string().optional().catch(undefined),
  /** Users: `pending` lists who has not completed their own profile (2026-10-26). */
  profile: z.enum(['pending']).optional().catch(undefined),
  /** The selected record in a detail drawer. */
  selected: z.string().optional().catch(undefined),
  tab: z.string().optional().catch(undefined),
  /** Audit filters. */
  action: z.string().optional().catch(undefined),
  entityType: z.string().optional().catch(undefined),
  actorId: z.string().optional().catch(undefined),
  from: z.string().optional().catch(undefined),
  to: z.string().optional().catch(undefined),
});

export type AdminSearch = z.infer<typeof adminSearchSchema>;
