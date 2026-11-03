import { createFileRoute } from '@tanstack/react-router';
import { VacationReturnsPage } from '@/features/safety/v2/VacationReturnsPage';

export const Route = createFileRoute('/safety/vacation-returns')({
  component: VacationReturnsPage,
});
