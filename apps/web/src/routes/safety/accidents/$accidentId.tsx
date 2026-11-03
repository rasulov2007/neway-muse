import { createFileRoute } from '@tanstack/react-router';
import { AccidentRoute } from '@/features/safety/v2/routes';

export const Route = createFileRoute('/safety/accidents/$accidentId')({
  component: AccidentRoute,
});
