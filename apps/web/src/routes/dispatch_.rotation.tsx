import { createFileRoute } from '@tanstack/react-router';
import { RotationPage } from '@/features/dispatch/roster/RotationPage';

export const Route = createFileRoute('/dispatch_/rotation')({
  component: RotationPage,
});
