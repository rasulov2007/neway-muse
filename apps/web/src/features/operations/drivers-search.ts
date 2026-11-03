import { DRIVER_AVAILABILITY_STATES, type DriverAvailability } from '@neway/shared';
import { z } from 'zod';
import { DRIVER_AVAILABILITY_LABEL } from './operations-ui';

/**
 * The drivers page's URL contract.
 *
 * The availability filter reuses the engine's own state list rather than a hand-written copy, so a
 * new state can never exist in the data and be un-filterable in the URL. Every field is optional
 * and `.catch(undefined)` so a stale or hand-edited URL degrades to the unfiltered list instead of
 * throwing, matching `dispatch-search.ts`.
 */
export const driversSearchSchema = z.object({
  /** Which register is on screen: the working roster, or everyone who has left. */
  tab: z.enum(['active', 'terminated', 'archived']).optional().catch(undefined),
  availability: z.enum(DRIVER_AVAILABILITY_STATES).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  /** Driver id of the row open in the drawer. */
  driver: z.string().optional().catch(undefined),
});

export type DriversSearch = z.infer<typeof driversSearchSchema>;

/** Human label for an availability filter, for headings and the clear chip. */
export function describeAvailability(state: DriverAvailability | undefined): string | null {
  return state ? DRIVER_AVAILABILITY_LABEL[state] : null;
}
