import { createFileRoute, redirect } from '@tanstack/react-router';
import { ShopWorkOrderRoute } from '@/features/fleet/ShopWorkOrderPage';
import { isEnabled } from '@/lib/feature-flags';

/**
 * The shop's work-order page, behind `fleet_v2`.
 *
 * With the flag off the route sends the reader to the work-order workspace this product already
 * had, on the same record, rather than showing them a page explaining that a page exists
 * somewhere. The component is never mounted, so nothing it would fetch is requested.
 */
export const Route = createFileRoute('/fleet/shop/$orderId')({
  beforeLoad: ({ params }) => {
    if (isEnabled('fleet_v2')) return;
    throw redirect({ to: '/fleet/maintenance/$orderId', params: { orderId: params.orderId } });
  },
  component: ShopWorkOrderRoute,
});
