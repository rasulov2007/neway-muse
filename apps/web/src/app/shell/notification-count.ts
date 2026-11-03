import { useQuery } from '@tanstack/react-query';
import { listNotifications } from '@/demo';
import { useNotificationPreferences } from '@/features/notifications/usePreferences';

/**
 * The red number on the bell and on Notifications in the sidebar (owner, 2026-10-06): every
 * notification still unread or still needing action, in the categories this person has kept on —
 * a muted category counts for nothing here, as on the page. Reading one does not clear "needs
 * action"; that goes when the thing behind it is dealt with. Shares the bell's query.
 */
export function useNotificationAttention(): number {
  // The bell refreshes on its own (owner, 2026-10-12): a consent or an application arriving is announced
  // within half a minute, not on the next page load.
  const { data } = useQuery({ queryKey: ['notifications'], queryFn: () => listNotifications(), refetchInterval: 30_000 });
  const { isKindEnabled } = useNotificationPreferences();
  return (data?.data ?? []).filter(
    (n) => isKindEnabled(n.kind) && (n.readAt === null || n.actionRequired),
  ).length;
}
