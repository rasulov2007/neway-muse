import { createFileRoute, redirect } from '@tanstack/react-router';
import { dispatchSearchSchema } from '@/features/operations/dispatch-search';

/**
 * Dispatch was the same page as Loads under another name.
 *
 * The route stays as a redirect rather than being deleted: bookmarks, notification targets and
 * the shared attention queue all point here (`/dispatch?risk=critical`), and a dead link to work
 * somebody saved is a worse outcome than a hop. The risk filter maps onto the Loads view that
 * means the same thing, so a link that used to open the critical loads still opens them.
 */
export const Route = createFileRoute('/dispatch')({
  validateSearch: dispatchSearchSchema,
  beforeLoad: ({ search }) => {
    const view = search.risk === 'critical' || search.risk === 'at_risk' ? 'at_risk' : undefined;
    throw redirect({ to: '/loads', search: view ? { view } : {}, replace: true });
  },
});
