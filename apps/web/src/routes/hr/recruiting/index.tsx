import { createFileRoute } from '@tanstack/react-router';
import { RecruitingPage } from '@/features/hr/RecruitingPage';
import { hrSearchSchema } from '@/features/hr/hr-search';

export const Route = createFileRoute('/hr/recruiting/')({
  validateSearch: hrSearchSchema,
  component: RecruitingPage,
});
