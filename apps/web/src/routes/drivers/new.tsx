import { createFileRoute } from '@tanstack/react-router';
import { DriverFormPage } from '@/features/operations/DriverFormPage';

export const Route = createFileRoute('/drivers/new')({
  component: DriverFormPage,
});
