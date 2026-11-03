import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * Taken off on 2026-09-21 (owner's ask): the Repair log and the Create work order form carry what
 * this page showed. Old links land on the Repair log.
 */
export const Route = createFileRoute('/fleet/repairs/new')({
  beforeLoad: () => {
    throw redirect({ to: '/fleet/maintenance' });
  },
});
