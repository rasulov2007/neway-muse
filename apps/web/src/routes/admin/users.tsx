import { createFileRoute } from '@tanstack/react-router';
import { UsersPage } from '@/features/admin/UsersPage';
import { adminSearchSchema } from '@/features/admin/admin-search';

export const Route = createFileRoute('/admin/users')({
  validateSearch: adminSearchSchema,
  component: UsersPage,
});
