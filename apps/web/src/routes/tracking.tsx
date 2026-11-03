import { createFileRoute } from '@tanstack/react-router';
import { TrackingPage } from '@/features/operations/TrackingPage';
import { trackingSearchSchema } from '@/features/operations/tracking-search';

export const Route = createFileRoute('/tracking')({
  validateSearch: trackingSearchSchema,
  component: TrackingPage,
});
