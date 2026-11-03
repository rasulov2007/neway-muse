import { createFileRoute } from '@tanstack/react-router';
import { PayablesPage } from '@/features/accounting/PayablesPage';
import { payablesSearchSchema } from '@/features/accounting/payables-search';

export const Route = createFileRoute('/accounting/payables')({
  validateSearch: payablesSearchSchema,
  component: PayablesPage,
});
