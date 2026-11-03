import { createFileRoute } from '@tanstack/react-router';
import { BrokersPage } from '@/features/operations/BrokersPage';
import { brokersSearchSchema } from '@/features/operations/brokers-search';

export const Route = createFileRoute('/brokers/')({
  validateSearch: brokersSearchSchema,
  component: BrokersPage,
});
