import { createFileRoute } from '@tanstack/react-router';
import { DriversPage } from '@/features/operations/DriversPage';
import { driversSearchSchema } from '@/features/operations/drivers-search';

export const Route = createFileRoute('/drivers/')({
  validateSearch: driversSearchSchema,
  component: DriversPage,
});
