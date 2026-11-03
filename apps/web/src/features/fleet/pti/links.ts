/**
 * Where a defect's work order is read.
 *
 * Two registers exist mid-transition: the shop's orders in PostgreSQL (`wo_…`, the fleet_v2
 * shop page) and the older register in the workspace (`ro_…`, the maintenance page). The id
 * says which, so a link from a defect lands on the record rather than on a 404.
 */
export function workOrderLink(workOrderId: string): { to: '/fleet/shop/$orderId' | '/fleet/maintenance/$orderId'; params: { orderId: string } } {
  return workOrderId.startsWith('wo_')
    ? { to: '/fleet/shop/$orderId', params: { orderId: workOrderId } }
    : { to: '/fleet/maintenance/$orderId', params: { orderId: workOrderId } };
}
