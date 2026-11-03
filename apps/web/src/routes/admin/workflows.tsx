import { createFileRoute } from '@tanstack/react-router';
import { WorkflowsPage } from '@/features/admin/WorkflowsPage';

export const Route = createFileRoute('/admin/workflows')({
  component: WorkflowsPage,
});
