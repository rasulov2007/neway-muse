import { useNavigate, useSearch } from '@tanstack/react-router';
import {
  ChevronLeft,
  ChevronRight,
  CircleDollarSign,
  CreditCard,
  Lock,
  Paperclip,
  MessageCircle,
  Phone,
  Search,
  ShieldCheck,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  DRIVER_RELATION_TOPICS,
  DRIVER_RELATION_TOPIC_HINTS,
  DRIVER_RELATION_TOPIC_LABELS,
  type DriverRelationCounts,
  type DriverRelationListQuery,
  type DriverRelationRequest,
  type DriverRelationTopic,
} from '@neway/shared';
import {
  Badge,
  ErrorState,
  Input,
  PageHeader,
  Select,
  StatusSymbol,
  cn,
} from '@/design-system';
import { formatDate, formatTime } from '@/lib/format';
import {
  useCanContact,
  useDriverRelationCounts,
  useDriverRelationList,
  useIntegrationStatus,
} from './api';
import { CareLinkButton } from './CareLinkPanel';
import { RequestDetail } from './RequestDetail';
import { RequestStatus } from './RequestStatus';

const TOPIC_ICONS: Record<DriverRelationTopic, LucideIcon> = {
  referral: UsersRound,
  complaint_feedback: MessageCircle,
  reimbursement: CircleDollarSign,
  pay_statement: CreditCard,
  compliance: ShieldCheck,
  management_call: Phone,
};

type StatusTab = 'all' | 'needs_contact' | 'contacted' | 'resolved';

function useDebounced<T>(value: T, ms: number): T {
  const [debounced, setDebounced] = useState(value);
  useEffect(() => {
    const timer = window.setTimeout(() => setDebounced(value), ms);
    return () => window.clearTimeout(timer);
  }, [value, ms]);
  return debounced;
}

/**
 * Driver Relations (owner brief 2026-10-06; layout from the owner's image, colours from Porcelain).
 *
 * Six topic cards with their red counts, three totals, the request list and the selected request.
 * Every number is the server's: a request needs contact until somebody records a contact with a
 * note, and nothing on this page clears that by being opened, assigned or attempted.
 */
export function DriverRelationsPage() {
  const search = useSearch({ strict: false }) as { request?: string };
  const navigate = useNavigate();
  const [topic, setTopic] = useState<DriverRelationTopic | undefined>(undefined);
  const [tab, setTab] = useState<StatusTab>('all');
  const [text, setText] = useState('');
  const q = useDebounced(text.trim(), 250);
  const [sort, setSort] = useState<'received_desc' | 'received_asc'>('received_desc');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(25);
  // Typed notes per request, in memory only: switching requests or assigning keeps them.
  const [drafts, setDrafts] = useState<Record<string, string>>({});

  const query: DriverRelationListQuery = { topic, status: tab, q: q || undefined, sort, page, pageSize };
  const counts = useDriverRelationCounts();
  const list = useDriverRelationList(query);
  const canContact = useCanContact();
  const selectedId = search.request ?? null;

  const select = (id: string | null) =>
    void navigate({ to: '.', search: (prev: Record<string, unknown>) => ({ ...prev, request: id ?? undefined }) } as never);

  // A filter change starts the list from its first page (adjusted during render, not in an effect).
  const filterKey = `${topic ?? ''}|${tab}|${q}|${sort}|${pageSize}`;
  const [lastFilterKey, setLastFilterKey] = useState(filterKey);
  if (lastFilterKey !== filterKey) {
    setLastFilterKey(filterKey);
    setPage(1);
  }

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Driver Relations"
        description="Every request. A clear owner. A real follow-up."
        actions={
          <div className="flex flex-wrap items-center gap-2">
            <TelegramStatus />
            <CareLinkButton />
          </div>
        }
      />

      <TopicCards counts={counts.data} loading={counts.isPending} active={topic} onPick={(t) => setTopic(topic === t ? undefined : t)} />
      <Totals counts={counts.data} loading={counts.isPending} error={counts.isError} />

      <section
        aria-label="Requests"
        className="grid grid-cols-1 items-start gap-4 xl:grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)]"
      >
        <div className="min-w-0 rounded-lg border border-nw-border bg-nw-panel">
          <div className="flex flex-wrap items-center gap-3 border-b border-nw-border px-4 py-3">
            <Input
              aria-label="Search requests"
              placeholder="Search driver, truck or request…"
              value={text}
              onChange={(e) => setText(e.target.value)}
              prefix={<Search className="size-4 text-nw-text-3" aria-hidden />}
              className="min-w-[200px] flex-1"
            />
            <StatusTabs value={tab} onChange={setTab} counts={counts.data} />
          </div>
          <RequestTable
            rows={list.data?.data}
            loading={list.isPending}
            error={list.isError ? list.error : null}
            onRetry={() => void list.refetch()}
            selectedId={selectedId}
            onSelect={select}
            sort={sort}
            onSort={() => setSort(sort === 'received_desc' ? 'received_asc' : 'received_desc')}
          />
          <Footer
            total={list.data?.total}
            page={page}
            pageSize={pageSize}
            onPage={setPage}
            onPageSize={setPageSize}
          />
        </div>

        <div className="min-w-0 rounded-lg border border-nw-border bg-nw-panel">
          {selectedId ? (
            <RequestDetail
              key={selectedId}
              id={selectedId}
              canContact={canContact}
              draft={drafts[selectedId] ?? ''}
              onDraft={(value) => setDrafts((d) => ({ ...d, [selectedId]: value }))}
            />
          ) : (
            <p className="px-6 py-10 text-center text-sm text-nw-text-3">Select a request to see the driver’s message and record contact.</p>
          )}
        </div>
      </section>

      <p className="text-xs text-nw-text-3">
        A red alert stays until actual contact is recorded with a note. Opening, assigning or recording an attempt does not clear it.
      </p>
    </div>
  );
}

function TelegramStatus() {
  const status = useIntegrationStatus();
  if (status.isPending) return <span className="text-xs text-nw-text-3">Telegram: Loading…</span>;
  if (status.isError || !status.data) return null;
  return (
    <Badge tone={status.data.telegram.enabled ? 'success' : 'neutral'} dot>
      Telegram: {status.data.telegram.label}
    </Badge>
  );
}

function TopicCards({
  counts,
  loading,
  active,
  onPick,
}: {
  counts: DriverRelationCounts | undefined;
  loading: boolean;
  active: DriverRelationTopic | undefined;
  onPick: (topic: DriverRelationTopic) => void;
}) {
  return (
    <div role="group" aria-label="Topics" className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      {DRIVER_RELATION_TOPICS.map((t) => {
        const Icon = TOPIC_ICONS[t];
        const waiting = counts?.byTopic[t]?.needsContact ?? 0;
        const pressed = active === t;
        return (
          <button
            key={t}
            type="button"
            aria-pressed={pressed}
            data-testid={`topic-${t}`}
            onClick={() => onPick(t)}
            className={cn(
              'relative flex min-h-[104px] cursor-pointer flex-col gap-2 rounded-lg border bg-nw-panel p-4 text-left',
              'transition-colors duration-(--duration-base) hover:bg-nw-hover',
              pressed ? 'border-nw-accent ring-1 ring-nw-accent' : 'border-nw-border',
            )}
          >
            <span className="flex items-start gap-2.5 pr-10">
              <Icon aria-hidden className="mt-0.5 size-5 shrink-0 text-nw-text-2" strokeWidth={1.6} />
              <span className="text-sm font-bold text-nw-text">{DRIVER_RELATION_TOPIC_LABELS[t]}</span>
            </span>
            <span className="text-xs text-nw-text-3">{DRIVER_RELATION_TOPIC_HINTS[t]}</span>
            {t === 'complaint_feedback' && counts?.confidentialHidden ? (
              <span className="mt-auto flex items-center gap-1 text-2xs text-nw-text-3" data-testid="confidential-hidden">
                <Lock className="size-3" aria-hidden />
                Confidential: Driver Relations staff only
              </span>
            ) : null}
            {loading ? (
              <span className="absolute top-3 right-3 text-2xs text-nw-text-3">Loading…</span>
            ) : waiting > 0 ? (
              <span
                className="tabular absolute top-3 right-3 inline-flex h-5 min-w-5 items-center justify-center gap-1 rounded-sm border border-nw-urgent-border bg-nw-urgent-bg px-1.5 text-eyebrow font-bold text-nw-urgent-text"
                aria-label={`${waiting} need${waiting === 1 ? 's' : ''} contact`}
              >
                <StatusSymbol family="urgent" size={12} className="text-nw-urgent-icon" />
                {waiting}
              </span>
            ) : null}
          </button>
        );
      })}
    </div>
  );
}

function Totals({ counts, loading, error }: { counts: DriverRelationCounts | undefined; loading: boolean; error: boolean }) {
  const value = (n: number | undefined) => (loading ? 'Loading…' : error || n === undefined ? 'Not available' : String(n));
  const cards = [
    { key: 'awaiting', n: counts?.byStatus.awaitingContact, title: 'Awaiting contact', hint: 'Requests that need your outreach', urgent: true },
    { key: 'contacted', n: counts?.byStatus.contacted, title: 'Contacted / follow-up', hint: 'Contact made, may need more action', urgent: false },
    { key: 'resolved', n: counts?.byStatus.resolved, title: 'Resolved', hint: 'Completed requests', urgent: false },
  ];
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
      {cards.map((c) => (
        <div key={c.key} data-testid={`total-${c.key}`} className="flex items-center gap-4 rounded-xl border border-nw-border bg-nw-panel px-5 py-4 shadow-card">
          <span
            className={cn(
              'tabular font-bold',
              loading || error ? 'text-sm text-nw-text-3' : 'text-3xl',
              !loading && !error && c.urgent && (c.n ?? 0) > 0 ? 'text-nw-urgent-text' : 'text-nw-text',
            )}
          >
            {value(c.n)}
          </span>
          <span className="min-w-0">
            <span className="flex items-center gap-1.5 text-md font-bold text-nw-text">
              {c.urgent && (c.n ?? 0) > 0 ? <StatusSymbol family="urgent" size={13} className="text-nw-urgent-icon" /> : null}
              {c.title}
            </span>
            <span className="block text-xs text-nw-text-3">{c.hint}</span>
          </span>
        </div>
      ))}
    </div>
  );
}

function StatusTabs({ value, onChange, counts }: { value: StatusTab; onChange: (t: StatusTab) => void; counts: DriverRelationCounts | undefined }) {
  const tabs: { key: StatusTab; label: string; n: number | undefined }[] = [
    { key: 'all', label: 'All', n: counts?.byStatus.all },
    { key: 'needs_contact', label: 'Awaiting contact', n: counts?.byStatus.awaitingContact },
    { key: 'contacted', label: 'Contacted', n: counts?.byStatus.contacted },
    { key: 'resolved', label: 'Resolved', n: counts?.byStatus.resolved },
  ];
  return (
    <div role="tablist" aria-label="Status" className="flex flex-wrap items-center gap-1">
      {tabs.map((t) => (
        <button
          key={t.key}
          type="button"
          role="tab"
          aria-selected={value === t.key}
          onClick={() => onChange(t.key)}
          className={cn(
            'relative h-8 cursor-pointer rounded-md px-2.5 text-sm font-semibold transition-colors',
            value === t.key ? 'bg-nw-accent-tint text-nw-accent-ink' : 'text-nw-text-2 hover:bg-nw-hover hover:text-nw-text',
          )}
        >
          {t.label}
          {t.n !== undefined ? <span className="tabular"> ({t.n})</span> : null}
        </button>
      ))}
    </div>
  );
}

function RequestTable({
  rows,
  loading,
  error,
  onRetry,
  selectedId,
  onSelect,
  sort,
  onSort,
}: {
  rows: DriverRelationRequest[] | undefined;
  loading: boolean;
  error: unknown;
  onRetry: () => void;
  selectedId: string | null;
  onSelect: (id: string) => void;
  sort: 'received_desc' | 'received_asc';
  onSort: () => void;
}) {
  if (loading && !rows) return <p className="px-4 py-10 text-center text-sm text-nw-text-3">Loading…</p>;
  if (error && !rows) {
    return <ErrorState size="sm" title="Requests could not be loaded" error={error} onRetry={onRetry} className="py-8" />;
  }
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[600px] border-collapse text-left text-sm">
        <thead>
          <tr className="border-b border-nw-border bg-nw-subtle text-xs font-semibold text-nw-text-3">
            <th scope="col" className="px-4 py-2.5">Driver</th>
            <th scope="col" className="px-3 py-2.5">Truck #</th>
            <th scope="col" className="px-3 py-2.5">Request type</th>
            <th scope="col" className="px-3 py-2.5">Status</th>
            <th scope="col" className="px-3 py-2.5" aria-sort={sort === 'received_desc' ? 'descending' : 'ascending'}>
              <button type="button" onClick={onSort} className="inline-flex cursor-pointer items-center gap-1 font-semibold">
                Requested
                <span aria-hidden>{sort === 'received_desc' ? '↓' : '↑'}</span>
                <span className="sr-only">{sort === 'received_desc' ? 'newest first; select for oldest first' : 'oldest first; select for newest first'}</span>
              </button>
            </th>
          </tr>
        </thead>
        <tbody>
          {(rows ?? []).length === 0 ? (
            <tr>
              <td colSpan={5} className="px-4 py-10 text-center text-sm text-nw-text-3">
                No requests match these filters.
              </td>
            </tr>
          ) : (
            (rows ?? []).map((r) => (
              <tr
                key={r.id}
                tabIndex={0}
                aria-selected={selectedId === r.id}
                aria-label={`${r.requestNumber}, ${r.submittedName}, ${r.topicLabel}${r.needsContact ? ', needs contact' : ''}`}
                onClick={() => onSelect(r.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.preventDefault();
                    onSelect(r.id);
                  }
                }}
                className={cn(
                  'cursor-pointer border-b border-nw-border last:border-b-0 hover:bg-nw-hover',
                  selectedId === r.id && 'bg-nw-selected hover:bg-nw-selected',
                )}
              >
                <td className="px-4 py-3">
                  <span className="flex items-center gap-1.5 font-semibold text-nw-text">
                    {r.submittedName}
                    {r.confidential ? <Lock className="size-3 text-nw-text-3" aria-label="Confidential" /> : null}
                    {r.attachmentCount > 0 ? <Paperclip className="size-3 text-nw-text-3" aria-label={`${r.attachmentCount} receipts`} /> : null}
                  </span>
                  <span className="block text-2xs text-nw-text-3">{r.requestNumber}</span>
                </td>
                <td className="tabular px-3 py-3 text-nw-text-2">{r.truckNumber ?? '—'}</td>
                <td className="px-3 py-3 text-nw-text">{r.topicLabel}</td>
                <td className="px-3 py-3">
                  <RequestStatus request={r} />
                </td>
                <td className="px-3 py-3 text-xs whitespace-nowrap text-nw-text-2">
                  {formatDate(r.lastDriverMessageAt)}
                  <span className="block text-2xs text-nw-text-3">{formatTime(r.lastDriverMessageAt)}</span>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

function Footer({
  total,
  page,
  pageSize,
  onPage,
  onPageSize,
}: {
  total: number | undefined;
  page: number;
  pageSize: number;
  onPage: (p: number) => void;
  onPageSize: (n: number) => void;
}) {
  const pages = useMemo(() => Math.max(1, Math.ceil((total ?? 0) / pageSize)), [total, pageSize]);
  const from = total ? (page - 1) * pageSize + 1 : 0;
  const to = total ? Math.min(total, page * pageSize) : 0;
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-nw-border px-4 py-3 text-xs text-nw-text-3">
      <span>{total === undefined ? 'Loading…' : `Showing ${from}–${to} of ${total} requests`}</span>
      <div className="flex items-center gap-2">
        <span id="dr-rows-label">Rows per page</span>
        <Select
          aria-labelledby="dr-rows-label"
          size="sm"
          value={String(pageSize)}
          onValueChange={(v) => onPageSize(Number(v))}
          options={['10', '25', '50', '100'].map((v) => ({ value: v, label: v }))}
          className="w-20"
        />
        <button
          type="button"
          aria-label="Previous page"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
          className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-nw-text-2 hover:bg-nw-hover disabled:pointer-events-none disabled:opacity-45"
        >
          <ChevronLeft className="size-4" aria-hidden />
        </button>
        <button
          type="button"
          aria-label="Next page"
          disabled={page >= pages}
          onClick={() => onPage(page + 1)}
          className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-nw-text-2 hover:bg-nw-hover disabled:pointer-events-none disabled:opacity-45"
        >
          <ChevronRight className="size-4" aria-hidden />
        </button>
      </div>
    </div>
  );
}
