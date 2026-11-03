import { createFileRoute } from '@tanstack/react-router';
import { CompaniesPage } from '@/features/platform/CompaniesPage';

export const Route = createFileRoute('/platform/companies')({
  component: CompaniesPage,
});
