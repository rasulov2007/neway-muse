import { createFileRoute } from '@tanstack/react-router';
import { accidentsSearchSchema } from '@/features/safety/accidents-search';
import { AccidentsRoute } from '@/features/safety/v2/routes';

export const Route = createFileRoute('/safety/accidents/')({
  validateSearch: accidentsSearchSchema,
  component: AccidentsRoute,
});
