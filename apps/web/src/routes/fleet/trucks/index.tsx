import { createFileRoute } from '@tanstack/react-router';
import { TrucksPage } from '@/features/fleet/TrucksPage';
import { trucksSearchSchema } from '@/features/fleet/trucks-search';

export const Route = createFileRoute('/fleet/trucks/')({
  validateSearch: trucksSearchSchema,
  component: TrucksPage,
});
