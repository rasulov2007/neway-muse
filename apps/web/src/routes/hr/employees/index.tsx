import { createFileRoute } from '@tanstack/react-router';
import { EmployeesPage } from '@/features/people/EmployeesPage';
import { employeesSearchSchema } from '@/features/people/employees-search';

export const Route = createFileRoute('/hr/employees/')({
  validateSearch: employeesSearchSchema,
  component: EmployeesPage,
});
