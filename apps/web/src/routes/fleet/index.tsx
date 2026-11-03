import { createFileRoute } from '@tanstack/react-router';
import { ExpenseSummaryPage } from '@/features/fleet/ExpenseSummaryPage';
import { expenseSearchSchema } from '@/features/fleet/expense-search';

export const Route = createFileRoute('/fleet/')({
  validateSearch: expenseSearchSchema,
  component: ExpenseSummaryPage,
});
