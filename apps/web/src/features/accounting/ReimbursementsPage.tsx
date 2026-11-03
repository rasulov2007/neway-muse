import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Check, ExternalLink, Plus, Receipt, Upload, X } from 'lucide-react';
import { useMemo, useRef, useState } from 'react';
import {
  PAYMENT_SOURCE_LABEL,
  PAYMENT_SOURCES,
  REIMBURSEMENT_CATEGORIES,
  REIMBURSEMENT_CATEGORY_LABEL,
  REIMBURSEMENT_STATUS_LABEL,
  companyFundedCents,
  reimbursableCents,
  reimbursementProblems,
  type PaymentSource,
  type ReimbursementCategory,
  type ReimbursementStatus,
} from '@neway/shared';
import {
  Alert,
  Badge,
  Button,
  Combobox,
  DataTable,
  Drawer,
  FilterBar,
  FormField,
  Input,
  Modal,
  PageHeader,
  Select,
  Textarea,
  createColumns,
  useToast,
  type DataTableState,
  type FilterDefinition,
} from '@/design-system';
import { createReimbursement, listDrivers, listReimbursements, listTrucks, reimbursementLoadOptions, reviewReimbursement, type ReimbursementLoadOption, type ServerReimbursement } from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { uploadFile } from '@/lib/files';
import { ReceiptPreview } from './ReceiptPreview';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { reimbursementsSearchSchema } from './reimbursements-search';

/**
 * Reimbursements: money a driver laid out, and getting it back to them.
 *
 * Each row here is an expense the company already carries, seen from the driver's side - so the
 * receipt, the load and the posting are the ones Accounting already has, and nothing is recorded
 * twice. The four cards follow the item's life: waiting to be looked at, approved and unclaimed,
 * riding on a statement that has not been paid, and paid.
 *
 * Amounts throughout are what the company owes the driver, not what the receipt came to. On a
 * split the difference is shown beside it, so a company-funded share is never quietly treated as
 * money owed.
 */

const col = createColumns<ServerReimbursement>();

const STATUS_TONE: Record<ReimbursementStatus, 'warning' | 'info' | 'success' | 'neutral' | 'danger'> = {
  pending: 'warning',
  approved: 'info',
  included: 'info',
  paid: 'success',
  rejected: 'neutral',
};

const money = (cents: number) => formatMoney(cents / 100);

export function ReimbursementsPage() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => reimbursementsSearchSchema.parse(rawSearch), [rawSearch]);
  const navigate = useNavigate();
  const account = useAccount();
  const canEdit = account?.permissions.includes('accounting.edit') ?? false;
  const queryClient = useQueryClient();
  const [columnVisibility, setColumnVisibility] = useState<DataTableState['columnVisibility']>({});
  const [adding, setAdding] = useState(false);

  const query = useQuery({ queryKey: ['accounting', 'reimbursements'], queryFn: () => listReimbursements(), staleTime: 15_000 });
  const drivers = useQuery({ queryKey: ['drivers', 'for-reimbursements'], queryFn: () => listDrivers({ pageSize: 300 }), staleTime: 300_000 });
  const trucks = useQuery({ queryKey: ['trucks', 'for-reimbursements'], queryFn: () => listTrucks({ pageSize: 300 }), staleTime: 300_000 });
  const all = useMemo(() => query.data ?? [], [query.data]);

  const focus = all.find((r) => r.id === search.open) ?? null;

  function updateSearch(patch: Record<string, string | number | undefined>) {
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        for (const key of Object.keys(next)) if (next[key] === undefined || next[key] === '') delete next[key];
        return next;
      },
      replace: true,
    });
  }

  const rows = useMemo(() => {
    let list = all;
    if (search.status) list = list.filter((r) => r.reimbursement.status === search.status);
    if (search.driver) list = list.filter((r) => r.reimbursement.payerDriverId === search.driver);
    if (search.truck) list = list.filter((r) => r.truckId === search.truck);
    if (search.category) list = list.filter((r) => r.reimbursement.category === search.category);
    const q = (search.q ?? '').trim().toLowerCase();
    if (q) {
      list = list.filter((r) =>
        [r.description, r.reimbursement.payerDriverName, r.loadNumber, r.unitNumber, r.expenseNumber, r.reimbursement.settlementNumber]
          .filter(Boolean)
          .some((v) => String(v).toLowerCase().includes(q)),
      );
    }
    return list;
  }, [all, search.status, search.driver, search.truck, search.category, search.q]);

  // Every card is the money the company owes, per state. Two currencies are never added up.
  const cards = useMemo(() => {
    const of = (status: ReimbursementStatus) => all.filter((r) => r.reimbursement.status === status);
    const sum = (list: ServerReimbursement[]) => list.reduce((t, r) => t + reimbursableCents(r.reimbursement), 0);
    const currencies = [...new Set(all.map((r) => r.reimbursement.currency || 'USD'))];
    return {
      currencies,
      pending: of('pending'),
      approved: of('approved'),
      included: of('included'),
      paid: of('paid'),
      sum,
    };
  }, [all]);

  const filters: FilterDefinition[] = [
    { key: 'status', type: 'select', label: 'Status', options: (['pending', 'approved', 'included', 'paid', 'rejected'] as const).map((s) => ({ value: s, label: REIMBURSEMENT_STATUS_LABEL[s] })) },
    { key: 'driver', type: 'select', label: 'Driver', options: (drivers.data?.data ?? []).map((d) => ({ value: d.id, label: d.name })) },
    { key: 'truck', type: 'select', label: 'Truck', options: (trucks.data?.data ?? []).map((t) => ({ value: t.id, label: `#${t.unitNumber}` })) },
    { key: 'category', type: 'select', label: 'Category', options: REIMBURSEMENT_CATEGORIES.map((c) => ({ value: c, label: REIMBURSEMENT_CATEGORY_LABEL[c] })) },
  ];

  const columns = useMemo(
    () =>
      col.columns([
        col.accessor('onDate', { header: 'Date', cell: ({ getValue }) => formatIsoDate(getValue()), meta: { width: 104 } }),
        // The driver, with the truck beneath: one column, not two, so Status and Review stay on screen.
        col.display({
          id: 'driver',
          header: 'Driver',
          meta: { width: 170 },
          cell: ({ row }) => (
            <span className="block min-w-0">
              <span className="block truncate">{row.original.reimbursement.payerDriverName ?? '\u2014'}</span>
              <span className="block truncate text-xs text-muted">{row.original.unitNumber ? `Truck #${row.original.unitNumber}` : 'No truck'}</span>
            </span>
          ),
        }),
        col.display({ id: 'load', header: 'Load', meta: { width: 160 }, cell: ({ row }) => <LoadLabel item={row.original} /> }),
        // What it was for, with the category beneath.
        col.display({
          id: 'what',
          header: 'Description',
          cell: ({ row }) => (
            <span className="block min-w-0">
              <span className="block truncate">{row.original.description}</span>
              <span className="block truncate text-xs text-muted">{REIMBURSEMENT_CATEGORY_LABEL[row.original.reimbursement.category]}{row.original.receiptFileId ? '' : row.original.reimbursement.missingReceipt ? ' \u00b7 no receipt (authorised)' : ' \u00b7 no receipt'}{row.original.reimbursement.source === 'driver_app' ? ' \u00b7 Driver app' : ''}</span>
            </span>
          ),
        }),
        col.display({
          id: 'amount',
          header: 'Amount',
          meta: { align: 'right', width: 112 },
          cell: ({ row }) => (
            <span className="tabular-nums">
              {money(reimbursableCents(row.original.reimbursement))}
              {companyFundedCents(row.original.reimbursement) > 0 ? <span className="block text-2xs text-muted">of {money(row.original.reimbursement.receiptCents)}</span> : null}
            </span>
          ),
        }),
        col.display({ id: 'status', header: 'Status', meta: { width: 124 }, cell: ({ row }) => <Badge tone={STATUS_TONE[row.original.reimbursement.status]} size="sm">{REIMBURSEMENT_STATUS_LABEL[row.original.reimbursement.status]}</Badge> }),
        col.display({
          id: 'statement',
          header: 'Statement',
          meta: { width: 150 },
          cell: ({ row }) =>
            row.original.reimbursement.settlementId ? (
              <Link to="/accounting/settlements/$settlementId" params={{ settlementId: row.original.reimbursement.settlementId }} className="text-primary-text hover:underline" onClick={(e) => e.stopPropagation()}>
                {row.original.reimbursement.settlementNumber ?? 'Statement'}
              </Link>
            ) : (
              <span className="text-faint">\u2014</span>
            ),
        }),
        col.display({
          id: 'actions',
          header: '',
          meta: { width: 92 },
          cell: ({ row }) => (
            <Button variant="secondary" size="sm" onClick={(e) => { e.stopPropagation(); updateSearch({ open: row.original.id }); }}>
              {row.original.reimbursement.status === 'pending' && canEdit ? 'Review' : 'Open'}
            </Button>
          ),
        }),
      ]),
    // The row identity is what the cells read; the handlers below are stable for this page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [canEdit],
  );

  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        title="Reimbursements"
        description="Money a driver paid out of pocket. Approved items ride on their next statement and are paid when that statement is paid."
        actions={canEdit ? <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>Add reimbursement</Button> : undefined}
      />

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <Card title="Pending review" items={cards.pending} sum={cards.sum} hint="Waiting for Accounting to approve or reject" onOpen={() => updateSearch({ status: 'pending' })} />
        <Card title="Approved, not on a statement" items={cards.approved} sum={cards.sum} hint="Will be picked up by the next draft statement" onOpen={() => updateSearch({ status: 'approved' })} />
        <Card title="On unpaid statements" items={cards.included} sum={cards.sum} hint="On a statement that has not been paid yet" onOpen={() => updateSearch({ status: 'included' })} />
        <Card title="Paid" items={cards.paid} sum={cards.sum} hint="The settlement carrying it has been paid" onOpen={() => updateSearch({ status: 'paid' })} />
      </div>
      {cards.currencies.length > 1 ? (
        <Alert tone="info" title="More than one currency is in use" description={`Totals are shown per currency: ${cards.currencies.join(', ')}. Amounts in different currencies are never added together.`} />
      ) : null}

      <DataTable
        columns={columns}
        data={rows}
        rowKey={(r) => r.id}
        state={{ sorting: [], pagination: { page: search.page ?? 1, pageSize: 25 }, rowSelection: {}, columnVisibility, globalFilter: '' }}
        onStateChange={(patch) => {
          if (patch.pagination !== undefined) updateSearch({ page: patch.pagination.page > 1 ? patch.pagination.page : undefined });
          if (patch.columnVisibility !== undefined) setColumnVisibility(patch.columnVisibility);
        }}
        loading={query.isPending}
        error={query.error ?? undefined}
        onRetry={() => void query.refetch()}
        emptyTitle="No reimbursements"
        emptyDescription="A reimbursement is recorded when a driver pays for something out of their own pocket - a lumper, a scale, parking."
        caption="Reimbursements"
        onRowClick={(r) => updateSearch({ open: r.id })}
        toolbar={
          <FilterBar
            search={{ value: search.q ?? '', onChange: (value) => updateSearch({ q: value || undefined, page: undefined }), placeholder: 'Search driver, load, description…' }}
            filters={filters}
            values={{ status: search.status, driver: search.driver, truck: search.truck, category: search.category }}
            onChange={(key, value) => updateSearch({ [key]: (value as string | undefined) || undefined, page: undefined })}
            onClear={() => updateSearch({ status: undefined, driver: undefined, truck: undefined, category: undefined, q: undefined, page: undefined })}
          />
        }
      />

      <ReviewDrawer
        item={focus}
        canEdit={canEdit}
        onClose={() => updateSearch({ open: undefined })}
        onReviewed={async () => { await queryClient.invalidateQueries({ queryKey: ['accounting'] }); }}
      />
      {adding ? (
        <AddReimbursement
          drivers={(drivers.data?.data ?? []).map((d) => ({ id: d.id, name: d.name }))}
          trucks={(trucks.data?.data ?? []).map((t) => ({ id: t.id, unitNumber: t.unitNumber }))}
          onClose={() => setAdding(false)}
          onDone={async () => { await queryClient.invalidateQueries({ queryKey: ['accounting'] }); setAdding(false); }}
        />
      ) : null}
    </div>
  );
}

function Card({ title, items, sum, hint, onOpen }: { title: string; items: ServerReimbursement[]; sum: (l: ServerReimbursement[]) => number; hint: string; onOpen: () => void }) {
  return (
    <button type="button" onClick={onOpen} className="rounded-xl border border-line bg-surface p-4 text-left transition-colors hover:bg-surface-hover">
      <span className="block text-xs font-semibold text-muted">{title}</span>
      <span className="mt-1 block text-2xl font-semibold tabular-nums text-ink">{money(sum(items))}</span>
      <span className="mt-0.5 block text-xs text-muted">{items.length} item{items.length === 1 ? '' : 's'} · {hint}</span>
    </button>
  );
}

/** One item in full: the receipt, who paid what, and - when it is pending - approve or reject. */
function ReviewDrawer({ item, canEdit, onClose, onReviewed }: { item: ServerReimbursement | null; canEdit: boolean; onClose: () => void; onReviewed: () => Promise<void> }) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const review = useMutation({
    mutationFn: (decision: 'approve' | 'reject') => reviewReimbursement(item!.id, { decision, reason: reason.trim() || null }),
    onSuccess: async (_r, decision) => {
      await onReviewed();
      toast({ tone: 'success', title: decision === 'approve' ? 'Approved' : 'Rejected' });
      setReason('');
      onClose();
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'That could not be recorded', description: e instanceof Error ? e.message : undefined }),
  });

  const b = item?.reimbursement;
  const owed = b ? reimbursableCents(b) : 0;
  const company = b ? companyFundedCents(b) : 0;

  return (
    <Drawer open={item !== null} onOpenChange={(o) => { if (!o) onClose(); }} size="md" title="Reimbursement" description={item ? `${item.expenseNumber} · ${formatIsoDate(item.onDate)}` : undefined}>
      {item && b ? (
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex items-center justify-between">
            <Badge tone={STATUS_TONE[b.status]}>{REIMBURSEMENT_STATUS_LABEL[b.status]}</Badge>
            <span className="text-right"><span className="block text-xs text-muted">Owed to the driver</span><span className="text-xl font-semibold tabular-nums text-ink">{money(owed)}</span></span>
          </div>

          {/* A receipt is kept light in both appearances, like every other document. */}
          {item.receiptFileId ? (
            <ReceiptPreview key={item.receiptFileId} fileId={item.receiptFileId} fileName={`receipt-${item.expenseNumber}`} />
          ) : (
            <div className="nw-paper rounded-lg border border-line" data-theme="light">
              {b.missingReceipt ? (
                <p className="p-4 text-xs text-ink">No receipt. Authorised by {b.missingReceipt.authorizedBy}: \u201c{b.missingReceipt.reason}\u201d</p>
              ) : (
                <p className="p-6 text-center text-xs text-muted">No receipt on file</p>
              )}
            </div>
          )}

          <dl className="grid grid-cols-2 gap-3 text-xs">
            <Fact label="Driver who paid" value={b.payerDriverName ?? b.payerDriverId} />
            <Fact label="Paid by" value={PAYMENT_SOURCE_LABEL[b.paymentSource]} />
            <Fact label="Category" value={REIMBURSEMENT_CATEGORY_LABEL[b.category]} />
            <Fact label="Currency" value={b.currency} />
            <Fact label="Receipt total" value={money(b.receiptCents)} />
            <Fact label="Company funded" value={company > 0 ? money(company) : 'None'} />
            <Fact label="Truck" value={item.unitNumber ? `#${item.unitNumber}` : 'Not on a truck'} />
            <Fact label="Load" value={item.loadNumber ?? (item.loadId ? 'On a load that is no longer on file' : 'Not on a load')} />
            <Fact label="Submitted" value={`${b.submittedBy} · ${formatIsoDate(b.submittedAt.slice(0, 10))}${b.source === 'driver_app' ? ' · from the driver app' : ''}`} />
            {b.source === 'driver_app' && b.location ? <Fact label="Where (driver)" value={b.location} /> : null}
            <Fact label="Reviewed" value={b.reviewedBy ? `${b.reviewedBy} · ${formatIsoDate((b.reviewedAt ?? '').slice(0, 10))}` : 'Not yet'} />
          </dl>

          {owed > 0 && company > 0 ? (
            <Alert tone="info" title="This receipt was funded in two parts" description={`The driver put in ${money(owed)} and the company ${money(company)}. Only the driver's part is reimbursed.`} />
          ) : owed === 0 ? (
            <Alert tone="neutral" title="Nothing is owed to the driver" description={`The company funded all ${money(b.receiptCents)} of this receipt, so there is no reimbursement to approve. It stays on the books as a company cost.`} />
          ) : null}
          {b.rejectedReason ? <Alert tone="warning" title="Rejected" description={b.rejectedReason} /> : null}
          {b.note ? <p className="rounded-lg border border-line bg-surface-muted p-3 text-xs text-ink">{b.note}</p> : null}

          <div className="flex flex-wrap items-center gap-3 text-xs">
            <Link to="/accounting/expenses" search={{ q: item.expenseNumber }} className="inline-flex items-center gap-1 text-primary-text underline">
              Open the expense <ExternalLink className="size-3" />
            </Link>
            {item.loadNumber ? <Link to="/loads/$loadNumber" params={{ loadNumber: item.loadNumber }} className="inline-flex items-center gap-1 text-primary-text underline">Open load {item.loadNumber} <ExternalLink className="size-3" /></Link> : null}
            {b.settlementId ? <Link to="/accounting/settlements/$settlementId" params={{ settlementId: b.settlementId }} className="inline-flex items-center gap-1 text-primary-text underline">Open the statement <ExternalLink className="size-3" /></Link> : null}
          </div>

          {b.status === 'pending' && canEdit ? (
            <div className="flex flex-col gap-2 border-t border-line pt-4">
              <FormField label="Reason" description="Required to reject; kept with the record either way.">
                <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why this is being approved or rejected" />
              </FormField>
              <div className="flex gap-2">
                <Button variant="primary" icon={<Check />} disabled={owed === 0 || review.isPending} loading={review.isPending} onClick={() => review.mutate('approve')}>
                  {owed === 0 ? 'Nothing to approve' : `Approve ${money(owed)}`}
                </Button>
                <Button variant="secondary" icon={<X />} disabled={!reason.trim() || review.isPending} onClick={() => review.mutate('reject')}>Reject</Button>
              </div>
              {!reason.trim() ? <p className="text-2xs text-muted">A rejection needs a reason the driver can read.</p> : null}
            </div>
          ) : b.status === 'included' ? (
            <p className="text-xs text-muted">On statement {b.settlementNumber}. It becomes paid when that statement is paid, not before.</p>
          ) : b.status === 'paid' ? (
            <p className="text-xs text-muted">Paid with statement {b.settlementNumber} on {formatIsoDate((b.paidAt ?? '').slice(0, 10))}.</p>
          ) : null}
        </div>
      ) : null}
    </Drawer>
  );
}

/** A load number, a load that is no longer on file, or no load - never a raw id. */
function LoadLabel({ item }: { item: ServerReimbursement }) {
  if (item.loadNumber) return <span className="block truncate">{item.loadNumber}</span>;
  if (item.loadId) return <span className="text-faint">Load not on file</span>;
  return <span className="text-faint">Not on a load</span>;
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-muted">{label}</dt>
      <dd className="text-sm text-ink">{value}</dd>
    </div>
  );
}

/**
 * Recording one.
 *
 * The receipt total and the driver-funded amount are asked for separately, because they are not
 * always the same number; the form says what will be owed before anything is saved, so a split
 * or a company-card expense cannot be filed by accident.
 */
function AddReimbursement({ drivers, trucks, onClose, onDone }: { drivers: Array<{ id: string; name: string }>; trucks: Array<{ id: string; unitNumber: string }>; onClose: () => void; onDone: () => Promise<void> }) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [payerDriverId, setPayer] = useState('');
  const [truckId, setTruck] = useState('');
  const [loadId, setLoadId] = useState<string | null>(null);
  const [loadQuery, setLoadQuery] = useState('');
  // This company's loads, the chosen driver's first. Served by Accounting, so filing a receipt
  // does not need the dispatch board's permissions.
  const loadOptions = useQuery({
    queryKey: ['accounting', 'reimbursement-loads', payerDriverId, loadQuery],
    queryFn: () => reimbursementLoadOptions({ q: loadQuery || undefined, driverId: payerDriverId || undefined }),
    staleTime: 30_000,
  });
  const pickedLoad: ReimbursementLoadOption | null = (loadOptions.data ?? []).find((l) => l.id === loadId) ?? null;
  const [onDate, setOnDate] = useState(new Date().toISOString().slice(0, 10));
  const [category, setCategory] = useState<ReimbursementCategory>('lumper');
  const [receipt, setReceipt] = useState('');
  const [funded, setFunded] = useState('');
  const [currency, setCurrency] = useState('USD');
  const [description, setDescription] = useState('');
  const [paymentSource, setSource] = useState<PaymentSource>('driver_personal');
  const [receiptFileId, setReceiptFile] = useState<string | null>(null);
  const [receiptName, setReceiptName] = useState<string | null>(null);
  const [missingReason, setMissingReason] = useState('');
  const [note, setNote] = useState('');
  const [uploading, setUploading] = useState(false);

  const receiptCents = Math.round((Number(receipt) || 0) * 100);
  // A driver paying with their own money is almost always paying all of it, so the field
  // follows the receipt until somebody says otherwise.
  const fundedCents = funded.trim() === '' ? receiptCents : Math.round((Number(funded) || 0) * 100);
  const owed = reimbursableCents({ receiptCents, driverFundedCents: fundedCents, paymentSource });
  const problems = reimbursementProblems({
    receiptCents,
    driverFundedCents: fundedCents,
    paymentSource,
    payerDriverId,
    hasReceiptFile: Boolean(receiptFileId),
    missingReceiptReason: missingReason.trim() || null,
  });
  const ready = problems.length === 0 && description.trim().length >= 2;

  const save = useMutation({
    mutationFn: () =>
      createReimbursement({
        payerDriverId,
        truckId: truckId || null,
        loadId,
        onDate,
        category,
        receiptCents,
        driverFundedCents: fundedCents,
        currency,
        description: description.trim(),
        paymentSource,
        receiptFileId,
        missingReceiptReason: missingReason.trim() || null,
        note: note.trim() || null,
      }),
    onSuccess: async (r) => {
      if (!r.ok) {
        toast({ tone: 'danger', title: 'Not recorded', description: r.blocked });
        return;
      }
      await onDone();
      toast(
        r.reimbursable === false
          ? { tone: 'success', title: 'Recorded as a company expense', description: 'The company funded all of it, so nothing is owed to the driver and it does not wait for review.' }
          : { tone: 'success', title: 'Reimbursement recorded', description: `${money(owed)} pending review` },
      );
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not recorded', description: e instanceof Error ? e.message : undefined }),
  });

  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="lg"
      title="Add reimbursement"
      description="What the driver paid for out of their own pocket. It is reviewed before it reaches a statement."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready || save.isPending} loading={save.isPending} onClick={() => save.mutate()}>
            Record {owed > 0 ? money(owed) : ''}
          </Button>
        </>
      }
    >
      <div className="grid grid-cols-2 gap-3">
        <FormField label="Driver who paid" description="On a team load this is the driver who actually paid, not both.">
          <Select
            value={payerDriverId}
            placeholder="Choose a driver"
            onValueChange={setPayer}
            options={drivers.map((d) => ({ value: d.id, label: d.name }))}
          />
        </FormField>
        <FormField label="Expense date">
          <Input type="date" value={onDate} onChange={(e) => setOnDate(e.target.value)} />
        </FormField>
        <FormField label="Truck" description="Optional.">
          <Select
            value={truckId}
            placeholder="Not on a truck"
            onValueChange={setTruck}
            options={trucks.map((t) => ({ value: t.id, label: `#${t.unitNumber}` }))}
          />
        </FormField>
        <FormField label="Load" description="Optional: leave empty for an expense that is not on a load.">
          <Combobox
            aria-label="Load"
            value={loadId}
            placeholder="Not on a load"
            searchPlaceholder="Search load number, broker reference or customer"
            loading={loadOptions.isFetching}
            onSearch={(q) => setLoadQuery(q)}
            emptyMessage={payerDriverId ? 'No load of this company matches.' : 'Choose the driver first, or search any load.'}
            options={(loadOptions.data ?? []).map((l) => ({
              value: l.id,
              label: l.loadNumber,
              description: [l.route, l.deliveredOn ? `delivered ${l.deliveredOn}` : null, l.onThisDriver ? 'this driver' : [l.driverName, l.coDriverName].filter(Boolean).join(' & ')].filter(Boolean).join(' \u00b7 '),
            }))}
            onValueChange={(v) => {
              setLoadId(v);
              // The truck follows the load when nobody has chosen one.
              const chosen = (loadOptions.data ?? []).find((l) => l.id === v);
              if (chosen?.truckId && !truckId) setTruck(chosen.truckId);
            }}
          />
          {pickedLoad && payerDriverId && !pickedLoad.onThisDriver ? (
            <p className="mt-1 text-2xs text-warning-text">The chosen driver is not on this load; it will be refused.</p>
          ) : null}
        </FormField>
        <FormField label="Category">
          <Select
            value={category}
            onValueChange={(v) => setCategory(v as ReimbursementCategory)}
            options={REIMBURSEMENT_CATEGORIES.map((c) => ({ value: c, label: REIMBURSEMENT_CATEGORY_LABEL[c] }))}
          />
        </FormField>
        <FormField label="Payment source">
          <Select
            value={paymentSource}
            onValueChange={(v) => setSource(v as PaymentSource)}
            options={PAYMENT_SOURCES.map((v) => ({ value: v, label: PAYMENT_SOURCE_LABEL[v] }))}
          />
        </FormField>
        <FormField label="Receipt total" description="The whole receipt, whoever paid it.">
          <Input type="number" min="0" step="0.01" value={receipt} onChange={(e) => setReceipt(e.target.value)} placeholder="0.00" />
        </FormField>
        <FormField label="Of which the driver funded" description="Leave empty if the driver paid all of it.">
          <Input type="number" min="0" step="0.01" value={funded} onChange={(e) => setFunded(e.target.value)} placeholder={receipt || '0.00'} />
        </FormField>
        <FormField label="Currency">
          <Input value={currency} onChange={(e) => setCurrency(e.target.value.toUpperCase().slice(0, 3))} />
        </FormField>
        <FormField label="Description" className="col-span-2">
          <Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Lumper at the Fresno DC" />
        </FormField>

        <FormField label="Receipt" className="col-span-2" description="Attach it, or record why it is missing.">
          <div className="flex items-center gap-3">
            <input
              ref={fileRef}
              type="file"
              accept="image/*,.pdf"
              className="hidden"
              onChange={async (e) => {
                const f = e.target.files?.[0];
                e.target.value = '';
                if (!f) return;
                setUploading(true);
                try {
                  const stored = await uploadFile(f);
                  setReceiptFile(stored.id);
                  setReceiptName(f.name);
                } catch (err) {
                  toast({ tone: 'danger', title: 'The receipt could not be uploaded', description: err instanceof Error ? err.message : undefined });
                } finally {
                  setUploading(false);
                }
              }}
            />
            <Button variant="secondary" size="sm" icon={<Upload />} loading={uploading} onClick={() => fileRef.current?.click()}>Attach receipt</Button>
            <span className="text-xs text-muted">{receiptName ?? 'No receipt attached'}</span>
          </div>
        </FormField>
        {!receiptFileId ? (
          <FormField label="Reason the receipt is missing" className="col-span-2" description="Recorded against your name as an authorised exception.">
            <Input value={missingReason} onChange={(e) => setMissingReason(e.target.value)} placeholder="Receipt lost at the dock; scale ticket photographed instead" />
          </FormField>
        ) : null}
        <FormField label="Note" className="col-span-2">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>
      </div>

      <div className="mt-3 flex items-center justify-between rounded-lg border border-line bg-surface-muted px-3 py-2 text-sm">
        <span className="flex items-center gap-2 text-muted"><Receipt className="size-4" /> Owed to the driver</span>
        <span className="text-lg font-semibold tabular-nums text-ink">{money(owed)}</span>
      </div>
      {owed === 0 && receiptCents > 0 ? (
        <p className="mt-1 text-xs text-muted">The company funded this, so it owes the driver nothing. It is still recorded as a company expense.</p>
      ) : null}
      {problems.length ? (
        <ul className="mt-2 flex flex-col gap-1">
          {problems.map((p) => <li key={p} className="text-xs text-warning-text">{p}</li>)}
        </ul>
      ) : null}
    </Modal>
  );
}
