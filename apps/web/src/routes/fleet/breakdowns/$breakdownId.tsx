import { createFileRoute, redirect } from '@tanstack/react-router';
import { BreakdownDetailRoute } from '@/features/fleet/breakdowns/BreakdownDetailPage';
import { isEnabled } from '@/lib/feature-flags';

/** One breakdown case (mobile M3), behind `fleet_v2`. */
export const Route = createFileRoute('/fleet/breakdowns/$breakdownId')({
  beforeLoad: () => {
    if (!isEnabled('fleet_v2')) throw redirect({ to: '/fleet' });
  },
  component: BreakdownDetailRoute,
});
