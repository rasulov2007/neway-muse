import { createFileRoute } from '@tanstack/react-router';
import { FleetExpensesListPage } from '@/features/fleet/expenses/FleetExpensesPages';
import { fleetExpensesSearchSchema } from '@/features/fleet/expenses/expenses-search';

export const Route = createFileRoute('/fleet/expenses/list')({
  validateSearch: fleetExpensesSearchSchema,
  component: FleetExpensesListPage,
});
