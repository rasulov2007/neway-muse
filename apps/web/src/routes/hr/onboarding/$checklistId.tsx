import { createFileRoute } from '@tanstack/react-router';
import { OnboardingDetailRoute } from '@/features/hr/OnboardingPage';

export const Route = createFileRoute('/hr/onboarding/$checklistId')({
  component: OnboardingDetailRoute,
});
