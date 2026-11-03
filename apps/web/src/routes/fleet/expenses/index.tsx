import { createFileRoute, redirect } from '@tanstack/react-router';

/** The Fleet Expenses dashboard is Costs now (owner, 2026-10-13): one Fleet dashboard. */
export const Route = createFileRoute('/fleet/expenses/')({
  beforeLoad: () => {
    throw redirect({ to: '/fleet', replace: true });
  },
});
