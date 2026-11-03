import { createFileRoute } from '@tanstack/react-router';
import { z } from 'zod';
import { LoadDetailRoute } from '@/features/loads/LoadDetailPage';
import { LOAD_TABS } from '@/features/loads/loadUtils';

const searchSchema = z.object({
  tab: z.enum(LOAD_TABS).optional().catch(undefined),
});

export const Route = createFileRoute('/loads/$loadNumber')({
  validateSearch: searchSchema,
  component: LoadDetailRoute,
});
