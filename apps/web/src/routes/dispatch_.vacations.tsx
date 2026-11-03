import { createFileRoute } from '@tanstack/react-router';
import { VacationBoardPage } from '@/features/dispatch/roster/VacationBoardPage';

export const Route = createFileRoute('/dispatch_/vacations')({
  component: VacationBoardPage,
});
