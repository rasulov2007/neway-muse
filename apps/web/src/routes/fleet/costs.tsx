import { createFileRoute, redirect } from '@tanstack/react-router';

/**
 * The Costs overview was taken off on 2026-09-21 (owner's ask): the Expense summary is the one
 * costs page. Old links land there.
 */
export const Route = createFileRoute('/fleet/costs')({
  beforeLoad: () => {
    throw redirect({ to: '/fleet' });
  },
});
