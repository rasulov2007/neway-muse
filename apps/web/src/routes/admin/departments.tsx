import { createFileRoute } from '@tanstack/react-router';
import { DepartmentsPage } from '@/features/admin/DepartmentsPage';

export const Route = createFileRoute('/admin/departments')({
  component: DepartmentsPage,
});
