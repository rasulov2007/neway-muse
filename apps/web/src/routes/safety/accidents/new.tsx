import { createFileRoute } from '@tanstack/react-router';
import { AccidentNewRoute } from '@/features/safety/v2/routes';

export const Route = createFileRoute('/safety/accidents/new')({
  component: AccidentNewRoute,
});
