import type { PtiDefect } from '@neway/shared';
import { apiPost } from '@/lib/api-client';
import { isEnabled } from '@/lib/feature-flags';

/**
 * The legacy work-order register's end of the defect link (WP6).
 *
 * An order in this register closes here, in the browser, so the server cannot see it happen.
 * This tells it: the defects opened on the order move to awaiting-verify, never to verified.
 * The v2 shop's orders do the same on the server, where it cannot be skipped.
 */
export async function proposeDefectVerification(orderId: string): Promise<PtiDefect[]> {
  if (!isEnabled('fleet_v2')) return [];
  try {
    return await apiPost<PtiDefect[]>(`/fleet/pti/work-orders/${orderId}/closed`, {});
  } catch (error) {
    console.warn(`The defects on ${orderId} could not be proposed for verification`, error);
    return [];
  }
}
