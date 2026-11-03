import { createFileRoute } from '@tanstack/react-router';
import { RosterMatchPage } from '@/features/dispatch/roster/RosterMatchPage';

export const Route = createFileRoute('/dispatch_/roster-match')({
  component: RosterMatchPage,
});
