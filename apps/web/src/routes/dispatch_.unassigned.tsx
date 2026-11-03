import { createFileRoute } from '@tanstack/react-router';
import { DailyBoardPage } from '@/features/dispatch/board/DailyBoardPage';
import { dailyBoardSearchSchema } from '@/features/dispatch/board/search';

/** The drivers with no dispatcher, on a page of their own beside Dispatcher rotation (owner, 2026-10-25). */
export const Route = createFileRoute('/dispatch_/unassigned')({
  validateSearch: dailyBoardSearchSchema,
  component: UnassignedDriversPage,
});

function UnassignedDriversPage() {
  return <DailyBoardPage scope="unassigned" />;
}
