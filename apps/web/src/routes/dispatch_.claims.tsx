import { createFileRoute } from '@tanstack/react-router';
import { ClaimsPage } from '@/features/dispatch/board/ClaimsPage';

export const Route = createFileRoute('/dispatch_/claims')({
  component: ClaimsPage,
});
