import { createFileRoute } from '@tanstack/react-router';
import { TrailerFormPage } from '@/features/fleet/TrailerFormPage';

export const Route = createFileRoute('/fleet/trailers/new')({
  component: TrailerFormPage,
});
