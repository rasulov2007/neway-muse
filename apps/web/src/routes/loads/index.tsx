import { createFileRoute } from '@tanstack/react-router';
import { LoadsPage } from '@/features/loads/LoadsPage';
import { loadsSearchSchema } from '@/features/loads/loads-search';

export const Route = createFileRoute('/loads/')({
  validateSearch: loadsSearchSchema,
  component: LoadsPage,
});
