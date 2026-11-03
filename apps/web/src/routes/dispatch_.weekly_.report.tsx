import { createFileRoute } from '@tanstack/react-router';
import { WeeklyReportPage } from '@/features/dispatch/board/WeeklyReportPage';
import { weeklyBoardSearchSchema } from '@/features/dispatch/board/search';

export const Route = createFileRoute('/dispatch_/weekly_/report')({
  validateSearch: weeklyBoardSearchSchema,
  component: WeeklyReportPage,
});
