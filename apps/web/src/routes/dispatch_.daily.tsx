import { createFileRoute } from '@tanstack/react-router';
import { DailyBoardPage } from '@/features/dispatch/board/DailyBoardPage';
import { dailyBoardSearchSchema } from '@/features/dispatch/board/search';

export const Route = createFileRoute('/dispatch_/daily')({
  validateSearch: dailyBoardSearchSchema,
  component: DailyBoardPage,
});
