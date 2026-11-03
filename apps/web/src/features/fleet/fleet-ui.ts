import {
  MAINTENANCE_DEFAULTS,
  type DueStatus,
  type MaintenanceUrgency,
  type ShopStage,
  type UnitAvailability,
  type WorkOrderAction,
} from '@neway/shared';
import type { DownHold } from '@/demo/down-periods';
import type { BadgeTone } from '@/design-system';

/**
 * Presentation for the fleet vocabulary.
 *
 * Only the enums the design system's status registry does not already own live here. A truck's
 * stored *status* still goes through `StatusBadge`, so this file never becomes a second opinion
 * about what "in shop" looks like — it covers the two derived vocabularies (availability and
 * service urgency) that exist only as engine output.
 */

export const AVAILABILITY_LABEL: Record<UnitAvailability, string> = {
  available: 'Available',
  assigned: 'Assigned',
  in_transit: 'In transit',
  in_maintenance: 'In maintenance',
  out_of_service: 'Out of service',
  inactive: 'Inactive',
  retired: 'Retired',
  unknown: 'Unknown',
};

export const AVAILABILITY_TONE: Record<UnitAvailability, BadgeTone> = {
  available: 'success',
  assigned: 'info',
  in_transit: 'info',
  in_maintenance: 'warning',
  out_of_service: 'danger',
  inactive: 'neutral',
  retired: 'neutral',
  unknown: 'neutral',
};

/** The order the summary strip presents, and the order a board sorts by. */
export const AVAILABILITY_ORDER: readonly UnitAvailability[] = [
  'available',
  'assigned',
  'in_transit',
  'in_maintenance',
  'out_of_service',
  'inactive',
  'unknown',
  'retired',
];

export const MAINTENANCE_LABEL: Record<MaintenanceUrgency, string> = {
  ok: 'On schedule',
  due_soon: 'Due soon',
  overdue: 'Overdue',
  scheduled: 'Scheduled',
  unknown: 'No interval',
};

export const MAINTENANCE_TONE: Record<MaintenanceUrgency, BadgeTone> = {
  ok: 'success',
  due_soon: 'warning',
  overdue: 'danger',
  scheduled: 'info',
  unknown: 'neutral',
};

/** Placeholder for a figure that has no value, so every table agrees on what "nothing" looks like. */
export const DASH = '—';

/**
 * What a trailer's stored status is called on screen.
 *
 * A truck at the end of its life is sold; a trailer is almost always handed back to the lessor,
 * so the same stored status reads as *Returned* on a trailer. Only the word changes - the status
 * itself, and everything that keys on it, is untouched.
 */
export function trailerStatusLabel(status: string): string | undefined {
  // A trailer in the shop reads "In maintenance", as a truck does (owner, 2026-10-14).
  if (status === 'in_shop') return 'In maintenance';
  return status === 'sold' ? 'Returned' : status === 'inactive' ? 'Inactive' : undefined;
}

/**
 * The unit page's sections, in the order they are shown.
 *
 * Here rather than on the page itself because the route validates `?tab=` against it: a section
 * chosen on screen has to survive being linked to, and coming back from an accident has to land
 * on the tab it was opened from.
 */
export const TRUCK_TABS = [
  'overview',
  'driver',
  'load',
  'tracking',
  'maintenance',
  // Beside Maintenance; it replaced the truck's own Costs tab (owner, 2026-10-12).
  'expenses',
  'history',
  'documents',
  'performance',
  'notes',
  'activity',
] as const;
export type TruckTab = (typeof TRUCK_TABS)[number];

// ---------------------------------------------------------------------- the shop's vocabulary

/** Overdue is red, due soon amber, and "we never wrote it down" is neutral rather than alarming. */
export const DUE_TONE: Record<DueStatus, BadgeTone> = {
  overdue: 'danger',
  due_soon: 'warning',
  ok: 'success',
  unknown: 'neutral',
};

/**
 * A shop stage is blue while the unit is being worked on and green once it can be collected.
 *
 * Ready for pickup is the only stage that means somebody outside the shop has something to do, so
 * it is the only one that changes colour.
 */
export function shopStageTone(stage: ShopStage): BadgeTone {
  return stage === 'ready_for_pickup' ? 'success' : 'info';
}

/** What a history entry reads as when it carries no note of its own. */
export function workOrderActionWord(action: WorkOrderAction['action']): string {
  if (action === 'created') return 'Opened';
  if (action === 'stage_changed') return 'Stage changed';
  if (action === 'completed') return 'Completed';
  if (action === 'reopened') return 'Reopened';
  if (action === 'voided') return 'Voided';
  return 'Note added';
}

/** The marker family for a history entry: a reopened record is a warning, a closed one is done. */
export const WORK_ORDER_ACTION_TONE: Record<WorkOrderAction['action'], BadgeTone> = {
  created: 'neutral',
  stage_changed: 'info',
  note_added: 'neutral',
  completed: 'success',
  reopened: 'warning',
  voided: 'danger',
};

/**
 * What is holding a down unit, in the shop board's colours.
 *
 * `ready_for_pickup` is the one hold that means somebody outside the shop has something to do, so
 * it is the one that turns green; the rest are work in progress and read blue. Deliberately the
 * same rule as `shopStageTone` above: the two screens keep separate vocabularies - a down period
 * is not a work order - but the same word must not be a different colour on two pages.
 */
export const DOWN_HOLD_TONE: Record<DownHold, BadgeTone> = {
  diagnosing: 'info',
  waiting_our_ok: 'info',
  waiting_parts: 'info',
  in_repair: 'info',
  ready_for_pickup: 'success',
};

/**
 * Neutral, amber past three days, red past seven - the company's own downtime thresholds.
 *
 * Read from the maintenance defaults rather than written again, so a carrier that decides a week
 * is acceptable changes it in one place and every screen agrees.
 */
export function downtimeTone(days: number): BadgeTone {
  if (days > MAINTENANCE_DEFAULTS.downtimeRedDays) return 'danger';
  if (days > MAINTENANCE_DEFAULTS.downtimeAmberDays) return 'warning';
  return 'neutral';
}
