import { createFileRoute } from '@tanstack/react-router';
import { AuditLogPage } from '@/features/admin/AuditLogPage';
import { adminSearchSchema } from '@/features/admin/admin-search';

export const Route = createFileRoute('/admin/audit-logs')({
  validateSearch: adminSearchSchema,
  component: AuditLogPage,
});
