import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { CandidateDetailRoute } from '@/features/hr/CandidateDetailPage';

/** `tab` keeps the open profile tab through a refresh, a shared link and the back button. */
const search = z.object({ tab: z.string().optional().catch(undefined) });

export const Route = createFileRoute('/hr/recruiting/$candidateId')({
  validateSearch: search,
  component: CandidateDetailRoute,
});
