import { createFileRoute } from '@tanstack/react-router';
import { CustomersPage } from '@/features/operations/CustomersPage';
import { customersSearchSchema } from '@/features/operations/customers-search';

export const Route = createFileRoute('/customers')({
  validateSearch: customersSearchSchema,
  component: CustomersPage,
});
