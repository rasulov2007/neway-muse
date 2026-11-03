import type { AttentionItem, AttentionQueue } from '@neway/shared';
import { z } from 'zod';

/**
 * The dispatch board's URL contract.
 *
 * These keys are the same ones `buildAttentionQueue` puts in its targets, which is what makes an
 * attention count clickable: the number and the filtered list are produced from one vocabulary, so
 * "7 loads have no driver or unit" always opens exactly those seven.
 *
 * Every field is optional and `.catch(undefined)` so a hand-edited or stale URL degrades to the
 * unfiltered board instead of throwing.
 */

export const RISK_FILTERS = ['critical', 'at_risk', 'watch', 'insufficient_data'] as const;
export const ECONOMICS_FILTERS = ['below_target', 'high_deadhead', 'unknown'] as const;
export const FLEET_FILTERS = ['available', 'sitting', 'held', 'drivers_available'] as const;

export const dispatchSearchSchema = z.object({
  risk: z.enum(RISK_FILTERS).optional().catch(undefined),
  assignment: z.enum(['unassigned']).optional().catch(undefined),
  tracking: z.enum(['lost']).optional().catch(undefined),
  window: z.enum(['approaching']).optional().catch(undefined),
  economics: z.enum(ECONOMICS_FILTERS).optional().catch(undefined),
  fleet: z.enum(FLEET_FILTERS).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  /** Load number of the row open in the intelligence panel. */
  load: z.string().optional().catch(undefined),
});

export type DispatchSearch = z.infer<typeof dispatchSearchSchema>;

/** The filter keys, so "clear" and "is anything active" never drift from the schema. */
export const DISPATCH_FILTER_KEYS = [
  'risk',
  'assignment',
  'tracking',
  'window',
  'economics',
  'fleet',
] as const;

export type DispatchFilterKey = (typeof DISPATCH_FILTER_KEYS)[number];

export function hasActiveFilter(search: DispatchSearch): boolean {
  return DISPATCH_FILTER_KEYS.some((key) => search[key] !== undefined) || Boolean(search.q);
}

/** True when the active filter selects fleet rows rather than loads. */
export function isFleetView(search: DispatchSearch): boolean {
  return search.fleet !== undefined;
}

const FILTER_LABELS: Record<string, string> = {
  'risk:critical': 'Will miss appointment',
  'risk:at_risk': 'At risk',
  'risk:watch': 'Watch',
  'risk:insufficient_data': 'Cannot be assessed',
  'assignment:unassigned': 'No driver or unit',
  'tracking:lost': 'Tracking lost',
  'window:approaching': 'Appointment approaching',
  'economics:below_target': 'Below target margin',
  'economics:high_deadhead': 'Heavy deadhead',
  'economics:unknown': 'Economics unknown',
  'fleet:available': 'Units available',
  'fleet:sitting': 'Units sitting',
  'fleet:held': 'Units held',
  'fleet:drivers_available': 'Drivers available',
};

/** Human label for whichever filter is active, for the board heading and the clear chip. */
export function describeFilter(search: DispatchSearch): string | null {
  for (const key of DISPATCH_FILTER_KEYS) {
    const value = search[key];
    if (value) return FILTER_LABELS[`${key}:${value}`] ?? `${key}: ${value}`;
  }
  return null;
}

/**
 * The attention item whose filter is currently applied, if any.
 *
 * Lives here rather than in the page because the board needs it too: it is what lets a count and
 * the list it opens be produced from the same ids.
 */
export function activeAttentionItem(
  attention: AttentionQueue,
  search: DispatchSearch,
): AttentionItem | null {
  for (const key of DISPATCH_FILTER_KEYS) {
    const value = search[key];
    if (!value) continue;
    const match = attention.items.find((item) => item.target.search?.[key] === value);
    if (match) return match;
  }
  return null;
}
