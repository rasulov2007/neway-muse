import { loadStatusLabel } from '@/features/loads/loads-search';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { Download, Eye, FileText, LifeBuoy, ListFilter, MapPin, Pencil, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  DataTable,
  FilterBar,
  MenuItem,
  MenuSeparator,
  Modal,
  PageHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  StatusBadge,
  cn,
  createColumns,
  type DataTableState,
} from '@/design-system';
import type { Load } from '@/demo';
import { LoadForm } from './LoadFormPage';
import { AttachFilesDialog } from './AttachFilesDialog';
import { LoadDocumentsDialog } from './LoadDocumentsDialog';
import { PaperworkChip } from './PaperworkChip';
import { RecoverLoadDialog } from './RecoverLoadDialog';
import { NeedsAttentionStrip } from './NeedsAttentionStrip';
import { LoadsSummary } from './LoadsSummary';
import { formatInstant } from '@neway/shared';
import { formatMoney, formatNumber } from '@/lib/format';
import { hrefs, useGo } from '@/features/dashboard/links';
import { DASH, riskRank } from '@/features/operations/operations-ui';
import {
  isActiveLoad,
  useOperations,
  type OperationalLoad,
} from '@/features/operations/useOperations';
import { useOpenProblems } from './useLoadProblems';
import { useAccount } from '@/features/auth/auth-context';
import { Flag } from 'lucide-react';
import { EQUIPMENT_LABEL } from './loadUtils';
import {
  LOAD_VIEWS,
  LOAD_VIEW_LABEL,
  loadsSearchSchema,
  matchesView,
  type LoadsSearch,
} from './loads-search';

/**
 * The loads register.
 *
 * Dispatch answers "what needs attention"; this answers "show me the freight". It reads the same
 * operations bundle, so a load's risk, economics and tracking freshness are the same numbers here
 * as on the dispatch board. Rows open the existing load detail page rather than a drawer, because
 * that page already exists and duplicating it would create a second source of truth.
 */
export function LoadsPage() {
  const navigate = useNavigate();
  const go = useGo();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => loadsSearchSchema.parse(rawSearch), [rawSearch]);
  const query = useOperations();

  const [pageSize, setPageSize] = useState(25);
  const [columnVisibility, setColumnVisibility] = useState<Record<string, boolean>>({});
  const [rowSelection, setRowSelection] = useState<DataTableState['rowSelection']>({});
  // Booking opens over the register (NWF-style), never a separate page.
  const [booking, setBooking] = useState(false);
  // The paperwork on one load, and the recovery of one load: both open over the register.
  const [documentsFor, setDocumentsFor] = useState<Load | null>(null);
  const [attachingFor, setAttachingFor] = useState<Load | null>(null);
  const [recovering, setRecovering] = useState<Load | null>(null);
  const [editing, setEditing] = useState<Load | null>(null);
  const filterCount = [search.customer, search.broker, search.equipment].filter(Boolean).length;

  function updateSearch(patch: Partial<LoadsSearch>) {
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

  const bundle = query.data;
  // The attention bars name the loads behind a count; the queue carries ids, the bar shows numbers.
  const loadNumberById = useMemo(
    () => new Map((bundle?.loads ?? []).map((row) => [row.load.id, row.load.loadNumber])),
    [bundle],
  );
  const view = search.view ?? 'all';
  // Open flags (rule 1.10) come from their own table; the list says which loads carry one.
  const problems = useOpenProblems();
  const flagged = useMemo(() => new Set((problems.data ?? []).map((p) => p.loadId)), [problems.data]);
  const account = useAccount();
  const userId = account?.userId ?? null;
  const extraFor = (row: OperationalLoad) => ({ flagged: flagged.has(row.load.id), userId });

  // Counts come from the same predicate the table filters on, so a chip and its list agree.
  const counts = useMemo(() => {
    const rows = bundle?.loads ?? [];
    return Object.fromEntries(
      LOAD_VIEWS.map((key) => [
        key,
        rows.filter((row) => matchesView(key, row.load, row.risk.state, row.delivery.state, extraFor(row))).length,
      ]),
    ) as Record<(typeof LOAD_VIEWS)[number], number>;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle, flagged, userId]);

  const filtered = useMemo(() => {
    const rows = bundle?.loads ?? [];
    const q = search.q?.trim().toLowerCase() ?? '';
    return rows
      .filter((row) => matchesView(view, row.load, row.risk.state, row.delivery.state))
      .filter((row) => !search.customer || row.load.customerId === search.customer)
      .filter((row) => !search.broker || row.load.brokerId === search.broker)
      .filter((row) => !search.equipment || row.load.equipmentType === search.equipment)
      .filter((row) => {
        if (!q) return true;
        return [
          row.load.loadNumber,
          row.load.brokerReference,
          row.load.customerName,
          row.load.brokerName,
          row.load.driverName,
          row.load.truckUnit,
          row.load.origin.city,
          row.load.destination.city,
          row.load.commodity,
        ].some((value) => value && value.toLowerCase().includes(q));
      })
      .sort((a, b) => {
        // Worst risk first inside a view, then soonest delivery: the order a dispatcher works in.
        const byRisk = riskRank(a.risk.state) - riskRank(b.risk.state);
        if (byRisk !== 0) return byRisk;
        return (a.load.deliveryAt ?? '').localeCompare(b.load.deliveryAt ?? '');
      });
  }, [bundle, view, search.q, search.customer, search.broker, search.equipment]);

  const tableState: DataTableState = {
    sorting: [],
    pagination: { page: search.page ?? 1, pageSize },
    rowSelection,
    columnVisibility,
    globalFilter: '',
  };

  function onTableStateChange(patch: Partial<DataTableState>) {
    if (patch.pagination) {
      if (patch.pagination.pageSize !== pageSize) {
        setPageSize(patch.pagination.pageSize);
        updateSearch({ page: undefined });
      } else {
        updateSearch({ page: patch.pagination.page === 1 ? undefined : patch.pagination.page });
      }
    }
    if (patch.columnVisibility) setColumnVisibility(patch.columnVisibility);
    if (patch.rowSelection) setRowSelection(patch.rowSelection);
  }

  const col = createColumns<OperationalLoad>();
  const columns = col.columns([
    col.accessor((row) => row.load.loadNumber, {
      id: 'loadNumber',
      header: 'Load / Status',
      meta: { primary: true, label: 'Load / Status', width: 150 },
      cell: ({ row }) => (
        <Stacked
          top={<span className="font-semibold text-ink">{row.original.load.loadNumber}</span>}
          bottom={
            <span className="inline-flex items-center gap-1">
              <StatusBadge
                status={row.original.load.status}
                label={loadStatusLabel(row.original.load.status)}
                size="sm"
                // Live work (waiting or on the road) breathes so the eye finds the freight still in
                // play; delivered, cancelled and closed stay still.
                pulse={isActiveLoad(row.original.load)}
              />
              <PaperworkChip load={row.original.load} />
              {flagged.has(row.original.load.id) ? (
                <span className="inline-flex items-center gap-0.5 rounded-sm bg-danger-soft px-1 text-[11px] font-semibold text-danger-text" title="Flagged: needs a person">
                  <Flag aria-hidden className="size-3" /> Flagged
                </span>
              ) : null}
            </span>
          }
        />
      ),
    }),
    col.display({
      id: 'customer',
      header: 'Customer / Broker',
      cell: ({ row }) => (
        <Stacked
          top={
            <EntityLink
              label={row.original.load.customerName}
              onOpen={() => go(hrefs.customer(row.original.load.customerId))}
            />
          }
          bottom={
            // The broker line only when it is a different company (owner, 2026-10-27: the same name twice).
            (row.original.load.brokerName ?? '').trim().toLowerCase() === (row.original.load.customerName ?? '').trim().toLowerCase() ? null : row.original.load.brokerId ? (
              <EntityLink
                muted
                label={row.original.load.brokerName ?? DASH}
                onOpen={() => go(hrefs.broker(row.original.load.brokerId as string))}
              />
            ) : (
              <span className="text-faint">{DASH}</span>
            )
          }
        />
      ),
    }),
    col.display({
      id: 'lane',
      header: 'Route',
      meta: { label: 'Route', width: 220, className: 'min-w-[13rem]' },
      cell: ({ row }) => (
        <Route origin={row.original.load.origin} destination={row.original.load.destination} />
      ),
    }),
    col.display({
      id: 'pickup',
      header: 'Pickup',
      cell: ({ row }) => (
        <When at={row.original.load.pickupAt} zone={row.original.load.stops[0]?.timezone} />
      ),
    }),
    col.display({
      id: 'delivery',
      header: 'Delivery',
      cell: ({ row }) => (
        <When
          at={row.original.load.deliveryAt}
          zone={row.original.load.stops[row.original.load.stops.length - 1]?.timezone}
        />
      ),
    }),
    col.display({
      id: 'driver',
      header: 'Driver / Unit',
      cell: ({ row }) => {
        const { driverId, driverName, truckUnit } = row.original.load;
        if (!driverId && !truckUnit) {
          return (
            <Stacked
              top={<span className="font-medium text-warning-text">Unassigned</span>}
              bottom={<span className="text-warning-text">Unassigned</span>}
            />
          );
        }
        return (
          <Stacked
            top={
              driverId ? (
                <EntityLink label={driverName ?? DASH} onOpen={() => go(hrefs.driver(driverId))} />
              ) : (
                <span className="font-medium text-warning-text">Unassigned</span>
              )
            }
            bottom={
              truckUnit ? (
                <EntityLink
                  primary
                  label={`Unit ${truckUnit}`}
                  onOpen={() => go(hrefs.truck(truckUnit))}
                />
              ) : (
                <span className="text-warning-text">Unassigned</span>
              )
            }
          />
        );
      },
    }),
    col.display({
      id: 'equipment',
      header: 'Equipment',
      cell: ({ row }) => EQUIPMENT_LABEL[row.original.load.equipmentType] ?? DASH,
    }),
    col.display({
      id: 'totalMiles',
      header: 'Miles',
      meta: { label: 'Miles', align: 'right' },
      // Deadhead as miles, not a share: a dispatcher decides on "how far empty", and 12% of an
      // unknown total is not a number anybody can act on.
      cell: ({ row }) => {
        const total = row.original.economics.totalMiles;
        const empty = row.original.load.emptyMiles;
        return (
          <Stacked
            top={
              total === null ? (
                <Unknown row={row.original} />
              ) : (
                <span className="tabular text-ink">{formatNumber(total)}</span>
              )
            }
            bottom={
              empty === null || empty === undefined ? (
                <span className="text-faint">{DASH}</span>
              ) : (
                <span className="tabular">{formatNumber(empty)} DH</span>
              )
            }
          />
        );
      },
    }),
    col.display({
      id: 'revenue',
      header: 'Revenue',
      meta: { align: 'right' },
      cell: ({ row }) => {
        const value = row.original.economics.revenue;
        return value === null ? (
          <Unknown row={row.original} />
        ) : (
          <span className="tabular font-semibold text-ink">{formatMoney(value)}</span>
        );
      },
    }),
  ]);

  // Filter options come from the loaded data, so they never offer a customer with no freight.
  const customerOptions = useMemo(() => {
    const seen = new Map<string, string>();
    // A load saved without a customer name (older records) must not take the page down.
    for (const row of bundle?.loads ?? []) if (row.load.customerId) seen.set(row.load.customerId, row.load.customerName || row.load.customerId);
    return [...seen]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => String(a.label ?? '').localeCompare(String(b.label ?? '')));
  }, [bundle]);

  const brokerOptions = useMemo(() => {
    const seen = new Map<string, string>();
    for (const row of bundle?.loads ?? []) {
      if (row.load.brokerId) seen.set(row.load.brokerId, row.load.brokerName ?? row.load.brokerId);
    }
    return [...seen]
      .map(([value, label]) => ({ value, label }))
      .sort((a, b) => String(a.label ?? '').localeCompare(String(b.label ?? '')));
  }, [bundle]);

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Loads"
        description="Manage loads, assignments and delivery progress."
        meta={
          // The bundle refetches every 30 s, so "Live" is only said once it has arrived and while
          // the last refresh succeeded — never before data, never over an error.
          query.isSuccess ? (
            <Badge
              tone="success"
              size="sm"
              icon={<span aria-hidden className="nw-live-dot text-nw-done-icon" />}
              title="Refreshes every 30 seconds"
            >
              Live
            </Badge>
          ) : null
        }
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Download />}
              disabled={filtered.length === 0}
              onClick={() => exportLoadsCsv(filtered)}
            >
              Export
            </Button>
          </>
        }
      />

      {query.isError ? null : (
        <LoadsSummary
          rows={bundle?.loads ?? []}
          counts={counts}
          loading={query.isPending}
        />
      )}

      {bundle ? (
        <NeedsAttentionStrip
          attention={bundle.attention}
          loadNumberById={loadNumberById}
          activeView={view}
          onSelectView={(next) =>
            updateSearch({ view: next === 'all' ? undefined : next, page: undefined })
          }
        />
      ) : null}

      {/*
       * The views, as one segmented bar rather than nine loose pills.
       *
       * They are a single choice, so they look like one control: a tray with the chosen view
       * raised out of it. The count sits in its own pill so the eye can run down the numbers
       * without reading the words, and a view with nothing in it is dimmed rather than removed —
       * "no loads at risk" is the answer somebody is looking for.
       */}
      <div
        role="group"
        aria-label="Load views"
        className="scroll-quiet flex items-center gap-1 overflow-x-auto rounded-xl bg-nw-subtle p-1.5 ring-1 ring-nw-border"
      >
        {LOAD_VIEWS.map((key) => {
          const selected = key === view;
          const empty = counts[key] === 0;
          return (
            <button
              key={key}
              type="button"
              aria-pressed={selected}
              onClick={() =>
                updateSearch({ view: key === 'all' ? undefined : key, page: undefined })
              }
              className={cn(
                'inline-flex h-9 shrink-0 items-center gap-2 rounded-lg px-3.5 text-[13.5px] font-semibold whitespace-nowrap',
                'transition-colors duration-(--duration-base) focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus',
                selected
                  ? 'bg-nw-panel text-nw-text shadow-nw-segment'
                  : empty
                    ? 'text-nw-text-3 hover:bg-nw-hover hover:text-nw-text-2'
                    : 'text-nw-text-2 hover:bg-nw-hover hover:text-nw-text',
              )}
            >
              {LOAD_VIEW_LABEL[key]}
              <span
                className={cn(
                  'tabular inline-flex h-5 min-w-5 items-center justify-center rounded-full px-1.5 text-xs font-bold',
                  selected
                    ? 'bg-nw-accent text-nw-on-accent'
                    : empty
                      ? 'bg-nw-segment text-nw-text-3'
                      : 'bg-nw-segment text-nw-text-2',
                )}
              >
                {counts[key]}
              </span>
            </button>
          );
        })}
      </div>

      <DataTable
        columns={columns}
        data={filtered}
        rowKey={(row) => row.load.id}
        state={tableState}
        onStateChange={onTableStateChange}
        // No `total`: passing it puts DataTable in server-side mode, where it renders whatever rows
        // it is given and expects the caller to have paged them. Filtering happens here over the
        // loaded bundle, so the table does its own paging.
        loading={query.isPending}
        error={query.isError ? query.error : undefined}
        onRetry={() => void query.refetch()}
        stickyHeader
        selectable
        caption="Loads with operational risk, total-mile economics and tracking freshness"
        emptyTitle="No loads found"
        emptyDescription="Try another view, or clear the filters and search."
        onRowClick={(row) => go(hrefs.load(row.load.loadNumber))}
        rowActions={(row) => (
          <>
            {/* Attach files first: the owner asked for it at the top (2026-09-21). */}
            <MenuItem icon={<FileText />} onSelect={() => setAttachingFor(row.load)}>
              Attach files
            </MenuItem>
            <MenuItem icon={<Eye />} onSelect={() => go(hrefs.load(row.load.loadNumber))}>
              Open load
            </MenuItem>
            <MenuItem icon={<Pencil />} onSelect={() => setEditing(row.load)}>
              Edit
            </MenuItem>
            <MenuItem icon={<FileText />} onSelect={() => setDocumentsFor(row.load)}>
              Paperwork
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={<LifeBuoy />} onSelect={() => setRecovering(row.load)}>
              Recover load
            </MenuItem>
          </>
        )}
        bulkActions={(rows) => (
          <Button
            size="sm"
            variant="secondary"
            icon={<Download />}
            onClick={() => exportLoadsCsv(rows)}
          >
            Export selected
          </Button>
        )}
        toolbar={
          <FilterBar
            search={{
              value: search.q ?? '',
              onChange: (value) => updateSearch({ q: value || undefined, page: undefined }),
              placeholder: 'Search load #, reference, customer...',
            }}
            values={{}}
            onChange={() => {}}
            onClear={() => updateSearch({ q: undefined, page: undefined })}
          >
            <Button variant="primary" size="sm" icon={<Plus />} onClick={() => setBooking(true)}>
              New load
            </Button>
          </FilterBar>
        }
        toolbarRight={
          <Popover>
            <PopoverTrigger asChild>
              <Button variant="secondary" size="sm" icon={<ListFilter />}>
                Filters{filterCount > 0 ? ` · ${filterCount}` : ''}
              </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="flex w-64 flex-col gap-3">
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Customer
                <Select
                  options={[{ value: '', label: 'Any customer' }, ...customerOptions]}
                  value={search.customer ?? ''}
                  onValueChange={(v) => updateSearch({ customer: v || undefined, page: undefined })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Broker
                <Select
                  options={[{ value: '', label: 'Any broker' }, ...brokerOptions]}
                  value={search.broker ?? ''}
                  onValueChange={(v) => updateSearch({ broker: v || undefined, page: undefined })}
                />
              </label>
              <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                Equipment
                <Select
                  options={[
                    { value: '', label: 'Any equipment' },
                    { value: 'dry_van', label: 'Dry van' },
                    { value: 'reefer', label: 'Reefer' },
                    { value: 'flatbed', label: 'Flatbed' },
                  ]}
                  value={search.equipment ?? ''}
                  onValueChange={(v) =>
                    updateSearch({
                      equipment: (v || undefined) as LoadsSearch['equipment'],
                      page: undefined,
                    })
                  }
                />
              </label>
              {filterCount > 0 && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() =>
                    updateSearch({
                      customer: undefined,
                      broker: undefined,
                      equipment: undefined,
                      page: undefined,
                    })
                  }
                >
                  Clear filters
                </Button>
              )}
            </PopoverContent>
          </Popover>
        }
      />

      {/*
        Editing opens the booking form over the register with the load already in it. One form
        does both jobs, so a field that can be set when a load is created can always be corrected.
      */}
      {editing ? (
        <Modal
          open
          onOpenChange={(next) => !next && setEditing(null)}
          size="lg"
          title={`Edit ${editing.loadNumber}`}
        >
          <LoadForm
            initial={editing}
            onCancel={() => setEditing(null)}
            onBooked={() => setEditing(null)}
          />
        </Modal>
      ) : null}

      {attachingFor ? (
        <AttachFilesDialog
          load={attachingFor}
          open
          onOpenChange={(next) => !next && setAttachingFor(null)}
        />
      ) : null}

      {documentsFor ? (
        <LoadDocumentsDialog
          load={documentsFor}
          open
          onOpenChange={(next) => !next && setDocumentsFor(null)}
        />
      ) : null}

      {recovering ? (
        <RecoverLoadDialog
          load={recovering}
          open
          onOpenChange={(next) => !next && setRecovering(null)}
        />
      ) : null}

      {/* Booking happens HERE, over the list — the NWF way. */}
      <Modal open={booking} onOpenChange={setBooking} size="lg" title="Add load">
        <LoadForm onCancel={() => setBooking(false)} onBooked={() => setBooking(false)} />
      </Modal>
    </div>
  );
}

/** Two lines in one cell: the thing on top, its qualifier underneath. */
function Stacked({ top, bottom }: { top: React.ReactNode; bottom: React.ReactNode }) {
  return (
    <span className="flex flex-col gap-0.5 py-1.5 leading-tight">
      <span className="text-sm">{top}</span>
      <span className="text-xs text-muted">{bottom}</span>
    </span>
  );
}

/** A related record, opened without triggering the row's own navigation. */
function EntityLink({
  label,
  onOpen,
  muted = false,
  primary = false,
}: {
  label: string;
  onOpen: () => void;
  muted?: boolean;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      className={cn(
        'rounded-xs text-left hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
        primary ? 'text-primary-text' : muted ? 'text-muted' : 'font-semibold text-ink',
      )}
      onClick={(event) => {
        event.stopPropagation();
        onOpen();
      }}
    >
      {label}
    </button>
  );
}

/** A figure the cost engine could not produce, naming what it was missing. */
function Unknown({ row }: { row: OperationalLoad }) {
  const missing = row.economics.insufficient;
  return (
    <span
      className="text-faint italic"
      title={missing.length > 0 ? `Missing: ${missing.join(', ')}` : 'Not calculated'}
    >
      Insufficient data
    </span>
  );
}

/**
 * A date on one line and its time underneath, in the stop's own clock with its abbreviation
 * (P0.4). An appointment is a wall-clock promise at a place; the company clock is one hover away.
 */
function When({ at, zone }: { at: string | null; zone: string | null | undefined }) {
  const f = formatInstant(at, zone);
  if (!at || f.time === 'Time unknown') {
    return <span className="text-faint">{DASH}</span>;
  }
  return (
    <span title={f.tooltip}>
      <Stacked
        top={<span className="whitespace-nowrap text-ink">{f.weekday}</span>}
        bottom={<span className="whitespace-nowrap">{f.time}</span>}
      />
    </span>
  );
}

/**
 * A lane, stacked rather than strung out on one line.
 *
 * A city pair fits anywhere; a full street address — which is what gets typed once mileage has to
 * be measured door to door — is four times as long and used to stretch the row across the table.
 * Origin sits above destination, each on one clamped line, and the full text is on the title
 * attribute so nothing is lost for someone checking a bill.
 */
function Route({
  origin,
  destination,
}: {
  origin: { city: string; state: string } | null | undefined;
  destination: { city: string; state: string } | null | undefined;
}) {
  const line = (place: { city?: string; state?: string } | null | undefined) => {
    // A record written without a place shows a dash instead of taking the whole list down.
    const city = (place?.city ?? '').trim();
    const state = place?.state ?? '';
    if (!city && !state) return '—';
    // A typed-in full address often already ends with the state; repeating it reads as a mistake.
    return !state || city.toUpperCase().endsWith(`, ${state.toUpperCase()}`) ? city : city ? `${city}, ${state}` : state;
  };
  const from = line(origin);
  const to = line(destination);
  return (
    <span className="flex flex-col gap-0.5 py-1.5 leading-tight" title={`${from} to ${to}`}>
      <span className="flex items-center gap-1.5 text-sm text-ink">
        <span aria-hidden className="size-2 shrink-0 rounded-full bg-primary" />
        <span className="truncate">{from}</span>
      </span>
      <span className="flex items-center gap-1.5 text-sm text-ink">
        <MapPin aria-hidden className="size-3 shrink-0 text-danger" />
        <span className="truncate">{to}</span>
      </span>
    </span>
  );
}

/** The rows as shown, as a file: what somebody pastes into a spreadsheet to argue about. */
function exportLoadsCsv(rows: ReadonlyArray<OperationalLoad>): void {
  const escape = (value: unknown): string => {
    if (value === null || value === undefined) return '';
    const text = String(value);
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };
  const header = [
    'Load #',
    'Status',
    'Customer',
    'Broker',
    'Origin',
    'Destination',
    'Pickup',
    'Delivery',
    'Driver',
    'Unit',
    'Equipment',
    'Total miles',
    'Deadhead miles',
    'Revenue',
  ];
  const lines = rows.map((row) =>
    [
      row.load.loadNumber,
      loadStatusLabel(row.load.status),
      row.load.customerName,
      row.load.brokerName,
      `${row.load.origin.city}, ${row.load.origin.state}`,
      `${row.load.destination.city}, ${row.load.destination.state}`,
      row.load.pickupAt,
      row.load.deliveryAt,
      row.load.driverName,
      row.load.truckUnit,
      EQUIPMENT_LABEL[row.load.equipmentType],
      row.economics.totalMiles,
      row.load.emptyMiles,
      row.economics.revenue,
    ]
      .map(escape)
      .join(','),
  );
  const blob = new Blob([[header.join(','), ...lines].join('\n')], {
    type: 'text/csv;charset=utf-8',
  });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `loads_${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  URL.revokeObjectURL(url);
}
