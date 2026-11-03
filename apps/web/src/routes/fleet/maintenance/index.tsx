import { createFileRoute } from '@tanstack/react-router';
import { RepairLogRoute } from '@/features/fleet/RepairLogPage';
import { maintenanceSearchSchema } from '@/features/fleet/maintenance-search';

export const Route = createFileRoute('/fleet/maintenance/')({
  validateSearch: maintenanceSearchSchema,
  component: RepairLogRoute,
});
