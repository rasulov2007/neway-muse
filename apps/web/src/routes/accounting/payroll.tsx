import { createFileRoute } from '@tanstack/react-router';
import { PayrollPage } from '@/features/accounting/PayrollPage';
import { payrollSearchSchema } from '@/features/accounting/payroll-search';

export const Route = createFileRoute('/accounting/payroll')({
  validateSearch: payrollSearchSchema,
  component: PayrollPage,
});
