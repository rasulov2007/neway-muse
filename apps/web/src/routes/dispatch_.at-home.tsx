import { createFileRoute } from '@tanstack/react-router';
import { AtHomePage } from '@/features/dispatch/roster/AtHomePage';

export const Route = createFileRoute('/dispatch_/at-home')({
  component: AtHomePage,
});
