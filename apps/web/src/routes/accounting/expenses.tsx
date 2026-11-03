import { createFileRoute } from '@tanstack/react-router';
import { ExpensesPage } from '@/features/accounting/ExpensesPage';
import { expensesSearchSchema } from '@/features/accounting/expenses-search';

export const Route = createFileRoute('/accounting/expenses')({
  validateSearch: expensesSearchSchema,
  component: ExpensesPage,
});
