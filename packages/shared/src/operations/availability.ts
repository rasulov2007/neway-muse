import { z } from 'zod';

/**
 * Operational availability for drivers and trucks.
 *
 * "Available / unavailable" is not enough to dispatch 200 trucks: a driver sitting off duty, one
 * on home time, and one behind a compliance hold are all "unavailable" and need three different
 * responses. These states are derived from data that already exists elsewhere in the product —
 * the driver's duty status, the truck's status, the maintenance queue, and the compliance engine's
 * dispatch gates — so Operations never becomes a second opinion about who can run.
 *
 * The compliance gate is authoritative and comes in as an input: safety decides who is held, and
 * this module reports that decision rather than re-deriving it.
 */

export const DRIVER_AVAILABILITY_STATES = [
  'available',
  'assigned',
  'driving',
  'at_pickup',
  'at_delivery',
  'off_duty',
  'home_time',
  'compliance_hold',
  'safety_hold',
  'inactive',
] as const;
export const DriverAvailabilitySchema = z.enum(DRIVER_AVAILABILITY_STATES);
export type DriverAvailability = z.infer<typeof DriverAvailabilitySchema>;

export const TRUCK_AVAILABILITY_STATES = [
  'available',
  'dispatched',
  'driving',
  'idle',
  'in_shop',
  'maintenance_overdue',
  'compliance_hold',
  'out_of_service',
  'retired',
] as const;
export const TruckAvailabilitySchema = z.enum(TRUCK_AVAILABILITY_STATES);
export type TruckAvailability = z.infer<typeof TruckAvailabilitySchema>;

export interface AvailabilityResult<T extends string> {
  state: T;
  /** True only when this resource can take a new load right now. */
  assignable: boolean;
  reasons: string[];
  /** Set when something must happen before this resource can run again. */
  blocker: string | null;
}

export interface DriverAvailabilityInput {
  /** The driver's own duty status, as recorded. */
  status: string;
  /** Status of the load currently assigned to this driver, if any. */
  currentLoadStatus: string | null;
  /** From the compliance engine: false when a qualification gate holds this driver. */
  compliant: boolean;
  /** The gate reasons behind `compliant: false`, quoted verbatim. */
  gateReasons: readonly string[];
}

/**
 * Where a driver stands operationally.
 *
 * Order matters: an expired medical certificate outranks "currently driving", because the answer
 * to "can this driver take the next load" is no regardless of what they are doing right now.
 */
export function driverAvailability(
  input: DriverAvailabilityInput,
): AvailabilityResult<DriverAvailability> {
  const reasons: string[] = [];

  if (input.status === 'terminated' || input.status === 'inactive') {
    return {
      state: 'inactive',
      assignable: false,
      reasons: [`Driver is ${input.status}`],
      blocker: null,
    };
  }

  if (input.status === 'suspended') {
    return {
      state: 'safety_hold',
      assignable: false,
      reasons: ['Driver is suspended'],
      blocker: 'Safety must lift the suspension before this driver can be assigned',
    };
  }

  if (!input.compliant) {
    const gates =
      input.gateReasons.length > 0 ? input.gateReasons : ['a qualification requirement'];
    return {
      state: 'compliance_hold',
      assignable: false,
      reasons: gates.map((gate) => `Held by ${gate}`),
      blocker: `Resolve ${gates.join(', ')} to release this driver`,
    };
  }

  if (input.currentLoadStatus) {
    const load = input.currentLoadStatus;
    reasons.push(`On a load that is ${load.replace(/_/g, ' ')}`);
    if (load === 'at_pickup' || load === 'loading') {
      return { state: 'at_pickup', assignable: false, reasons, blocker: null };
    }
    if (load === 'at_delivery' || load === 'unloading') {
      return { state: 'at_delivery', assignable: false, reasons, blocker: null };
    }
    if (load === 'in_transit' || load === 'loaded' || load === 'dispatched') {
      return { state: 'driving', assignable: false, reasons, blocker: null };
    }
    if (load === 'assigned' || load === 'booked') {
      return { state: 'assigned', assignable: false, reasons, blocker: null };
    }
  }

  if (input.status === 'onboarding') {
    return {
      state: 'compliance_hold',
      assignable: false,
      reasons: ['Driver is onboarding; their qualification file is still open'],
      blocker: 'Finish onboarding and verify the required documents',
    };
  }
  if (input.status === 'off_duty' || input.status === 'sleeper') {
    return {
      state: 'off_duty',
      assignable: false,
      reasons: [`Driver is ${input.status.replace(/_/g, ' ')}`],
      blocker: null,
    };
  }
  if (input.status === 'vacation') {
    return {
      state: 'home_time',
      assignable: false,
      reasons: ['Driver is on home time'],
      blocker: null,
    };
  }

  return {
    state: 'available',
    assignable: true,
    reasons: ['Qualified, unassigned and on duty'],
    blocker: null,
  };
}

export interface TruckAvailabilityInput {
  /** The unit's own status, as recorded. */
  status: string;
  /** Worst maintenance state across this unit's open items, if any. */
  maintenanceStatus: 'ok' | 'due_soon' | 'overdue' | 'scheduled' | 'in_shop' | null;
  /** True while the unit is on a load. */
  onLoad: boolean;
  /** From the compliance engine: false when a vehicle qualification gate holds this unit. */
  compliant: boolean;
  gateReasons: readonly string[];
}

/** Where a unit stands operationally, combining its status, the shop queue and vehicle compliance. */
export function truckAvailability(
  input: TruckAvailabilityInput,
): AvailabilityResult<TruckAvailability> {
  if (input.status === 'sold') {
    return { state: 'retired', assignable: false, reasons: ['Unit has been sold'], blocker: null };
  }
  if (input.status === 'archived') {
    return { state: 'retired', assignable: false, reasons: ['Unit has been archived'], blocker: null };
  }
  if (input.status === 'out_of_service' || input.status === 'accident') {
    return {
      state: 'out_of_service',
      assignable: false,
      reasons: [`Unit is ${input.status.replace(/_/g, ' ')}`],
      blocker: 'Return the unit to service before assigning it',
    };
  }

  if (!input.compliant) {
    const gates = input.gateReasons.length > 0 ? input.gateReasons : ['a vehicle requirement'];
    return {
      state: 'compliance_hold',
      assignable: false,
      reasons: gates.map((gate) => `Held by ${gate}`),
      blocker: `Resolve ${gates.join(', ')} to release this unit`,
    };
  }

  if (input.status === 'in_shop' || input.maintenanceStatus === 'in_shop') {
    return {
      state: 'in_shop',
      assignable: false,
      reasons: ['Unit is in the shop'],
      blocker: 'Close the repair order to return this unit to service',
    };
  }

  if (input.maintenanceStatus === 'overdue') {
    return {
      state: 'maintenance_overdue',
      assignable: false,
      reasons: ['A required service on this unit is past due'],
      blocker: 'Book the overdue service before dispatching this unit',
    };
  }

  if (input.onLoad) {
    return {
      state: input.status === 'driving' ? 'driving' : 'dispatched',
      assignable: false,
      reasons: ['Unit is on a load'],
      blocker: null,
    };
  }

  if (input.status === 'idle') {
    return {
      state: 'idle',
      assignable: true,
      reasons: ['Unit is sitting with no load assigned'],
      blocker: null,
    };
  }

  const reasons = ['Unit is in service with no load assigned'];
  if (input.maintenanceStatus === 'due_soon') {
    reasons.push('A service is due soon; long dispatches should account for it');
  }
  if (input.maintenanceStatus === 'scheduled') {
    reasons.push('A service is already booked for this unit');
  }
  return { state: 'available', assignable: true, reasons, blocker: null };
}
