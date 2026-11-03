import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { ChevronDown, Database, Droplet, FileText, Fuel, Plus, Truck, Upload } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { summarizeFuel, summarizeUnitFuel } from '@neway/shared';
import {
  Badge,
  Button,
  Card,
  DataTable,
  DateRangePicker,
  FilterBar,
  PageHeader,
  StatusSymbol,
  Tabs,
  cn,
  createColumns,
  type DataTableState,
  type DateRange,
  type DateRangePreset,
  type FilterDefinition,
} from '@/design-system';
import type { FuelTransaction } from '@/demo';
import { today as companyToday } from '@/lib/clock';
import { formatDateTime, formatMiles, formatMoney, formatNumber } from '@/lib/format';
import { AddFuelDialog } from './components/AddFuelDialog';
import { FleetExceptionPanel } from './components/FleetExceptionPanel';
import { FuelInvoiceCard, FuelInvoiceDialog } from './components/FuelInvoice';
import {
  FUEL_RANGE_PRESETS,
  RELAY_INVOICE_CAPTION,
  chargedPricePerGallon,
  downloadFuelCsv,
  fillKey,
  formatGallons,
  formatPricePerGallon,
  formatRange,
  groupFills,
  inRange,
  productLabel,
  rangeLabel,
  resolveRange,
  type FuelFillGroup,
  type FuelRange,
} from './fuel-ledger';
import { fuelSearchSchema, type FuelSearch } from './fuel-search';
import { DASH } from './fleet-ui';
import { useFleet } from './useFleet';

const ANOMALY_LABEL: Record<string, string> = {
  location_mismatch: 'Location mismatch',
  duplicate: 'Possible duplicate',
  impossible_gallons: 'Gallons exceed tank',
  excess_consumption: 'Excess consumption',
  off_hours: 'Off hours',
};

const LOADING = 'Loading…';

function matchesFill(fill: FuelTransaction, filters: FuelSearch): boolean {
  if (filters.unit && fill.unitNumber !== filters.unit) return false;
  if (filters.state && fill.station.state !== filters.state) return false;
  if (filters.vendor && fill.station.brand !== filters.vendor) return false;
  if (filters.product && fill.product !== filters.product) return false;
  if (filters.flagged === 'yes' && fill.anomalyFlags.length === 0) return false;

  const q = filters.q?.trim().toLowerCase();
  if (q) {
    const haystack = [
      fill.unitNumber,
      fill.driverName,
      fill.station.name,
      fill.station.brand,
      fill.station.city,
      fill.station.state,
      fill.cardLast4,
    ];
    if (!haystack.some((value) => value?.toLowerCase().includes(q))) return false;
  }
  return true;
}

function stationPlace(fill: FuelTransaction): string {
  return [fill.station.city, fill.station.state].filter(Boolean).join(', ') || DASH;
}

/** Eastern calendar date <-> the local-midnight Date the calendar widget works in. */
function toPickerDate(date: string): Date {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(y, m - 1, d);
}
function fromPickerDate(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

const col = createColumns<FuelTransaction>();
const fillCol = createColumns<FuelFillGroup>();

/**
 * Fuel.
 *
 * Every figure on this page is arithmetic on recorded fills, over the date range the header names
 * (Eastern calendar days). **MPG** is measured between consecutive fills on the same unit, so a
 * unit with one fill has no MPG rather than a plausible-looking one; **cost per mile** is priced
 * on the gallons that demonstrably produced the measured miles. A vendor's own MPG claim is never
 * used.
 *
 * The invoice of a Relay fill is its itemised transaction. Relay has no receipt image, and this
 * page never shows one it does not have.
 */
export function FuelPage() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => fuelSearchSchema.parse(rawSearch), [rawSearch]);
  const navigate = useNavigate();
  const [sorting, setSorting] = useState<DataTableState['sorting']>([{ id: 'at', desc: true }]);
  const [fillSorting, setFillSorting] = useState<DataTableState['sorting']>([
    { id: 'at', desc: true },
  ]);
  const [columnVisibility, setColumnVisibility] = useState<DataTableState['columnVisibility']>({
    odometer: false,
    flags: false,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [invoice, setInvoice] = useState<FuelFillGroup | null>(null);
  const [adding, setAdding] = useState(false);
  const [mpgOpen, setMpgOpen] = useState(false);

  const fleetQuery = useFleet();
  const bundle = fleetQuery.data;
  const tab = search.tab ?? 'transactions';

  function updateSearch(patch: Partial<FuelSearch>) {
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

  // "Today" is the server's clock in Eastern, never the browser's.
  const today = companyToday();
  const range: FuelRange = resolveRange(today, search.from, search.to);
  const label = rangeLabel(range, today);

  const ledger = useMemo(() => bundle?.fuel ?? [], [bundle]);
  const inWindow = useMemo(
    () => ledger.filter((fill) => inRange(fill, range)),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ledger, range.from, range.to],
  );
  const rows = useMemo(
    () =>
      inWindow
        .filter((fill) => matchesFill(fill, search))
        .sort((a, b) => Date.parse(b.at) - Date.parse(a.at)),
    [inWindow, search],
  );

  // Fills are gathered from the whole ledger, so an invoice always carries every line of its fill
  // even when a filter hides one of them.
  const fillsByKey = useMemo(() => {
    const map = new Map<string, FuelFillGroup>();
    for (const fill of groupFills(ledger)) map.set(fill.key, fill);
    return map;
  }, [ledger]);
  const fillOf = (row: FuelTransaction) => fillsByKey.get(fillKey(row)) ?? null;

  const invoiceRows = useMemo(() => {
    const keys = new Set(rows.map(fillKey));
    return [...keys]
      .map((key) => fillsByKey.get(key))
      .filter((fill): fill is FuelFillGroup => Boolean(fill));
  }, [rows, fillsByKey]);

  const summary = useMemo(() => (bundle ? summarizeFuel(inWindow) : null), [bundle, inWindow]);
  const unitNumberById = useMemo(() => {
    const map = new Map<string, string>();
    for (const fill of ledger) map.set(fill.truckId, fill.unitNumber);
    return map;
  }, [ledger]);

  const selected = rows.find((row) => row.id === selectedId) ?? rows[0] ?? null;
  const selectedFill = selected ? fillOf(selected) : null;
  const selectedUnit = useMemo(
    () =>
      selected
        ? summarizeUnitFuel(
            selected.truckId,
            inWindow.filter((fill) => fill.truckId === selected.truckId),
          )
        : null,
    [selected, inWindow],
  );

  const options = (values: string[]) =>
    [...new Set(values.filter(Boolean))].sort().map((value) => ({ value, label: value }));

  const filters = useMemo<FilterDefinition[]>(
    () => [
      {
        key: 'unit',
        label: 'Truck',
        type: 'select',
        options: options(ledger.map((f) => f.unitNumber)),
      },
      {
        key: 'state',
        label: 'State',
        type: 'select',
        options: options(ledger.map((f) => f.station.state)),
      },
      {
        key: 'vendor',
        label: 'Vendor',
        type: 'select',
        options: options(ledger.map((f) => f.station.brand)),
      },
      {
        key: 'product',
        label: 'Product',
        type: 'select',
        options: [...new Set(ledger.map((f) => f.product))]
          .sort()
          .map((value) => ({ value, label: productLabel(value) })),
      },
      {
        key: 'flagged',
        label: 'Flagged',
        type: 'select',
        options: [{ value: 'yes', label: 'Flagged only' }],
      },
    ],
    [ledger],
  );

  const columns = useMemo(
    () =>
      col.columns([
        col.accessor((row) => Date.parse(row.at), {
          id: 'at',
          header: 'Date & time',
          cell: ({ row }) => (
            <span className="whitespace-nowrap">{formatDateTime(row.original.at)}</span>
          ),
          // Rows are clickable, which would make the first column bold; nothing here is an id.
          meta: { width: 200, label: 'Date & time', className: 'font-normal' },
        }),
        col.display({
          id: 'unit',
          header: 'Truck / Driver',
          meta: { label: 'Truck / Driver' },
          cell: ({ row }) => (
            <span className="flex min-w-0 items-baseline gap-3">
              <Link
                to="/fleet/trucks/$truckId"
                params={{ truckId: row.original.truckId }}
                className="font-medium text-primary-text hover:underline"
              >
                {row.original.unitNumber}
              </Link>
              <span className="truncate text-ink">
                {row.original.driverName || <span className="text-faint">{DASH}</span>}
              </span>
            </span>
          ),
        }),
        col.display({
          id: 'station',
          header: 'Station',
          meta: { label: 'Station' },
          cell: ({ row }) => (
            <span className="whitespace-nowrap">{stationPlace(row.original)}</span>
          ),
        }),
        col.accessor('product', {
          header: 'Product',
          cell: ({ getValue }) => productLabel(getValue()),
          meta: { width: 90 },
        }),
        col.accessor('gallons', {
          header: 'Gallons',
          cell: ({ getValue }) => formatGallons(getValue()),
          meta: { align: 'right', width: 90 },
        }),
        col.accessor('amount', {
          header: 'Total',
          cell: ({ getValue }) => formatMoney(getValue()),
          meta: { align: 'right', width: 110 },
        }),
        col.accessor('odometer', {
          header: 'Odometer',
          cell: ({ getValue }) =>
            getValue() > 0 ? formatMiles(getValue()) : <span className="text-faint">{DASH}</span>,
          meta: { align: 'right', width: 110 },
        }),
        col.display({
          id: 'flags',
          header: 'Flags',
          meta: { label: 'Flags' },
          cell: ({ row }) =>
            row.original.anomalyFlags.length === 0 ? (
              <span className="text-faint">{DASH}</span>
            ) : (
              <span className="inline-flex flex-wrap gap-1">
                {row.original.anomalyFlags.map((flag) => (
                  <Badge key={flag} tone="warning" dot>
                    {ANOMALY_LABEL[flag] ?? flag}
                  </Badge>
                ))}
              </span>
            ),
        }),
        col.display({
          id: 'invoice',
          header: 'Invoice',
          meta: { align: 'center', width: 90, label: 'Invoice' },
          cell: ({ row }) => {
            const fill = fillsByKey.get(fillKey(row.original));
            // "View" sits on the line that leads a Relay fill; its other lines are the same
            // invoice. A fill keyed in by hand has no receipt to show.
            if (!fill?.relayTransactionId || fill.lead.id !== row.original.id) {
              return <span className="text-faint">{DASH}</span>;
            }
            return <ViewButton onClick={() => setInvoice(fill)} />;
          },
        }),
      ]),
    [fillsByKey],
  );

  const fillColumns = useMemo(
    () =>
      fillCol.columns([
        fillCol.accessor((fill) => Date.parse(fill.lead.at), {
          id: 'at',
          header: 'Date',
          cell: ({ row }) => (
            <span className="whitespace-nowrap">{formatDateTime(row.original.lead.at)}</span>
          ),
          meta: { width: 200, label: 'Date', className: 'font-normal' },
        }),
        fillCol.display({
          id: 'unit',
          header: 'Truck',
          meta: { width: 90, label: 'Truck' },
          cell: ({ row }) => (
            <Link
              to="/fleet/trucks/$truckId"
              params={{ truckId: row.original.lead.truckId }}
              className="font-medium text-primary-text hover:underline"
            >
              {row.original.lead.unitNumber}
            </Link>
          ),
        }),
        fillCol.display({
          id: 'driver',
          header: 'Driver',
          meta: { label: 'Driver' },
          cell: ({ row }) =>
            row.original.lead.driverName || <span className="text-faint">{DASH}</span>,
        }),
        fillCol.display({
          id: 'vendor',
          header: 'Vendor',
          meta: { label: 'Vendor' },
          cell: ({ row }) => (
            <span className="flex flex-col">
              <span className="text-ink">{row.original.lead.station.brand || DASH}</span>
              <span className="text-xs text-muted">{stationPlace(row.original.lead)}</span>
            </span>
          ),
        }),
        fillCol.display({
          id: 'lines',
          header: 'Lines',
          meta: { label: 'Lines' },
          cell: ({ row }) =>
            row.original.lines.map((line) => productLabel(line.product)).join(', '),
        }),
        fillCol.accessor('gallons', {
          header: 'Gallons',
          cell: ({ getValue }) => formatGallons(getValue()),
          meta: { align: 'right', width: 90 },
        }),
        fillCol.accessor('total', {
          header: 'Total',
          cell: ({ getValue }) => formatMoney(getValue()),
          meta: { align: 'right', width: 110 },
        }),
        fillCol.display({
          id: 'view',
          header: 'Invoice',
          meta: { align: 'center', width: 90, label: 'Invoice' },
          cell: ({ row }) =>
            row.original.relayTransactionId ? (
              <ViewButton onClick={() => setInvoice(row.original)} />
            ) : (
              <span className="text-faint" title="Keyed in by hand; no receipt was attached.">
                {DASH}
              </span>
            ),
        }),
      ]),
    [],
  );

  const presets: DateRangePreset[] = FUEL_RANGE_PRESETS.map((preset) => ({
    label: preset.label,
    range: () => {
      const r = preset.range(today);
      return { from: toPickerDate(r.from), to: toPickerDate(r.to) };
    },
  }));

  const filterBar = (
    <FilterBar
      search={{
        value: search.q ?? '',
        onChange: (value) => updateSearch({ q: value || undefined, page: undefined }),
        placeholder: 'Search truck, driver, station…',
      }}
      filters={filters}
      values={{
        unit: search.unit,
        state: search.state,
        vendor: search.vendor,
        product: search.product,
        flagged: search.flagged,
      }}
      onChange={(key, value) =>
        updateSearch({ [key]: (value as string | undefined) || undefined, page: undefined })
      }
      onClear={() =>
        updateSearch({
          unit: undefined,
          state: undefined,
          vendor: undefined,
          product: undefined,
          flagged: undefined,
          q: undefined,
          page: undefined,
        })
      }
    />
  );

  const loading = fleetQuery.isPending;
  const unitsWithoutMpg = summary?.unitsWithoutMpg ?? [];

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Fuel"
        // Keep the title from collapsing to one letter: on a phone the actions wrap below it.
        className="[&>div>div:first-child]:min-w-20"
        actions={
          <>
            <DateRangePicker
              aria-label="Date range"
              className="w-auto sm:min-w-64"
              value={{ from: toPickerDate(range.from), to: toPickerDate(range.to) }}
              presets={presets}
              maxDate={toPickerDate(today)}
              formatValue={() => formatRange(range)}
              trailing={
                <span className="ml-1 hidden h-5 sm:inline-flex items-center rounded-sm bg-nw-accent-tint px-1.5 text-2xs font-semibold text-nw-accent-ink">
                  {label}
                </span>
              }
              onChange={(next: DateRange | undefined) => {
                if (!next?.from) {
                  updateSearch({ from: undefined, to: undefined, page: undefined });
                  return;
                }
                updateSearch({
                  from: fromPickerDate(next.from),
                  to: fromPickerDate(next.to ?? next.from),
                  page: undefined,
                });
              }}
            />
            <Button
              variant="outline"
              icon={<Upload />}
              disabled={loading || rows.length === 0}
              onClick={() => downloadFuelCsv(rows, range)}
            >
              Export
            </Button>
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>
              Add fuel
            </Button>
          </>
        }
        tabs={
          <Tabs
            aria-label="Fuel views"
            value={tab}
            onValueChange={(value) =>
              updateSearch({
                tab: value === 'invoices' ? 'invoices' : undefined,
                page: undefined,
              })
            }
            items={[
              { value: 'transactions', label: 'Transactions' },
              { value: 'invoices', label: 'Invoices' },
            ]}
            listClassName="border-b-0"
          />
        }
      />

      <section aria-label="Fuel totals" className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        <FuelKpi
          icon={<Fuel />}
          label="Fuel spend"
          value={summary ? formatMoney(summary.spend) : null}
          hint={label === 'Custom' ? formatRange(range) : label}
        />
        <FuelKpi
          icon={<Droplet />}
          label="Gallons"
          value={summary ? formatNumber(summary.gallons, 1) : null}
          hint={
            summary
              ? summary.avgMpg === null
                ? 'Diesel · no measurable MPG'
                : `Diesel · ${summary.avgMpg.toFixed(2)} MPG over ${formatMiles(summary.measuredMiles)}`
              : undefined
          }
        />
        <FuelKpi
          icon={<Database />}
          label="Cost per gallon"
          value={
            summary
              ? summary.avgPricePerGallon === null
                ? DASH
                : `$${summary.avgPricePerGallon.toFixed(3)}`
              : null
          }
          hint={
            summary?.costPerMile != null ? `$${summary.costPerMile.toFixed(3)} per mile` : undefined
          }
        />
        <FuelKpi
          icon={<Truck />}
          label="Trucks fueled"
          value={summary ? formatNumber(summary.unitsFuelled) : null}
          unit="units"
          hint={
            summary?.spendPerUnit != null
              ? `${formatMoney(summary.spendPerUnit)} per truck`
              : undefined
          }
        />
      </section>

      {unitsWithoutMpg.length > 0 ? (
        <section
          aria-label="Units without measurable MPG"
          className="rounded-[10px] border border-nw-warning-border bg-nw-warning-bg text-sm"
        >
          <button
            type="button"
            aria-expanded={mpgOpen}
            onClick={() => setMpgOpen((open) => !open)}
            className="flex w-full cursor-pointer items-center gap-3 px-4 py-2.5 text-left"
          >
            <StatusSymbol family="warning" size={16} />
            <span className="min-w-0 flex-1 text-nw-warning-text">
              <span className="sr-only">Warning: </span>
              {formatNumber(unitsWithoutMpg.length)}{' '}
              {unitsWithoutMpg.length === 1 ? 'unit' : 'units'} bought diesel but{' '}
              {unitsWithoutMpg.length === 1 ? 'has' : 'have'} no measurable MPG — a fill needs an
              odometer reading, and a unit needs two of them.
              {summary && summary.discardedPairs > 0
                ? ` ${formatNumber(summary.discardedPairs)} readings were discarded as implausible.`
                : ''}
            </span>
            <ChevronDown
              aria-hidden
              className={cn(
                'size-4 shrink-0 text-nw-warning-icon transition-transform',
                mpgOpen && 'rotate-180',
              )}
            />
          </button>
          {mpgOpen ? (
            <ul className="flex flex-wrap gap-x-4 gap-y-1.5 border-t border-nw-warning-border px-4 py-3">
              {unitsWithoutMpg.map((truckId) => (
                <li key={truckId}>
                  <Link
                    to="/fleet/trucks/$truckId"
                    params={{ truckId }}
                    className="font-medium text-primary-text hover:underline"
                  >
                    {unitNumberById.get(truckId) ?? truckId}
                  </Link>
                </li>
              ))}
            </ul>
          ) : null}
        </section>
      ) : null}

      {bundle ? (
        <FleetExceptionPanel
          items={bundle.exceptions.items.filter((item) => item.target.to === '/fleet/fuel')}
          // Fuel has no per-unit filter to apply, so these rows report rather than navigate.
          interactive={false}
        />
      ) : null}

      {tab === 'invoices' ? (
        <DataTable
          columns={fillColumns}
          data={invoiceRows}
          rowKey={(fill) => fill.key}
          state={{
            sorting: fillSorting,
            pagination: { page: search.page ?? 1, pageSize: 25 },
            rowSelection: {},
            columnVisibility: {},
            globalFilter: '',
          }}
          onStateChange={(patch) => {
            if (patch.sorting !== undefined) setFillSorting(patch.sorting);
            if (patch.pagination !== undefined) {
              updateSearch({
                page: patch.pagination.page > 1 ? patch.pagination.page : undefined,
              });
            }
          }}
          loading={loading}
          error={fleetQuery.error ?? undefined}
          onRetry={() => void fleetQuery.refetch()}
          emptyTitle="No fuel invoices match"
          emptyDescription="Try another date range, search or filter."
          caption="Fuel invoices"
          showColumnChooser={false}
          toolbar={<TableTitle title="Fuel invoices">{filterBar}</TableTitle>}
        />
      ) : (
        <div className="grid items-start gap-4 xl:grid-cols-[minmax(0,1fr)_400px]">
          <DataTable
            columns={columns}
            data={rows}
            rowKey={(fill) => fill.id}
            state={{
              sorting,
              pagination: { page: search.page ?? 1, pageSize: 25 },
              rowSelection: {},
              columnVisibility,
              globalFilter: '',
            }}
            onStateChange={(patch) => {
              if (patch.sorting !== undefined) setSorting(patch.sorting);
              if (patch.pagination !== undefined) {
                updateSearch({
                  page: patch.pagination.page > 1 ? patch.pagination.page : undefined,
                });
              }
              if (patch.columnVisibility !== undefined) {
                setColumnVisibility(patch.columnVisibility);
              }
            }}
            onRowClick={(row) => setSelectedId(row.id)}
            getRowStatus={(row) => (selected && row.id === selected.id ? 'selected' : undefined)}
            loading={loading}
            error={fleetQuery.error ?? undefined}
            onRetry={() => void fleetQuery.refetch()}
            emptyTitle="No fuel transactions match"
            emptyDescription="Try another date range, search or filter."
            caption="Fuel transactions"
            toolbar={<TableTitle title="Fuel transactions">{filterBar}</TableTitle>}
            className="min-w-0"
          />

          <Card
            aria-label="Selected transaction"
            className="[&>div]:flex [&>div]:flex-col [&>div]:gap-4"
          >
            <h2 className="text-md font-bold text-ink">Selected transaction</h2>
            {loading ? (
              <p className="text-sm text-muted">{LOADING}</p>
            ) : !selected ? (
              <p className="text-sm text-muted">No transaction in this range.</p>
            ) : (
              <>
                <dl className="flex flex-col">
                  <Row label="Date & time">{formatDateTime(selected.at)}</Row>
                  <Row label="Truck">
                    <Link
                      to="/fleet/trucks/$truckId"
                      params={{ truckId: selected.truckId }}
                      className="font-medium text-primary-text hover:underline"
                    >
                      {selected.unitNumber}
                    </Link>
                  </Row>
                  <Row label="Driver">{selected.driverName || DASH}</Row>
                  <Row label="Station">
                    {selected.station.name ? (
                      <span className="block">{selected.station.name}</span>
                    ) : null}
                    {stationPlace(selected)}
                  </Row>
                  <Row label="Vendor">{selected.station.brand || DASH}</Row>
                  <Row label="Product">{productLabel(selected.product)}</Row>
                  <Row label="Gallons">{formatGallons(selected.gallons)}</Row>
                  <Row label="Price per gallon">
                    {formatPricePerGallon(chargedPricePerGallon(selected))}
                  </Row>
                  <Row label="Total">{formatMoney(selected.amount)}</Row>
                  <Row label="Odometer">
                    {selected.odometer > 0 ? (
                      formatMiles(selected.odometer)
                    ) : (
                      <span className="text-muted">Not recorded</span>
                    )}
                  </Row>
                  {selected.product === 'diesel' && selectedUnit ? (
                    <Row label="Unit MPG">
                      {selectedUnit.mpg === null ? (
                        <span className="text-muted">Not measurable in this range</span>
                      ) : (
                        `${selectedUnit.mpg.toFixed(2)} over ${formatMiles(selectedUnit.measuredMiles)}`
                      )}
                    </Row>
                  ) : null}
                  <Row label="Card">{selected.cardLast4 ? `•••• ${selected.cardLast4}` : DASH}</Row>
                  {selected.loadId ? <Row label="Load">{selected.loadId}</Row> : null}
                  {selected.anomalyFlags.length > 0 ? (
                    <Row label="Flags">
                      <span className="inline-flex flex-wrap gap-1">
                        {selected.anomalyFlags.map((flag) => (
                          <Badge key={flag} tone="warning" dot>
                            {ANOMALY_LABEL[flag] ?? flag}
                          </Badge>
                        ))}
                      </span>
                    </Row>
                  ) : null}
                </dl>

                <div className="flex flex-col gap-3 border-t border-line-soft pt-4">
                  <div className="flex items-baseline justify-between gap-3">
                    <h3 className="text-md font-bold text-ink">Invoice</h3>
                  </div>
                  {selectedFill?.relayTransactionId ? (
                    <>
                      <FuelInvoiceCard fill={selectedFill} />
                      <p className="text-xs text-muted">{RELAY_INVOICE_CAPTION}</p>
                      <Button
                        variant="outline"
                        size="lg"
                        fullWidth
                        icon={<FileText />}
                        onClick={() => setInvoice(selectedFill)}
                      >
                        View invoice
                      </Button>
                    </>
                  ) : (
                    <p className="text-sm text-muted">
                      Keyed in by hand — no receipt was attached.
                    </p>
                  )}
                </div>
              </>
            )}
          </Card>
        </div>
      )}

      <FuelInvoiceDialog fill={invoice} onOpenChange={(open) => !open && setInvoice(null)} />

      <AddFuelDialog
        open={adding}
        onOpenChange={setAdding}
        trucks={bundle?.trucks ?? []}
        onDone={() => setAdding(false)}
      />
    </div>
  );
}

function TableTitle({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-5 gap-y-2">
      <h2 className="text-md font-bold whitespace-nowrap text-ink">{title}</h2>
      {children}
    </div>
  );
}

function ViewButton({ onClick }: { onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="inline-flex cursor-pointer items-center gap-1.5 font-semibold text-primary-text hover:underline [&_svg]:size-4"
    >
      <FileText aria-hidden />
      View
    </button>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="grid grid-cols-[9rem_minmax(0,1fr)] gap-3 py-1 text-sm">
      <dt className="text-muted">{label}</dt>
      <dd className="min-w-0 text-ink tabular-nums">{children}</dd>
    </div>
  );
}

function FuelKpi({
  icon,
  label,
  value,
  unit,
  hint,
}: {
  icon: ReactNode;
  label: string;
  /** Null while the fills are still loading. */
  value: string | null;
  unit?: string;
  hint?: string;
}) {
  return (
    <div className="flex items-center gap-4 rounded-xl border border-nw-border bg-nw-panel px-5 py-4 shadow-card">
      <span
        aria-hidden
        className="flex size-12 shrink-0 items-center justify-center rounded-full bg-nw-accent-tint text-nw-accent-ink [&_svg]:size-5"
      >
        {icon}
      </span>
      <div className="min-w-0">
        <div className="text-sm font-semibold text-nw-text-2">{label}</div>
        {value === null ? (
          <div className="mt-1 text-sm text-nw-text-3">{LOADING}</div>
        ) : (
          <div className="mt-0.5 flex items-baseline gap-1.5">
            <span className="kpi-value text-2xl font-extrabold tracking-[-0.015em] text-nw-text tabular-nums">
              {value}
            </span>
            {unit ? <span className="text-sm text-nw-text-3">{unit}</span> : null}
          </div>
        )}
        {value !== null && hint ? (
          <div className="mt-0.5 truncate text-xs text-nw-text-3">{hint}</div>
        ) : null}
      </div>
    </div>
  );
}
