import { createFileRoute } from '@tanstack/react-router';
import { PtoPage } from '@/features/hr/PtoPage';
import { hrSearchSchema } from '@/features/hr/hr-search';

export const Route = createFileRoute('/hr/pto')({
  validateSearch: hrSearchSchema,
  component: PtoPage,
});
