import { createFileRoute } from '@tanstack/react-router';
import { inspectionsSearchSchema } from '@/features/safety/inspections-search';
import { InspectionsRoute } from '@/features/safety/v2/routes';

export const Route = createFileRoute('/safety/inspections/')({
  validateSearch: inspectionsSearchSchema,
  component: InspectionsRoute,
});
