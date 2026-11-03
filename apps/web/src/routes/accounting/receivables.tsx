import { createFileRoute } from '@tanstack/react-router';
import { ReceivablesPage } from '@/features/accounting/ReceivablesPage';
import { receivablesSearchSchema } from '@/features/accounting/receivables-search';

export const Route = createFileRoute('/accounting/receivables')({
  validateSearch: receivablesSearchSchema,
  component: ReceivablesPage,
});
