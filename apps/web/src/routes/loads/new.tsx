import { createFileRoute } from '@tanstack/react-router';
import { LoadFormPage } from '@/features/loads/LoadFormPage';

export const Route = createFileRoute('/loads/new')({
  component: LoadFormPage,
});
