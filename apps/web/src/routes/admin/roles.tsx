import { createFileRoute } from '@tanstack/react-router';
import { RolesPage } from '@/features/admin/RolesPage';

export const Route = createFileRoute('/admin/roles')({
  component: RolesPage,
});
