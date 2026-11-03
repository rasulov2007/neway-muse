import { createFileRoute } from '@tanstack/react-router';
import { PerformancePage } from '@/features/hr/PerformancePage';
import { hrSearchSchema } from '@/features/hr/hr-search';

export const Route = createFileRoute('/hr/performance')({
  validateSearch: hrSearchSchema,
  component: PerformancePage,
});
