/**
 * Fleet writes.
 *
 * Everything the Fleet workspace changes goes through here, so that a button in the UI and the
 * record it claims to change can never diverge. Each write appends an audit row for the same
 * reason the compliance module does: a status change nobody can trace is a status change nobody
 * can defend in an audit.
 *
 * These live beside `api.ts` rather than inside it only because that file is already long; they
 * are re-exported from the same barrel and behave identically (latency, `simulate`, cloning).
 */
import { demoData, isActiveStatus } from './data';
import type {
  FuelTransaction,
  IsoDate,
  MaintenanceItem,
  MaintenanceType,
  NoInvoiceReason,
  RepairOrder,
  RepairOrderStatus,
  Trailer,
  TrailerType,
  Truck,
  WorkOrderInvoice,
} from './types';
import {
  appendFleetAudit,
  cloneValue,
  fleetRespond,
  nowIsoString,
  type SimulateOptions,
} from './internals';
import { FIRST_SERVICE_INTERVAL_MILES } from '@neway/shared';
import { createTrailerRecord, createTruckRecord, updateTrailerRecord } from './roster-api';
import { resolutionRating } from './pti-condition';
import { saveSoon } from './state-persist';
import { proposeDefectVerification } from './pti-defect-link';
import { refreshBillingCharge } from './work-order-billing';
import { markCreated } from '@/lib/recent-creates';

/**
 * The unit follows its work order into and out of the shop, so the fleet list, the dispatch
 * board and the shop never disagree about where it is.
 *
 * A truck in a shop is out of dispatch. A trailer in a shop is marked unavailable and comes off
 * whatever truck was pulling it — the truck itself stays dispatchable, because a box in the shop
 * does not stop the tractor from taking another one.
 */
function followWorkOrder(order: RepairOrder, status: RepairOrderStatus): void {
  const leaving = status === 'completed' || status === 'cancelled';
  if (order.unitType === 'trailer') {
    const trailer = demoData.trailers.find((t) => t.id === order.trailerId);
    if (!trailer) return;
    if (status === 'in_shop' && trailer.status !== 'out_of_service') {
      trailer.status = 'in_shop';
      if (trailer.currentTruckId) {
        const truck = demoData.trucks.find((t) => t.id === trailer.currentTruckId);
        if (truck && truck.currentTrailerId === trailer.id) truck.currentTrailerId = null;
        trailer.currentTruckId = null;
        trailer.currentTruckUnit = null;
      }
    } else if (leaving && trailer.status === 'in_shop') {
      trailer.status = 'available';
    }
    return;
  }
  const truck = demoData.trucks.find((t) => t.id === order.truckId);
  if (!truck) return;
  if (status === 'in_shop' && truck.status !== 'out_of_service') {
    truck.status = 'in_shop';
  } else if (leaving && truck.status === 'in_shop') {
    truck.status = 'available';
  }
}

/**
 * A finished work order closes the condition loop.
 *
 * A component rated Replace now (or Replace soon past its window) opened this order; the shop has
 * done the work, so the component goes back to Good with a note of what was done — a fresh rating
 * appended to the history, the same way issue → work order → action already closes on the board.
 */
function closeConditionLoop(order: RepairOrder): void {
  // A defect this order was opened for is proposed for verification on the server; nothing here
  // verifies it (§4.4). The order is saved whatever the server answers; a refusal is logged.
  if (order.defectId) void proposeDefectVerification(order.id);
  const at = nowIsoString();
  const today = at.slice(0, 10);
  const monday = new Date(`${today}T00:00:00Z`);
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const weekStart = monday.toISOString().slice(0, 10);
  const open = demoData.ptiRatings.filter(
    (r) =>
      r.workOrderId === order.id && (r.rating === 'replace_now' || r.rating === 'replace_soon'),
  );
  for (const rating of open) {
    const resolved = demoData.ptiRatings.some(
      (r) =>
        r.workOrderId === order.id && r.rating === 'good' && r.componentId === rating.componentId,
    );
    if (resolved) continue;
    demoData.ptiRatings.push(
      resolutionRating(rating, {
        at,
        weekStart,
        note: `${order.roNumber} completed: ${order.summary}`,
        by: { id: null, name: order.technician || null },
      }),
    );
  }
}

/**
 * A fleet write, saved promptly.
 *
 * The expense summary is aggregated on the server from the saved workspace, so a work order
 * completed here must reach `app_state` before the page refetches — not at the next tick of the
 * twenty-second loop. Every write in this module goes through this; reads do not.
 */
function fleetWrite<T>(
  options: SimulateOptions | undefined,
  produce: () => T,
  empty: () => T,
): Promise<T> {
  return fleetRespond(
    options,
    () => {
      const result = produce();
      saveSoon();
      return result;
    },
    empty,
  );
}

// ---------------------------------------------------------------------------------------------
// Trucks
// ---------------------------------------------------------------------------------------------

export interface CreateTruckInput {
  unitNumber: string;
  vin: string;
  year: number;
  make: string;
  model: string;
  /** Everything below the identity is optional: a unit exists before every detail about it does. */
  plate?: string;
  plateState?: string;
  color?: string;
  /** Absent: company owned. */
  ownership?: Truck['ownership'];
  odometer: number;
  /** Absent: 0. */
  engineHours?: number;
  /** Absent: the unit is measured from the day it was added. */
  inServiceDate?: IsoDate;
  homeTerminal?: string;
  /** Where the unit starts. A unit with a driver on it cannot start out of service. */
  status: Extract<Truck['status'], 'available' | 'idle' | 'out_of_service'>;
  /** Driver to put on the unit straight away, when one is being moved onto it. */
  driverId: string | null;
  /** Miles from today's odometer at which the first service falls due. Absent: the standard interval. */
  serviceIntervalMiles?: number;
  nextServiceType?: MaintenanceType;
  /** Absent: the server books it from the in-service date, or from the day the unit was added. */
  nextServiceDate?: IsoDate;
  /** A vendor truck (owner, 2026-10-28): whose it is and what the company keeps of its gross. */
  vendor?: { vendorId?: string | null; vendorName?: string | null; companyPercent: number };
}

function getTruckStatusLabel(status: string): string {
  return status.replace(/_/g, ' ');
}

/**
 * Adds a truck to the fleet.
 *
 * The record is written to the database and the server's row is what comes back — including the id
 * it assigned. Nothing here invents an id and hopes the server agrees later: a client-generated id
 * that the server replaces is the shortest route to a record the UI shows and the database has
 * never heard of.
 *
 * Duplicate unit numbers and VINs, and the rule that a unit in a shop cannot start with a driver on
 * it, are enforced by the server. They are checked once, where the data is, rather than twice in
 * two places that can disagree.
 */
export async function createTruck(
  input: CreateTruckInput,
  options?: SimulateOptions,
): Promise<Truck> {
  if (options?.simulate === 'error') throw new Error('Simulated failure');

  const truck = await createTruckRecord({
    unitNumber: input.unitNumber,
    vin: input.vin,
    year: input.year,
    make: input.make,
    model: input.model,
    plate: input.plate,
    plateState: input.plateState,
    color: input.color,
    // The same defaults the shared CreateTruckSchema applies; spelled out here because the
    // request type is the parsed shape, in which they have already been applied.
    ownership: input.ownership ?? 'owned',
    odometer: input.odometer,
    engineHours: input.engineHours ?? 0,
    inServiceDate: input.inServiceDate,
    homeTerminal: input.homeTerminal,
    status: input.status,
    driverId: input.driverId,
    serviceIntervalMiles: input.serviceIntervalMiles ?? FIRST_SERVICE_INTERVAL_MILES,
    nextServiceType: input.nextServiceType ?? 'pm_service',
    nextServiceDate: input.nextServiceDate,
    ...(input.vendor ? { vendor: input.vendor } : {}),
  });

  const driver = truck.currentDriverId
    ? demoData.drivers.find((d) => d.id === truck.currentDriverId)
    : undefined;

  appendFleetAudit({
    action: 'status_changed',
    entity: { type: 'truck', id: truck.id, label: `Unit ${truck.unitNumber}` },
    subject: 'Truck record',
    before: null,
    after: getTruckStatusLabel(truck.status),
    reason: `Unit ${truck.unitNumber} added to the fleet${driver ? `, ${driver.name} assigned` : ''}`,
  });

  return cloneValue(truck);
}

// ---------------------------------------------------------------------------------------------
// Trailers
// ---------------------------------------------------------------------------------------------

export interface CreateTrailerInput {
  unitNumber: string;
  vin: string;
  year: number;
  make?: string | null;
  model: string;
  type: TrailerType;
  /** Everything below the identity is optional and stored as `null` until it is known. */
  lengthFt?: number;
  plate?: string;
  plateState?: string;
  /** Absent: company owned. */
  ownership?: Trailer['ownership'];
  nextInspectionDate?: IsoDate;
}

/** The details a trailer is created without and given later from its page (round 3, P1 #5). */
export async function updateTrailerDetails(
  id: string,
  patch: Partial<
    Pick<Trailer, 'lengthFt' | 'plate' | 'plateState' | 'ownership' | 'nextInspectionDate'>
  >,
  _options?: SimulateOptions,
): Promise<Trailer> {
  return updateTrailerRecord(id, patch);
}

export async function createTrailer(
  input: CreateTrailerInput,
  _options?: SimulateOptions,
): Promise<Trailer> {
  /*
   * Straight to the server. A trailer is an asset with a VIN and a plate, and it now lives in the
   * `trailers` table beside trucks and drivers — the unit-number and VIN clashes are decided there,
   * in one place, rather than against whatever this browser happens to be holding.
   */
  const trailer = await createTrailerRecord({
    unitNumber: input.unitNumber.trim(),
    vin: input.vin.trim().toUpperCase(),
    year: input.year,
    // Add trailer no longer asks for a make (owner, 2026-10-22); absent is "not set".
    make: input.make?.trim() || null,
    model: input.model.trim(),
    type: input.type,
    lengthFt: input.lengthFt ?? null,
    plate: input.plate?.trim().toUpperCase() ?? null,
    plateState: input.plateState?.trim().toUpperCase() ?? null,
    ownership: input.ownership ?? 'owned',
    nextInspectionDate: input.nextInspectionDate ?? null,
  });

  appendFleetAudit({
    action: 'status_changed',
    entity: { type: 'trailer', id: trailer.id, label: `Trailer ${trailer.unitNumber}` },
    subject: 'Trailer record',
    before: null,
    after: 'Available',
    reason: `Trailer ${trailer.unitNumber} added to the fleet`,
  });

  return trailer;
}

// ---------------------------------------------------------------------------------------------
// Work orders
// ---------------------------------------------------------------------------------------------

/** The states a work order may be written up in. */
export type WorkOrderCreateStatus = Extract<
  RepairOrderStatus,
  'open' | 'scheduled' | 'in_shop' | 'completed'
>;

export interface CreateRepairOrderInput {
  /** The truck, or empty for a trailer order. */
  truckId: string;
  /** Opened for a walk-around defect: kept on the order so the two are navigable both ways. */
  defectId?: string | null;
  /** `trailer` with `trailerId` opens the order against a trailer. Trucks are the default. */
  unitType?: 'truck' | 'trailer';
  trailerId?: string | null;
  type: MaintenanceType;
  summary: string;
  priority: RepairOrder['priority'];
  vendorName: string;
  /** The vendor record the name was chosen from, when it was. */
  vendorId?: string | null;
  technician: string;
  /** When the shop has promised the unit back, when a date was agreed. */
  promisedAt: string | null;
  /** When the unit actually went back on the road. Required to write a repair up as completed. */
  backInServiceAt?: string | null;
  /**
   * Where the work already stands.
   *
   * `completed` is allowed because work is routinely written up after the shop has finished it —
   * refusing to record it would mean the order never exists, which is worse than recording it late.
   * A completed order with no invoice is listed as awaiting one rather than treated as settled.
   */
  status: WorkOrderCreateStatus;
  warranty: boolean;
  notes: string | null;
  /**
   * What the work is expected to cost, when it is known at the time of writing.
   *
   * Booked as labour: a quote is one figure and splitting it into parts, labour and fees here
   * would be inventing a breakdown nobody gave. The shop's invoice replaces it later.
   */
  price?: number;
}

/**
 * Attaches the shop's invoice to a work order.
 *
 * When the paperwork carries an amount it becomes the order's cost: an invoice is what the work
 * actually cost, and the figure typed when the order was opened was an estimate.
 */
export function attachWorkOrderInvoice(
  input: {
    orderId: string;
    fileName: string;
    sizeBytes: number;
    mimeType: string;
    /** From `uploadFile`: the bytes are already in the file store. */
    fileUrl: string;
    fileId: string;
    uploadedBy: string;
    amount: number | null;
    invoiceNumber?: string | null;
    invoiceDate?: string | null;
  },
  options?: SimulateOptions,
): Promise<RepairOrder> {
  return fleetWrite(
    options,
    () => {
      const order = demoData.repairOrders.find((ro) => ro.id === input.orderId);
      if (!order) throw new Error('That work order no longer exists');
      const invoice: WorkOrderInvoice = {
        id: `inv_${Math.random().toString(36).slice(2, 10)}`,
        fileName: input.fileName,
        sizeBytes: input.sizeBytes,
        mimeType: input.mimeType,
        fileUrl: input.fileUrl,
        fileId: input.fileId,
        uploadedAt: nowIsoString(),
        uploadedBy: input.uploadedBy,
        amount: input.amount,
        invoiceNumber: input.invoiceNumber ?? null,
        invoiceDate: input.invoiceDate ?? null,
      };
      order.invoices = [...(order.invoices ?? []), invoice];
      // The invoice has arrived: the order is no longer waiting on one.
      order.awaitingInvoice = null;
      // An invoice that changes what the work cost changes what the owner owes for it.
      refreshBillingCharge(order);
      if (input.amount !== null) {
        order.laborTotal = input.amount;
        order.total = input.amount;
      }

      /*
       * The invoice is the shop saying the work is done.
       *
       * A carrier does not get an invoice for work still in the bay, so an order that has one and
       * is still open is an order somebody forgot to close. Attaching it closes the order — except
       * on one that was cancelled, where the invoice is a dispute rather than a completion.
       */
      const wasOpen = order.status !== 'completed' && order.status !== 'cancelled';
      if (wasOpen) {
        order.status = 'completed';
        order.completedAt = order.completedAt ?? nowIsoString();
        closeConditionLoop(order);
        followWorkOrder(order, 'completed');
      }

      appendFleetAudit({
        action: 'status_changed',
        entity: { type: 'repair_order', id: order.id, label: order.roNumber },
        subject: 'Work order',
        before: null,
        after: wasOpen ? 'Completed' : 'Invoice attached',
        reason: wasOpen
          ? `${input.fileName} attached to ${order.roNumber}; the order is completed`
          : `${input.fileName} attached to ${order.roNumber}`,
      });
      return cloneValue(order);
    },
    () => {
      throw new Error('The invoice could not be attached');
    },
  );
}

/**
 * Completing a work order with no invoice, for a stated reason.
 *
 * The rule that completed work carries its invoice stays; this is the deliberate exception -
 * warranty work, the company's own shop, or a bill still in the post - and it leaves the order
 * flagged as awaiting its invoice so the gap is visible until the paperwork lands.
 */
export function completeWorkOrderWithoutInvoice(
  input: { orderId: string; reason: NoInvoiceReason; note: string; completedBy: string },
  options?: SimulateOptions,
): Promise<RepairOrder> {
  return fleetWrite(
    options,
    () => {
      const order = demoData.repairOrders.find((ro) => ro.id === input.orderId);
      if (!order) throw new Error('That work order no longer exists');
      if (order.status === 'cancelled')
        throw new Error('A cancelled work order cannot be completed');
      const wasOpen = order.status !== 'completed';
      order.status = 'completed';
      order.completedAt = order.completedAt ?? nowIsoString();
      // A lease operator's truck needs no invoice (owner, 2026-11-03): nothing is left awaiting one.
      order.awaitingInvoice =
        (order.invoices ?? []).length > 0 || input.reason === 'lease_operator'
          ? null
          : { reason: input.reason, note: input.note, at: nowIsoString(), by: input.completedBy };
      if (wasOpen) {
        closeConditionLoop(order);
        followWorkOrder(order, 'completed');
      }
      appendFleetAudit({
        action: 'status_changed',
        entity: { type: 'repair_order', id: order.id, label: order.roNumber },
        subject: 'Work order',
        before: wasOpen ? 'Open' : 'Completed',
        after: input.reason === 'lease_operator' ? 'Completed (lease operator, invoice optional)' : 'Completed, awaiting invoice',
        reason: `${order.roNumber} completed without an invoice: ${input.reason.replace(/_/g, ' ')} - ${input.note}`,
      });
      return cloneValue(order);
    },
    () => {
      throw new Error('The work order could not be completed');
    },
  );
}

/**
 * Correcting an invoice that was attached in a hurry.
 *
 * The amount is the one thing people get wrong — a figure typed from the wrong line of the
 * paperwork — and it becomes the order's cost, so leaving it uncorrectable means the maintenance
 * spend is wrong and nobody can fix it. The file itself is replaced by attaching a new one.
 */
export function updateWorkOrderInvoice(
  input: { orderId: string; invoiceId: string; amount: number | null },
  options?: SimulateOptions,
): Promise<RepairOrder> {
  return fleetWrite(
    options,
    () => {
      const order = demoData.repairOrders.find((ro) => ro.id === input.orderId);
      if (!order) throw new Error('That work order no longer exists');
      const invoice = (order.invoices ?? []).find((i) => i.id === input.invoiceId);
      if (!invoice) throw new Error('That invoice is no longer on this order');

      const before = invoice.amount;
      invoice.amount = input.amount;
      // The order costs what its invoices say. The newest figure wins, as it did when attached.
      const latest = [...(order.invoices ?? [])].reverse().find((i) => i.amount !== null);
      if (latest) {
        order.laborTotal = latest.amount as number;
        order.total = latest.amount as number;
      }

      appendFleetAudit({
        action: 'status_changed',
        entity: { type: 'repair_order', id: order.id, label: order.roNumber },
        subject: 'Invoice amount',
        before: before === null ? 'No amount' : String(before),
        after: input.amount === null ? 'No amount' : String(input.amount),
        reason: `${invoice.fileName} on ${order.roNumber} corrected`,
      });
      return cloneValue(order);
    },
    () => {
      throw new Error('The invoice could not be changed');
    },
  );
}

/**
 * Taking an invoice off a work order.
 *
 * For the one attached to the wrong order, which is the mistake this exists for. Removing the last
 * one takes the order back out of completed: the rule is that completed work has an invoice
 * behind it, and an order that kept the status while losing the paperwork would break it quietly.
 */
export function removeWorkOrderInvoice(
  input: { orderId: string; invoiceId: string },
  options?: SimulateOptions,
): Promise<RepairOrder> {
  return fleetWrite(
    options,
    () => {
      const order = demoData.repairOrders.find((ro) => ro.id === input.orderId);
      if (!order) throw new Error('That work order no longer exists');
      const invoice = (order.invoices ?? []).find((i) => i.id === input.invoiceId);
      if (!invoice) throw new Error('That invoice is no longer on this order');

      order.invoices = (order.invoices ?? []).filter((i) => i.id !== input.invoiceId);
      const remaining = [...order.invoices].reverse().find((i) => i.amount !== null);
      order.laborTotal = remaining?.amount ?? 0;
      order.total = remaining?.amount ?? 0;

      const reopened = order.invoices.length === 0 && order.status === 'completed';
      if (reopened) {
        order.status = 'in_shop';
        order.completedAt = null;
      }

      appendFleetAudit({
        action: 'status_changed',
        entity: { type: 'repair_order', id: order.id, label: order.roNumber },
        subject: 'Work order',
        before: 'Invoice on file',
        after: reopened ? 'In shop — no invoice' : 'Invoice removed',
        reason: `${invoice.fileName} removed from ${order.roNumber}`,
      });
      return cloneValue(order);
    },
    () => {
      throw new Error('The invoice could not be removed');
    },
  );
}

function nextRepairOrderNumber(): string {
  const highest = demoData.repairOrders.reduce((max, ro) => {
    const value = Number.parseInt(ro.roNumber.replace(/^RO-/, ''), 10);
    return Number.isNaN(value) ? max : Math.max(max, value);
  }, 1000);
  return `RO-${highest + 1}`;
}

export function createRepairOrder(
  input: CreateRepairOrderInput,
  options?: SimulateOptions,
): Promise<RepairOrder> {
  return fleetWrite(
    options,
    () => {
      const trailerOrder = input.unitType === 'trailer';
      const truck = trailerOrder ? null : demoData.trucks.find((t) => t.id === input.truckId);
      const trailer = trailerOrder ? demoData.trailers.find((t) => t.id === input.trailerId) : null;
      if (trailerOrder ? !trailer : !truck) throw new Error('That unit is not in the fleet');
      /*
       * An order is never *born* completed.
       *
       * Work written up after the shop finished it is real, but completed means invoiced — and
       * the invoice arrives a moment later, in the same dialog. So it opens in the shop and the
       * invoice completes it, which is the one path completion has.
       */
      const opening = input.status === 'completed' ? 'in_shop' : input.status;

      const roNumber = nextRepairOrderNumber();
      const order: RepairOrder = {
        id: `ro_${roNumber.replace('RO-', '')}`,
        roNumber,
        defectId: input.defectId ?? null,
        truckId: truck?.id ?? '',
        unitType: trailerOrder ? 'trailer' : 'truck',
        trailerId: trailer?.id ?? null,
        unitNumber: (truck ?? trailer)?.unitNumber ?? '',
        status: opening,
        priority: input.priority,
        type: input.type,
        summary: input.summary.trim(),
        vendorName: input.vendorName.trim(),
        vendorId: input.vendorId ?? null,
        technician: input.technician.trim(),
        openedAt: nowIsoString(),
        promisedAt: input.promisedAt,
        backInServiceAt: input.backInServiceAt ?? null,
        // Set by the invoice that completes it, never by the form.
        completedAt: null,
        // A trailer has no odometer of its own.
        odometer: truck?.odometer ?? 0,
        // Downtime and money are measured as the work happens; a new order has neither.
        downtimeMinutes: 0,
        partsTotal: 0,
        laborTotal: input.price ?? 0,
        feesTotal: 0,
        total: input.price ?? 0,
        warranty: input.warranty,
        notes: input.notes?.trim() ? input.notes.trim() : null,
        invoices: [],
      };

      demoData.repairOrders.unshift(order);
      markCreated(order.id);

      appendFleetAudit({
        action: 'status_changed',
        entity: { type: 'repair_order', id: order.id, label: order.roNumber },
        subject: 'Work order',
        before: null,
        after: input.status === 'scheduled' ? 'Scheduled' : 'Open',
        reason: `${order.roNumber} opened on ${trailerOrder ? 'trailer' : 'unit'} ${order.unitNumber}: ${order.summary}`,
      });

      return cloneValue(order);
    },
    () => {
      throw new Error('Work order could not be created');
    },
  );
}

/** Which transitions a work order is allowed to make from where it stands. */
const WORK_ORDER_TRANSITIONS: Record<RepairOrderStatus, RepairOrderStatus[]> = {
  draft: ['open', 'cancelled'],
  open: ['scheduled', 'in_shop', 'cancelled'],
  scheduled: ['in_shop', 'open', 'cancelled'],
  in_shop: ['completed', 'scheduled'],
  completed: ['in_shop'],
  cancelled: ['open'],
};

export function workOrderTransitions(status: RepairOrderStatus): RepairOrderStatus[] {
  return WORK_ORDER_TRANSITIONS[status] ?? [];
}

export interface UpdateRepairOrderInput {
  id: string;
  status?: RepairOrderStatus;
  /** Money is only accepted on completion, because that is when the shop invoices it. */
  partsTotal?: number;
  laborTotal?: number;
  feesTotal?: number;
  technician?: string;
  promisedAt?: string | null;
  notes?: string | null;
  reason?: string | null;
  /** A lease operator's truck (owner, 2026-11-03): completing it does not wait for an invoice. */
  invoiceOptional?: boolean;
}

export interface UpdateRepairOrderResult {
  ok: boolean;
  order: RepairOrder | null;
  /** Why the change was refused, when it was. */
  blocked?: string;
}

export function updateRepairOrder(
  input: UpdateRepairOrderInput,
  options?: SimulateOptions,
): Promise<UpdateRepairOrderResult> {
  return fleetWrite(
    options,
    () => {
      const order = demoData.repairOrders.find((r) => r.id === input.id);
      if (!order) return { ok: false, order: null, blocked: 'That work order no longer exists' };

      const before = order.status;
      if (input.status === 'completed' && (order.invoices ?? []).length === 0 && !input.invoiceOptional) {
        // Completed work is work somebody has been charged for. Without the invoice the order is
        // an estimate wearing a finished badge, which is how a maintenance budget stops meaning
        // anything — so the status waits for the paperwork.
        return {
          ok: false,
          order: cloneValue(order),
          blocked: `${order.roNumber} has no invoice yet. Attach it and the order completes itself.`,
        };
      }
      if (input.status && input.status !== before) {
        if (!WORK_ORDER_TRANSITIONS[before]?.includes(input.status)) {
          return {
            ok: false,
            order: cloneValue(order),
            blocked: `A ${before.replace(/_/g, ' ')} work order cannot move straight to ${input.status.replace(/_/g, ' ')}`,
          };
        }
        order.status = input.status;
        order.completedAt = input.status === 'completed' ? nowIsoString() : null;
        if (input.status === 'completed') closeConditionLoop(order);
        followWorkOrder(order, input.status);

        appendFleetAudit({
          action: 'status_changed',
          entity: { type: 'repair_order', id: order.id, label: order.roNumber },
          subject: 'Work order status',
          before: before.replace(/_/g, ' '),
          after: input.status.replace(/_/g, ' '),
          reason: input.reason?.trim()
            ? input.reason.trim()
            : `${order.roNumber} moved to ${input.status.replace(/_/g, ' ')}`,
        });
      }

      if (typeof input.partsTotal === 'number') order.partsTotal = input.partsTotal;
      if (typeof input.laborTotal === 'number') order.laborTotal = input.laborTotal;
      if (typeof input.feesTotal === 'number') order.feesTotal = input.feesTotal;
      order.total = Math.round((order.partsTotal + order.laborTotal + order.feesTotal) * 100) / 100;
      if (input.technician !== undefined) order.technician = input.technician;
      if (input.promisedAt !== undefined) order.promisedAt = input.promisedAt;
      if (input.notes !== undefined) order.notes = input.notes;

      return { ok: true, order: cloneValue(order) };
    },
    () => ({ ok: false, order: null, blocked: 'Work order could not be updated' }),
  );
}

// ---------------------------------------------------------------------------------------------
// Scheduling a service
// ---------------------------------------------------------------------------------------------

export interface ScheduleServiceInput {
  truckId: string;
  /** Which PM row to book, when the operator picked one from the unit's schedule. */
  maintenanceItemId?: string | null;
  type: MaintenanceType;
  scheduledFor: IsoDate;
  vendorName: string | null;
  /** The vendor record the shop was picked from, so the booking points at a record, not a string. */
  vendorId?: string | null;
  /** Odometer at which the service falls due, when the shop agreed one. */
  nextDueOdometer?: number | null;
}

export interface ScheduleServiceResult {
  ok: boolean;
  item: MaintenanceItem | null;
  truck: Truck | null;
  blocked?: string;
}

/**
 * Books a service against a unit.
 *
 * The booking updates the PM row *and* the truck's own next-service fields, because the trucks
 * list reads the truck record and the maintenance list reads the PM row; leaving one behind is how
 * a fleet ends up with two different answers to "when is 3091 due".
 */
export function scheduleService(
  input: ScheduleServiceInput,
  options?: SimulateOptions,
): Promise<ScheduleServiceResult> {
  return fleetWrite(
    options,
    () => {
      const truck = demoData.trucks.find((t) => t.id === input.truckId);
      if (!truck) {
        return { ok: false, item: null, truck: null, blocked: 'That unit is not in the fleet' };
      }

      const item: MaintenanceItem | null =
        demoData.maintenance.find(
          (m) =>
            m.id === input.maintenanceItemId ||
            (!input.maintenanceItemId && m.truckId === truck.id && m.type === input.type),
        ) ?? null;

      if (item) {
        item.scheduledFor = input.scheduledFor;
        item.status = item.status === 'overdue' ? 'overdue' : 'scheduled';
        if (typeof input.nextDueOdometer === 'number') {
          item.nextDueOdometer = input.nextDueOdometer;
          item.milesUntilDue = input.nextDueOdometer - truck.odometer;
        }
        if (input.vendorName) item.vendorName = input.vendorName;
        if (input.vendorId !== undefined) item.vendorId = input.vendorId;
      }

      truck.nextServiceType = input.type;
      truck.nextServiceDate = input.scheduledFor;
      if (typeof input.nextDueOdometer === 'number') {
        truck.nextServiceOdometer = input.nextDueOdometer;
      }

      appendFleetAudit({
        action: 'item_updated',
        entity: { type: 'truck', id: truck.id, label: `Unit ${truck.unitNumber}` },
        subject: 'Next service',
        before: null,
        after: input.scheduledFor,
        reason: `${input.type.replace(/_/g, ' ')} booked for ${input.scheduledFor}${input.vendorName ? ` at ${input.vendorName}` : ''}`,
      });

      return { ok: true, item: item ? cloneValue(item) : null, truck: cloneValue(truck) };
    },
    () => ({ ok: false, item: null, truck: null, blocked: 'The service could not be booked' }),
  );
}

// ---------------------------------------------------------------------------------------------
// Fuel
// ---------------------------------------------------------------------------------------------

export interface CreateFuelTransactionInput {
  truckId: string;
  driverId: string | null;
  loadId: string | null;
  at: string;
  station: { brand: string; name: string; city: string; state: string };
  product: FuelTransaction['product'];
  gallons: number;
  pricePerGallon: number;
  odometer: number;
  cardLast4: string;
}

function nextFuelId(): string {
  const highest = demoData.fuelTransactions.reduce((max, f) => {
    const value = Number.parseInt(f.id.replace(/^fue_/, ''), 10);
    return Number.isNaN(value) ? max : Math.max(max, value);
  }, 0);
  return `fue_${String(highest + 1).padStart(4, '0')}`;
}

export function createFuelTransaction(
  input: CreateFuelTransactionInput,
  options?: SimulateOptions,
): Promise<FuelTransaction> {
  return fleetWrite(
    options,
    () => {
      const truck = demoData.trucks.find((t) => t.id === input.truckId);
      if (!truck) throw new Error('That unit is not in the fleet');
      const driver = input.driverId
        ? demoData.drivers.find((d) => d.id === input.driverId)
        : undefined;

      const amount = Math.round(input.gallons * input.pricePerGallon * 100) / 100;

      // The same checks the imported card feed runs, applied to a hand-keyed fill so both arrive
      // in the ledger with the same standard of evidence.
      const anomalyFlags: FuelTransaction['anomalyFlags'] = [];
      if (input.odometer > 0 && input.odometer < truck.odometer) {
        anomalyFlags.push('location_mismatch');
      }
      if (input.gallons > 300) anomalyFlags.push('impossible_gallons');
      const duplicate = demoData.fuelTransactions.some(
        (f) =>
          f.truckId === input.truckId &&
          Math.abs(Date.parse(f.at) - Date.parse(input.at)) < 30 * 60_000 &&
          Math.abs(f.gallons - input.gallons) < 0.5,
      );
      if (duplicate) anomalyFlags.push('duplicate');

      const transaction: FuelTransaction = {
        id: nextFuelId(),
        truckId: truck.id,
        unitNumber: truck.unitNumber,
        driverId: driver?.id ?? '',
        driverName: driver?.name ?? truck.currentDriverName ?? 'Unassigned',
        loadId: input.loadId,
        at: input.at,
        station: input.station,
        product: input.product,
        gallons: input.gallons,
        pricePerGallon: input.pricePerGallon,
        amount,
        odometer: input.odometer,
        cardLast4: input.cardLast4,
        anomalyFlags,
        status: anomalyFlags.length > 0 ? 'warning' : 'verified',
      };

      demoData.fuelTransactions.unshift(transaction);

      // A fill is the most reliable odometer reading a carrier gets, so it advances the unit.
      if (input.odometer > truck.odometer) {
        truck.odometer = input.odometer;
        truck.odometerAt = input.at;
      }

      appendFleetAudit({
        action: 'item_updated',
        entity: {
          type: 'fuel_transaction',
          id: transaction.id,
          label: `Fill on ${truck.unitNumber}`,
        },
        subject: 'Fuel transaction',
        before: null,
        after: `${input.gallons.toFixed(1)} gal`,
        reason: `${input.gallons.toFixed(1)} gal at ${input.station.name}, ${input.station.city} ${input.station.state}`,
      });

      return cloneValue(transaction);
    },
    () => {
      throw new Error('Fuel transaction could not be recorded');
    },
  );
}

// ---------------------------------------------------------------------------------------------
// Assignment
// ---------------------------------------------------------------------------------------------

export interface AssignTrailerInput {
  truckId: string;
  /** Null detaches whatever trailer is on the truck. */
  trailerId: string | null;
}

export interface AssignTrailerResult {
  ok: boolean;
  blocked?: string;
}

export function assignTrailer(
  input: AssignTrailerInput,
  options?: SimulateOptions,
): Promise<AssignTrailerResult> {
  return fleetWrite(
    options,
    () => {
      const truck = demoData.trucks.find((t) => t.id === input.truckId);
      if (!truck) return { ok: false, blocked: 'That unit is not in the fleet' };

      const previous = truck.currentTrailerId
        ? demoData.trailers.find((t) => t.id === truck.currentTrailerId)
        : undefined;

      if (input.trailerId === null) {
        if (
          previous &&
          demoData.loads.some((l) => l.trailerId === previous.id && isActiveStatus(l.status))
        ) {
          return {
            ok: false,
            blocked: `Trailer ${previous.unitNumber} is on an active load and cannot be dropped here`,
          };
        }
        if (previous) {
          previous.currentTruckId = null;
          previous.currentTruckUnit = null;
          previous.status = 'available';
        }
        truck.currentTrailerId = null;
        appendFleetAudit({
          action: 'item_updated',
          entity: { type: 'truck', id: truck.id, label: `Unit ${truck.unitNumber}` },
          subject: 'Trailer assignment',
          before: previous?.unitNumber ?? null,
          after: 'None',
          reason: 'Trailer detached',
        });
        return { ok: true };
      }

      const trailer = demoData.trailers.find((t) => t.id === input.trailerId);
      if (!trailer) return { ok: false, blocked: 'That trailer is not in the fleet' };
      if (trailer.status === 'in_shop' || trailer.status === 'out_of_service') {
        return {
          ok: false,
          blocked: `Trailer ${trailer.unitNumber} is ${trailer.status.replace(/_/g, ' ')} and cannot be assigned`,
        };
      }
      if (trailer.currentTruckId && trailer.currentTruckId !== truck.id) {
        return {
          ok: false,
          blocked: `Trailer ${trailer.unitNumber} is already on unit ${trailer.currentTruckUnit ?? trailer.currentTruckId}`,
        };
      }

      if (previous && previous.id !== trailer.id) {
        previous.currentTruckId = null;
        previous.currentTruckUnit = null;
        previous.status = 'available';
      }

      trailer.currentTruckId = truck.id;
      trailer.currentTruckUnit = truck.unitNumber;
      trailer.status = 'assigned';
      truck.currentTrailerId = trailer.id;

      appendFleetAudit({
        action: 'item_updated',
        entity: { type: 'truck', id: truck.id, label: `Unit ${truck.unitNumber}` },
        subject: 'Trailer assignment',
        before: previous?.unitNumber ?? null,
        after: trailer.unitNumber,
        reason: `Trailer ${trailer.unitNumber} attached to unit ${truck.unitNumber}`,
      });

      return { ok: true };
    },
    () => ({ ok: false, blocked: 'The assignment could not be saved' }),
  );
}
