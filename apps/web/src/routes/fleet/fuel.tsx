import { createFileRoute } from '@tanstack/react-router';
import { FuelPage } from '@/features/fleet/FuelPage';
import { fuelSearchSchema } from '@/features/fleet/fuel-search';

export const Route = createFileRoute('/fleet/fuel')({
  validateSearch: fuelSearchSchema,
  component: FuelPage,
});
