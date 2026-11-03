import { z } from 'zod';
import { DEFAULT_HIGH_DEADHEAD_PCT, DEFAULT_TARGET_MARGIN_PCT } from './economics.js';
import type { LoadRiskState } from './risk.js';
import type { TrackingState } from './tracking.js';
import type { DriverAvailability, TruckAvailability } from './availability.js';

/**
 * "What needs attention right now?"
 *
 * The command centre's first screen is this queue, not a wall of charts. Every entry is a count of
 * real records plus the filter that lists exactly those records, so a number on screen can always
 * be opened and worked.
 *
 * Two honesty rules shape the output:
 *  - A check that cannot run because the data does not exist is reported in `unavailable` with the
 *    reason, instead of being silently dropped or filled with a plausible number. HOS is the
 *    obvious case: without an ELD feed there is no honest way to say who is near their limit.
 *  - "Economics unknown" is itself an attention item. A load nobody can price is an operational
 *    problem, not an empty cell.
 */

export const ATTENTION_GROUPS = ['critical', 'high', 'financial', 'fleet'] as const;
export const AttentionGroupSchema = z.enum(ATTENTION_GROUPS);
export type AttentionGroup = z.infer<typeof AttentionGroupSchema>;

export interface AttentionTarget {
  /** Route path, e.g. `/dispatch`. */
  to: string;
  /** Search params that reproduce exactly the records behind the count. */
  search?: Record<string, string>;
}

export interface AttentionItem {
  key: string;
  group: AttentionGroup;
  /** Sentence describing the finding, without the count. */
  label: string;
  count: number;
  /**
   * Ids of the exact records behind the count. The board filters on these rather than re-deriving
   * the predicate, so a count and the list it opens can never disagree.
   */
  ids: string[];
  target: AttentionTarget;
  /** Why this is worth a dispatcher's time. */
  reason: string;
}

export interface UnavailableCheck {
  key: string;
  label: string;
  /** What is missing, in the operator's language. */
  requires: string;
}

export interface AttentionLoad {
  id: string;
  loadNumber: string;
  status: string;
  risk: LoadRiskState;
  tracking: TrackingState;
  /** The next stop, in the four words the board uses: on_time · at_risk · late · no_update. */
  delivery?: 'on_time' | 'at_risk' | 'late' | 'no_update';
  hasDriver: boolean;
  hasTruck: boolean;
  /** Null when the load's economics could not be computed. */
  marginPct: number | null;
  deadheadPct: number | null;
  /** Controlling appointment, used for the "approaching" check. */
  nextAppointmentAt: string | null;
}

export interface AttentionTruck {
  id: string;
  unitNumber: string;
  availability: TruckAvailability;
  /** Hours since this unit last moved; null when unknown. */
  idleHours: number | null;
}

export interface AttentionDriver {
  id: string;
  name: string;
  availability: DriverAvailability;
}

export interface AttentionInput {
  nowIso: string;
  loads: readonly AttentionLoad[];
  trucks: readonly AttentionTruck[];
  drivers: readonly AttentionDriver[];
}

export interface AttentionPolicy {
  targetMarginPct: number;
  highDeadheadPct: number;
  /** An appointment inside this many hours is "approaching". */
  appointmentHorizonHours: number;
  /** A unit sitting longer than this is worth chasing. */
  idleHoursThreshold: number;
}

export const DEFAULT_ATTENTION_POLICY: AttentionPolicy = {
  targetMarginPct: DEFAULT_TARGET_MARGIN_PCT,
  highDeadheadPct: DEFAULT_HIGH_DEADHEAD_PCT,
  appointmentHorizonHours: 4,
  idleHoursThreshold: 24,
};

export interface AttentionQueue {
  items: AttentionItem[];
  /** Checks that could not run, each naming the data or integration it needs. */
  unavailable: UnavailableCheck[];
}

/** Load statuses that are still live work. */
const ACTIVE = new Set([
  'booked',
  'assigned',
  'dispatched',
  'at_pickup',
  'loading',
  'loaded',
  'in_transit',
  'at_delivery',
  'unloading',
]);

function hoursUntil(iso: string | null, nowIso: string): number | null {
  if (!iso) return null;
  const at = Date.parse(iso);
  const now = Date.parse(nowIso);
  if (Number.isNaN(at) || Number.isNaN(now)) return null;
  return (at - now) / 3_600_000;
}

/**
 * Builds the attention queue. Pure, and every count is derived from the rows passed in, so the
 * caller can hand the same filter to a list page and get exactly the records behind the number.
 */
export function buildAttentionQueue(
  input: AttentionInput,
  policy: AttentionPolicy = DEFAULT_ATTENTION_POLICY,
): AttentionQueue {
  const active = input.loads.filter((load) => ACTIVE.has(load.status));
  const items: AttentionItem[] = [];

  const push = (
    key: string,
    group: AttentionGroup,
    label: string,
    ids: string[],
    target: AttentionTarget,
    reason: string,
  ) => {
    if (ids.length > 0) items.push({ key, group, label, count: ids.length, ids, target, reason });
  };

  // ---- Critical -------------------------------------------------------------------------------
  const critical = active.filter((l) => l.risk === 'critical');
  push(
    'loads_critical',
    'critical',
    critical.length === 1 ? 'load will miss its appointment' : 'loads will miss their appointments',
    critical.map((l) => l.id),
    { to: '/dispatch', search: { risk: 'critical' } },
    'The projected arrival is already past the delivery window',
  );

  const atRisk = active.filter((l) => (l.delivery ? l.delivery === 'at_risk' : l.risk === 'at_risk'));
  push(
    'loads_at_risk',
    'critical',
    atRisk.length === 1 ? 'load is at risk' : 'loads are at risk',
    atRisk.map((l) => l.id),
    { to: '/dispatch', search: { risk: 'at_risk' } },
    'Projected to arrive inside the buffer before the appointment',
  );
  // Late by the four-word verdict: the ETA is past the appointment, or the appointment has passed
  // with no arrival recorded. Distinct from "critical", which is the risk engine's own word.
  const late = active.filter((l) => l.delivery === 'late' && !critical.some((c) => c.id === l.id));
  push(
    'loads_late',
    'critical',
    late.length === 1 ? 'load is late' : 'loads are late',
    late.map((l) => l.id),
    { to: '/dispatch', search: { risk: 'late' } },
    'The ETA is past the appointment, or the appointment has passed with no arrival',
  );

  // ---- High -----------------------------------------------------------------------------------
  const unassigned = active.filter((l) => !l.hasDriver || !l.hasTruck);
  push(
    'loads_unassigned',
    'high',
    unassigned.length === 1 ? 'load has no driver or unit' : 'loads have no driver or unit',
    unassigned.map((l) => l.id),
    { to: '/dispatch', search: { assignment: 'unassigned' } },
    'These loads cannot move until someone is assigned',
  );

  // No update: the position is too old to trust, or the truck has no unit. Never counted on time.
  const untracked = active.filter((l) =>
    l.delivery ? l.delivery === 'no_update' : l.tracking === 'stale' || l.tracking === 'offline',
  );
  push(
    'loads_untracked',
    'high',
    untracked.length === 1 ? 'load has lost tracking' : 'loads have lost tracking',
    untracked.map((l) => l.id),
    { to: '/dispatch', search: { tracking: 'lost' } },
    'The position is too old to verify the ETA',
  );

  const approaching = active.filter((l) => {
    const hours = hoursUntil(l.nextAppointmentAt, input.nowIso);
    return hours !== null && hours >= 0 && hours <= policy.appointmentHorizonHours;
  });
  push(
    'appointments_approaching',
    'high',
    approaching.length === 1 ? 'appointment is approaching' : 'appointments are approaching',
    approaching.map((l) => l.id),
    { to: '/dispatch', search: { window: 'approaching' } },
    `Due within ${policy.appointmentHorizonHours} hours`,
  );

  // ---- Financial ------------------------------------------------------------------------------
  const lowMargin = active.filter(
    (l) => l.marginPct !== null && l.marginPct < policy.targetMarginPct,
  );
  push(
    'loads_low_margin',
    'financial',
    lowMargin.length === 1 ? 'load is below target margin' : 'loads are below target margin',
    lowMargin.map((l) => l.id),
    { to: '/dispatch', search: { economics: 'below_target' } },
    `Margin under ${policy.targetMarginPct}% once deadhead is counted`,
  );

  const highDeadhead = active.filter(
    (l) => l.deadheadPct !== null && l.deadheadPct >= policy.highDeadheadPct,
  );
  push(
    'loads_high_deadhead',
    'financial',
    highDeadhead.length === 1 ? 'load carries heavy deadhead' : 'loads carry heavy deadhead',
    highDeadhead.map((l) => l.id),
    { to: '/dispatch', search: { economics: 'high_deadhead' } },
    `At or above ${policy.highDeadheadPct}% of total miles run empty`,
  );

  const unpriced = active.filter((l) => l.marginPct === null);
  push(
    'loads_unpriced',
    'financial',
    unpriced.length === 1 ? 'load cannot be priced' : 'loads cannot be priced',
    unpriced.map((l) => l.id),
    { to: '/dispatch', search: { economics: 'unknown' } },
    'Revenue, miles or costs are missing, so profitability is unknown',
  );

  // ---- Fleet ----------------------------------------------------------------------------------
  const availableTrucks = input.trucks.filter(
    (t) => t.availability === 'available' || t.availability === 'idle',
  );
  push(
    'trucks_available',
    'fleet',
    availableTrucks.length === 1 ? 'unit is available' : 'units are available',
    availableTrucks.map((t) => t.id),
    { to: '/dispatch', search: { fleet: 'available' } },
    'In service, compliant and carrying no load',
  );

  const sitting = input.trucks.filter(
    (t) => t.idleHours !== null && t.idleHours >= policy.idleHoursThreshold,
  );
  push(
    'trucks_sitting',
    'fleet',
    sitting.length === 1 ? 'unit has been sitting' : 'units have been sitting',
    sitting.map((t) => t.id),
    { to: '/dispatch', search: { fleet: 'sitting' } },
    `No movement for over ${policy.idleHoursThreshold} hours`,
  );

  const heldTrucks = input.trucks.filter(
    (t) =>
      t.availability === 'compliance_hold' ||
      t.availability === 'maintenance_overdue' ||
      t.availability === 'in_shop' ||
      t.availability === 'out_of_service',
  );
  push(
    'trucks_unavailable',
    'fleet',
    heldTrucks.length === 1 ? 'unit cannot be dispatched' : 'units cannot be dispatched',
    heldTrucks.map((t) => t.id),
    { to: '/dispatch', search: { fleet: 'held' } },
    'Held by compliance, the shop, or an out-of-service status',
  );

  const availableDrivers = input.drivers.filter((d) => d.availability === 'available');
  push(
    'drivers_available',
    'fleet',
    availableDrivers.length === 1 ? 'driver is available' : 'drivers are available',
    availableDrivers.map((d) => d.id),
    { to: '/dispatch', search: { fleet: 'drivers_available' } },
    'Qualified, on duty and unassigned',
  );

  const heldDrivers = input.drivers.filter(
    (d) => d.availability === 'compliance_hold' || d.availability === 'safety_hold',
  );
  push(
    'drivers_held',
    'fleet',
    heldDrivers.length === 1 ? 'driver is on hold' : 'drivers are on hold',
    heldDrivers.map((d) => d.id),
    { to: '/safety', search: { focus: 'held' } },
    'Blocked by a safety or qualification gate',
  );

  // ---- Checks this deployment cannot run yet --------------------------------------------------
  const unavailable: UnavailableCheck[] = [
    {
      key: 'hos_limits',
      label: 'Drivers approaching hours-of-service limits',
      requires: 'an ELD integration; no duty-clock data reaches the system today',
    },
    {
      key: 'route_deviation',
      label: 'Units running off the planned route',
      requires: 'a routing provider to compare the planned lane against reported positions',
    },
    {
      key: 'weather_traffic',
      label: 'Delays attributable to weather or traffic',
      requires: 'the weather and maps providers described in docs/INTEGRATIONS.md',
    },
  ];

  return { items, unavailable };
}

/** Group ordering for display: worst first. */
export const ATTENTION_GROUP_ORDER: readonly AttentionGroup[] = [
  'critical',
  'high',
  'financial',
  'fleet',
];
