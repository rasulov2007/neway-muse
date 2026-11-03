/**
 * What in the fleet is actually wrong right now.
 *
 * The same discipline as the dispatch attention queue: every finding carries the ids of the exact
 * records behind its count, so the panel and the list it opens can never disagree, and a finding
 * with a count of zero is simply not produced. An empty queue means the fleet is clean — the panel
 * is meant to disappear, not to display reassuring nothings.
 *
 * A check that cannot run says so in `unavailable` with what it needs. Nothing is inferred from
 * absent data.
 */

import { isLateWorkOrder, isActiveUnit, pmPosition } from './counts.js';
import { DEFAULT_MAINTENANCE_POLICY, type MaintenancePolicy } from './maintenance.js';
import { unitAvailability } from './unit-status.js';

export type FleetExceptionGroup = 'maintenance' | 'utilisation' | 'cost' | 'compliance';
export type FleetExceptionSeverity = 'critical' | 'warning' | 'info';

export interface FleetExceptionTarget {
  to: string;
  search?: Record<string, string>;
}

export interface FleetException {
  key: string;
  group: FleetExceptionGroup;
  severity: FleetExceptionSeverity;
  /** The finding without its count, e.g. "trucks are overdue for maintenance". */
  label: string;
  count: number;
  /** Ids of the exact records behind the count. */
  ids: string[];
  target: FleetExceptionTarget;
  /** Why this costs the carrier something. */
  reason: string;
}

export interface FleetUnavailableCheck {
  key: string;
  label: string;
  requires: string;
}

export interface ExceptionTruck {
  id: string;
  unitNumber: string;
  status: string;
  currentLoadId: string | null;
  odometer: number | null;
  nextServiceOdometer: number | null;
  nextServiceDate: string | null;
  /** The date this unit is already booked into a shop, when it is. Omitting it used to make the
   * panel count trucks as due soon that the Trucks list showed as booked. */
  scheduledFor?: string | null;
  speedMph?: number | null;
  inOpenWorkOrder?: boolean;
  telematicsStatus?: string | null;
}

export interface ExceptionTrailer {
  id: string;
  unitNumber: string;
  status: string;
  currentTruckId: string | null;
  nextInspectionDate: string | null;
}

export interface ExceptionWorkOrder {
  id: string;
  roNumber: string;
  status: string;
  promisedAt: string | null;
  completedAt: string | null;
}

export interface FleetExceptionInput {
  trucks: ExceptionTruck[];
  trailers: ExceptionTrailer[];
  workOrders: ExceptionWorkOrder[];
  /** Fleet cost per mile for the current window, when it could be measured. */
  costPerMile?: number | null;
  /** The same figure for the prior window, so the change is a fact rather than a feeling. */
  priorCostPerMile?: number | null;
  /**
   * Units whose current document of some type has expired, or expires soon. "Soon" is the shared
   * expiry bands (`expiryTone` in compliance/expiry-tone.ts): within one calendar month is the
   * red band, within two the yellow, within three the blue. Each unit is listed once, in its
   * loudest band. Derived by the caller from the document store; absent when documents were not
   * loaded.
   */
  unitDocuments?: {
    expiredUnitIds: string[];
    /** A document expires within one calendar month (today included). */
    expiringUnitIds: string[];
    /** The soonest document expires in the second calendar month. */
    expiringSoonUnitIds?: string[];
    /** The soonest document expires in the third calendar month. */
    expiringLaterUnitIds?: string[];
    /**
     * Active units whose annual inspection has lapsed.
     *
     * Kept apart from the other expired paperwork because it is not the same kind of problem. An
     * expired lease agreement is an administrative matter; a unit past its annual inspection must
     * not be driven at all (49 CFR 396.17), and it needs a decision today rather than a renewal
     * next week.
     */
    inspectionLapsedUnitIds?: string[];
  };
}

export interface FleetExceptionQueue {
  items: FleetException[];
  unavailable: FleetUnavailableCheck[];
}

export interface FleetExceptionPolicy extends MaintenancePolicy {
  /** Percentage rise in cost per mile worth raising. */
  costPerMileJumpPct: number;
}

export const DEFAULT_FLEET_EXCEPTION_POLICY: FleetExceptionPolicy = {
  ...DEFAULT_MAINTENANCE_POLICY,
  costPerMileJumpPct: 5,
};


const SEVERITY_RANK: Record<FleetExceptionSeverity, number> = { critical: 0, warning: 1, info: 2 };

export function buildFleetExceptions(
  input: FleetExceptionInput,
  today: string,
  policy: FleetExceptionPolicy = DEFAULT_FLEET_EXCEPTION_POLICY,
): FleetExceptionQueue {
  const items: FleetException[] = [];
  const unavailable: FleetUnavailableCheck[] = [];

  const push = (item: Omit<FleetException, 'count'>) => {
    if (item.ids.length === 0) return;
    items.push({ ...item, count: item.ids.length });
  };

  // --- Maintenance -----------------------------------------------------------------------------
  const overdue: string[] = [];
  const dueSoon: string[] = [];
  for (const truck of input.trucks) {
    // A sold or retired unit cannot be overdue for a service it will never have.
    if (!isActiveUnit(truck.status)) continue;
    const due = pmPosition(truck, today, policy);
    if (due.urgency === 'overdue') overdue.push(truck.id);
    else if (due.urgency === 'due_soon') dueSoon.push(truck.id);
  }

  push({
    key: 'maintenance_overdue',
    group: 'maintenance',
    severity: 'critical',
    label: 'trucks are overdue for maintenance',
    ids: overdue,
    target: { to: '/fleet/trucks', search: { maintenance: 'overdue' } },
    reason:
      'A unit past its service limit is running on borrowed time and fails a roadside inspection on the spot.',
  });

  push({
    key: 'maintenance_due_soon',
    group: 'maintenance',
    severity: 'warning',
    label: 'trucks are due for service soon',
    ids: dueSoon,
    target: { to: '/fleet/trucks', search: { maintenance: 'due_soon' } },
    reason: 'Booking the shop now is cheaper than a roadside repair later.',
  });

  const lateWorkOrders = input.workOrders
    .filter((wo) => isLateWorkOrder(wo, today))
    .map((wo) => wo.id);

  push({
    key: 'work_orders_past_promise',
    group: 'maintenance',
    severity: 'warning',
    label: 'work orders are past their promised date',
    ids: lateWorkOrders,
    target: { to: '/fleet/maintenance', search: { view: 'overdue' } },
    reason: 'Every extra day in a shop is a day the unit earns nothing.',
  });

  // --- Utilisation -----------------------------------------------------------------------------
  const idleTrucks = input.trucks
    .filter(
      (truck) =>
        unitAvailability({
          status: truck.status,
          currentLoadId: truck.currentLoadId,
          speedMph: truck.speedMph,
          inOpenWorkOrder: truck.inOpenWorkOrder,
        }).availability === 'available',
    )
    .map((truck) => truck.id);

  push({
    key: 'trucks_unassigned',
    group: 'utilisation',
    severity: 'warning',
    label: 'trucks have no current assignment',
    ids: idleTrucks,
    // No availability filter: a truck with a driver and no load reads Assigned on the list (owner,
    // 2026-10-22) but is still a truck with no freight, so the finding opens by its ids alone.
    target: { to: '/fleet/trucks' },
    reason: 'A dispatchable truck with no freight on it is fixed cost with no revenue against it.',
  });

  const idleTrailers = input.trailers
    .filter((trailer) => trailer.status === 'available' && !trailer.currentTruckId)
    .map((trailer) => trailer.id);

  push({
    key: 'trailers_unassigned',
    group: 'utilisation',
    severity: 'info',
    label: 'trailers are sitting unassigned',
    ids: idleTrailers,
    target: { to: '/fleet/trailers', search: { status: 'available' } },
    reason: 'Trailer pools drift; unassigned equipment in the wrong yard slows the next dispatch.',
  });

  const outOfService = input.trucks.filter((t) => t.status === 'out_of_service').map((t) => t.id);
  push({
    key: 'trucks_out_of_service',
    group: 'utilisation',
    severity: 'critical',
    label: 'trucks are out of service',
    ids: outOfService,
    target: { to: '/fleet/trucks', search: { availability: 'out_of_service' } },
    reason:
      'Out-of-service units still carry payments, insurance and plates while earning nothing.',
  });

  // --- Telematics ------------------------------------------------------------------------------
  const disconnected = input.trucks
    .filter((t) => t.telematicsStatus === 'disconnected' || t.telematicsStatus === 'error')
    .map((t) => t.id);

  push({
    key: 'telematics_down',
    group: 'compliance',
    severity: 'warning',
    label: 'trucks are not reporting telematics',
    ids: disconnected,
    target: { to: '/fleet/trucks', search: { telematics: 'down' } },
    reason:
      'Without a feed the unit has no position, no odometer and no MPG, so every check below it goes blind.',
  });

  // --- Documents -------------------------------------------------------------------------------
  if (input.unitDocuments) {
    const lapsed = new Set(input.unitDocuments.inspectionLapsedUnitIds ?? []);
    push({
      key: 'annual_inspection_lapsed',
      group: 'compliance',
      severity: 'critical',
      label: 'units are past their annual inspection and must not be driven',
      ids: [...lapsed],
      target: { to: '/fleet/trucks', search: { documents: 'expired' } },
      reason:
        'Under 49 CFR 396.17 a unit without a current annual inspection may not be operated. This one needs a decision today: inspect it, or take it off the road.',
    });
    push({
      key: 'documents_expired',
      group: 'compliance',
      severity: 'critical',
      label: 'units have an expired registration, inspection or other document',
      ids: input.unitDocuments.expiredUnitIds.filter((id) => !lapsed.has(id)),
      target: { to: '/fleet/trucks', search: { documents: 'expired' } },
      reason:
        'A unit on the road with expired paperwork is a roadside out-of-service order and a fine waiting to happen.',
    });
    // Severity follows the expiry band's colour: within a month is red, then yellow, then blue.
    push({
      key: 'documents_expiring',
      group: 'compliance',
      severity: 'critical',
      label: 'units have a document expiring within a month',
      ids: input.unitDocuments.expiringUnitIds,
      target: { to: '/fleet/trucks', search: { documents: 'expiring' } },
      reason: 'Renewals take days; a reminder now is cheaper than a unit parked later.',
    });
    push({
      key: 'documents_expiring_soon',
      group: 'compliance',
      severity: 'warning',
      label: 'units have a document expiring within two months',
      ids: input.unitDocuments.expiringSoonUnitIds ?? [],
      target: { to: '/fleet/trucks', search: { documents: 'expiring' } },
      reason: 'Book the renewal or the inspection now, while there is a choice of date.',
    });
    push({
      key: 'documents_expiring_later',
      group: 'compliance',
      severity: 'info',
      label: 'units have a document expiring within three months',
      ids: input.unitDocuments.expiringLaterUnitIds ?? [],
      target: { to: '/fleet/trucks', search: { documents: 'expiring' } },
      reason: 'Nothing to do yet beyond putting the renewal on the calendar.',
    });
  } else {
    unavailable.push({
      key: 'unit_documents',
      label: 'Expired or expiring unit documents',
      requires: 'Documents attached to each unit with their expiry dates',
    });
  }

  // --- Cost ------------------------------------------------------------------------------------
  // Reported only when both windows were measurable; a missing prior window is not a 0% change.
  if (
    typeof input.costPerMile === 'number' &&
    typeof input.priorCostPerMile === 'number' &&
    input.priorCostPerMile > 0
  ) {
    const changePct = ((input.costPerMile - input.priorCostPerMile) / input.priorCostPerMile) * 100;
    if (changePct >= policy.costPerMileJumpPct) {
      items.push({
        key: 'fuel_cost_per_mile_up',
        group: 'cost',
        severity: 'warning',
        label: `fuel cost per mile is up ${changePct.toFixed(0)}% on the previous period`,
        count: 1,
        ids: [],
        target: { to: '/fleet/fuel' },
        reason: `Now ${input.costPerMile.toFixed(3)} per mile against ${input.priorCostPerMile.toFixed(3)}. On a fleet this size the difference compounds every week it is left alone.`,
      });
    }
  } else {
    unavailable.push({
      key: 'fuel_cost_trend',
      label: 'Fuel cost per mile trend',
      requires: 'Fills with odometer readings in both the current and the previous period',
    });
  }

  unavailable.push({
    key: 'tire_and_brake_wear',
    label: 'Tire and brake wear',
    requires: 'Inspection measurements recorded against each unit',
  });
  unavailable.push({
    key: 'warranty_expiry',
    label: 'Units approaching warranty expiry',
    requires: 'Warranty terms captured on the truck record',
  });

  items.sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity] || b.count - a.count);

  return { items, unavailable };
}
