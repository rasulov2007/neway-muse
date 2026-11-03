import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * The "Due & lapsed" page was taken off on 2026-09-20 (owner's ask): Oil changes and the
 * Pre-trip board carry what it showed. Old links land on Oil changes; without `fleet_v2` the
 * route still sends the reader to the Fleet page production had.
 */
export const Route = createFileRoute('/fleet/pm')({
  beforeLoad: () => {
    throw redirect({ to: '/fleet/oil-change' });
  },
});
