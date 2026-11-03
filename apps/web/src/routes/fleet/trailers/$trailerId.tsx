import { createFileRoute } from '@tanstack/react-router';
import { TrailerDetailRoute } from '@/features/fleet/TrailerDetailPage';

export const Route = createFileRoute('/fleet/trailers/$trailerId')({
  component: TrailerDetailRoute,
});
