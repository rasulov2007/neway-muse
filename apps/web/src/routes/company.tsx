import { createFileRoute } from '@tanstack/react-router';
import { CompanyInfoPage } from '@/features/company/CompanyInfoPage';

export const Route = createFileRoute('/company')({
  component: CompanyInfoPage,
});
