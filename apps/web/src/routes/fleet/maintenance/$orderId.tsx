import { createFileRoute } from '@tanstack/react-router';
import { WorkOrderRoute } from '@/features/fleet/WorkOrderDetailPage';

export const Route = createFileRoute('/fleet/maintenance/$orderId')({
  component: WorkOrderRoute,
});
