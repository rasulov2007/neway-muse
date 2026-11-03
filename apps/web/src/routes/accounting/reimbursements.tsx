import { createFileRoute } from '@tanstack/react-router';
import { ReimbursementsPage } from '@/features/accounting/ReimbursementsPage';
import { reimbursementsSearchSchema } from '@/features/accounting/reimbursements-search';

export const Route = createFileRoute('/accounting/reimbursements')({
  validateSearch: reimbursementsSearchSchema,
  component: ReimbursementsPage,
});
