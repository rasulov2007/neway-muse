import { createFileRoute } from '@tanstack/react-router';
import { InvoicesPage } from '@/features/accounting/InvoicesPage';
import { invoicesSearchSchema } from '@/features/accounting/invoices-search';

export const Route = createFileRoute('/accounting/invoices/')({
  validateSearch: invoicesSearchSchema,
  component: InvoicesPage,
});
