import { createFileRoute } from '@tanstack/react-router';
import { TrailersPage } from '@/features/fleet/TrailersPage';
import { trailersSearchSchema } from '@/features/fleet/trailers-search';

export const Route = createFileRoute('/fleet/trailers/')({
  validateSearch: trailersSearchSchema,
  component: TrailersPage,
});
