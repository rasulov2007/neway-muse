import { createFileRoute } from '@tanstack/react-router';
import { OnboardingPage } from '@/features/hr/OnboardingPage';
import { hrSearchSchema } from '@/features/hr/hr-search';

export const Route = createFileRoute('/hr/onboarding/')({
  validateSearch: hrSearchSchema,
  component: OnboardingPage,
});
