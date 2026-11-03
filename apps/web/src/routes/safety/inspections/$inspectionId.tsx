import { createFileRoute } from '@tanstack/react-router';
import { InspectionDetailRoute } from '@/features/safety/InspectionDetailPage';

export const Route = createFileRoute('/safety/inspections/$inspectionId')({
  component: InspectionDetailRoute,
});
