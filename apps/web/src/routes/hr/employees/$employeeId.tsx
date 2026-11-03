import { createFileRoute } from '@tanstack/react-router';
import { EmployeeDetailRoute } from '@/features/people/EmployeeDetailPage';
import { employeesSearchSchema } from '@/features/people/employees-search';

export const Route = createFileRoute('/hr/employees/$employeeId')({
  validateSearch: employeesSearchSchema,
  component: EmployeeDetailRoute,
});
