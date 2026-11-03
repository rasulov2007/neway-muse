import { createFileRoute, redirect } from '@tanstack/react-router';
import { BreakdownsPage } from '@/features/fleet/breakdowns/BreakdownsPage';
import { isEnabled } from '@/lib/feature-flags';

/** Fleet → Breakdowns (mobile M3), behind `fleet_v2` like the rest of the new Fleet. */
export const Route = createFileRoute('/fleet/breakdowns/')({
  beforeLoad: () => {
    if (!isEnabled('fleet_v2')) throw redirect({ to: '/fleet' });
  },
  component: BreakdownsPage,
});
