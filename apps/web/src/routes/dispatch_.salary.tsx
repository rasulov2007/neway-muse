import { createFileRoute } from '@tanstack/react-router';
import { SalaryReportPage } from '@/features/dispatch/board/SalaryReportPage';
import { salarySearchSchema } from '@/features/dispatch/board/search';

export const Route = createFileRoute('/dispatch_/salary')({
  validateSearch: salarySearchSchema,
  component: SalaryReportPage,
});
