import { createFileRoute } from '@tanstack/react-router';
import { TruckFormPage } from '@/features/fleet/TruckFormPage';

export const Route = createFileRoute('/fleet/trucks/new')({
  component: TruckFormPage,
});
