import { createFileRoute, redirect } from '@tanstack/react-router';

// Role-based landing arrives with authentication (Phase 3). Until then, everyone lands on the dashboard.
export const Route = createFileRoute('/')({
  beforeLoad: () => {
    throw redirect({ to: '/dashboard' });
  },
});
