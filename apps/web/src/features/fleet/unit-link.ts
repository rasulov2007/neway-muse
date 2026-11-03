import type { RepairOrder } from '@/demo';

/**
 * Where a work order's unit lives.
 *
 * An order used to be a fact about a truck; now it can be about a trailer, and a link that sends
 * a trailer order to a truck page lands on "that truck is not in the fleet". One place decides.
 */
export function unitLinkFor(
  order: Pick<RepairOrder, 'truckId' | 'unitType' | 'trailerId'>,
):
  | { to: '/fleet/trucks/$truckId'; params: { truckId: string } }
  | { to: '/fleet/trailers/$trailerId'; params: { trailerId: string } } {
  if (order.unitType === 'trailer' && order.trailerId) {
    return { to: '/fleet/trailers/$trailerId', params: { trailerId: order.trailerId } };
  }
  return { to: '/fleet/trucks/$truckId', params: { truckId: order.truckId } };
}

export function unitKindOf(order: Pick<RepairOrder, 'unitType'>): 'truck' | 'trailer' {
  return order.unitType === 'trailer' ? 'trailer' : 'truck';
}
