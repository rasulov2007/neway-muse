import { z } from 'zod';

/**
 * The tracking view's URL contract.
 *
 * Same shape as the dispatch board: a focus narrows the fleet, `unit` opens the selected-truck
 * panel. Keeping selection in the URL is what makes a tracking view shareable — a dispatcher can
 * send "look at unit 2785" as a link rather than a description.
 */

export const TRACKING_FOCUSES = [
  'active',
  'moving',
  'stopped',
  'at_risk',
  'stale',
  'available',
  'delivered_today',
] as const;
export type TrackingFocus = (typeof TRACKING_FOCUSES)[number];

export const trackingSearchSchema = z.object({
  focus: z.enum(TRACKING_FOCUSES).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  /** Unit number of the truck open in the side panel. */
  unit: z.union([z.string(), z.number()]).transform(String).optional().catch(undefined),
});

export type TrackingSearch = z.infer<typeof trackingSearchSchema>;

export const FOCUS_LABEL: Record<TrackingFocus, string> = {
  active: 'Active loads',
  moving: 'Trucks moving',
  stopped: 'Trucks stopped',
  at_risk: 'At risk',
  stale: 'Tracking stale',
  available: 'Available trucks',
  delivered_today: 'Delivered today',
};

export const FOCUS_REASON: Record<TrackingFocus, string> = {
  active: 'Units currently carrying a load',
  moving: 'On a load and reporting road speed on their last fix',
  stopped: 'On a load but reporting no movement',
  at_risk: 'Projected to miss the delivery appointment',
  stale: 'Position too old to verify the ETA',
  available: 'In service, compliant and carrying no load',
  delivered_today: 'Loads delivered on the current operating day',
};
