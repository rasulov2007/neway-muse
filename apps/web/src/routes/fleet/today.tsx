import { createFileRoute, redirect } from '@tanstack/react-router';
import { FleetTodayPage } from '@/features/fleet/FleetTodayPage';
import { isEnabled } from '@/lib/feature-flags';

/**
 * The shop board, behind `fleet_v2`.
 *
 * Off, the route does not exist yet in any form: it sends the reader to the Fleet landing page
 * production has always had, so a build without the flag carries none of the new Fleet screens.
 */
export const Route = createFileRoute('/fleet/today')({
  beforeLoad: () => {
    if (!isEnabled('fleet_v2')) throw redirect({ to: '/fleet' });
  },
  component: FleetTodayPage,
});
