import { createFileRoute } from '@tanstack/react-router';
import { PtiPage } from '@/features/fleet/PtiPage';
import { ptiSearchSchema } from '@/features/fleet/pti-search';

export const Route = createFileRoute('/fleet/pti')({
  validateSearch: ptiSearchSchema,
  component: PtiPage,
});
