import { createFileRoute } from '@tanstack/react-router';
import { safetySearchSchema } from '@/features/safety/safety-search';
import { SafetyHomeRoute } from '@/features/safety/v2/routes';

export const Route = createFileRoute('/safety/')({
  validateSearch: safetySearchSchema,
  component: SafetyHomeRoute,
});
