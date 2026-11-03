import { z } from 'zod';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery } from '@tanstack/react-query';
import { AlertCircle, CalendarClock, Check, Clock, DollarSign, Download, ExternalLink, FileText, Plus, Receipt } from 'lucide-react';
import { useMemo, useState } from 'react';
import { billTransitions, daysPastDue } from '@neway/shared';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  DataTable,
  Drawer,
  FilterBar,
  KpiCard,
  FormField,
  Input,
  MenuItem,
  Modal,
  PageHeader,
  Select,
  StatusBadge,
  Textarea,
  cn,
  createColumns,
  useToast,
  type DataTableState,
  type FilterDefinition,
} from '@/design-system';
import { createBill, createBillsFromWorkOrders, fetchWorkOrderBillCandidates, listVendors, payBill, updateBill, type Bill, type Payment, type WorkOrderBillCandidate } from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { useAccounting, useInvalidateAccounting } from './useAccounting';
import { payablesSearchSchema } from './payables-search';

/**
 * Accounts payable (corrective brief 2, section 1): what the carrier owes vendors.
 *
 * Title and actions → four figures → three tabs → filters → one table → a drawer for the row.
 * Bills is the money owed; Needs billing is the intake of completed repair orders, kept on its
 * own tab so the source list never sits above the bills; Payment history is the money that
 * went out, from the same payment allocations the ledger holds. A completed repair does not
 * prove a vendor is still owed: each candidate says what already exists before a bill is made.
 */

const col = createColumns<Bill>();
const OUTSTANDING = new Set(['open', 'scheduled', 'partially_paid', 'pending_approval', 'disputed']);
/** The bills as shown, as a CSV the browser saves; nothing leaves the machine. */
function exportCsv(bills: Bill[]) {
  const esc = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Bill #', 'Vendor', 'Vendor invoice', 'Source', 'Unit', 'Bill date', 'Due', 'Amount', 'Paid', 'Balance', 'Status', 'Approved by'];
  const lines = bills.map((b) => [b.billNumber, b.vendorName, b.vendorInvoiceNumber, b.source, b.unitNumber, b.issuedOn, b.dueOn, b.amount, b.paid, b.balance, b.status, b.approvedBy].map(esc).join(','));
  const blob = new Blob([[head.map(esc).join(','), ...lines].join(String.fromCharCode(10))], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'bills.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

const SOURCE_LABEL: Record<Bill['source'], string> = { repair_order: 'Repair order', fuel: 'Fuel', tolls: 'Tolls', lease: 'Lease', manual: 'Manual' };

function matchesBill(bill: Bill, filters: z.infer<typeof payablesSearchSchema>, today: string) {
  if (filters.ids) return filters.ids.split(',').includes(bill.id);
  if (filters.vendor && bill.vendorId !== filters.vendor) return false;
  if (filters.category && bill.categoryCode !== filters.category) return false;
  const late = daysPastDue(bill.dueOn, today) ?? 0;
  const outstanding = OUTSTANDING.has(bill.status) && bill.balance > 0;
  switch (filters.view) {
    case 'outstanding': if (!outstanding) return false; break;
    case 'overdue': if (!(outstanding && late > 0)) return false; break;
    case 'due_today': if (!(outstanding && late === 0)) return false; break;
    case 'due_week': if (!(outstanding && late <= 0 && late >= -7)) return false; break;
    case 'pending_approval': case 'open': case 'scheduled': case 'partially_paid': case 'disputed': case 'paid':
      if (bill.status !== filters.view) return false; break;
    default: break;
  }
  if (filters.q) {
    const q = filters.q.toLowerCase();
    return [bill.billNumber, bill.vendorName, bill.vendorInvoiceNumber ?? '', bill.unitNumber ?? '', bill.sourceId ?? ''].some((v) => v.toLowerCase().includes(q));
  }
  return true;
}

export function PayablesPage() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => payablesSearchSchema.parse(rawSearch), [rawSearch]);
  const navigate = useNavigate();
  const { toast } = useToast();
  const invalidate = useInvalidateAccounting();
  const account = useAccount();
  const canEdit = account?.permissions.includes('accounting.edit') ?? false;
  const [columnVisibility, setColumnVisibility] = useState<DataTableState['columnVisibility']>({});
  const [paying, setPaying] = useState<Bill | null>(null);
  const [amount, setAmount] = useState('');
  const [method, setMethod] = useState<Payment['method']>('ach');
  const [reference, setReference] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);

  const query = useAccounting('year');
  const bundle = query.data;
  const today = bundle?.today ?? '';
  const candidates = useQuery({ queryKey: ['accounting', 'wo-candidates'], queryFn: fetchWorkOrderBillCandidates, staleTime: 30_000 });
  const needsBilling = (candidates.data ?? []).filter((c) => !c.hasBill && !c.expensePosted);
  const tab: 'bills' | 'needs_billing' | 'history' = search.view === 'needs_billing' ? 'needs_billing' : search.view === 'history' ? 'history' : 'bills';

  const move = useMutation({
    mutationFn: ({ id, status }: { id: string; status: Bill['status'] }) => updateBill({ billId: id, status }),
    onSuccess: async (result) => {
      if (!result.ok) { toast({ tone: 'danger', title: 'That was refused', description: result.blocked }); return; }
      await invalidate();
      toast({ tone: 'success', title: `${result.bill?.billNumber} is now ${result.bill?.status.replace(/_/g, ' ')}` });
    },
  });
  const pay = useMutation({
    mutationFn: () => payBill({ billId: paying?.id ?? '', amount: Number(amount) || 0, method, paidOn: today, reference }),
    onSuccess: async (result) => {
      if (!result.ok) { setError(result.blocked ?? 'The payment could not be recorded.'); return; }
      await invalidate();
      toast({ tone: 'success', title: `${formatMoney(Number(amount))} paid to ${result.bill?.vendorName}` });
      setPaying(null); setAmount(''); setReference('');
    },
  });

  function updateSearch(patch: Record<string, string | number | undefined>) {
    void navigate({ to: '.', search: (prev: Record<string, unknown>) => { const next: Record<string, unknown> = { ...prev, ...patch }; for (const key of Object.keys(next)) if (next[key] === undefined || next[key] === '') delete next[key]; return next; }, replace: true });
  }

  const rows = useMemo(() => (bundle?.bills ?? []).filter((b) => matchesBill(b, { ...search, view: tab === 'bills' ? search.view : undefined }, today)), [bundle, search, today, tab]);
  const focus = (bundle?.bills ?? []).find((b) => b.id === focusId) ?? null;
  const ap = bundle?.payables;

  const filters = useMemo<FilterDefinition[]>(() => {
    const vendors = [...new Map((bundle?.bills ?? []).map((b) => [b.vendorId, b.vendorName]))].sort((a, b) => a[1].localeCompare(b[1]));
    const categories = [...new Set((bundle?.bills ?? []).map((b) => b.categoryCode))].sort();
    return [
      { key: 'view', label: 'Status', type: 'select', options: [{ value: 'outstanding', label: 'Outstanding' }, { value: 'pending_approval', label: 'Pending approval' }, { value: 'open', label: 'Approved (open)' }, { value: 'scheduled', label: 'Scheduled' }, { value: 'overdue', label: 'Overdue' }, { value: 'partially_paid', label: 'Partly paid' }, { value: 'disputed', label: 'Disputed' }, { value: 'paid', label: 'Paid' }] },
      { key: 'vendor', label: 'Vendor', type: 'select', options: vendors.map(([value, label]) => ({ value, label })) },
      { key: 'category', label: 'Category', type: 'select', options: categories.map((value) => ({ value, label: value.replace(/_/g, ' ') })) },
    ];
  }, [bundle]);

  const columns = useMemo(() => col.columns([
    col.accessor('billNumber', { header: 'Bill #', meta: { primary: true, width: 100 } }),
    col.accessor('vendorName', { header: 'Vendor' }),
    col.display({ id: 'source', header: 'Source', meta: { width: 120 }, cell: ({ row }) => row.original.source === 'repair_order' && row.original.sourceId ? <Link to="/fleet/maintenance/$orderId" params={{ orderId: row.original.sourceId }} className="text-primary-text hover:underline" onClick={(e) => e.stopPropagation()}>{row.original.vendorInvoiceNumber ?? 'Repair order'}</Link> : <span className="text-secondary">{SOURCE_LABEL[row.original.source]}</span> }),
    col.display({ id: 'unit', header: 'Unit', meta: { width: 90 }, cell: ({ row }) => row.original.truckId ? <Link to="/fleet/trucks/$truckId" params={{ truckId: row.original.truckId }} className="hover:underline" onClick={(e) => e.stopPropagation()}>{row.original.unitNumber}</Link> : <span className="text-faint">—</span> }),
    col.accessor('issuedOn', { header: 'Bill date', cell: ({ getValue }) => formatIsoDate(getValue()), meta: { width: 105 } }),
    col.accessor('dueOn', { header: 'Due', cell: ({ getValue, row }) => { const late = daysPastDue(getValue(), today) ?? 0; const outstanding = OUTSTANDING.has(row.original.status) && row.original.balance > 0; return <span className={cn(late > 0 && outstanding && 'font-medium text-danger-text')}>{formatIsoDate(getValue())}</span>; }, meta: { width: 105 } }),
    col.accessor('amount', { header: 'Amount', cell: ({ getValue }) => formatMoney(getValue()), meta: { align: 'right', width: 105 } }),
    col.display({ id: 'paid', header: 'Paid / Balance', meta: { align: 'right', width: 130 }, cell: ({ row }) => <span className="tabular-nums"><span className="text-muted">{formatMoney(row.original.paid)}</span> / <span className={cn(row.original.balance > 0 && 'font-medium')}>{formatMoney(row.original.balance)}</span></span> }),
    col.accessor('status', { header: 'Status', cell: ({ getValue }) => <StatusBadge status={getValue()} />, meta: { width: 130 } }),
    col.display({ id: 'approval', header: 'Approval', meta: { width: 120 }, cell: ({ row }) => row.original.approvedAt ? <span className="text-xs text-muted">by {row.original.approvedBy}</span> : <Badge tone="warning" title={row.original.approvalReason ?? undefined}>Needed</Badge> }),
  ]), [today]);

  const kpi = (label: string, value: number | null, count: number | null, definition: string, icon: React.ReactNode, tone?: 'urgent' | 'warning', onSelect?: () => void) => (
    <KpiCard label={label} value={value === null ? 'Loading…' : formatMoney(value)} hint={count === null ? definition : `${count} bill${count === 1 ? '' : 's'} · ${definition}`} icon={icon} iconTile variant="feature" tone={tone} onClick={onSelect} title={definition} />
  );

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Accounts Payable"
        description="Vendor bills and payments"
        actions={<div className="flex gap-2">{canEdit ? <Button variant="primary" size="sm" icon={<Plus />} onClick={() => setAdding(true)}>Add Bill</Button> : null}<Button variant="secondary" size="sm" icon={<Download />} disabled={!bundle} onClick={() => exportCsv(rows.length ? rows : (bundle?.bills ?? []))}>Export</Button></div>}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {kpi('Outstanding', ap ? ap.total : null, ap ? (bundle?.bills ?? []).filter((b) => OUTSTANDING.has(b.status) && b.balance > 0 && b.status !== 'pending_approval').length : null, 'approved balance not yet paid', <FileText />, undefined, () => updateSearch({ view: 'outstanding', ids: undefined, page: undefined }))}
        {kpi('Due this week', ap ? ap.dueThisWeek : null, ap ? ap.ids.dueThisWeek.length : null, `due by ${today ? formatIsoDate(today) : 'today'} + 7 days`, <CalendarClock />, undefined, () => updateSearch({ view: 'due_week', ids: ap?.ids.dueThisWeek.join(','), page: undefined }))}
        {kpi('Overdue', ap ? ap.overdue : null, ap ? ap.ids.overdue.length : null, 'due date passed, balance open', <AlertCircle />, 'urgent', () => updateSearch({ view: 'overdue', ids: ap?.ids.overdue.join(','), page: undefined }))}
        {kpi('Pending approval', ap ? ap.pendingApproval : null, ap ? ap.ids.pendingApproval.length : null, 'not yet owed until approved', <Clock />, 'warning', () => updateSearch({ view: 'pending_approval', ids: ap?.ids.pendingApproval.join(','), page: undefined }))}
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-line" role="tablist" aria-label="Accounts payable">
        {([['bills', 'Bills'], ['needs_billing', `Needs billing${candidates.data ? ` (${needsBilling.length})` : ''}`], ['history', 'Payment history']] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => updateSearch({ view: k === 'bills' ? undefined : k, ids: undefined, page: undefined })} className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-semibold', tab === k ? 'border-primary text-primary-text' : 'border-transparent text-muted hover:text-ink')}>{label}</button>
        ))}
      </div>

      {tab === 'bills' ? (
        <>
          {needsBilling.length > 0 ? <Alert tone="warning" title={`${needsBilling.length} repair order${needsBilling.length === 1 ? '' : 's'} ready for review`} actions={<Button variant="link" size="sm" onClick={() => updateSearch({ view: 'needs_billing', ids: undefined, page: undefined })}>Review sources →</Button>} /> : null}
          <DataTable
            columns={columns}
            data={rows}
            rowKey={(bill) => bill.id}
            state={{ sorting: [], pagination: { page: search.page ?? 1, pageSize: 25 }, rowSelection: {}, columnVisibility, globalFilter: '' }}
            onStateChange={(patch) => { if (patch.pagination !== undefined) updateSearch({ page: patch.pagination.page > 1 ? patch.pagination.page : undefined }); if (patch.columnVisibility !== undefined) setColumnVisibility(patch.columnVisibility); }}
            loading={query.isPending}
            error={query.error ?? undefined}
            onRetry={() => void query.refetch()}
            emptyTitle="No bills yet"
            emptyDescription={needsBilling.length > 0 ? `${needsBilling.length} completed repair order(s) are waiting on the Needs billing tab; a bill is created from a source only after review.` : 'A bill records what a vendor is owed and when. Add one, or create bills from reviewed repair orders.'}
            caption="Bills"
            onRowClick={(bill) => setFocusId(bill.id)}
            toolbar={<FilterBar search={{ value: search.q ?? '', onChange: (value) => updateSearch({ q: value || undefined, page: undefined }), placeholder: 'Search bills, vendors, or RO numbers…' }} filters={filters} values={{ view: search.view, vendor: search.vendor, category: search.category }} onChange={(key, value) => updateSearch({ [key]: (value as string | undefined) || undefined, ids: undefined, page: undefined })} onClear={() => updateSearch({ view: undefined, vendor: undefined, category: undefined, ids: undefined, page: undefined })} />}
            rowActions={(bill) => (
              <>
                <MenuItem icon={<ExternalLink />} onSelect={() => setFocusId(bill.id)}>Open</MenuItem>
                {canEdit && billTransitions(bill.status).includes('open') && bill.status === 'pending_approval' ? <MenuItem icon={<Check />} onSelect={() => move.mutate({ id: bill.id, status: 'open' })}>Approve</MenuItem> : null}
                {canEdit && billTransitions(bill.status).includes('scheduled') ? <MenuItem icon={<CalendarClock />} onSelect={() => move.mutate({ id: bill.id, status: 'scheduled' })}>Schedule payment</MenuItem> : null}
                {canEdit && bill.balance > 0 && bill.status !== 'pending_approval' ? <MenuItem icon={<DollarSign />} onSelect={() => { setPaying(bill); setAmount(String(bill.balance)); setError(null); }}>Record payment</MenuItem> : null}
              </>
            )}
          />
        </>
      ) : null}

      {tab === 'needs_billing' ? <NeedsBillingPanel candidates={candidates.data ?? null} loading={candidates.isPending} error={candidates.error ?? null} canEdit={canEdit} onDone={async () => { await Promise.all([invalidate(), candidates.refetch()]); }} /> : null}

      {tab === 'history' ? <PaymentHistory payments={(bundle?.payments ?? []).filter((p) => p.direction === 'out')} bills={bundle?.bills ?? []} loading={query.isPending} /> : null}

      <Drawer open={focus !== null} onOpenChange={(o) => { if (!o) setFocusId(null); }} size="md" title={focus ? `Bill ${focus.billNumber}` : ''} description={focus?.vendorName} headerExtra={focus ? <StatusBadge status={focus.status} size="sm" /> : undefined}>
        {focus ? (
          <div className="flex flex-col gap-4 text-sm">
            <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-y-2 text-sm">
              <dt className="text-muted">Bill number</dt><dd className="text-ink">{focus.billNumber}</dd>
              <dt className="text-muted">Vendor</dt><dd className="text-ink">{focus.vendorName}</dd>
              <dt className="text-muted">Vendor invoice</dt><dd className="text-ink">{focus.vendorInvoiceNumber ?? '—'}</dd>
              {focus.source === 'repair_order' && focus.sourceId ? <><dt className="text-muted">Linked repair order</dt><dd><Link to="/fleet/maintenance/$orderId" params={{ orderId: focus.sourceId }} className="text-primary-text underline">{focus.vendorInvoiceNumber ?? focus.sourceId}</Link></dd></> : null}
              <dt className="text-muted">Unit</dt><dd className="text-ink">{focus.unitNumber ?? '—'}</dd>
              <dt className="text-muted">Bill date</dt><dd className="text-ink">{formatIsoDate(focus.issuedOn)}</dd>
              <dt className="text-muted">Due date</dt><dd className="text-ink">{formatIsoDate(focus.dueOn)} ({focus.paymentTermsDays} days)</dd>
              <dt className="text-muted">Category</dt><dd className="text-ink">{focus.categoryCode.replace(/_/g, ' ')}</dd>
            </dl>
            <div className="rounded-lg bg-surface-muted p-3">
              <dl className="grid grid-cols-[120px_minmax(0,1fr)] gap-y-1 text-sm">
                <dt className="text-muted">Amount</dt><dd className="tabular-nums text-ink">{formatMoney(focus.amount)}</dd>
                <dt className="text-muted">Paid</dt><dd className="tabular-nums text-ink">{formatMoney(focus.paid)}</dd>
                <dt className="font-semibold text-ink">Balance</dt><dd className="tabular-nums font-semibold text-ink">{formatMoney(focus.balance)}</dd>
              </dl>
            </div>
            <div>
              <p className="eyebrow">Payments</p>
              {(bundle?.payments ?? []).filter((p) => p.applications.some((a) => a.billId === focus.id)).length === 0 ? <p className="mt-1 text-xs text-muted">No payment recorded.</p> : (
                <ul className="mt-1 divide-y divide-line-soft text-xs">
                  {(bundle?.payments ?? []).filter((p) => p.applications.some((a) => a.billId === focus.id)).map((p) => <li key={p.id} className="flex justify-between py-1"><span>{formatIsoDate(p.receivedOn)} · {p.method} · {p.reference}</span><span className="tabular-nums">{formatMoney(p.applications.filter((a) => a.billId === focus.id).reduce((s, a) => s + a.amount, 0))}</span></li>)}
                </ul>
              )}
            </div>
            <div>
              <p className="eyebrow">Original receipt</p>
              {(() => { const att = ((focus as Bill & { attachments?: Array<{ fileId: string; fileName: string }> }).attachments ?? []); return att.length === 0 ? <p className="mt-1 rounded-lg border border-dashed border-line p-3 text-xs text-muted">No document attached to this bill.</p> : <ul className="mt-1 flex flex-col gap-1">{att.map((a) => <li key={a.fileId} className="flex items-center gap-2 rounded-lg border border-line p-2 text-xs"><span className="flex size-10 items-center justify-center rounded bg-surface-muted"><FileText className="size-4 text-muted" /></span><span className="min-w-0 truncate text-ink">{a.fileName}</span></li>)}</ul>; })()}
            </div>
            <div>
              <p className="eyebrow">Source and provenance</p>
              <p className="mt-1 text-xs text-secondary">{SOURCE_LABEL[focus.source]}{focus.source === 'repair_order' ? ' · imported from a completed repair order' : ''}. Approval {focus.approvedAt ? `by ${focus.approvedBy} on ${formatIsoDate(focus.approvedAt.slice(0, 10))}` : `needed${focus.approvalReason ? `: ${focus.approvalReason}` : ''}`}.</p>
            </div>
            <div className="flex flex-col gap-2">
              {canEdit && focus.status === 'pending_approval' ? <Button variant="primary" icon={<FileText />} onClick={() => move.mutate({ id: focus.id, status: 'open' })}>Review bill</Button> : canEdit && billTransitions(focus.status).includes('scheduled') ? <Button variant="primary" icon={<CalendarClock />} onClick={() => move.mutate({ id: focus.id, status: 'scheduled' })}>Schedule payment</Button> : null}
              {canEdit && focus.balance > 0 && focus.status !== 'pending_approval' ? <Button variant="outline" icon={<Receipt />} onClick={() => { setPaying(focus); setAmount(String(focus.balance)); setError(null); }}>Record Payment</Button> : null}
              {focus.source === 'repair_order' && focus.sourceId ? <Link to="/fleet/maintenance/$orderId" params={{ orderId: focus.sourceId }} className="text-center text-xs text-primary-text underline">Open Fleet Repair</Link> : null}
              <p className="text-2xs text-muted">Creating or approving a bill does not mark it paid.</p>
            </div>
          </div>
        ) : null}
      </Drawer>

      <Modal open={paying !== null} onOpenChange={(open) => { if (!open) setPaying(null); }} title={`Pay ${paying?.billNumber ?? ''}`} description={`${paying?.vendorName ?? ''} · balance ${formatMoney(paying?.balance ?? 0)}`} footer={<><Button variant="secondary" onClick={() => setPaying(null)}>Cancel</Button><Button loading={pay.isPending} disabled={!reference.trim() || Number(amount) <= 0} onClick={() => { setError(null); pay.mutate(); }}>Record payment</Button></>}>
        <div className="flex flex-col gap-4">
          {error ? <p role="alert" className="text-sm text-danger-text">{error}</p> : null}
          <div className="grid gap-4 sm:grid-cols-2">
            <FormField label="Amount" required description="Cannot exceed the balance; overpaying is refused."><Input inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} prefix="$" /></FormField>
            <FormField label="Method" required><Select options={[{ value: 'ach', label: 'ACH' }, { value: 'check', label: 'Check' }, { value: 'wire', label: 'Wire' }, { value: 'card', label: 'Card' }]} value={method} onValueChange={(v) => setMethod(v as Payment['method'])} /></FormField>
          </div>
          <FormField label="Reference" required><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="CHK-2210" /></FormField>
        </div>
      </Modal>

      {adding ? <AddBillDialog today={today} onClose={() => setAdding(false)} onDone={async () => { await invalidate(); setAdding(false); }} /> : null}
    </div>
  );
}

/** Completed repair orders as bill candidates: review first, then create bills for the eligible ones only. */
function NeedsBillingPanel({ candidates, loading, error, canEdit, onDone }: { candidates: WorkOrderBillCandidate[] | null; loading: boolean; error: Error | null; canEdit: boolean; onDone: () => Promise<void> }) {
  const { toast } = useToast();
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const create = useMutation({
    mutationFn: (ids: string[]) => createBillsFromWorkOrders(ids),
    onSuccess: async (r) => { await onDone(); setPicked(new Set()); toast({ tone: r.skipped.length ? 'warning' : 'success', title: `${r.created.length} bill${r.created.length === 1 ? '' : 's'} created`, description: r.skipped.length ? r.skipped.map((s) => s.reason).join(' · ') : undefined }); },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not created', description: e instanceof Error ? e.message : undefined }),
  });
  if (loading) return <p className="text-sm text-muted">Loading…</p>;
  if (error) return <Alert tone="danger" title="Repair orders could not be loaded" description={error.message} />;
  const list = candidates ?? [];
  const open = list.filter((c) => !c.hasBill && !c.expensePosted);
  const done = list.filter((c) => c.hasBill || c.expensePosted);
  const eligible = (c: WorkOrderBillCandidate) => c.problems.length === 0 && c.total > 0 && c.amountSource === 'invoice';
  const pickedRows = open.filter((c) => picked.has(c.workOrderId) && eligible(c));
  const pickedTotal = pickedRows.reduce((s, c) => s + c.total, 0);
  const reason = open.length === 0 ? 'Nothing waiting' : pickedRows.length === 0 ? 'Select eligible repair orders (vendor and vendor invoice total on record)' : null;
  return (
    <div className="flex flex-col gap-3">
      <p className="text-xs text-muted">A completed repair is a candidate, not a debt. Each row says what already exists: an existing bill, a cost Fleet already posted, an estimate instead of a vendor invoice, or a zero-cost repair. Only reviewed, eligible rows become draft bills, keyed on the work order so a retry never doubles one.</p>
      {open.length === 0 ? <p className="rounded-xl border border-line bg-surface p-6 text-sm text-muted">Every completed repair order is either billed, already posted as an expense, or has nothing owed.</p> : (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <table className="w-full text-sm">
            <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted"><tr><th className="w-8 px-3 py-2" /><th className="px-3 py-2">Source</th><th className="px-3 py-2">Vendor</th><th className="px-3 py-2">Unit</th><th className="px-3 py-2">Completed</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Amount from</th><th className="px-3 py-2">Documents</th><th className="px-3 py-2">Review</th></tr></thead>
            <tbody className="divide-y divide-line-soft">
              {open.map((c) => (
                <tr key={c.workOrderId} className={cn(!eligible(c) && 'text-muted')}>
                  <td className="px-3 py-2"><Checkbox aria-label={`Select ${c.number}`} disabled={!eligible(c) || !canEdit} checked={picked.has(c.workOrderId)} onCheckedChange={(v) => setPicked((p) => { const n = new Set(p); if (v === true) n.add(c.workOrderId); else n.delete(c.workOrderId); return n; })} /></td>
                  <td className="px-3 py-2"><Link to="/fleet/maintenance/$orderId" params={{ orderId: c.workOrderId }} className="font-semibold text-primary-text">{c.number}</Link></td>
                  <td className="px-3 py-2">{c.vendorName ?? <span className="text-danger-text">No vendor</span>}</td>
                  <td className="px-3 py-2">{c.unitNumber}</td>
                  <td className="px-3 py-2 text-xs">{c.completedAt ? formatIsoDate(c.completedAt.slice(0, 10)) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{c.amountSource === 'none' ? 'Unknown' : formatMoney(c.total)}</td>
                  <td className="px-3 py-2 text-xs">{c.amountSource === 'invoice' ? 'Vendor invoice' : c.amountSource === 'work_order' ? 'Estimate' : '—'}</td>
                  <td className="px-3 py-2 text-xs">{c.documentCount > 0 ? `${c.documentCount} file${c.documentCount === 1 ? '' : 's'}` : 'None'}</td>
                  <td className="px-3 py-2">{eligible(c) ? <Badge tone="success" size="sm">Eligible</Badge> : <Badge tone="warning" size="sm">{c.reviewReason ?? c.problems[0]}</Badge>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-3">
        {canEdit ? <Button variant="primary" size="sm" disabled={pickedRows.length === 0 || create.isPending} loading={create.isPending} onClick={() => create.mutate(pickedRows.map((c) => c.workOrderId))}>Create bills ({pickedRows.length})</Button> : null}
        <span className="text-xs text-muted">{reason ?? `${pickedRows.length} selected · ${formatMoney(pickedTotal)} · created as pending approval, never paid`}</span>
      </div>
      {done.length > 0 ? <details className="text-xs text-muted"><summary className="cursor-pointer">{done.length} completed repair order{done.length === 1 ? '' : 's'} already handled</summary><ul className="mt-1 divide-y divide-line-soft">{done.map((c) => <li key={c.workOrderId} className="flex justify-between py-1"><span>{c.number} · {c.vendorName ?? 'no vendor'} · {formatMoney(c.total)}</span><span>{c.reviewReason}</span></li>)}</ul></details> : null}
    </div>
  );
}

function PaymentHistory({ payments, bills, loading }: { payments: Payment[]; bills: Bill[]; loading: boolean }) {
  if (loading) return <p className="text-sm text-muted">Loading…</p>;
  if (payments.length === 0) return <p className="rounded-xl border border-line bg-surface p-6 text-sm text-muted">No vendor payment recorded yet. A payment is recorded against an approved bill; approval alone never marks a bill paid.</p>;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full text-sm">
        <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Vendor</th><th className="px-3 py-2">Method</th><th className="px-3 py-2">Reference</th><th className="px-3 py-2">Applied to</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2 text-right">Unapplied</th></tr></thead>
        <tbody className="divide-y divide-line-soft">
          {[...payments].sort((a, b) => b.receivedOn.localeCompare(a.receivedOn)).map((p) => (
            <tr key={p.id}>
              <td className="px-3 py-2">{formatIsoDate(p.receivedOn)}</td>
              <td className="px-3 py-2">{p.partyName}</td>
              <td className="px-3 py-2 text-xs">{p.method}</td>
              <td className="px-3 py-2 text-xs">{p.reference}</td>
              <td className="px-3 py-2 text-xs">{p.applications.map((a) => bills.find((b) => b.id === a.billId)?.billNumber ?? a.billId ?? '—').join(', ') || '—'}</td>
              <td className="px-3 py-2 text-right tabular-nums">{formatMoney(p.amount)}</td>
              <td className="px-3 py-2 text-right tabular-nums text-muted">{p.unappliedAmount > 0 ? formatMoney(p.unappliedAmount) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AddBillDialog({ today, onClose, onDone }: { today: string; onClose: () => void; onDone: () => Promise<void> }) {
  const { toast } = useToast();
  const vendors = useQuery({ queryKey: ['accounting', 'vendors'], queryFn: () => listVendors({ pageSize: 500 }) });
  const [vendorId, setVendorId] = useState('');
  const [invoice, setInvoice] = useState('');
  const [issuedOn, setIssuedOn] = useState(today);
  const [amount, setAmount] = useState('');
  const [category, setCategory] = useState('maintenance');
  const [notes, setNotes] = useState('');
  const save = useMutation({
    mutationFn: () => createBill({ vendorId, vendorInvoiceNumber: invoice.trim() || null, issuedOn, amount: Number(amount), categoryCode: category, truckId: null, loadId: null, notes: notes.trim() || null }),
    onSuccess: async (b) => { await onDone(); toast({ tone: 'success', title: `${b.billNumber} created`, description: 'Pending approval; nothing is paid.' }); },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not created', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} title="Add bill" description="A vendor invoice not raised by a repair order. Created as pending approval." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!vendorId || !(Number(amount) > 0)} onClick={() => save.mutate()}>Create bill</Button></>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Vendor" required><Select options={(vendors.data?.data ?? []).map((v) => ({ value: v.id, label: v.name }))} value={vendorId} onValueChange={setVendorId} placeholder={vendors.isPending ? 'Loading…' : 'Choose a vendor'} /></FormField>
        <FormField label="Vendor invoice #"><Input value={invoice} onChange={(e) => setInvoice(e.target.value)} /></FormField>
        <FormField label="Bill date" required><Input type="date" value={issuedOn} onChange={(e) => setIssuedOn(e.target.value)} /></FormField>
        <FormField label="Amount" required><Input inputMode="decimal" prefix="$" value={amount} onChange={(e) => setAmount(e.target.value)} /></FormField>
        <FormField label="Category" required><Select options={[{ value: 'maintenance', label: 'Maintenance' }, { value: 'fuel', label: 'Fuel' }, { value: 'tolls', label: 'Tolls' }, { value: 'lease', label: 'Lease' }, { value: 'other', label: 'Other' }]} value={category} onValueChange={setCategory} /></FormField>
        <div className="sm:col-span-2"><FormField label="Notes"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField></div>
      </div>
    </Modal>
  );
}
