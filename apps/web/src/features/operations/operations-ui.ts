import type {
  AttentionGroup,
  BrokerRiskLevel,
  DriverAvailability,
  LoadRiskState,
  TrackingState,
  TruckAvailability,
} from '@neway/shared';
import type { BadgeTone } from '@/design-system';

/**
 * Presentation for the operations vocabulary.
 *
 * Only enums the design system's status registry does not already own live here — load and truck
 * *statuses* keep going through `StatusBadge`, so this file never becomes a second opinion about
 * what "in transit" looks like.
 */

export const RISK_LABEL: Record<LoadRiskState, string> = {
  on_track: 'On track',
  watch: 'Watch',
  at_risk: 'At risk',
  critical: 'Critical',
  insufficient_data: 'Insufficient data',
  not_applicable: 'Not tracked',
};

export const RISK_TONE: Record<LoadRiskState, BadgeTone> = {
  on_track: 'success',
  watch: 'warning',
  at_risk: 'danger',
  critical: 'danger',
  insufficient_data: 'neutral',
  not_applicable: 'neutral',
};

/** Worst first, for sorting a board by what needs attention. */
export const RISK_ORDER: readonly LoadRiskState[] = [
  'critical',
  'at_risk',
  'watch',
  'insufficient_data',
  'on_track',
  'not_applicable',
];

export function riskRank(state: LoadRiskState): number {
  const index = RISK_ORDER.indexOf(state);
  return index === -1 ? RISK_ORDER.length : index;
}

export const TRACKING_LABEL: Record<TrackingState, string> = {
  live: 'Live',
  recent: 'Recent',
  stale: 'Stale',
  offline: 'Offline',
  none: 'No tracking',
};

export const TRACKING_TONE: Record<TrackingState, BadgeTone> = {
  live: 'success',
  recent: 'info',
  stale: 'warning',
  offline: 'danger',
  none: 'neutral',
};

export const DRIVER_AVAILABILITY_LABEL: Record<DriverAvailability, string> = {
  available: 'Available',
  assigned: 'Assigned',
  driving: 'Driving',
  at_pickup: 'At pickup',
  at_delivery: 'At delivery',
  // The fleet calls this Home: a driver who is off duty is at the house, and "off duty" is HOS
  // vocabulary rather than something a dispatcher says. `home_time` stays distinct - it is
  // scheduled, agreed time off rather than simply not being on a load.
  off_duty: 'Home',
  home_time: 'Home time (scheduled)',
  compliance_hold: 'Compliance hold',
  safety_hold: 'Safety hold',
  inactive: 'Inactive',
};

export const DRIVER_AVAILABILITY_TONE: Record<DriverAvailability, BadgeTone> = {
  available: 'success',
  assigned: 'info',
  driving: 'info',
  at_pickup: 'info',
  at_delivery: 'info',
  off_duty: 'neutral',
  home_time: 'neutral',
  compliance_hold: 'danger',
  safety_hold: 'danger',
  inactive: 'neutral',
};

export const TRUCK_AVAILABILITY_LABEL: Record<TruckAvailability, string> = {
  available: 'Available',
  dispatched: 'Dispatched',
  driving: 'Driving',
  idle: 'Idle',
  in_shop: 'In shop',
  maintenance_overdue: 'Service overdue',
  compliance_hold: 'Compliance hold',
  out_of_service: 'Out of service',
  retired: 'Retired',
};

export const TRUCK_AVAILABILITY_TONE: Record<TruckAvailability, BadgeTone> = {
  available: 'success',
  dispatched: 'info',
  driving: 'info',
  idle: 'warning',
  in_shop: 'warning',
  maintenance_overdue: 'danger',
  compliance_hold: 'danger',
  out_of_service: 'danger',
  retired: 'neutral',
};

export const ATTENTION_GROUP_LABEL: Record<AttentionGroup, string> = {
  critical: 'Critical',
  high: 'High',
  financial: 'Financial',
  fleet: 'Fleet',
};

export const ATTENTION_GROUP_TONE: Record<AttentionGroup, BadgeTone> = {
  critical: 'danger',
  high: 'warning',
  financial: 'violet',
  fleet: 'info',
};

export const BROKER_RISK_LABEL: Record<BrokerRiskLevel, string> = {
  low: 'Low',
  medium: 'Medium',
  high: 'High',
  insufficient_data: 'Not enough data',
};

export const BROKER_RISK_TONE: Record<BrokerRiskLevel, BadgeTone> = {
  low: 'success',
  medium: 'warning',
  high: 'danger',
  insufficient_data: 'neutral',
};

/**
 * Worst first, so a broker list sorts by what needs a decision. `insufficient_data` sits above
 * `low` because an ungraded broker is an open question, not a clean bill of health.
 */
export const BROKER_RISK_ORDER: readonly BrokerRiskLevel[] = [
  'high',
  'medium',
  'insufficient_data',
  'low',
];

/** `—` for a value the system genuinely does not have, never `0`. */
export const DASH = '—';

/** How a driver is engaged. Lives here with the rest of the operations vocabulary so the panel
 * module can export components and nothing else. */
export const DRIVER_TYPE_LABEL: Record<string, string> = {
  company: 'Company driver',
  owner_operator: 'Owner operator',
  lease_operator: 'Lease operator',
};
