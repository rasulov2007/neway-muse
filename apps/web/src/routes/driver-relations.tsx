import { createFileRoute } from '@tanstack/react-router';
import { DriverRelationsPage } from '@/features/driver-relations/DriverRelationsPage';

/** `?request=<id>` opens one request; it is the link a Telegram notification carries. */
export const Route = createFileRoute('/driver-relations')({
  validateSearch: (search: Record<string, unknown>): { request?: string } =>
    typeof search.request === 'string' && search.request.length <= 80 ? { request: search.request } : {},
  component: DriverRelationsPage,
});
