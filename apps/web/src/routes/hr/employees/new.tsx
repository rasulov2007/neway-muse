import { createFileRoute } from '@tanstack/react-router';
import { EmployeeFormPage } from '@/features/people/EmployeeFormPage';

export const Route = createFileRoute('/hr/employees/new')({
  component: EmployeeFormPage,
});
