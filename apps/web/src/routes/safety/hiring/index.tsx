import { createFileRoute } from '@tanstack/react-router';
import { SafetyHiringPage } from '@/features/safety/hiring/SafetyHiringPage';

export const Route = createFileRoute('/safety/hiring/')({
  component: SafetyHiringPage,
});
