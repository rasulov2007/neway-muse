import { createFileRoute } from '@tanstack/react-router';
import { BrokerFormPage } from '@/features/operations/BrokerFormPage';

export const Route = createFileRoute('/brokers/new')({
  component: BrokerFormPage,
});
