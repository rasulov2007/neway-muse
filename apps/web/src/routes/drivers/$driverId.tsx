import { createFileRoute } from '@tanstack/react-router';
import { DriverProfileRoute } from '@/features/operations/DriverProfilePage';

export const Route = createFileRoute('/drivers/$driverId')({
  component: DriverProfileRoute,
});
