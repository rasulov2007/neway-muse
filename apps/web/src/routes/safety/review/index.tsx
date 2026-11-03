import { createFileRoute } from '@tanstack/react-router';
import { SafetyReviewRoute } from '@/features/safety/v2/routes';

export const Route = createFileRoute('/safety/review/')({
  component: SafetyReviewRoute,
});
