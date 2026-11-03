import { createFileRoute } from '@tanstack/react-router';
import { DashboardPage } from '@/features/dashboard/DashboardPage';
import { parseDashboardSearch } from '@/features/dashboard/period/search';

export const Route = createFileRoute('/dashboard')({
  validateSearch: (search) => parseDashboardSearch(search),
  component: DashboardPage,
});
