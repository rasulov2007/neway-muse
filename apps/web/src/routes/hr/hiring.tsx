import { createFileRoute, redirect } from '@tanstack/react-router';

/** The hiring dashboard became Recruiting › Overview (owner, 2026-09-30); old links land there. */
export const Route = createFileRoute('/hr/hiring')({
  beforeLoad: () => {
    throw redirect({ to: '/hr/recruiting' });
  },
});
