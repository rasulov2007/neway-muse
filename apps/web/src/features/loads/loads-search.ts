import { getStatus } from '@/design-system/status';
import { z } from 'zod';
import type { Load } from '@/demo';
import type { LoadRiskState } from '@neway/shared';

/**
 * The loads list URL contract.
 *
 * Views are the operational states a dispatcher actually asks for, not a dump of every status code.
 * `unassigned` and `at_risk` are derived rather than stored — a load is unassigned when it has no
 * driver or no unit, and at risk when the risk engine says so — which is why the view lives here
 * beside the predicates rather than being a status filter.
 */

export const LOAD_VIEWS = [
  'all',
  'booked',
  'unassigned',
  'assigned',
  'in_transit',
  'at_risk',
  'late',
  'no_update',
  'ready_to_bill',
  'delivered',
  'cancelled',
  'flagged',
  'mine',
] as const;
export type LoadView = (typeof LOAD_VIEWS)[number];

/**
 * What a load's state is called wherever freight is listed.
 *
 * `closed` is shared with the ledger, where it means a period nobody may post into any more. On a
 * load it means something else entirely: it ran, the paperwork is in, the money is settled. The
 * lifecycle stepper on the load has always called that Completed, so everything that shows a load
 * says Completed too — one word for one thing, rather than the register and the load disagreeing.
 */
export function loadStatusLabel(status: Load['status']): string {
  return status === 'closed' ? 'Completed' : getStatus(status).label;
}

export const LOAD_VIEW_LABEL: Record<LoadView, string> = {
  all: 'All',
  booked: 'Booked',
  unassigned: 'Unassigned',
  assigned: 'Assigned',
  in_transit: 'In transit',
  at_risk: 'At risk',
  late: 'Late',
  no_update: 'No update',
  ready_to_bill: 'Ready to bill',
  flagged: 'Flagged',
  mine: 'My loads',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
};

export const loadsSearchSchema = z.object({
  view: z.enum(LOAD_VIEWS).optional().catch(undefined),
  q: z.string().optional().catch(undefined),
  customer: z.string().optional().catch(undefined),
  broker: z.string().optional().catch(undefined),
  equipment: z.enum(['dry_van', 'reefer', 'flatbed']).optional().catch(undefined),
  page: z.number().int().min(1).optional().catch(undefined),
  sort: z.string().optional().catch(undefined),
});

export type LoadsSearch = z.infer<typeof loadsSearchSchema>;

const IN_TRANSIT = new Set([
  'at_pickup',
  'loading',
  'loaded',
  'in_transit',
  'at_delivery',
  'unloading',
]);

/**
 * Delivered, proven, and not yet invoiced.
 *
 * The one definition of "billable", used by the Loads view, by Accounting and by anything else
 * that asks — a second copy would eventually disagree about which loads are waiting for money.
 * The proof matters: a load marked delivered with no POD on file is a claim, and a customer who
 * disputes it will ask for the paperwork.
 */
export function isReadyToBill(load: Load): boolean {
  if (load.status !== 'delivered') return false;
  if (load.invoiceId) return false;
  return (load.documents ?? []).some((doc) => doc.type === 'pod' && doc.status !== 'missing');
}

/**
 * Whether a load belongs in a view. Takes the risk state as an argument rather than recomputing it,
 * so the list and the dispatch board can never disagree about which loads are at risk.
 */
export function matchesView(
  view: LoadView,
  load: Load,
  risk: LoadRiskState,
  delivery?: 'on_time' | 'at_risk' | 'late' | 'no_update',
  extra?: { flagged?: boolean; userId?: string | null },
): boolean {
  switch (view) {
    // Somebody said this one needs a person (rule 1.10), and nobody has closed it.
    case 'flagged':
      return extra?.flagged === true;
    // Mine as its dispatcher or its updater (rule 1.7).
    case 'mine':
      return Boolean(extra?.userId) && (load.dispatcherId === extra!.userId || load.updaterId === extra!.userId);
    case 'all':
      return true;
    case 'booked':
      return load.status === 'booked';
    case 'unassigned':
      // Only live work counts: a delivered load with no driver recorded is a data gap, not a job
      // waiting to be covered.
      return (
        (load.status === 'booked' || load.status === 'assigned') &&
        (load.driverId === null || load.truckId === null)
      );
    case 'assigned':
      return load.status === 'assigned' || load.status === 'dispatched';
    case 'in_transit':
      return IN_TRANSIT.has(load.status);
    // The three verdict chips filter to exactly the loads the verdict names (rule 1.4). The risk
    // engine's words are the fallback only for a caller that has no verdict.
    case 'at_risk':
      return delivery ? delivery === 'at_risk' : risk === 'at_risk' || risk === 'critical';
    case 'late':
      return delivery === 'late';
    case 'no_update':
      return delivery === 'no_update';
    case 'ready_to_bill':
      // An open flag (rule 1.10) holds the invoice: somebody said this load needs a person first.
      return isReadyToBill(load) && extra?.flagged !== true;
    case 'delivered':
      return load.status === 'delivered' || load.status === 'closed';
    case 'cancelled':
      return load.status === 'cancelled' || load.status === 'tonu';
    default:
      return true;
  }
}
