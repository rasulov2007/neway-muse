import { createFileRoute, redirect } from '@tanstack/react-router';
import { z } from 'zod';

const search = z.object({
  from: z.string().optional().catch(undefined),
  to: z.string().optional().catch(undefined),
});

/**
 * Old links to the standalone analytics page land on Recruiting › Analytics, with the same
 * dates, so there is one analytics view and one period control.
 */
export const Route = createFileRoute('/hr/recruiting/analytics')({
  validateSearch: search,
  beforeLoad: ({ search: s }) => {
    throw redirect({ to: '/hr/recruiting', search: { tab: 'analytics', from: s.from, to: s.to } as never, replace: true });
  },
});
