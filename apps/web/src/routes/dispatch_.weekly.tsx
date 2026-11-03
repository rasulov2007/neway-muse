import { createFileRoute } from '@tanstack/react-router';
import { WeeklyBoardPage } from '@/features/dispatch/board/WeeklyBoardPage';
import { weeklyBoardSearchSchema } from '@/features/dispatch/board/search';

export const Route = createFileRoute('/dispatch_/weekly')({
  validateSearch: weeklyBoardSearchSchema,
  component: WeeklyBoardPage,
});
