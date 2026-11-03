import { createFileRoute, redirect } from '@tanstack/react-router';

/** The Tire work order lives in Create work order now (owner, 2026-10-15); old links open it there. */
export const Route = createFileRoute('/fleet/maintenance/tire-work-order')({
  beforeLoad: () => {
    throw redirect({ to: '/fleet/maintenance', search: { create: 'tires' } as never, replace: true });
  },
});
