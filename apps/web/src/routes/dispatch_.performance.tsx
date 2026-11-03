import { createFileRoute } from '@tanstack/react-router';
import { PerformancePage } from '@/features/dispatch/board/PerformancePage';
import { salarySearchSchema } from '@/features/dispatch/board/search';

export const Route = createFileRoute('/dispatch_/performance')({
  validateSearch: salarySearchSchema,
  component: PerformancePage,
});
