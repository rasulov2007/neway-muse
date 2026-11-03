import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { BellOff, CheckCheck, SearchX } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  deleteNotification,
  listNotifications,
  markAllNotificationsRead,
  markNotificationRead,
  markNotificationUnread,
  type Notification,
} from '@/demo';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  FilterBar,
  PageHeader,
  Pagination,
  Skeleton,
  Tabs,
  useToast,
  type DateRange,
} from '@/design-system';
import { NotificationRow } from './NotificationRow';
import { DeliveryPanel, PreferencesPanel } from './PreferencesPanel';
import { KINDS, KIND_ORDER, SEVERITIES, SEVERITY_ORDER } from './event-kind';
import { CATEGORIES } from './preferences';
import { useNotificationPreferences } from './usePreferences';

const PAGE_SIZE = 10;

type TabKey = 'all' | 'action' | 'unread' | 'mentions' | 'system';

/**
 * Tabs split on two axes on purpose: `all`/`action`/`unread` are about the state of the event,
 * `mentions`/`system` are about who raised it. `source: 'user'` is the closest thing the model has
 * to a mention — an item a teammate posted rather than one the platform, a workflow or a detector
 * raised — so the tab filters on that rather than on a field that does not exist.
 */
const TAB_FILTERS: Record<TabKey, (n: Notification) => boolean> = {
  all: () => true,
  action: (n) => n.actionRequired,
  unread: (n) => n.readAt === null,
  mentions: (n) => n.source === 'user',
  system: (n) => n.source === 'system',
};

interface FilterValues {
  kind?: string;
  severity?: string;
  date?: DateRange;
}

function inRange(at: string, range: DateRange | undefined): boolean {
  if (!range?.from) return true;
  const time = new Date(at).getTime();
  if (Number.isNaN(time)) return false;
  const from = new Date(range.from);
  from.setHours(0, 0, 0, 0);
  if (time < from.getTime()) return false;
  if (!range.to) return true;
  const to = new Date(range.to);
  to.setHours(23, 59, 59, 999);
  return time <= to.getTime();
}

function matchesSearch(n: Notification, search: string): boolean {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return [n.title, n.body, n.entity?.label, KINDS[n.kind].label].some(
    (value) => value && value.toLowerCase().includes(query),
  );
}

/** Operational event centre: what happened, how urgent, which object, and what to do next. */
export function NotificationsPage() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const preferences = useNotificationPreferences();

  const [tab, setTab] = useState<TabKey>('all');
  const [search, setSearch] = useState('');
  const [filters, setFilters] = useState<FilterValues>({});
  const [page, setPage] = useState(1);

  // Same query key as the topbar's notification drawer, so the two share one cache entry and one
  // request rather than each fetching the list.
  const query = useQuery({ queryKey: ['notifications'], queryFn: () => listNotifications() });
  const invalidate = () => queryClient.invalidateQueries({ queryKey: ['notifications'] });

  // Wrapped rather than passed directly: react-query hands the mutation function a context
  // object as its second argument, which the demo API would read as simulate options.
  const markRead = useMutation({
    mutationFn: (id: string) => markNotificationRead(id),
    onSuccess: invalidate,
  });
  const markUnread = useMutation({
    mutationFn: (id: string) => markNotificationUnread(id),
    onSuccess: invalidate,
  });
  const markAll = useMutation({
    mutationFn: () => markAllNotificationsRead(),
    onSuccess: invalidate,
  });
  const remove = useMutation({
    mutationFn: (id: string) => deleteNotification(id),
    onSuccess: () => {
      invalidate();
      toast({ tone: 'success', title: 'Notification deleted' });
    },
  });

  const all = useMemo(() => query.data?.data ?? [], [query.data]);

  // Muted categories are removed before anything else, so tab counts reflect what the user has
  // actually chosen to receive.
  const subscribed = useMemo(
    () => all.filter((n) => preferences.isKindEnabled(n.kind)),
    [all, preferences],
  );

  const counts = useMemo(
    () => ({
      all: subscribed.length,
      action: subscribed.filter(TAB_FILTERS.action).length,
      unread: subscribed.filter(TAB_FILTERS.unread).length,
      mentions: subscribed.filter(TAB_FILTERS.mentions).length,
      system: subscribed.filter(TAB_FILTERS.system).length,
    }),
    [subscribed],
  );

  const filtered = useMemo(
    () =>
      subscribed
        .filter(TAB_FILTERS[tab])
        .filter((n) => matchesSearch(n, search))
        .filter((n) => !filters.kind || n.kind === filters.kind)
        .filter((n) => !filters.severity || n.severity === filters.severity)
        .filter((n) => inRange(n.at, filters.date))
        .sort((a, b) => b.at.localeCompare(a.at)),
    [subscribed, tab, search, filters],
  );

  const pageCount = Math.max(1, Math.ceil(filtered.length / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount);
  const rows = filtered.slice((currentPage - 1) * PAGE_SIZE, currentPage * PAGE_SIZE);

  const hasFilters =
    search.trim() !== '' || Boolean(filters.kind ?? filters.severity ?? filters.date);
  const changeFilter = (key: string, value: unknown) => {
    setFilters((current) => ({ ...current, [key]: value }));
    setPage(1);
  };

  const mute = (notification: Notification) => {
    const key = preferences.muteKind(notification.kind);
    const category = CATEGORIES.find((c) => c.key === key);
    toast({
      tone: 'info',
      title: `${category?.label ?? 'Category'} muted`,
      description: 'These notifications are hidden until you switch the category back on.',
    });
  };

  return (
    // `page-surface-workspace` asks the shell's <main> for the cooler analytics ground the
    // dashboard already uses, so the two pages read as one product (tokens.css).
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Notifications"
        description="Stay up to date with important fleet, load, maintenance, financial and system events."
        meta={
          counts.action > 0 ? (
            <Badge tone="warning" size="sm">
              {counts.action} need action
            </Badge>
          ) : null
        }
      />

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-4">
        <div className="min-w-0 xl:col-span-3">
          <Card padding="none" data-testid="notification-list">
            <div className="flex flex-col gap-3 border-b border-line-soft px-(--card-padding) pt-3 pb-3">
              <Tabs
                aria-label="Notification filters"
                variant="segmented"
                listClassName="scroll-quiet overflow-x-auto"
                value={tab}
                onValueChange={(value) => {
                  setTab(value as TabKey);
                  setPage(1);
                }}
                items={[
                  { value: 'all', label: 'All', count: counts.all },
                  { value: 'action', label: 'Needs action', count: counts.action },
                  { value: 'unread', label: 'Unread', count: counts.unread },
                  { value: 'mentions', label: 'Mentions', count: counts.mentions },
                  { value: 'system', label: 'System', count: counts.system },
                ]}
              />
              <FilterBar
                search={{
                  value: search,
                  onChange: (value) => {
                    setSearch(value);
                    setPage(1);
                  },
                  placeholder: 'Search notifications (load #, unit #, driver, etc.)',
                }}
                values={filters as Record<string, unknown>}
                onChange={changeFilter}
                onClear={() => {
                  setFilters({});
                  setSearch('');
                  setPage(1);
                }}
                filters={[
                  {
                    key: 'kind',
                    label: 'Type',
                    type: 'select',
                    options: KIND_ORDER.map((kind) => ({ value: kind, label: KINDS[kind].label })),
                  },
                  {
                    key: 'severity',
                    label: 'Priority',
                    type: 'select',
                    options: SEVERITY_ORDER.map((severity) => ({
                      value: severity,
                      label: SEVERITIES[severity].label,
                    })),
                  },
                  { key: 'date', label: 'Date', type: 'daterange' },
                ]}
              >
                {/* Search, filters and the primary action on one row. */}
                <span className="ml-auto flex items-center gap-2">
                  <Button
                    variant="secondary"
                    icon={<CheckCheck />}
                    disabled={counts.unread === 0}
                    loading={markAll.isPending}
                    onClick={() => markAll.mutate()}
                  >
                    Mark all read
                  </Button>
                </span>
              </FilterBar>
            </div>

            {query.isPending ? (
              <NotificationListSkeleton />
            ) : query.isError ? (
              <ErrorState
                title="Notifications couldn't be loaded"
                description="Please try again."
                error={query.error}
                onRetry={() => void query.refetch()}
                retrying={query.isFetching}
              />
            ) : rows.length === 0 ? (
              hasFilters || tab !== 'all' ? (
                <EmptyState
                  icon={<SearchX />}
                  title="No notifications found"
                  description="Try changing your filters or search query."
                />
              ) : (
                <EmptyState
                  icon={<BellOff />}
                  title="No notifications"
                  description={
                    counts.all === 0 && all.length > 0
                      ? 'Every category is muted. Switch one back on to see events here.'
                      : "You're all caught up."
                  }
                />
              )
            ) : (
              <>
                {/* `relative` keeps absolutely positioned screen-reader text inside this scroll
                    container instead of stretching the page on narrow viewports. */}
                <div className="scroll-quiet relative w-full overflow-x-auto">
                  <table className="w-full text-sm max-md:block">
                    <caption className="sr-only">
                      Notifications: event, related object, time, priority and the action it needs.
                    </caption>
                    <thead className="max-md:hidden">
                      <tr className="border-b border-line-soft bg-surface-muted text-xs text-secondary">
                        <th
                          scope="col"
                          className="px-4 py-2 text-left font-semibold whitespace-nowrap"
                        >
                          Type
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-2 text-left font-semibold whitespace-nowrap"
                        >
                          Details
                        </th>
                        <th
                          scope="col"
                          className="hidden px-4 py-2 text-left font-semibold whitespace-nowrap xl:table-cell"
                        >
                          Related to
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-2 text-left font-semibold whitespace-nowrap"
                        >
                          Time
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-2 text-left font-semibold whitespace-nowrap"
                        >
                          Priority
                        </th>
                        <th
                          scope="col"
                          className="px-4 py-2 text-right font-semibold whitespace-nowrap"
                        >
                          Action
                        </th>
                      </tr>
                    </thead>
                    {/* Keyed so a tab, filter or page change remounts the body and the new
                        result set fades in. `tokens.css` collapses it under reduced motion. */}
                    <tbody
                      key={`${tab}:${currentPage}:${search}:${filters.kind ?? ''}:${filters.severity ?? ''}`}
                      className="animate-fade-in divide-y divide-line-soft max-md:block max-md:divide-y-0"
                    >
                      {rows.map((notification) => (
                        <NotificationRow
                          key={notification.id}
                          notification={notification}
                          onMarkRead={(id) => markRead.mutate(id)}
                          onMarkUnread={(id) => markUnread.mutate(id)}
                          onDelete={(id) => remove.mutate(id)}
                          onMute={mute}
                        />
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="border-t border-line-soft px-(--card-padding) py-2">
                  <Pagination
                    page={currentPage}
                    pageSize={PAGE_SIZE}
                    total={filtered.length}
                    onPageChange={setPage}
                  />
                </div>
              </>
            )}
          </Card>
        </div>

        <div className="min-w-0">
          <PreferencesPanel state={preferences} />
        </div>
      </div>

      <DeliveryPanel state={preferences} />
    </div>
  );
}

function NotificationListSkeleton() {
  return (
    <div role="status" aria-label="Loading notifications" className="divide-y divide-line-soft">
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="flex items-start gap-3 px-(--card-padding) py-3.5">
          <Skeleton variant="circle" className="size-8 shrink-0" />
          <div className="flex-1">
            <Skeleton className="h-3 w-1/3" />
            <Skeleton className="mt-2 h-3 w-2/3" />
          </div>
          <Skeleton className="h-4 w-16 shrink-0" />
        </div>
      ))}
    </div>
  );
}
