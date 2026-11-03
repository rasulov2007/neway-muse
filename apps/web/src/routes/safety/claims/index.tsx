import { createFileRoute } from '@tanstack/react-router';
import { ClaimsRoute } from '@/features/safety/v2/routes';

export const Route = createFileRoute('/safety/claims/')({
  component: ClaimsRoute,
});
