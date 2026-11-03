import { createFileRoute } from '@tanstack/react-router';
import { SettlementsPage } from '@/features/accounting/SettlementsPage';
import { settlementsSearchSchema } from '@/features/accounting/settlements-search';

export const Route = createFileRoute('/accounting/settlements/')({
  validateSearch: settlementsSearchSchema,
  component: SettlementsPage,
});
