import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { AlertCircle, ArrowRight, CreditCard, FileText, Truck } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  FilterBar,
  KpiCard,
  MenuItem,
  PageHeader,
  cn,
  createColumns,
  type DataTableState,
  type FilterDefinition,
} from '@/design-system';
import { fetchBillingQueue, fetchInvoices, type Invoice, type Payment, type ServerInvoice } from '@/demo';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { RecordFundingDialog } from './components/RecordFundingDialog';
import { RecordPaymentDialog } from './components/RecordPaymentDialog';
import { useAccount } from '@/features/auth/auth-context';
import { useAccounting } from './useAccounting';
import { receivablesSearchSchema } from './receivables-search';

/**
 * Receivables (owner's design, 2026-09-27): issued invoices and what they still owe.
 *
 * Unbilled loads are a banner, not a receivable: nothing is owed until an invoice is issued.
 * Four figures with their definitions, four tabs (open invoices, RTS funding, receipts and
 * allocations, history) and one table. Overdue is one place (owner, 2026-09-29): the Overdue
 * figure opens the open invoices past due with how long they have sat, oldest first. RTS funding is tracked on
 * its own tab and never added to outstanding invoices.
 */

const col = createColumns<Invoice>();
const OPEN = new Set(['issued', 'sent', 'partially_paid', 'disputed', 'overdue', 'funded']);
type Tab = 'open' | 'rts' | 'receipts' | 'history';

function daysLate(dueOn: string | null, today: string): number | null {
  if (!dueOn) return null;
  return Math.round((new Date(`${today}T00:00:00Z`).getTime() - new Date(`${dueOn}T00:00:00Z`).getTime()) / 86_400_000);
}

export function ReceivablesPage() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => receivablesSearchSchema.parse(rawSearch), [rawSearch]);
  const navigate = useNavigate();
  const [columnVisibility, setColumnVisibility] = useState<DataTableState['columnVisibility']>({});
  const [paying, setPaying] = useState<Invoice | null>(null);
  const query = useAccounting('year');
  const bundle = query.data;
  const today = bundle?.today ?? '';
  const queue = useQuery({ queryKey: ['accounting', 'billing-queue'], queryFn: fetchBillingQueue, staleTime: 60_000 });
  const serverInvoices = useQuery({ queryKey: ['accounting', 'invoices', 'server'], queryFn: fetchInvoices, staleTime: 60_000 });
  const tab: Tab = (['rts', 'receipts', 'history'] as const).find((t) => t === search.tab) ?? 'open';

  function updateSearch(patch: Record<string, string | number | undefined>) {
    void navigate({ to: '.', search: (prev: Record<string, unknown>) => { const next: Record<string, unknown> = { ...prev, ...patch }; for (const key of Object.keys(next)) if (next[key] === undefined || next[key] === '') delete next[key]; return next; }, replace: true });
  }

  const invoices = bundle?.invoices ?? [];
  const open = invoices.filter((i) => OPEN.has(i.status) && i.balance > 0);
  const overdue = open.filter((i) => (daysLate(i.dueOn, today) ?? 0) > 0);
  const byId = new Map((serverInvoices.data ?? []).map((i) => [i.id, i]));
  const awaitingFunding = (serverInvoices.data ?? []).filter((i) => i.isCurrent && i.submission?.status === 'submitted' && i.factoring.fundedGross < i.total);
  const receiptsIn = (bundle?.payments ?? []).filter((p) => p.direction === 'in');
  const unapplied = receiptsIn.reduce((s, p) => s + p.unappliedAmount, 0);
  const unbilled = (queue.data?.rows ?? []).filter((r) => !r.invoice);
  const unbilledTotal = unbilled.reduce((s, r) => s + (r.load.charges.find((c) => c.type === 'linehaul')?.amount ?? r.load.rate), 0);
  const ar = bundle?.receivables;

  const rows = useMemo(() => {
    let list = tab === 'open' ? open : tab === 'history' ? invoices.filter((i) => i.status === 'paid' || i.status === 'void' || (OPEN.has(i.status) && i.balance === 0)) : [];
    if (search.customer) list = list.filter((i) => i.billToId === search.customer);
    if (search.bucket && tab === 'open') {
      list = list.filter((i) => { const d = daysLate(i.dueOn, today) ?? 0; return search.bucket === 'current' ? d <= 0 : search.bucket === '1-30' ? d >= 1 && d <= 30 : search.bucket === '31-60' ? d >= 31 && d <= 60 : search.bucket === '61-90' ? d >= 61 && d <= 90 : search.bucket === '90+' ? d > 90 : search.bucket === 'overdue' ? d > 0 : true; });
    }
    const q = search.q?.trim().toLowerCase();
    if (q) list = list.filter((i) => [i.invoiceNumber, i.loadNumber, i.billToName].some((v) => v?.toLowerCase().includes(q)));
    return [...list].sort((a, b) => (a.dueOn ?? '').localeCompare(b.dueOn ?? ''));
  }, [tab, open, invoices, search, today]);

  const filters = useMemo<FilterDefinition[]>(() => [
    { key: 'customer', label: 'Customer', type: 'select', options: [...new Map(invoices.map((i) => [i.billToId, i.billToName]))].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label })) },
    { key: 'bucket', label: 'Due status', type: 'select', options: [{ value: 'current', label: 'Not due' }, { value: 'overdue', label: 'Overdue' }, { value: '1-30', label: '1–30 days' }, { value: '31-60', label: '31–60 days' }, { value: '61-90', label: '61–90 days' }, { value: '90+', label: '90+ days' }] },
  ], [invoices]);

  const columns = useMemo(() => col.columns([
    col.display({ id: 'invoice', header: 'Invoice / Load', meta: { primary: true }, cell: ({ row }) => <span><Link to="/accounting/invoices/$invoiceId" params={{ invoiceId: row.original.id }} className="font-semibold text-primary-text hover:underline" onClick={(e) => e.stopPropagation()}>{row.original.invoiceNumber}</Link><span className="block text-xs text-muted">{row.original.loadNumber}</span></span> }),
    col.accessor('billToName', { header: 'Customer' }),
    col.accessor('dueOn', { header: 'Due date', meta: { width: 120 }, cell: ({ getValue, row }) => { const d = daysLate(getValue(), today) ?? 0; return <span className={cn(d > 0 && row.original.balance > 0 && 'font-medium text-danger-text')}>{getValue() ? formatIsoDate(getValue()!) : '—'}{d > 0 && row.original.balance > 0 ? <span className="block text-2xs">{d} days overdue</span> : null}</span>; } }),
    col.accessor('total', { header: 'Invoice amount', meta: { align: 'right', width: 130 }, cell: ({ getValue }) => formatMoney(getValue()) }),
    col.accessor('balance', { header: 'Open balance', meta: { align: 'right', width: 120 }, cell: ({ getValue }) => <span className={cn(getValue() > 0 && 'font-semibold')}>{formatMoney(getValue())}</span> }),
    col.display({ id: 'rts', header: 'RTS status', meta: { width: 140 }, cell: ({ row }) => { const s = byId.get(row.original.id); const sub = s?.submission; return sub ? <Badge tone={sub.status === 'accepted' ? 'success' : sub.status === 'rejected' ? 'danger' : sub.status === 'submitted' ? 'info' : 'neutral'} size="sm">{sub.status === 'submitted' && s && s.factoring.fundedGross >= s.total ? 'Funded' : sub.status}</Badge> : <span className="text-xs text-muted">Not submitted</span>; } }),
    col.display({ id: 'action', header: 'Action', meta: { width: 140 }, cell: ({ row }) => row.original.balance > 0 && row.original.status !== 'draft' ? <Button variant="outline" size="sm" onClick={(e) => { e.stopPropagation(); setPaying(row.original); }}>Record receipt</Button> : null }),
  ]), [today, byId]);

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader title="Receivables" description="Track outstanding invoices and RTS funding." />

      {queue.data && unbilled.length > 0 ? (
        <Alert tone="warning" title={`${unbilled.length} unbilled load${unbilled.length === 1 ? '' : 's'} · ${formatMoney(unbilledTotal)}`} description="Not included in receivables. Documents and references still need validation." actions={<Button variant="outline" size="sm" onClick={() => void navigate({ to: '/accounting/invoices', search: { tab: 'queue' } })}>Open billing queue <ArrowRight className="size-3.5" /></Button>} />
      ) : null}

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <KpiCard label="Outstanding invoices" value={bundle ? formatMoney(ar?.total ?? 0) : 'Loading…'} hint={bundle ? `${open.length} open invoice${open.length === 1 ? '' : 's'}` : undefined} icon={<FileText />} iconTile variant="feature" onClick={() => updateSearch({ tab: undefined, bucket: undefined })} />
        <KpiCard label="Overdue" value={bundle ? formatMoney(ar?.overdue ?? 0) : 'Loading…'} hint="Past invoice due date" icon={<AlertCircle />} iconTile variant="feature" tone={overdue.length > 0 ? 'urgent' : undefined} onClick={() => updateSearch({ tab: undefined, bucket: 'overdue' })} />
        <KpiCard label="Awaiting RTS funding" value={serverInvoices.data ? formatMoney(awaitingFunding.reduce((s, i) => s + (i.total - i.factoring.fundedGross), 0)) : 'Loading…'} hint="Submitted, not funded" icon={<Truck />} iconTile variant="feature" onClick={() => updateSearch({ tab: 'rts' })} />
        <KpiCard label="Unapplied receipts" value={bundle ? formatMoney(unapplied) : 'Loading…'} hint="Payments awaiting allocation" icon={<CreditCard />} iconTile variant="feature" onClick={() => updateSearch({ tab: 'receipts' })} />
      </div>
      <p className="-mt-2 text-2xs text-muted">RTS funding is tracked separately and is not added to outstanding invoices.</p>

      <div className="flex flex-wrap items-center gap-1 border-b border-line" role="tablist" aria-label="Receivables">
        {([['open', 'Open invoices'], ['rts', 'RTS funding'], ['receipts', 'Receipts & allocations'], ['history', 'History']] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => updateSearch({ tab: k === 'open' ? undefined : k, page: undefined })} className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-semibold', tab === k ? 'border-primary text-primary-text' : 'border-transparent text-muted hover:text-ink')}>{label}</button>
        ))}
      </div>

      {tab === 'open' && search.bucket && OVERDUE_BUCKETS.has(search.bucket) ? (
        <OverdueBreakdown invoices={overdue} today={today} bucket={search.bucket} onPick={(bucket) => updateSearch({ bucket, page: undefined })} />
      ) : null}

      {tab === 'open' || tab === 'history' ? (
        <DataTable
          columns={columns}
          data={rows}
          rowKey={(i) => i.id}
          state={{ sorting: [], pagination: { page: search.page ?? 1, pageSize: 25 }, rowSelection: {}, columnVisibility, globalFilter: '' }}
          onStateChange={(patch) => { if (patch.pagination !== undefined) updateSearch({ page: patch.pagination.page > 1 ? patch.pagination.page : undefined }); if (patch.columnVisibility !== undefined) setColumnVisibility(patch.columnVisibility); }}
          loading={query.isPending}
          error={query.error ?? undefined}
          onRetry={() => void query.refetch()}
          emptyTitle={tab === 'open' ? 'No issued invoices to track' : 'No settled invoices yet'}
          emptyDescription={tab === 'open' ? (unbilled.length > 0 ? `You have ${unbilled.length} unbilled load${unbilled.length === 1 ? '' : 's'}. Review them in Billing & Invoices to create invoices.` : 'An invoice appears here once it is issued.') : 'Paid and voided invoices will appear here.'}
          emptyAction={tab === 'open' && unbilled.length > 0 ? <Button variant="primary" size="sm" onClick={() => void navigate({ to: '/accounting/invoices', search: { tab: 'queue' } })}>Review unbilled loads</Button> : undefined}
          caption="Invoices"
          onRowDoubleClick={(i) => void navigate({ to: '/accounting/invoices/$invoiceId', params: { invoiceId: i.id } })}
          toolbar={<FilterBar search={{ value: search.q ?? '', onChange: (value) => updateSearch({ q: value || undefined, page: undefined }), placeholder: 'Search invoice, customer or load' }} filters={filters} values={{ customer: search.customer, bucket: search.bucket }} onChange={(key, value) => updateSearch({ [key]: (value as string | undefined) || undefined, page: undefined })} onClear={() => updateSearch({ customer: undefined, bucket: undefined, q: undefined, page: undefined })} />}
          rowActions={(i) => <MenuItem onSelect={() => void navigate({ to: '/accounting/invoices/$invoiceId', params: { invoiceId: i.id } })}>Open invoice</MenuItem>}
        />
      ) : null}

      {tab === 'rts' ? <RtsFunding invoices={serverInvoices.data ?? null} loading={serverInvoices.isPending} /> : null}
      {tab === 'receipts' ? <Receipts payments={receiptsIn} invoices={invoices} loading={query.isPending} /> : null}

      {paying ? <RecordPaymentDialog open onOpenChange={(next) => { if (!next) setPaying(null); }} partyId={paying.billToId} partyName={paying.billToName} partyType={paying.billToType} onDone={() => setPaying(null)} /> : null}
    </div>
  );
}

const OVERDUE_BUCKETS = new Set(['overdue', '1-30', '31-60', '61-90', '90+']);
const AGE_BANDS = [
  { key: '1-30', label: '1–30 days', min: 1, max: 30 },
  { key: '31-60', label: '31–60 days', min: 31, max: 60 },
  { key: '61-90', label: '61–90 days', min: 61, max: 90 },
  { key: '90+', label: '90+ days', min: 91, max: Infinity },
] as const;

/** How much is past due and for how long, by band; a band narrows the table below. */
function OverdueBreakdown({ invoices, today, bucket, onPick }: { invoices: Invoice[]; today: string; bucket: string; onPick: (bucket: string) => void }) {
  const aged = invoices.map((i) => ({ invoice: i, days: daysLate(i.dueOn, today) ?? 0 }));
  const total = aged.reduce((sum, a) => sum + a.invoice.balance, 0);
  const oldest = aged.reduce<(typeof aged)[number] | null>((worst, a) => (!worst || a.days > worst.days ? a : worst), null);
  return (
    <section aria-label="Overdue by age" data-testid="overdue-breakdown" className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-semibold text-ink">
          Overdue: {formatMoney(total)} on {aged.length} invoice{aged.length === 1 ? '' : 's'}
        </p>
        {oldest ? (
          <p className="text-xs text-muted">
            Oldest: <span className="font-semibold text-danger-text">{oldest.invoice.invoiceNumber} · {oldest.days} day{oldest.days === 1 ? '' : 's'} overdue</span> · {formatMoney(oldest.invoice.balance)}
          </p>
        ) : (
          <p className="text-xs text-muted">Nothing is past its due date.</p>
        )}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-2 md:grid-cols-5">
        <button type="button" aria-pressed={bucket === 'overdue'} onClick={() => onPick('overdue')} className={cn('rounded-lg border px-3 py-2 text-left', bucket === 'overdue' ? 'border-primary bg-primary-soft' : 'border-line-soft hover:bg-surface-hover')}>
          <span className="block text-xs text-muted">All overdue</span>
          <span className="block text-base font-bold tabular-nums text-ink">{formatMoney(total)}</span>
          <span className="block text-2xs text-muted">{aged.length} invoice{aged.length === 1 ? '' : 's'}</span>
        </button>
        {AGE_BANDS.map((band) => {
          const inBand = aged.filter((a) => a.days >= band.min && a.days <= band.max);
          const sum = inBand.reduce((s, a) => s + a.invoice.balance, 0);
          return (
            <button key={band.key} type="button" aria-pressed={bucket === band.key} onClick={() => onPick(band.key)} className={cn('rounded-lg border px-3 py-2 text-left', bucket === band.key ? 'border-primary bg-primary-soft' : 'border-line-soft hover:bg-surface-hover')}>
              <span className="block text-xs text-muted">{band.label}</span>
              <span className={cn('block text-base font-bold tabular-nums', sum > 0 ? 'text-danger-text' : 'text-ink')}>{formatMoney(sum)}</span>
              <span className="block text-2xs text-muted">{inBand.length} invoice{inBand.length === 1 ? '' : 's'}</span>
            </button>
          );
        })}
      </div>
    </section>
  );
}

function RtsFunding({ invoices, loading }: { invoices: ServerInvoice[] | null; loading: boolean }) {
  const account = useAccount();
  const canEdit = account?.permissions.includes('accounting.edit') ?? false;
  const [recording, setRecording] = useState(false);
  if (loading) return <p className="text-sm text-muted">Loading…</p>;
  const list = (invoices ?? []).filter((i) => i.isCurrent && (i.submission || i.factoring.fundedGross > 0));
  // Submitted to RTS and not fully funded yet: what a funding can be recorded against.
  const awaiting = list.filter((i) => i.submission && i.submission.status !== 'rejected' && i.factoring.fundedGross < i.total && i.balance > 0);
  const header = (
    <div className="flex flex-wrap items-center justify-between gap-2">
      <p className="text-sm text-nw-text-2">{awaiting.length ? `${awaiting.length} invoice${awaiting.length === 1 ? '' : 's'} sent to RTS and not funded yet.` : 'Nothing is waiting on RTS funding.'}</p>
      {canEdit && awaiting.length ? (
        <Button variant="primary" size="sm" icon={<CreditCard />} onClick={() => setRecording(true)} data-testid="record-funding-open">
          Record RTS funding
        </Button>
      ) : null}
      {recording ? <RecordFundingDialog invoices={awaiting} onClose={() => setRecording(false)} /> : null}
    </div>
  );
  if (list.length === 0) return <p className="rounded-xl border border-line bg-surface p-6 text-sm text-muted">No invoice has been prepared for RTS yet. Submission is by export from the invoice; the answer and the funding are recorded here.</p>;
  return (
    <div className="flex flex-col gap-3">
    {header}
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full text-sm">
        <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted"><tr><th className="px-3 py-2">Invoice</th><th className="px-3 py-2">Customer</th><th className="px-3 py-2">RTS status</th><th className="px-3 py-2">Reference</th><th className="px-3 py-2 text-right">Invoice</th><th className="px-3 py-2 text-right">Funded</th><th className="px-3 py-2 text-right">Fee</th><th className="px-3 py-2 text-right">Awaiting</th></tr></thead>
        <tbody className="divide-y divide-line-soft">
          {list.map((i) => <tr key={i.id}><td className="px-3 py-2"><Link to="/accounting/invoices/$invoiceId" params={{ invoiceId: i.id }} className="font-semibold text-primary-text">{i.invoiceNumber}</Link><span className="block text-xs text-muted">{i.loadNumber}</span></td><td className="px-3 py-2">{i.billToName}</td><td className="px-3 py-2">{i.submission ? <Badge tone={i.submission.status === 'accepted' ? 'success' : i.submission.status === 'rejected' ? 'danger' : i.submission.status === 'submitted' ? 'info' : 'neutral'} size="sm">{i.submission.status}</Badge> : <span className="text-xs text-muted">—</span>}</td><td className="px-3 py-2 text-xs">{i.submission?.reference ?? '—'}</td><td className="px-3 py-2 text-right tabular-nums">{formatMoney(i.total)}</td><td className="px-3 py-2 text-right tabular-nums">{formatMoney(i.factoring.fundedGross)}</td><td className="px-3 py-2 text-right tabular-nums text-muted">{formatMoney(i.factoring.feeCents / 100)}</td><td className="px-3 py-2 text-right tabular-nums font-semibold">{formatMoney(Math.max(0, i.total - i.factoring.fundedGross))}</td></tr>)}
        </tbody>
      </table>
      <p className="px-3 py-2 text-2xs text-muted">Funding is money from RTS, recorded against the invoice; it never counts as a customer receipt and is not added to outstanding invoices.</p>
    </div>
    </div>
  );
}

function Receipts({ payments, invoices, loading }: { payments: Payment[]; invoices: Invoice[]; loading: boolean }) {
  if (loading) return <p className="text-sm text-muted">Loading…</p>;
  if (payments.length === 0) return <p className="rounded-xl border border-line bg-surface p-6 text-sm text-muted">No customer receipt recorded yet. A receipt is recorded against an issued invoice; an unapplied remainder stays visible until it is allocated.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full text-sm">
        <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Customer</th><th className="px-3 py-2">Method</th><th className="px-3 py-2">Reference</th><th className="px-3 py-2">Applied to</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2 text-right">Unapplied</th></tr></thead>
        <tbody className="divide-y divide-line-soft">
          {[...payments].sort((a, b) => b.receivedOn.localeCompare(a.receivedOn)).map((p) => <tr key={p.id}><td className="px-3 py-2">{formatIsoDate(p.receivedOn)}</td><td className="px-3 py-2">{p.partyName}</td><td className="px-3 py-2 text-xs">{p.method}</td><td className="px-3 py-2 text-xs">{p.reference}</td><td className="px-3 py-2 text-xs">{p.applications.map((a) => invoices.find((i) => i.id === a.invoiceId)?.invoiceNumber ?? a.invoiceId ?? '—').join(', ') || '—'}</td><td className="px-3 py-2 text-right tabular-nums">{formatMoney(p.amount)}</td><td className={cn('px-3 py-2 text-right tabular-nums', p.unappliedAmount > 0 ? 'font-semibold text-warning-text' : 'text-muted')}>{p.unappliedAmount > 0 ? formatMoney(p.unappliedAmount) : '—'}</td></tr>)}
        </tbody>
      </table>
    </div>
  );
}
