import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { TruckDetailRoute } from '@/features/fleet/TruckDetailPage';
import { TRUCK_TABS } from '@/features/fleet/fleet-ui';

const searchSchema = z.object({
  // The truck's Costs tab became Expenses (owner, 2026-10-12): old ?tab=costs links land there.
  tab: z
    .preprocess((v) => (v === 'costs' ? 'expenses' : v), z.enum(TRUCK_TABS).optional())
    .catch(undefined),
});

export const Route = createFileRoute('/fleet/trucks/$truckId')({
  validateSearch: searchSchema,
  component: TruckDetailRoute,
});
