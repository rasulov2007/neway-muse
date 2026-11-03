import { createFileRoute } from '@tanstack/react-router';
import { SpendCategoryPage } from '@/features/fleet/SpendCategoryPage';
import { expenseSearchSchema } from '@/features/fleet/expense-search';

/**
 * One category's records. The overview's period and unit filters ride in the search, so a direct
 * link or a refresh lands on the same set of records the amount was read from.
 */
export const Route = createFileRoute('/fleet/spending/categories/$categoryId')({
  validateSearch: expenseSearchSchema,
  component: RouteComponent,
});

function RouteComponent() {
  const { categoryId } = Route.useParams();
  return <SpendCategoryPage categoryId={categoryId} />;
}
