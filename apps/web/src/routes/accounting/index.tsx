import { createFileRoute } from '@tanstack/react-router';
import { AccountingPage } from '@/features/accounting/AccountingPage';
import { accountingSearchSchema } from '@/features/accounting/accounting-search';

export const Route = createFileRoute('/accounting/')({
  validateSearch: accountingSearchSchema,
  component: AccountingPage,
});
