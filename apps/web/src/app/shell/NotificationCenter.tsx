import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CheckCheck,
  CircleCheck,
  Info,
  MailCheck,
  OctagonAlert,
  TriangleAlert,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  type Notification,
} from '@/demo';
import { Button, Drawer, EmptyState, ErrorState, Skeleton, Tabs, cn } from '@/design-system';
import { formatRelative } from '@/lib/format';
import { useOpenProblems } from '@/features/loads/useLoadProblems';
import { LOAD_PROBLEM_KIND_LABELS } from '@neway/shared';
import { useShellState } from './shellState';

const severityIcon: Record<Notification['severity'], ReactNode> = {
  critical: <OctagonAlert aria-hidden className="text-danger-text" />,
  warning: <TriangleAlert aria-hidden className="text-warning-text" />,
  info: <Info aria-hidden className="text-info-text" />,
  success: <CircleCheck aria-hidden className="text-success-text" />,
};

const severityLabel: Record<Notification['severity'], string> = {
  critical: 'Critical',
  warning: 'Warning',
  info: 'Info',
  success: 'Success',
};

type Tab = 'all' | 'unread';

/** Right-side panel listing notifications; opened from the topbar bell. */
export function NotificationCenter() {
  const { notificationsOpen, setNotificationsOpen } = useShellState();
  const [tab, setTab] = useState<Tab>('all');
  const queryClient = useQueryClient();
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });

  const query = useQuery({
    queryKey: ['notifications'],
    queryFn: () => listNotifications(),
    enabled: notificationsOpen,
  });
  const markRead = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: invalidate,
  });
  const markAll = useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: invalidate,
  });

  /*
   * Open flags (rule 1.10) are notifications for as long as they are open: one item per flag,
   * ahead of everything else, gone the moment somebody closes it.
   */
  const problems = useOpenProblems();
  const flagItems: Notification[] = (problems.data ?? []).map((p) => ({
    id: `flag_${p.id}`,
    kind: 'load',
    severity: 'warning',
    title: `${p.loadNumber} flagged: ${LOAD_PROBLEM_KIND_LABELS[p.kind] ?? p.kind}`,
    body: `${p.note} — ${p.openedByName}`,
    department: 'dispatch',
    entity: { type: 'load', id: p.loadId, label: p.loadNumber },
    source: 'user',
    actionRequired: true,
    at: p.openedAt,
    readAt: p.openedAt,
  }));
  const items = [...flagItems, ...(query.data?.data ?? [])];
  const unread = query.data?.unread ?? 0;
  const visible = tab === 'unread' ? items.filter((n) => n.readAt === null) : items;

  let body: ReactNode;
  if (query.isPending) {
    body = (
      <div role="status" aria-label="Loading notifications" className="divide-y divide-line-soft">
        {Array.from({ length: 6 }).map((_, i) => (
          <div key={i} className="flex gap-3 px-5 py-3">
            <Skeleton variant="circle" className="mt-0.5 size-4 shrink-0" />
            <div className="flex-1">
              <Skeleton className="h-3 w-2/3" />
              <Skeleton className="mt-2 h-3 w-full" />
              <Skeleton className="mt-1.5 h-3 w-1/3" />
            </div>
          </div>
        ))}
      </div>
    );
  } else if (query.isError) {
    body = (
      <ErrorState
        size="sm"
        title="Unable to load notifications"
        error={query.error}
        onRetry={() => void query.refetch()}
        retrying={query.isFetching}
      />
    );
  } else if (visible.length === 0) {
    body = (
      <EmptyState
        icon={<MailCheck />}
        title="You're all caught up"
        description={
          tab === 'unread'
            ? 'No unread notifications.'
            : 'New alerts about loads, trucks, drivers and invoices will appear here.'
        }
      />
    );
  } else {
    body = (
      <ul role="list" className="divide-y divide-line-soft">
        {visible.map((n) => {
          const isUnread = n.readAt === null;
          return (
            <li key={n.id}>
              <button
                type="button"
                onClick={() => {
                  if (isUnread) markRead.mutate(n.id);
                }}
                className={cn(
                  'flex w-full gap-3 px-5 py-3 text-left transition-colors duration-(--duration-fast) hover:bg-surface-hover',
                  'focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                )}
              >
                <span className="mt-0.5 shrink-0 [&_svg]:size-4" title={severityLabel[n.severity]}>
                  {severityIcon[n.severity]}
                  <span className="sr-only">{severityLabel[n.severity]}</span>
                </span>
                <span className="min-w-0 flex-1">
                  <span className="flex items-start justify-between gap-3">
                    <span
                      className={cn(
                        'text-sm font-medium',
                        isUnread ? 'text-ink' : 'text-secondary',
                      )}
                    >
                      {n.title}
                    </span>
                    <span className="flex shrink-0 items-center gap-1.5 pt-0.5 text-xs whitespace-nowrap text-muted">
                      <time dateTime={n.at}>{formatRelative(n.at)}</time>
                      {isUnread ? (
                        <span aria-hidden className="size-1.5 rounded-full bg-primary" />
                      ) : null}
                      {isUnread ? <span className="sr-only">Unread</span> : null}
                    </span>
                  </span>
                  <span className="mt-0.5 line-clamp-2 block text-xs text-secondary">{n.body}</span>
                  {n.entity ? (
                    <span className="mt-1 block text-xs text-primary-text">{n.entity.label}</span>
                  ) : null}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    );
  }

  return (
    <Drawer
      open={notificationsOpen}
      onOpenChange={setNotificationsOpen}
      size="md"
      title="Notifications"
      bodyClassName="p-0"
      tabs={
        <div className="flex items-center justify-between gap-3">
          <Tabs
            aria-label="Notification filters"
            value={tab}
            onValueChange={(v) => setTab(v as Tab)}
            listClassName="border-b-0"
            items={[
              { value: 'all', label: 'All' },
              { value: 'unread', label: 'Unread', count: unread },
            ]}
          />
          <Button
            variant="ghost"
            size="sm"
            icon={<CheckCheck />}
            disabled={unread === 0}
            loading={markAll.isPending}
            onClick={() => markAll.mutate()}
          >
            Mark all read
          </Button>
        </div>
      }
    >
      {body}
    </Drawer>
  );
}
