import { createFileRoute } from '@tanstack/react-router';
import { complianceSearchSchema } from '@/features/safety/safety-search';
import { ComplianceRoute } from '@/features/safety/v2/routes';

export const Route = createFileRoute('/safety/compliance')({
  validateSearch: (search) => complianceSearchSchema.parse(search),
  component: ComplianceRoute,
});
