import { createFileRoute } from '@tanstack/react-router';
import { InvoiceDetailRoute } from '@/features/accounting/InvoiceDetailPage';

export const Route = createFileRoute('/accounting/invoices/$invoiceId')({
  component: InvoiceDetailRoute,
});
