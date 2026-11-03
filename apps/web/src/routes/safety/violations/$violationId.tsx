import { createFileRoute } from '@tanstack/react-router';
import { ViolationDetailRoute } from '@/features/safety/ViolationDetailPage';

export const Route = createFileRoute('/safety/violations/$violationId')({
  component: ViolationDetailRoute,
});
