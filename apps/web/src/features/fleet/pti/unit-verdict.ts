import {
  UNIT_SERVICE_STATUS_LABEL,
  type UnitServiceVerdict,
  type UnitStatusResult,
} from '@neway/shared';
import { AVAILABILITY_LABEL } from '../fleet-ui';

/**
 * The one line the truck header says about the unit (§4.2).
 *
 * Two engines answer two questions: `unitServiceStatus` (the server, from open defects) says
 * whether the truck is fit to run; `unitAvailability` (from status, load and shop) says whether
 * it is free to run. The header used to show both plus the stored status, and the three could
 * disagree - "Available", "In maintenance" and "an open work order has the unit in a shop" on
 * one truck. Here they are folded into one verdict, one reason, one release condition, in a
 * fixed order: a defect outranks the shop, the shop outranks the load, and nothing renders as
 * fit before the server has answered.
 */
export interface HeaderVerdict {
  /** A code from the status system: `cleared`, `watch`, `restricted`, `out_of_service`, `in_shop`, `assigned`, … or `loading`. */
  status: string;
  label: string;
  reason: string | null;
  releaseCondition: string | null;
}

export function headerVerdict(input: {
  /** Undefined until the server has answered. */
  service: UnitServiceVerdict | undefined;
  availability: UnitStatusResult;
}): HeaderVerdict {
  const { service, availability } = input;
  if (!service) {
    return { status: 'loading', label: 'Loading…', reason: null, releaseCondition: null };
  }

  if (service.status !== 'cleared') {
    return {
      status: service.status,
      label: UNIT_SERVICE_STATUS_LABEL[service.status],
      reason: service.reason,
      releaseCondition: service.releaseCondition,
    };
  }

  // No open defect. What the yard sees is what availability says, with its own reason.
  const reason = availability.reasons.join('. ') || null;
  switch (availability.availability) {
    case 'in_maintenance':
      return { status: 'in_shop', label: 'In maintenance', reason, releaseCondition: 'released when the work order is closed' };
    case 'available':
      return { status: 'cleared', label: 'Cleared', reason: 'No open defects and no shop hold', releaseCondition: null };
    case 'assigned':
      // A driver in the truck and no load (2026-10-22) is still free and fit to run: Cleared, as
      // before the list started calling it Assigned. A load on it keeps the Assigned verdict.
      if (availability.dispatchable) {
        return { status: 'cleared', label: 'Cleared', reason: 'No open defects and no shop hold', releaseCondition: null };
      }
      return { status: 'assigned', label: AVAILABILITY_LABEL.assigned, reason, releaseCondition: null };
    default:
      return {
        status: availability.availability,
        label: AVAILABILITY_LABEL[availability.availability],
        reason,
        releaseCondition: null,
      };
  }
}
