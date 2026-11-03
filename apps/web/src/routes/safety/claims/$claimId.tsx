import { createFileRoute } from '@tanstack/react-router';
import { ClaimRoute } from '@/features/safety/v2/routes';

export const Route = createFileRoute('/safety/claims/$claimId')({
  component: ClaimRoute,
});
