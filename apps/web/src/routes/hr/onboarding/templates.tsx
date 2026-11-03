import { createFileRoute } from '@tanstack/react-router';
import { OnboardingTemplatesPage } from '@/features/hr/OnboardingTemplatesPage';

export const Route = createFileRoute('/hr/onboarding/templates')({
  component: OnboardingTemplatesPage,
});
