import { createFileRoute, redirect } from '@tanstack/react-router';
import { OilChangePage } from '@/features/fleet/pm/OilChangePage';
import { oilChangeSearchSchema } from '@/features/fleet/pm/search';
import { isEnabled } from '@/lib/feature-flags';

/** Behind `pm_module`. Off, the route sends the reader to the work-order table production had. */
export const Route = createFileRoute('/fleet/oil-change')({
  validateSearch: oilChangeSearchSchema,
  beforeLoad: () => {
    if (!isEnabled('pm_module')) throw redirect({ to: '/fleet/maintenance' });
  },
  component: OilChangePage,
});
