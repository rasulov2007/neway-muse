import { createFileRoute } from '@tanstack/react-router';
import { AttendancePage } from '@/features/hr/AttendancePage';
import { hrSearchSchema } from '@/features/hr/hr-search';

export const Route = createFileRoute('/hr/attendance')({
  validateSearch: hrSearchSchema,
  component: AttendancePage,
});
