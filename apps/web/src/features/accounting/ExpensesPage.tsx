import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { ChevronDown, Copy, Download, ExternalLink, Plus, Upload, Wallet } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import type { PeriodPreset } from '@neway/shared';
import { EXPENSE_ACCOUNT, RECURRING_LABEL, accountFor } from '@neway/shared';
import {
  Alert,
  Badge,
  Button,
  DataTable,
  Drawer,
  FilterBar,
  FormField,
  Input,
  Modal,
  PageHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  Switch,
  Textarea,
  cn,
  createColumns,
  useToast,
  type DataTableState,
  type FilterDefinition,
} from '@/design-system';
import { createExpense, fetchImports, fetchRecurringAll, importCsv, listDrivers, listTrucks, postImports, previewImportCsv, resolveImport, type Expense, type ImportLine, type ImportResult, type ServerExpense } from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { useFileObjectUrl } from '@/lib/files';
import { formatIsoDate, formatMoney, formatNumber } from '@/lib/format';
import { FinancialPeriodSelector } from './components/AccountingKit';
import { useAccounting, useInvalidateAccounting } from './useAccounting';
import { expensesSearchSchema } from './expenses-search';

/**
 * Expenses (corrective brief 2, section 4): company costs and recoverable charges.
 *
 * Header with the period and three actions → four compact cards → four tabs → one table with
 * a drawer. Import is a dialog (provider → file → preview → confirm) that writes nothing until
 * confirmed and never duplicates a provider transaction. Draft lines are not posted expense;
 * advances stay outside expense totals; CPM says why when it cannot be computed.
 */

const col = createColumns<Expense>();
const BURDEN_LABEL: Record<ServerExpense['burden'], string> = { company_borne: 'Company', recoverable_driver: 'Driver recoverable', recoverable_vendor: 'Vendor recoverable' };
const BURDEN_TONE: Record<ServerExpense['burden'], 'info' | 'warning' | 'neutral'> = { company_borne: 'info', recoverable_driver: 'warning', recoverable_vendor: 'neutral' };
const CATEGORY_LABEL: Record<string, string> = { fuel: 'Fuel', tolls: 'Toll', maintenance: 'Repair', driver_pay: 'Driver pay', lumper: 'Lumper', insurance: 'Insurance', permits: 'Permits', lease: 'Lease', recruiting: 'Recruiting', other: 'Other' };

type Tab = 'transactions' | 'import_review' | 'recurring' | 'categories';

function asServer(e: Expense): ServerExpense {
  const s = e as Partial<ServerExpense> & Expense;
  return { ...e, sourceKey: s.sourceKey ?? '', accountingDate: s.accountingDate ?? e.onDate, currency: s.currency ?? 'USD', provider: s.provider ?? null, payer: s.payer ?? 'company', burden: s.burden ?? 'company_borne', chargeRecipientId: s.chargeRecipientId ?? null, allocations: s.allocations ?? [], driverTransactionId: s.driverTransactionId ?? null, receiptFileId: s.receiptFileId ?? null };
}

export function ExpensesPage() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => expensesSearchSchema.parse(rawSearch), [rawSearch]);
  const navigate = useNavigate();
  const account = useAccount();
  const canEdit = account?.permissions.includes('accounting.edit') ?? false;
  const invalidate = useInvalidateAccounting();
  const queryClient = useQueryClient();
  const [columnVisibility, setColumnVisibility] = useState<DataTableState['columnVisibility']>({});
  const [importing, setImporting] = useState<{ provider: 'relay' | 'bestpass' | 'efs' | 'csv'; name: string; text: string } | null>(null);
  const [pickProvider, setPickProvider] = useState<'relay' | 'bestpass' | 'efs' | 'csv'>('relay');
  const pickRef = useRef<HTMLInputElement>(null);
  const [adding, setAdding] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null);

  const preset = (search.fp as PeriodPreset) ?? 'month';
  const query = useAccounting(preset);
  const bundle = query.data;
  const imports = useQuery({ queryKey: ['accounting', 'imports'], queryFn: () => fetchImports(), staleTime: 30_000 });
  const tab: Tab = (['import_review', 'recurring', 'categories'] as const).find((t) => t === search.tab) ?? 'transactions';
  const reviewCount = (imports.data ?? []).filter((l) => l.state === 'unmatched' || (l.state === 'matched' && !l.expenseId)).length;

  function updateSearch(patch: Record<string, string | number | undefined>) {
    void navigate({ to: '.', search: (prev: Record<string, unknown>) => { const next: Record<string, unknown> = { ...prev, ...patch }; for (const key of Object.keys(next)) if (next[key] === undefined || next[key] === '') delete next[key]; return next; }, replace: true });
  }

  const inRange = useMemo(() => (bundle?.expenses ?? []).filter((e) => bundle !== undefined && e.onDate >= bundle.range.from && e.onDate <= bundle.range.to), [bundle]);
  const rows = useMemo(() => {
    let list = inRange;
    if (search.category) list = list.filter((e) => e.categoryCode === search.category);
    if (search.unit) list = list.filter((e) => e.truckId === search.unit);
    if (search.driver) list = list.filter((e) => e.driverId === search.driver);
    if (search.vendor) list = list.filter((e) => e.vendorId === search.vendor);
    if (search.source) list = list.filter((e) => e.source === search.source);
    if (search.burden) list = list.filter((e) => asServer(e).burden === search.burden);
    if (search.status) list = list.filter((e) => e.status === search.status);
    const q = search.q?.trim().toLowerCase();
    if (q) list = list.filter((e) => [e.expenseNumber, e.description, e.vendorName, e.unitNumber, e.driverName, e.loadNumber].some((v) => v?.toLowerCase().includes(q)));
    return [...list].sort((a, b) => (a.onDate < b.onDate ? 1 : -1));
  }, [inRange, search]);
  const focus = (bundle?.expenses ?? []).find((e) => e.id === focusId) ?? null;

  const posted = inRange.filter((e) => e.status === 'posted');
  const postedTotal = posted.reduce((s, e) => s + e.amount, 0);
  const companyBorne = posted.filter((e) => asServer(e).burden === 'company_borne').reduce((s, e) => s + e.amount, 0);
  const recoverable = posted.filter((e) => asServer(e).burden !== 'company_borne').reduce((s, e) => s + e.amount, 0);
  const drafts = inRange.filter((e) => e.status === 'draft');
  const advances = (imports.data ?? []).filter((l) => l.kind === 'advance');

  const filters = useMemo<FilterDefinition[]>(() => {
    const all = bundle?.expenses ?? [];
    const opt = (pairs: Array<[string, string]>) => [...new Map(pairs)].sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label }));
    return [
      { key: 'category', label: 'Category', type: 'select', options: [...new Set(all.map((e) => e.categoryCode))].sort().map((value) => ({ value, label: CATEGORY_LABEL[value] ?? value })) },
      { key: 'unit', label: 'Truck', type: 'select', options: opt(all.filter((e) => e.truckId).map((e) => [e.truckId as string, e.unitNumber as string])) },
      { key: 'driver', label: 'Driver', type: 'select', options: opt(all.filter((e) => e.driverId).map((e) => [e.driverId as string, e.driverName as string])) },
      { key: 'vendor', label: 'Vendor', type: 'select', options: opt(all.filter((e) => e.vendorId).map((e) => [e.vendorId as string, e.vendorName as string])) },
      { key: 'source', label: 'Source', type: 'select', options: [...new Set(all.map((e) => e.source))].sort().map((value) => ({ value, label: value.replace(/_/g, ' ') })) },
      { key: 'burden', label: 'Cost responsibility', type: 'select', options: (Object.keys(BURDEN_LABEL) as ServerExpense['burden'][]).map((value) => ({ value, label: BURDEN_LABEL[value] })) },
      { key: 'status', label: 'Status', type: 'select', options: [{ value: 'posted', label: 'Posted' }, { value: 'draft', label: 'Draft' }, { value: 'void', label: 'Void' }] },
    ];
  }, [bundle]);

  const columns = useMemo(() => col.columns([
    col.accessor('onDate', { header: 'Date', cell: ({ getValue }) => formatIsoDate(getValue()), meta: { width: 105 } }),
    col.accessor('categoryCode', { header: 'Category', cell: ({ getValue }) => CATEGORY_LABEL[getValue()] ?? getValue().replace(/_/g, ' '), meta: { width: 110 } }),
    col.display({ id: 'source', header: 'Source', meta: { width: 130 }, cell: ({ row }) => { const s = asServer(row.original); return <span className="text-secondary">{s.provider ? s.provider[0]!.toUpperCase() + s.provider.slice(1) : row.original.source === 'maintenance' && row.original.sourceId ? <Link to="/fleet/maintenance/$orderId" params={{ orderId: row.original.sourceId }} className="text-primary-text hover:underline" onClick={(e) => e.stopPropagation()}>{row.original.description.match(/RO-\d+|WO-\d+/)?.[0] ?? 'Repair order'}</Link> : row.original.billId ? 'Bill' : row.original.source.replace(/_/g, ' ')}</span>; } }),
    col.display({ id: 'unitDriver', header: 'Unit / Driver', cell: ({ row }) => <span>{row.original.truckId ? <Link to="/fleet/trucks/$truckId" params={{ truckId: row.original.truckId }} className="hover:underline" onClick={(e) => e.stopPropagation()}>Truck {row.original.unitNumber}</Link> : <span className="text-faint">No unit</span>}<span className="block text-xs text-muted">{row.original.driverName ?? '—'}</span></span> }),
    col.accessor('amount', { header: 'Amount', cell: ({ getValue }) => formatMoney(getValue()), meta: { align: 'right', width: 105 } }),
    col.display({ id: 'burden', header: 'Cost responsibility', meta: { width: 150 }, cell: ({ row }) => { const b = asServer(row.original).burden; return <Badge tone={BURDEN_TONE[b]} size="sm">{BURDEN_LABEL[b]}</Badge>; } }),
    col.accessor('status', { header: 'Status', meta: { width: 90 }, cell: ({ getValue }) => <Badge tone={getValue() === 'posted' ? 'success' : getValue() === 'void' ? 'neutral' : 'warning'} size="sm">{getValue()[0]!.toUpperCase() + getValue().slice(1)}</Badge> }),
  ]), []);

  const card = (label: string, value: string, hint: string, title?: string) => (
    <div className="rounded-xl border border-line bg-surface p-4" title={title}>
      <p className="text-xs text-muted">{label}</p>
      <p className="mt-1 text-2xl font-bold tabular-nums text-ink">{value}</p>
      <p className="text-2xs text-muted">{hint}</p>
    </div>
  );
  const cpm = bundle?.cpm;

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Expenses"
        description="Company costs and recoverable charges"
        actions={<div className="flex flex-wrap items-center gap-2">{bundle ? <FinancialPeriodSelector value={preset} onChange={(next) => updateSearch({ fp: next })} range={bundle.range} /> : null}{canEdit ? <Button variant="primary" size="sm" icon={<Plus />} onClick={() => setAdding(true)}>Add Expense</Button> : null}{canEdit ? (
          <Popover>
            <PopoverTrigger asChild><Button variant="secondary" size="sm" icon={<Upload />}>Import <ChevronDown className="size-3.5" /></Button></PopoverTrigger>
            <PopoverContent align="end" className="w-64 p-3">
              <p className="text-sm font-semibold text-ink">Import expenses</p>
              <ul className="mt-2 flex flex-col gap-1">
                {([['relay', 'Relay', 'Fuel purchases'], ['bestpass', 'BestPass', 'Tolls and fees'], ['efs', 'EFS', 'Fuel and cards'], ['csv', 'Other CSV', 'Generic CSV file']] as const).map(([v, l, h]) => (
                  <li key={v}><label className="flex cursor-pointer items-start gap-2 rounded-md px-1 py-1 hover:bg-surface-hover"><input type="radio" name="import-provider" className="mt-1 accent-primary" checked={pickProvider === v} onChange={() => setPickProvider(v)} /><span><span className="block text-sm text-ink">{l}</span><span className="block text-xs text-muted">{h}</span></span></label></li>
                ))}
              </ul>
              <input ref={pickRef} type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; setImporting({ provider: pickProvider, name: f.name, text: await f.text() }); }} />
              <Button className="mt-3 w-full" variant="primary" size="sm" icon={<Upload />} onClick={() => pickRef.current?.click()}>Choose file</Button>
              <p className="mt-2 text-2xs text-muted">API not connected · CSV available</p>
            </PopoverContent>
          </Popover>
        ) : null}<Button variant="secondary" size="sm" icon={<Download />} disabled={!bundle} onClick={() => exportCsv(rows)}>Export</Button></div>}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        {bundle ? card('Posted expenses', formatMoney(postedTotal), `${posted.length} posted · ${drafts.length} draft not counted`, 'Expenses with status posted in the selected period, by occurrence date.') : card('Posted expenses', 'Loading…', '')}
        {bundle ? card('Company-borne', formatMoney(companyBorne), 'not recovered from anyone') : card('Company-borne', 'Loading…', '')}
        {bundle ? card('Recoverable charges', formatMoney(recoverable), 'from drivers or vendors, per their profile') : card('Recoverable charges', 'Loading…', '')}
        {cpm ? card('CPM', cpm.costPerMile === null ? 'Not available' : `$${cpm.costPerMile.toFixed(2)}`, cpm.unavailable ? cpm.unavailable : `Based on ${formatNumber(cpm.miles ?? 0)} mi delivered in the period`, 'Ledger costs in the period over the miles delivered loads turned. Missing miles or costs make this unavailable, never zero.') : card('CPM', 'Loading…', '')}
      </div>

      <div className="flex flex-wrap items-center gap-1 border-b border-line" role="tablist" aria-label="Expenses">
        {([['transactions', 'Transactions'], ['import_review', `Import review${imports.data ? ` (${reviewCount})` : ''}`], ['recurring', 'Recurring'], ['categories', 'Categories']] as const).map(([k, label]) => (
          <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => updateSearch({ tab: k === 'transactions' ? undefined : k, page: undefined })} className={cn('-mb-px border-b-2 px-3 py-2 text-sm font-semibold', tab === k ? 'border-primary text-primary-text' : 'border-transparent text-muted hover:text-ink')}>{label}</button>
        ))}
      </div>

      {tab === 'transactions' ? (
        <>
          <DataTable
            columns={columns}
            data={rows}
            rowKey={(expense) => expense.id}
            state={{ sorting: [], pagination: { page: search.page ?? 1, pageSize: 25 }, rowSelection: {}, columnVisibility, globalFilter: '' }}
            onStateChange={(patch) => { if (patch.pagination !== undefined) updateSearch({ page: patch.pagination.page > 1 ? patch.pagination.page : undefined }); if (patch.columnVisibility !== undefined) setColumnVisibility(patch.columnVisibility); }}
            loading={query.isPending}
            error={query.error ?? undefined}
            onRetry={() => void query.refetch()}
            emptyTitle="No expenses in this period"
            emptyDescription={reviewCount > 0 ? `${reviewCount} imported line(s) are waiting on Import review.` : 'Fuel, tolls and repair costs arrive from provider imports and repair orders; anything else is added by hand.'}
            caption="Expenses"
            onRowClick={(e) => setFocusId(e.id)}
            toolbar={<FilterBar search={{ value: search.q ?? '', onChange: (value) => updateSearch({ q: value || undefined, page: undefined }), placeholder: 'Search expenses…' }} filters={filters} values={{ category: search.category, unit: search.unit, driver: search.driver, vendor: search.vendor, source: search.source, burden: search.burden, status: search.status }} onChange={(key, value) => updateSearch({ [key]: (value as string | undefined) || undefined, page: undefined })} onClear={() => updateSearch({ category: undefined, unit: undefined, driver: undefined, vendor: undefined, source: undefined, burden: undefined, status: undefined, q: undefined, page: undefined })} />}
          />
          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface p-4 text-sm">
            <span className="flex items-center gap-3"><span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-text"><Wallet className="size-4" /></span><span><span className="font-semibold text-ink">Advances are tracked separately from expense totals</span><span className="block text-xs text-muted">{advances.length > 0 ? `${advances.length} advance line(s) imported; they reach the driver's account, never these totals.` : 'Driver advances, fuel cards and other cash advances are not included in the expenses above.'}</span></span></span>
            <Link to="/accounting/settlements" className="inline-flex h-8 items-center gap-1 rounded-lg border border-line bg-surface px-3 text-xs font-semibold text-primary-text hover:bg-surface-hover">View advances <ExternalLink className="size-3" /></Link>
          </div>
        </>
      ) : null}

      {tab === 'import_review' ? <ImportReview lines={imports.data ?? []} loading={imports.isPending} canEdit={canEdit} onChanged={async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ['accounting', 'imports'] }), invalidate()]); }} /> : null}
      {tab === 'recurring' ? <RecurringTab /> : null}
      {tab === 'categories' ? <CategoriesTab expenses={inRange} /> : null}

      <ExpenseDrawer expense={focus} onClose={() => setFocusId(null)} />
      {importing ? <ImportDialog initial={importing} onClose={() => setImporting(null)} onDone={async () => { await Promise.all([queryClient.invalidateQueries({ queryKey: ['accounting', 'imports'] }), invalidate()]); }} /> : null}
      {adding ? <AddExpenseDialog today={bundle?.today ?? ''} onClose={() => setAdding(false)} onDone={async () => { await invalidate(); setAdding(false); }} /> : null}
    </div>
  );
}

function exportCsv(list: Expense[]) {
  const esc = (v: string | number | null) => `"${String(v ?? '').replace(/"/g, '""')}"`;
  const head = ['Date', 'Expense #', 'Category', 'Source', 'Unit', 'Driver', 'Vendor', 'Description', 'Amount', 'Responsibility', 'Status'];
  const lines = list.map((e) => [e.onDate, e.expenseNumber, e.categoryCode, e.source, e.unitNumber, e.driverName, e.vendorName, e.description, e.amount, asServer(e).burden, e.status].map(esc).join(','));
  const blob = new Blob([[head.map(esc).join(','), ...lines].join(String.fromCharCode(10))], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'expenses.csv';
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** The row, in full: receipt, provenance, event-time links, allocation, approval and the bill behind it. */
function ExpenseDrawer({ expense, onClose }: { expense: Expense | null; onClose: () => void }) {
  const s = expense ? asServer(expense) : null;
  const receipt = useFileObjectUrl(s?.receiptFileId ? { fileUrl: `/api/v1/files/${encodeURIComponent(s.receiptFileId)}` } : null);
  return (
    <Drawer open={expense !== null} onOpenChange={(o) => { if (!o) onClose(); }} size="md" title="Expense details" description={expense ? `${expense.expenseNumber} · ${formatIsoDate(expense.onDate)}` : undefined}>
      {expense && s ? (
        <div className="flex flex-col gap-4 text-sm">
          <div className="nw-paper overflow-hidden rounded-lg border border-line" data-theme="light">
            {s.receiptFileId ? (receipt ? <img src={receipt} alt="Receipt" className="max-h-72 w-full object-contain" /> : <p className="p-3 text-xs text-muted">Loading…</p>) : <p className="p-6 text-center text-xs text-muted">No receipt on file</p>}
          </div>
          <div className="flex items-start justify-between gap-3 text-xs">
            <span><span className="block text-muted">Source</span><span className="text-sm font-semibold text-ink">{s.provider ? s.provider[0]!.toUpperCase() + s.provider.slice(1) : expense.source.replace(/_/g, ' ')}</span></span>
            <span className="text-right"><span className="block text-muted">Transaction ID</span><span className="inline-flex items-center gap-1 font-mono text-ink">{expense.sourceId ?? (s.sourceKey || '—')}<button type="button" className="text-muted hover:text-ink" title="Copy" onClick={() => void navigator.clipboard?.writeText(expense.sourceId ?? s.sourceKey)}><Copy className="size-3" /></button></span></span>
          </div>
          <Field label="Date"><Input readOnly value={formatIsoDate(expense.onDate)} aria-label="Date" /></Field>
          <Field label="Linked to">
            <div className="grid grid-cols-2 gap-2">
              <Input readOnly value={expense.unitNumber ? `Truck ${expense.unitNumber}` : 'No unit'} aria-label="Truck" />
              <Input readOnly value={expense.driverName ?? 'No driver'} aria-label="Driver" />
              <Input className="col-span-2" readOnly value={expense.loadNumber ?? 'Load (optional)'} aria-label="Load" />
            </div>
            <p className="mt-1 text-2xs text-muted">As at the event time: the driver on the unit that day.</p>
          </Field>
          <div className="flex items-center justify-between rounded-lg border border-line px-3 py-2"><span><span className="block text-sm text-ink">Company paid</span><span className="block text-xs text-muted">{s.payer === 'company' ? 'This expense was paid by the company' : `Paid by ${s.payer}`}</span></span><Switch checked={s.payer === 'company'} disabled aria-label="Company paid" /></div>
          <Field label="Cost responsibility"><div className="flex items-center gap-2"><Input readOnly value={BURDEN_LABEL[s.burden]} aria-label="Cost responsibility" /><Badge tone={BURDEN_TONE[s.burden]} size="sm">{BURDEN_LABEL[s.burden]}</Badge></div></Field>
          <Field label="Approval status"><div className="flex items-center gap-2"><Badge tone={expense.status === 'posted' ? 'success' : expense.status === 'void' ? 'neutral' : 'warning'} size="sm">{expense.status === 'posted' ? 'Approved · posted' : expense.status}</Badge>{expense.postedAt ? <span className="text-xs text-muted">{formatIsoDate(expense.postedAt.slice(0, 10))} · account {expense.accountCode}</span> : null}</div></Field>
          <Field label="Amount"><Input readOnly value={`${formatMoney(expense.amount)} ${s.currency}`} aria-label="Amount" /></Field>
          {s.allocations.length > 0 ? <Field label="Allocation"><p className="text-xs text-ink">{s.allocations.map((a) => `${a.partyType} ${a.partyId} ${formatMoney(a.amount)}`).join(' · ')}</p></Field> : null}
          <Field label="Notes"><Textarea rows={2} readOnly value={expense.notes ?? expense.description} aria-label="Notes" /></Field>
          <div className="flex items-center justify-between">
            {expense.billId ? <Link to="/accounting/payables" search={{ ids: expense.billId }} className="inline-flex items-center gap-1 text-xs text-primary-text underline">View bill <ExternalLink className="size-3" /></Link> : <span className="text-xs text-muted">Paid directly, no bill</span>}
            {s.driverTransactionId && expense.driverId ? <Link to="/drivers/$driverId" params={{ driverId: expense.driverId }} search={{ tab: 'financial' }} className="text-xs text-primary-text underline">Driver charge on the account</Link> : null}
          </div>
          <p className="text-2xs text-muted">Source and allocation history are kept. Fields are read-only here; corrections go through Accounting with the permission checked on the server.</p>
        </div>
      ) : null}
    </Drawer>
  );
}

/** Provider → file → preview (nothing written) → confirm. A known provider transaction is skipped, never doubled. */
function ImportDialog({ initial, onClose, onDone }: { initial: { provider: 'relay' | 'bestpass' | 'efs' | 'csv'; name: string; text: string }; onClose: () => void; onDone: () => Promise<void> }) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [provider, setProvider] = useState<'relay' | 'bestpass' | 'efs' | 'csv'>(initial.provider);
  const [file, setFile] = useState<{ name: string; text: string } | null>({ name: initial.name, text: initial.text });
  const [preview, setPreview] = useState<ImportResult | null>(null);
  const previewRun = useMutation({ mutationFn: (text: string) => previewImportCsv(provider, text), onSuccess: setPreview, onError: (e: unknown) => toast({ tone: 'danger', title: 'The file could not be read', description: e instanceof Error ? e.message : undefined }) });
  const [started, setStarted] = useState(false);
  if (!started) { setStarted(true); previewRun.mutate(initial.text); }
  const confirm = useMutation({
    mutationFn: () => importCsv(provider, file!.text),
    onSuccess: async (r) => { await onDone(); toast({ tone: 'success', title: `${r.imported} line${r.imported === 1 ? '' : 's'} imported`, description: `${r.matched} matched · ${r.unmatched} to review · ${r.duplicates} already on file (skipped)` }); onClose(); },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Import failed', description: e instanceof Error ? e.message : undefined }),
  });
  const providers = [{ value: 'relay', label: 'Relay', hint: 'Fuel purchases' }, { value: 'bestpass', label: 'BestPass', hint: 'Tolls and fees' }, { value: 'efs', label: 'EFS', hint: 'Fuel and cards' }, { value: 'csv', label: 'Other CSV', hint: 'Generic CSV file' }] as const;
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} size="lg" title="Import expenses" description="CSV available · API not connected. Credentials and integration details live in Settings." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!preview || preview.imported === 0 || confirm.isPending} loading={confirm.isPending} onClick={() => confirm.mutate()}>{preview ? `Confirm import (${preview.imported})` : 'Confirm import'}</Button></>}>
      <div className="flex flex-col gap-4">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
          {providers.map((p) => (
            <button key={p.value} type="button" onClick={() => { setProvider(p.value); setPreview(null); if (file) previewRun.mutate(file.text); }} className={cn('rounded-lg border p-3 text-left', provider === p.value ? 'border-primary bg-primary-soft' : 'border-line bg-surface hover:bg-surface-hover')} aria-pressed={provider === p.value}>
              <span className="block text-sm font-semibold text-ink">{p.label}</span><span className="block text-xs text-muted">{p.hint}</span>
            </button>
          ))}
        </div>
        <input ref={fileRef} type="file" accept=".csv,text/csv" className="hidden" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; const text = await f.text(); setFile({ name: f.name, text }); setPreview(null); previewRun.mutate(text); }} />
        <div className="flex items-center gap-3"><Button variant="secondary" size="sm" icon={<Upload />} loading={previewRun.isPending} onClick={() => fileRef.current?.click()}>Choose file</Button><span className="text-xs text-muted">{file ? file.name : 'No file chosen. Nothing is written until you confirm.'}</span></div>
        {preview ? (
          <div className="flex flex-col gap-2">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4 text-sm">
              <Stat label="New lines" value={String(preview.imported)} />
              <Stat label="Matched" value={String(preview.matched)} />
              <Stat label="Unmatched" value={String(preview.unmatched)} tone={preview.unmatched > 0 ? 'warn' : undefined} />
              <Stat label="Already on file" value={String(preview.duplicates)} />
            </div>
            {preview.imported === 0 ? <Alert tone="info" title="Nothing new in this file" description={`${preview.duplicates} line(s) are already on file; re-importing is a no-op.`} /> : null}
            <div className="max-h-64 overflow-auto rounded-lg border border-line">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-surface-muted text-left text-muted"><tr><th className="px-2 py-1">Date</th><th className="px-2 py-1">Unit / card</th><th className="px-2 py-1">Driver on that date</th><th className="px-2 py-1">Description</th><th className="px-2 py-1 text-right">Amount</th><th className="px-2 py-1">Match</th></tr></thead>
                <tbody className="divide-y divide-line-soft">
                  {preview.records.slice(0, 100).map((l, i) => <tr key={`${l.sourceKey}-${i}`}><td className="px-2 py-1">{formatIsoDate(l.occurredOn)}</td><td className="px-2 py-1">{l.unitNumber ?? l.cardOrUnit ?? '—'}</td><td className="px-2 py-1">{l.driverName ?? '—'}</td><td className="truncate px-2 py-1">{l.description}</td><td className="px-2 py-1 text-right tabular-nums">{formatMoney(l.amountCents / 100)}</td><td className="px-2 py-1">{l.state === 'matched' ? <Badge tone="success" size="sm">Matched</Badge> : <Badge tone="warning" size="sm" title={l.problems.join('; ')}>{l.problems[0] ?? 'Unmatched'}</Badge>}</td></tr>)}
                </tbody>
              </table>
            </div>
            <p className="text-2xs text-muted">Total {formatMoney(preview.totalCents / 100)} across {preview.records.length} new line(s). Unmatched lines are imported for review, not posted.</p>
          </div>
        ) : null}
      </div>
    </Modal>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return <div><p className="mb-1 text-xs text-muted">{label}</p>{children}</div>;
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: 'warn' }) {
  return <div className="rounded-lg bg-surface-muted p-2"><p className="text-2xs text-muted">{label}</p><p className={cn('text-lg font-bold tabular-nums', tone === 'warn' ? 'text-warning-text' : 'text-ink')}>{value}</p></div>;
}

/** Imported lines that are not yet expenses: map the unit or driver, ignore with a reason, or post the matched ones. */
function ImportReview({ lines, loading, canEdit, onChanged }: { lines: ImportLine[]; loading: boolean; canEdit: boolean; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const trucks = useQuery({ queryKey: ['trucks', 'import-review'], queryFn: () => listTrucks({ pageSize: 500 }) });
  const drivers = useQuery({ queryKey: ['drivers', 'import-review'], queryFn: () => listDrivers({ pageSize: 500 }) });
  const [picked, setPicked] = useState<Record<string, { truckId?: string; driverId?: string }>>({});
  const fix = useMutation({ mutationFn: (input: { id: string; truckId?: string | null; driverId?: string | null }) => resolveImport(input.id, { truckId: input.truckId, driverId: input.driverId }), onSuccess: async (l) => { await onChanged(); toast({ tone: l.state === 'matched' ? 'success' : 'warning', title: l.state === 'matched' ? 'Line matched' : 'Still unmatched', description: l.problems.join('; ') || undefined }); } });
  const ignore = useMutation({ mutationFn: (id: string) => resolveImport(id, { ignore: true, reason: 'Ignored by Accounting' }), onSuccess: () => onChanged() });
  const post = useMutation({ mutationFn: (ids: string[]) => postImports(ids), onSuccess: async (r) => { await onChanged(); toast({ tone: 'success', title: `${r.posted} posted`, description: r.skipped.length ? r.skipped.map((s) => s.reason).join(' · ') : 'Expenses recorded; driver charges follow each profile.' }) } });
  if (loading) return <p className="text-sm text-muted">Loading…</p>;
  const unmatched = lines.filter((l) => l.state === 'unmatched');
  const matched = lines.filter((l) => l.state === 'matched' && !l.expenseId);
  if (unmatched.length === 0 && matched.length === 0) return <p className="rounded-xl border border-line bg-surface p-6 text-sm text-muted">Nothing to review. Imported lines that matched are posted; unmatched ones appear here with what to fix.</p>;
  return (
    <div className="flex flex-col gap-4">
      {unmatched.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <p className="border-b border-line-soft px-3 py-2 text-sm font-semibold text-ink">{unmatched.length} unmatched · candidate amount {formatMoney(unmatched.reduce((s, l) => s + l.amountCents, 0) / 100)} (not posted)</p>
          <table className="w-full text-sm">
            <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Provider</th><th className="px-3 py-2">Description</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Problem</th><th className="px-3 py-2">Fix</th></tr></thead>
            <tbody className="divide-y divide-line-soft">
              {unmatched.map((l) => (
                <tr key={l.id}>
                  <td className="px-3 py-2 text-xs">{formatIsoDate(l.occurredOn)}</td>
                  <td className="px-3 py-2 text-xs">{l.provider}</td>
                  <td className="px-3 py-2 text-xs">{l.description}<span className="block text-muted">{l.cardOrUnit ? `unit/card ${l.cardOrUnit}` : ''}</span></td>
                  <td className="px-3 py-2 text-right tabular-nums">{formatMoney(l.amountCents / 100)}</td>
                  <td className="px-3 py-2 text-xs text-warning-text">{l.problems.join('; ')}</td>
                  <td className="px-3 py-2">
                    {canEdit ? (
                      <div className="flex flex-wrap items-center gap-1">
                        <Select className="w-36" options={(trucks.data?.data ?? []).map((t) => ({ value: t.id, label: t.unitNumber }))} value={picked[l.id]?.truckId ?? l.truckId ?? ''} onValueChange={(v) => setPicked((p) => ({ ...p, [l.id]: { ...p[l.id], truckId: v } }))} placeholder="Unit" aria-label="Unit" />
                        <Select className="w-44" options={(drivers.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))} value={picked[l.id]?.driverId ?? l.driverId ?? ''} onValueChange={(v) => setPicked((p) => ({ ...p, [l.id]: { ...p[l.id], driverId: v } }))} placeholder="Driver" aria-label="Driver" />
                        <Button variant="secondary" size="sm" loading={fix.isPending} onClick={() => fix.mutate({ id: l.id, truckId: picked[l.id]?.truckId ?? l.truckId ?? null, driverId: picked[l.id]?.driverId ?? l.driverId ?? null })}>Match</Button>
                        <Button variant="link" size="sm" onClick={() => ignore.mutate(l.id)}>Ignore</Button>
                      </div>
                    ) : <span className="text-xs text-muted">Accounting resolves</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {matched.length > 0 ? (
        <div className="overflow-x-auto rounded-xl border border-line bg-surface">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-line-soft px-3 py-2"><p className="text-sm font-semibold text-ink">{matched.length} matched, not yet posted · {formatMoney(matched.reduce((s, l) => s + l.amountCents, 0) / 100)}</p>{canEdit ? <Button variant="primary" size="sm" loading={post.isPending} onClick={() => post.mutate(matched.map((l) => l.id))}>Post {matched.length} to expenses</Button> : null}</div>
          <table className="w-full text-sm">
            <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted"><tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Provider</th><th className="px-3 py-2">Unit</th><th className="px-3 py-2">Driver on that date</th><th className="px-3 py-2">Description</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">Flag</th></tr></thead>
            <tbody className="divide-y divide-line-soft">
              {matched.slice(0, 100).map((l) => <tr key={l.id}><td className="px-3 py-2 text-xs">{formatIsoDate(l.occurredOn)}</td><td className="px-3 py-2 text-xs">{l.provider}</td><td className="px-3 py-2 text-xs">{l.unitNumber ?? '—'}</td><td className="px-3 py-2 text-xs">{l.driverName ?? '—'}</td><td className="px-3 py-2 text-xs">{l.description}</td><td className="px-3 py-2 text-right tabular-nums">{formatMoney(l.amountCents / 100)}</td><td className="px-3 py-2">{l.driverChargeIndicator ? <Badge tone="warning" size="sm">Driver charge?</Badge> : l.kind === 'advance' ? <Badge tone="neutral" size="sm">Advance</Badge> : null}</td></tr>)}
            </tbody>
          </table>
          <p className="px-3 py-2 text-2xs text-muted">Posting follows each driver's profile: a company driver's fuel and tolls are company costs unless the profile says otherwise; nothing is recovered twice.</p>
        </div>
      ) : null}
    </div>
  );
}

function RecurringTab() {
  const q = useQuery({ queryKey: ['accounting', 'recurring-all'], queryFn: fetchRecurringAll });
  if (q.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (q.isError) return <Alert tone="danger" title="Recurring rules could not be loaded" />;
  const rows = q.data;
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <p className="border-b border-line-soft px-3 py-2 text-xs text-muted">The recurring deductions already on the drivers' accounts (the same rules the settlements apply). Edit them on the driver's Financial account.</p>
      {rows.length === 0 ? <p className="p-6 text-sm text-muted">No recurring rules yet.</p> : (
        <table className="w-full text-sm">
          <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted"><tr><th className="px-3 py-2">Driver</th><th className="px-3 py-2">Rule</th><th className="px-3 py-2">Cadence</th><th className="px-3 py-2 text-right">Amount</th><th className="px-3 py-2">From</th><th className="px-3 py-2">Status</th></tr></thead>
          <tbody className="divide-y divide-line-soft">
            {rows.map((r) => <tr key={r.id}><td className="px-3 py-2"><Link to="/drivers/$driverId" params={{ driverId: r.driverId }} search={{ tab: 'financial' }} className="text-primary-text hover:underline">{r.driverName ?? r.driverId}</Link></td><td className="px-3 py-2">{r.label ?? RECURRING_LABEL[r.category]}</td><td className="px-3 py-2 text-xs">{r.cadence}</td><td className="px-3 py-2 text-right tabular-nums">{formatMoney(r.amountCents / 100)}</td><td className="px-3 py-2 text-xs">{formatIsoDate(r.startsOn)}{r.endsOn ? ` – ${formatIsoDate(r.endsOn)}` : ''}</td><td className="px-3 py-2"><Badge tone={r.status === 'active' ? 'success' : 'neutral'} size="sm">{r.status}</Badge></td></tr>)}
          </tbody>
        </table>
      )}
    </div>
  );
}

function CategoriesTab({ expenses }: { expenses: Expense[] }) {
  const rows = Object.entries(EXPENSE_ACCOUNT).map(([code, acct]) => { const mine = expenses.filter((e) => e.categoryCode === code && e.status === 'posted'); return { code, label: CATEGORY_LABEL[code] ?? code, account: acct, accountName: accountFor(acct)?.name ?? acct, count: mine.length, amount: mine.reduce((s, e) => s + e.amount, 0) }; });
  return (
    <div className="overflow-x-auto rounded-xl border border-line bg-surface">
      <table className="w-full text-sm">
        <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted"><tr><th className="px-3 py-2">Category</th><th className="px-3 py-2">Ledger account</th><th className="px-3 py-2 text-right">Posted in period</th><th className="px-3 py-2 text-right">Amount</th></tr></thead>
        <tbody className="divide-y divide-line-soft">
          {rows.map((r) => <tr key={r.code}><td className="px-3 py-2">{r.label}</td><td className="px-3 py-2 text-xs"><span className="font-mono">{r.account}</span> {r.accountName}</td><td className="px-3 py-2 text-right tabular-nums">{r.count}</td><td className="px-3 py-2 text-right tabular-nums">{formatMoney(r.amount)}</td></tr>)}
        </tbody>
      </table>
      <p className="px-3 py-2 text-2xs text-muted">Categories mirror the expense accounts of the chart; an expense posts to exactly one.</p>
    </div>
  );
}

function AddExpenseDialog({ today, onClose, onDone }: { today: string; onClose: () => void; onDone: () => Promise<void> }) {
  const { toast } = useToast();
  const trucks = useQuery({ queryKey: ['trucks', 'add-expense'], queryFn: () => listTrucks({ pageSize: 500 }) });
  const drivers = useQuery({ queryKey: ['drivers', 'add-expense'], queryFn: () => listDrivers({ pageSize: 500 }) });
  const [onDate, setOnDate] = useState(today);
  const [category, setCategory] = useState('other');
  const [description, setDescription] = useState('');
  const [amount, setAmount] = useState('');
  const [truckId, setTruckId] = useState('');
  const [driverId, setDriverId] = useState('');
  const [companyPaid, setCompanyPaid] = useState(true);
  const [burden, setBurden] = useState<ServerExpense['burden']>('company_borne');
  const [notes, setNotes] = useState('');
  const save = useMutation({
    mutationFn: () => createExpense({ onDate, categoryCode: category, description: description.trim(), amount: Number(amount), truckId: truckId || null, driverId: driverId || null, loadId: null, vendorId: null, paymentMethod: null, paidDirectly: companyPaid, notes: notes.trim() || null, burden, payer: companyPaid ? 'company' : burden === 'recoverable_driver' ? 'driver' : 'vendor' }),
    onSuccess: async (r) => { if (!r.ok) { toast({ tone: 'danger', title: 'Not recorded', description: r.blocked }); return; } await onDone(); toast({ tone: 'success', title: `${r.expense?.expenseNumber ?? 'Expense'} recorded` }); },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not recorded', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} title="Add expense" description="A cost not raised by a provider file or a repair order." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} disabled={!(Number(amount) > 0) || description.trim().length < 2} onClick={() => save.mutate()}>Record expense</Button></>}>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        <FormField label="Date" required><Input type="date" value={onDate} onChange={(e) => setOnDate(e.target.value)} /></FormField>
        <FormField label="Category" required><Select options={Object.keys(EXPENSE_ACCOUNT).map((c) => ({ value: c, label: CATEGORY_LABEL[c] ?? c }))} value={category} onValueChange={setCategory} /></FormField>
        <div className="sm:col-span-2"><FormField label="Description" required><Input value={description} onChange={(e) => setDescription(e.target.value)} /></FormField></div>
        <FormField label="Amount" required><Input inputMode="decimal" prefix="$" value={amount} onChange={(e) => setAmount(e.target.value)} /></FormField>
        <FormField label="Cost responsibility"><Select options={(Object.keys(BURDEN_LABEL) as ServerExpense['burden'][]).map((b) => ({ value: b, label: BURDEN_LABEL[b] }))} value={burden} onValueChange={(v) => setBurden(v as ServerExpense['burden'])} /></FormField>
        <FormField label="Truck"><Select options={[{ value: '', label: 'None' }, ...(trucks.data?.data ?? []).map((t) => ({ value: t.id, label: t.unitNumber }))]} value={truckId} onValueChange={setTruckId} /></FormField>
        <FormField label="Driver"><Select options={[{ value: '', label: 'None' }, ...(drivers.data?.data ?? []).map((d) => ({ value: d.id, label: d.name }))]} value={driverId} onValueChange={setDriverId} /></FormField>
        <div className="sm:col-span-2"><Switch checked={companyPaid} onCheckedChange={setCompanyPaid} label="Company paid" /></div>
        <div className="sm:col-span-2"><FormField label="Notes"><Textarea rows={2} value={notes} onChange={(e) => setNotes(e.target.value)} /></FormField></div>
      </div>
    </Modal>
  );
}
