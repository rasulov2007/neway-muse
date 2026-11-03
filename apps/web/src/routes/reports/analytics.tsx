import { createFileRoute } from '@tanstack/react-router';
import { AnalyticsPage } from '@/features/insights/AnalyticsPage';
import { insightsSearchSchema } from '@/features/insights/insights-search';

export const Route = createFileRoute('/reports/analytics')({
  validateSearch: insightsSearchSchema,
  component: AnalyticsPage,
});
