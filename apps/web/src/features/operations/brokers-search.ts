import { BROKER_RISK_LEVELS } from '@neway/shared';
import { z } from 'zod';

export const BROKER_STATUS_FILTERS = ['active', 'on_hold', 'do_not_use'] as const;
export type BrokerStatusFilter = (typeof BROKER_STATUS_FILTERS)[number];

/**
 * The brokers page's URL contract.
 *
 * The risk filter reuses the engine's own level list rather than a hand-written copy, so a level
 * can never exist in the data and be un-filterable in the URL. Every field is optional and
 * `.catch(undefined)` so a stale or hand-edited URL degrades to the unfiltered list instead of
 * throwing, matching `dispatch-search.ts`.
 */
export const brokersSearchSchema = z.object({
  risk: z.enum(BROKER_RISK_LEVELS).optional().catch(undefined),
  /** The chip row under the header: a stored status, or the do-not-use flag. */
  status: z.enum(BROKER_STATUS_FILTERS).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  /** Broker id of the row open in the drawer. */
  broker: z.string().optional().catch(undefined),
});

export type BrokersSearch = z.infer<typeof brokersSearchSchema>;
