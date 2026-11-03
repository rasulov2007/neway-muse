import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { useMutation } from '@tanstack/react-query';
import { Ban, DollarSign, ExternalLink, Send } from 'lucide-react';
import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { BillingQueuePanel } from './BillingQueuePanel';
import { RtsBatchesPanel } from './RtsBatchesPanel';
import { fetchBillingQueue } from '@/demo';
import { daysPastDue } from '@neway/shared';
import {
  DataTable,
  FilterBar,
  MenuItem,
  MenuSeparator,
  PageHeader,
  StatusBadge,
  cn,
  createColumns,
  useToast,
  type DataTableState,
  type FilterDefinition,
} from '@/design-system';
import { issueInvoice, type Invoice } from '@/demo';
import { formatIsoDate, formatMoney } from '@/lib/format';
import {
  AccountingSummaryStrip,
  NeedsAttentionPanel,
  type CountSegment,
} from './components/AccountingKit';
import { RecordPaymentDialog } from './components/RecordPaymentDialog';
import { VoidInvoiceDialog } from './components/VoidInvoiceDialog';
import { useAccounting, useInvalidateAccounting } from './useAccounting';
import { invoicesSearchSchema, type InvoicesSearch } from './invoices-search';
import { accountingFileUrl } from '@/demo/accounting-server';
import { Button, DateRangePicker, type DateRange } from '@/design-system';
import { Download } from 'lucide-react';

const col = createColumns<Invoice>();

/** YYYY-MM-DD of a calendar day picked in the range picker (its local date, no zone shift). */
const isoOf = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
/** The picker's Date for a YYYY-MM-DD, at noon so no zone moves it to another day. */
const dateOf = (iso: string) => new Date(`${iso}T12:00:00`);

function matchesInvoice(invoice: Invoice, filters: InvoicesSearch, today: string): boolean {
  const ids = filters.ids ? filters.ids.split(',').filter(Boolean) : [];
  if (ids.length > 0 && !ids.includes(invoice.id)) return false;

  const late = daysPastDue(invoice.dueOn, today) ?? -1;
  if (filters.view) {
    switch (filters.view) {
      case 'draft':
        if (invoice.status !== 'draft') return false;
        break;
      case 'outstanding':
        if (invoice.balance <= 0 || invoice.status === 'void' || invoice.status === 'draft')
          return false;
        break;
      case 'overdue':
        if (invoice.balance <= 0 || late <= 0 || invoice.status === 'void') return false;
        break;
      case 'paid':
        if (invoice.status !== 'paid') return false;
        break;
      case 'partially_paid':
        if (invoice.status !== 'partially_paid') return false;
        break;
      case 'disputed':
        if (invoice.status !== 'disputed') return false;
        break;
      default:
        if (invoice.status !== filters.view) return false;
    }
  }
  if (filters.customer && invoice.billToId !== filters.customer) return false;
  // By the invoice date, both ends included; a draft has none yet, so it shows only with no range.
  if (filters.from || filters.to) {
    if (!invoice.issuedOn) return false;
    if (filters.from && invoice.issuedOn < filters.from) return false;
    if (filters.to && invoice.issuedOn > filters.to) return false;
  }

  const q = filters.q?.trim().toLowerCase();
  if (q) {
    // The broker's load number finds the invoice too (owner, 2026-10-30): the reference on the RC.
    const rc = (invoice as { rc?: { loadReference: string | null; rcReference: string | null } | null }).rc;
    const haystack = [invoice.invoiceNumber, invoice.billToName, invoice.loadNumber, rc?.loadReference, rc?.rcReference];
    if (!haystack.some((v) => v?.toLowerCase().includes(q))) return false;
  }
  return true;
}

/**
 * The invoice register.
 *
 * The Age column ages from the **due date**, not the issue date: an invoice on net-45 issued 40
 * days ago is not late, and a register that says otherwise manufactures a collections crisis while
 * burying the real one.
 */
export function InvoicesPage() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => invoicesSearchSchema.parse(rawSearch), [rawSearch]);
  const navigate = useNavigate();
  const { toast } = useToast();
  const invalidate = useInvalidateAccounting();

  const [rowSelection, setRowSelection] = useState<DataTableState['rowSelection']>({});
  const [columnVisibility, setColumnVisibility] = useState<DataTableState['columnVisibility']>({});
  const [paying, setPaying] = useState<Invoice | null>(null);
  const [voiding, setVoiding] = useState<Invoice | null>(null);

  // The queue and the invoice list are two views of one page, never stacked. Old links with view=queue still land on the queue.
  const tab: 'queue' | 'invoices' | 'rts' = search.tab === 'rts' ? 'rts' : search.tab === 'invoices' ? 'invoices' : search.tab === 'queue' || search.view === 'queue' || (search.tab === undefined && search.view === undefined && search.ids === undefined && search.customer === undefined) ? 'queue' : 'invoices';
  const queueQuery = useQuery({ queryKey: ['accounting', 'billing-queue'], queryFn: fetchBillingQueue, enabled: tab === 'invoices' });
  const query = useAccounting('year');
  const bundle = query.data;
  const today = bundle?.today ?? '';

  const issue = useMutation({
    mutationFn: (id: string) => issueInvoice({ invoiceId: id }),
    onSuccess: async (result) => {
      if (!result.ok) {
        toast({ tone: 'danger', title: 'That was refused', description: result.blocked });
        return;
      }
      await invalidate();
      toast({
        tone: 'success',
        title: `${result.invoice?.invoiceNumber} issued`,
        description: 'Posted to accounts receivable and revenue.',
      });
    },
  });

  function updateSearch(patch: Partial<InvoicesSearch>) {
    void navigate({
      to: '.',
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev, ...patch };
        for (const key of Object.keys(next)) {
          if (next[key] === undefined || next[key] === '') delete next[key];
        }
        return next;
      },
      replace: true,
    });
  }

  const rows = useMemo(
    () => (bundle?.invoices ?? []).filter((i) => matchesInvoice(i, search, today)),
    [bundle, search, today],
  );

  // The download carries the same date range, bill-to and status as the list on screen.
  const downloadUrl = (format: 'xlsx' | 'pdf') => {
    const q = new URLSearchParams();
    if (search.from) q.set('from', search.from);
    if (search.to) q.set('to', search.to);
    if (search.customer) q.set('customer', search.customer);
    if (search.view && ['draft', 'paid', 'partially_paid', 'disputed'].includes(search.view)) q.set('status', search.view);
    return accountingFileUrl(`invoices-export/${format}?${q.toString()}`);
  };

  const counts = useMemo(() => {
    const base = (bundle?.invoices ?? []).filter((i) =>
      matchesInvoice(i, { ...search, view: undefined }, today),
    );
    const money = (list: Invoice[]) =>
      Math.round(list.reduce((sum, i) => sum + i.balance, 0) * 100) / 100;
    const outstanding = base.filter(
      (i) => i.balance > 0 && i.status !== 'void' && i.status !== 'draft',
    );
    const overdue = outstanding.filter((i) => (daysPastDue(i.dueOn, today) ?? -1) > 0);
    return {
      total: base.length,
      draft: base.filter((i) => i.status === 'draft'),
      outstanding,
      overdue,
      partial: base.filter((i) => i.status === 'partially_paid'),
      paid: base.filter((i) => i.status === 'paid'),
      disputed: base.filter((i) => i.status === 'disputed'),
      money,
    };
  }, [bundle, search, today]);

  const segments: CountSegment[] = useMemo(() => {
    const define = (
      key: string,
      label: string,
      list: Invoice[],
      tone?: CountSegment['tone'],
      withAmount = true,
    ): CountSegment => ({
      key,
      label,
      count: bundle ? list.length : null,
      amount: withAmount ? (bundle ? counts.money(list) : null) : undefined,
      tone,
      onSelect: () =>
        updateSearch({
          view: key === '__total' ? undefined : search.view === key ? undefined : key,
          ids: undefined,
          page: undefined,
        }),
    });
    return [
      {
        key: '__total',
        label: 'Total',
        count: bundle ? counts.total : null,
        onSelect: () => updateSearch({ view: undefined, ids: undefined, page: undefined }),
      },
      define('draft', 'Draft', counts.draft),
      define('outstanding', 'Outstanding', counts.outstanding),
      define('partially_paid', 'Partly paid', counts.partial, 'warning'),
      define('overdue', 'Overdue', counts.overdue, 'danger'),
      define('disputed', 'Disputed', counts.disputed, 'danger'),
      define('paid', 'Paid', counts.paid, 'success', false),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle, counts, search.view]);

  const filters = useMemo<FilterDefinition[]>(() => {
    const parties = [
      ...new Map((bundle?.invoices ?? []).map((i) => [i.billToId, i.billToName])),
    ].sort((a, b) => a[1].localeCompare(b[1]));
    return [
      {
        key: 'view',
        label: 'Status',
        type: 'select',
        options: [
          { value: 'draft', label: 'Draft' },
          { value: 'issued', label: 'Issued' },
          { value: 'sent', label: 'Sent' },
          { value: 'outstanding', label: 'Outstanding' },
          { value: 'partially_paid', label: 'Partly paid' },
          { value: 'overdue', label: 'Overdue' },
          { value: 'disputed', label: 'Disputed' },
          { value: 'paid', label: 'Paid' },
          { value: 'void', label: 'Void' },
        ],
      },
      {
        key: 'customer',
        label: 'Bill to',
        type: 'select',
        options: parties.map(([value, label]) => ({ value, label })),
      },
    ];
  }, [bundle]);

  const columns = useMemo(
    () =>
      col.columns([
        col.display({
          id: 'invoiceNumber',
          header: 'Invoice #',
          meta: { primary: true, width: 130 },
          cell: ({ row }) => (
            <Link
              to="/accounting/invoices/$invoiceId"
              params={{ invoiceId: row.original.id }}
              className="font-medium text-primary-text hover:underline"
            >
              {row.original.invoiceNumber}
            </Link>
          ),
        }),
        col.accessor('billToName', { header: 'Bill to' }),
        col.display({
          id: 'load',
          header: 'Load',
          meta: { width: 110 },
          cell: ({ row }) => (
            <Link
              to="/loads/$loadNumber"
              params={{ loadNumber: row.original.loadNumber }}
              className="hover:underline"
            >
              {row.original.loadNumber}
            </Link>
          ),
        }),
        col.display({
          id: 'issuedOn',
          header: 'Issued',
          meta: { width: 110 },
          cell: ({ row }) =>
            row.original.issuedOn ? (
              formatIsoDate(row.original.issuedOn)
            ) : (
              <span className="text-faint">Not issued</span>
            ),
        }),
        col.display({
          id: 'dueOn',
          header: 'Due',
          meta: { width: 110 },
          cell: ({ row }) => {
            if (!row.original.dueOn) return <span className="text-faint">—</span>;
            const late = daysPastDue(row.original.dueOn, today) ?? 0;
            return (
              <span
                className={cn(
                  late > 0 && row.original.balance > 0 && 'font-medium text-danger-text',
                )}
              >
                {formatIsoDate(row.original.dueOn)}
              </span>
            );
          },
        }),
        col.accessor('total', {
          header: 'Amount',
          cell: ({ getValue }) => formatMoney(getValue()),
          meta: { align: 'right', width: 110 },
        }),
        col.accessor('paid', {
          header: 'Paid',
          cell: ({ getValue }) =>
            getValue() > 0 ? formatMoney(getValue()) : <span className="text-faint">—</span>,
          meta: { align: 'right', width: 110 },
        }),
        col.accessor('balance', {
          header: 'Balance',
          cell: ({ getValue }) => (
            <span className={cn(getValue() > 0 && 'font-medium')}>{formatMoney(getValue())}</span>
          ),
          meta: { align: 'right', width: 110 },
        }),
        col.display({
          id: 'age',
          header: 'Age',
          meta: { align: 'right', width: 90 },
          cell: ({ row }) => {
            // Aged from the due date: an invoice inside its terms is not late, however old it is.
            const late = daysPastDue(row.original.dueOn, today);
            if (late === null || row.original.balance <= 0) {
              return <span className="text-faint">—</span>;
            }
            if (late <= 0) return <span className="text-muted">In terms</span>;
            return <span className="font-medium text-danger-text">{late}d</span>;
          },
        }),
        col.accessor('status', {
          header: 'Status',
          cell: ({ getValue }) => <StatusBadge status={getValue()} />,
          meta: { width: 130 },
        }),
      ]),
    [today],
  );

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Billing & Invoices"
        description="Delivered loads become invoices once their documents and checks pass; issued invoices are submitted to RTS by export and funded against."
      />
      <div className="flex gap-1 self-start rounded-xl bg-nw-subtle p-1 ring-1 ring-nw-border" role="tablist" aria-label="Billing">
        {(['queue', 'invoices', 'rts'] as const).map((t) => (
          <button key={t} type="button" role="tab" aria-selected={tab === t} onClick={() => updateSearch({ tab: t, view: undefined, ids: undefined, page: undefined })} className={tab === t ? 'h-7 rounded-lg bg-nw-panel px-3 text-[12.5px] font-semibold text-nw-text shadow-nw-segment' : 'h-7 rounded-lg px-3 text-[12.5px] font-semibold text-nw-text-3'}>
            {t === 'queue' ? 'Billing queue' : t === 'invoices' ? 'Invoices' : 'RTS batches'}
          </button>
        ))}
      </div>
      {tab === 'queue' ? <BillingQueuePanel /> : null}
      {tab === 'rts' ? <RtsBatchesPanel /> : null}
      {tab === 'invoices' ? <>

      {bundle ? (
        <NeedsAttentionPanel
          items={bundle.exceptions.filter((e) => e.target.to === '/accounting/invoices')}
          onSelect={(item) =>
            updateSearch({
              ...item.target.search,
              ids: item.ids.length > 0 ? item.ids.join(',') : undefined,
              page: undefined,
            })
          }
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <DateRangePicker
          aria-label="Invoice date"
          className="w-72"
          placeholder="All dates — pick from and to"
          value={search.from || search.to ? { from: search.from ? dateOf(search.from) : undefined, to: search.to ? dateOf(search.to) : undefined } : null}
          onChange={(range: DateRange | undefined) =>
            updateSearch({
              from: range?.from ? isoOf(range.from) : undefined,
              to: range?.to ? isoOf(range.to) : range?.from ? isoOf(range.from) : undefined,
              ids: undefined,
              page: undefined,
            })
          }
        />
        {search.from || search.to ? (
          <Button variant="ghost" size="sm" onClick={() => updateSearch({ from: undefined, to: undefined, page: undefined })}>
            All dates
          </Button>
        ) : null}
        {/* Two plain buttons, not a menu (owner, 2026-10-23). */}
        <Button variant="secondary" size="sm" icon={<Download />} disabled={rows.length === 0} title={rows.length === 0 ? 'No invoices in this view' : undefined} onClick={() => window.open(downloadUrl('xlsx'), '_blank')}>
          Excel
        </Button>
        <Button variant="secondary" size="sm" icon={<Download />} disabled={rows.length === 0} title={rows.length === 0 ? 'No invoices in this view' : undefined} onClick={() => window.open(downloadUrl('pdf'), '_blank')}>
          PDF
        </Button>
      </div>

      <AccountingSummaryStrip
        segments={segments}
        activeKey={search.view ?? (search.ids ? null : '__total')}
        loading={query.isPending}
      />

      <DataTable
        columns={columns}
        data={rows}
        rowKey={(invoice) => invoice.id}
        state={{
          sorting: [],
          pagination: { page: search.page ?? 1, pageSize: 25 },
          rowSelection,
          columnVisibility,
          globalFilter: '',
        }}
        onStateChange={(patch) => {
          if (patch.pagination !== undefined) {
            updateSearch({ page: patch.pagination.page > 1 ? patch.pagination.page : undefined });
          }
          if (patch.rowSelection !== undefined) setRowSelection(patch.rowSelection);
          if (patch.columnVisibility !== undefined) setColumnVisibility(patch.columnVisibility);
        }}
        loading={query.isPending}
        error={query.error ?? undefined}
        onRetry={() => void query.refetch()}
        emptyTitle="No invoices issued yet"
        emptyDescription={(queueQuery.data?.rows.length ?? 0) > 0 ? `Review completed loads in Billing queue: ${queueQuery.data!.rows.length} waiting.` : 'An invoice turns a completed load into a receivable. Completed loads appear in the Billing queue first.'}
        selectable
        caption="Invoices"
        onRowClick={(invoice) =>
          setRowSelection((current) => {
            const next = { ...current };
            if (next[invoice.id]) delete next[invoice.id];
            else next[invoice.id] = true;
            return next;
          })
        }
        onRowDoubleClick={(invoice) =>
          void navigate({
            to: '/accounting/invoices/$invoiceId',
            params: { invoiceId: invoice.id },
          })
        }
        toolbar={
          <FilterBar
            search={{
              value: search.q ?? '',
              onChange: (value) => updateSearch({ q: value || undefined, page: undefined }),
              placeholder: 'Search invoice, customer, load # or broker load #…',
            }}
            filters={filters}
            values={{ view: search.view, customer: search.customer }}
            onChange={(key, value) =>
              updateSearch({
                [key]: (value as string | undefined) || undefined,
                ids: undefined,
                page: undefined,
              })
            }
            onClear={() =>
              updateSearch({
                view: undefined,
                customer: undefined,
                ids: undefined,
                page: undefined,
              })
            }
          />
        }
        rowActions={(invoice) => (
          <>
            <MenuItem
              icon={<ExternalLink />}
              onSelect={() =>
                void navigate({
                  to: '/accounting/invoices/$invoiceId',
                  params: { invoiceId: invoice.id },
                })
              }
            >
              Open invoice
            </MenuItem>
            {/* Actions follow the status: a draft is issued, an issued invoice takes payment. */}
            {invoice.status === 'draft' ? (
              <MenuItem icon={<Send />} onSelect={() => issue.mutate(invoice.id)}>
                Issue invoice
              </MenuItem>
            ) : null}
            {invoice.balance > 0 && invoice.status !== 'void' && invoice.status !== 'draft' ? (
              <MenuItem icon={<DollarSign />} onSelect={() => setPaying(invoice)}>
                Record payment
              </MenuItem>
            ) : null}
            {invoice.status !== 'void' && invoice.paid === 0 ? (
              <>
                <MenuSeparator />
                <MenuItem icon={<Ban />} destructive onSelect={() => setVoiding(invoice)}>
                  Void
                </MenuItem>
              </>
            ) : null}
          </>
        )}
      />

      </> : null}

      {paying ? (
        <RecordPaymentDialog
          open
          onOpenChange={(next) => {
            if (!next) setPaying(null);
          }}
          partyId={paying.billToId}
          partyName={paying.billToName}
          partyType={paying.billToType}
          onDone={() => setPaying(null)}
        />
      ) : null}

      {voiding ? (
        <VoidInvoiceDialog
          open
          onOpenChange={(next) => {
            if (!next) setVoiding(null);
          }}
          invoice={voiding}
          onDone={() => setVoiding(null)}
        />
      ) : null}
    </div>
  );
}
