import { createFileRoute } from '@tanstack/react-router';
import { ReportsPage } from '@/features/insights/ReportsPage';
import { insightsSearchSchema } from '@/features/insights/insights-search';

export const Route = createFileRoute('/reports/')({
  validateSearch: insightsSearchSchema,
  component: ReportsPage,
});
