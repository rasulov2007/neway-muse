import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { violationsSearchSchema } from '@/features/safety/violations-search';
import { ViolationsRoute } from '@/features/safety/v2/routes';

export const Route = createFileRoute('/safety/violations/')({
  // `open` names the violation Safety v2 opens in its drawer; the old page ignores it.
  validateSearch: violationsSearchSchema.extend({ open: z.string().optional() }),
  component: ViolationsRoute,
});
