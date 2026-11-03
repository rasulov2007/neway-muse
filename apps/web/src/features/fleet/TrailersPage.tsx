import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Info,
  Link2,
  MinusCircle,
  PowerOff,
  Plus,
  Unlink,
  Wrench,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  Badge,
  Button,
  DataTable,
  FilterBar,
  MenuItem,
  Modal,
  PageHeader,
  createColumns,
  getStatus,
  type DataTableState,
  type FilterDefinition,
} from '@/design-system';
import { formatIsoDate, formatNumber } from '@/lib/format';
import { trailersSearchSchema, type TrailersSearch } from './trailers-search';
import { FleetSummaryStrip, type FleetSummarySegment } from './components/FleetSummaryStrip';
import { AVAILABILITY_LABEL, AVAILABILITY_TONE, DASH, trailerStatusLabel } from './fleet-ui';
import { useFleet, type FleetTrailer } from './useFleet';
import { TrailerForm } from './TrailerFormPage';
import { InShopUpdateCell } from './components/InShopUpdateCell';
import { useInShopIssues } from './components/in-shop-issues';
import { UnitStatusCell } from './components/UnitStatusCell';
import { TrailerPtiIssueBadge } from './pti/PtiIssueBadge';
import { unitStatusLook } from './components/unit-status-look';
import { unitIdentity } from './unit-header';

const TYPE_LABEL: Record<string, string> = {
  dry_van: 'Dry van',
  reefer: 'Reefer',
  flatbed: 'Flatbed',
};

/** The one predicate the table filters on and the strip counts with. */
function matchesTrailer(row: FleetTrailer, filters: TrailersSearch): boolean {
  const ids = filters.ids ? filters.ids.split(',').filter(Boolean) : [];
  if (ids.length > 0 && !ids.includes(row.trailer.id)) return false;
  if (filters.status && row.trailer.status !== filters.status) return false;
  if (filters.type && row.trailer.type !== filters.type) return false;
  if (filters.truck === 'assigned' && !row.trailer.currentTruckId) return false;
  if (filters.truck === 'unassigned' && row.trailer.currentTruckId) return false;

  const q = filters.q?.trim().toLowerCase();
  if (q) {
    const haystack = [
      row.trailer.unitNumber,
      row.trailer.vin,
      row.trailer.make,
      row.trailer.model,
      row.trailer.currentTruckUnit,
      row.truck?.currentDriverName,
      row.currentLoad?.loadNumber,
    ];
    if (!haystack.some((value) => value?.toLowerCase().includes(q))) return false;
  }
  return true;
}

const col = createColumns<FleetTrailer>();

/**
 * The Trailers list.
 *
 * Same anatomy, same components and the same click behaviour as Trucks — deliberately, because a
 * second list that behaves differently is a second list to learn. What differs is only what a
 * trailer *is*: it has no odometer, no driver of its own and no economics, so those columns are
 * simply absent rather than filled with borrowed numbers from the truck pulling it.
 */
export function TrailersPage() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => trailersSearchSchema.parse(rawSearch), [rawSearch]);
  const navigate = useNavigate();
  const [columnVisibility, setColumnVisibility] = useState<DataTableState['columnVisibility']>({});
  // The person's choice from the Rows-per-page select; 25 until they change it.
  const [pageSize, setPageSize] = useState(25);
  const [adding, setAdding] = useState(false);

  const fleetQuery = useFleet();
  const bundle = fleetQuery.data;
  // A trailer with an open in-shop work order is in maintenance (owner, 2026-10-19): availability
  // comes from the work order, not from someone remembering to change the trailer's status.
  const inShop = useInShopIssues(true);
  const trailerRows = useMemo(
    () =>
      (bundle?.trailers ?? []).map((row) => {
        const order = inShop.get(row.trailer.id);
        if (!order || (row.trailer.status !== 'available' && row.trailer.status !== 'assigned')) return row;
        return {
          ...row,
          trailer: { ...row.trailer, status: 'in_shop' as typeof row.trailer.status },
          availability: { ...row.availability, availability: 'in_maintenance' as const, reasons: [...row.availability.reasons, `In the shop on ${order.number}`] },
        };
      }),
    [bundle, inShop],
  );

  function updateSearch(patch: Partial<TrailersSearch>) {
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

  // A search finds the trailer whatever tile is pressed (owner, 2026-10-22).
  const searching = Boolean(search.q?.trim());
  const rows = useMemo(
    () =>
      trailerRows.filter((row) =>
        matchesTrailer(row, searching ? { ...search, status: undefined } : search),
      ),
    [trailerRows, search, searching],
  );

  // The tiles and the total read the whole fleet, never only what the search matched.
  const counts = useMemo(() => {
    const base = trailerRows.filter((row) =>
      matchesTrailer(row, { ...search, q: undefined, status: undefined }),
    );
    const map = new Map<string, number>();
    for (const row of base) {
      map.set(row.trailer.status, (map.get(row.trailer.status) ?? 0) + 1);
    }
    return { map, total: base.length };
  }, [trailerRows, search]);

  const segments: FleetSummarySegment[] = useMemo(() => {
    const buckets: Array<{
      key: string;
      tone: FleetSummarySegment['tone'];
      icon: FleetSummarySegment['icon'];
    }> = [
      { key: 'available', tone: 'success', icon: <CheckCircle2 /> },
      { key: 'assigned', tone: 'info', icon: <Link2 /> },
      { key: 'in_shop', tone: 'warning', icon: <Wrench /> },
      // Off the fleet for good (stolen, totaled, returned…), apart from out of service (owner, 2026-10-08).
      // Red, with its own symbol, so it never reads as a paused or neutral unit (owner, 2026-10-14).
      { key: 'inactive', tone: 'danger', icon: <PowerOff /> },
      { key: 'out_of_service', tone: 'danger', icon: <MinusCircle /> },
    ];
    // No Total tile (owner, 2026-10-10): the fleet total reads under Available.
    return [
      ...buckets.map((bucket) => ({
        key: bucket.key,
        label: trailerStatusLabel(bucket.key) ?? getStatus(bucket.key).label,
        count: bundle ? (counts.map.get(bucket.key) ?? 0) : null,
        tone: bucket.tone,
        icon: bucket.icon,
        hint:
          bucket.key === 'available' && bundle ? `of ${formatNumber(counts.total)} total` : undefined,
        valueTone: true,
        onSelect: () =>
          updateSearch({
            status: search.status === bucket.key ? undefined : bucket.key,
            ids: undefined,
            page: undefined,
          }),
      })),
    ];
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [bundle, counts, search.status]);

  const findings = useMemo(
    () => (bundle?.exceptions.items ?? []).filter((item) => item.target.to === '/fleet/trailers'),
    [bundle],
  );

  const filters = useMemo<FilterDefinition[]>(
    () => [
      {
        key: 'status',
        label: 'Status',
        type: 'select',
        options: [...new Set((bundle?.trailers ?? []).map((r) => r.trailer.status))]
          .sort()
          .map((code) => ({ value: code, label: trailerStatusLabel(code) ?? getStatus(code).label })),
      },
      {
        key: 'type',
        label: 'Type',
        type: 'select',
        options: Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label })),
      },
      {
        key: 'truck',
        label: 'Assignment',
        type: 'select',
        options: [
          { value: 'assigned', label: 'On a truck' },
          { value: 'unassigned', label: 'Unassigned' },
        ],
      },
    ],
    [bundle],
  );

  const columns = useMemo(
    () =>
      col.columns([
        col.display({
          id: 'unitNumber',
          header: 'Trailer / Type',
          meta: { primary: true, width: 160, label: 'Trailer / Type' },
          cell: ({ row }) => {
            const trailer = row.original.trailer;
            // "Dry van · 53 ft · 2026 Utility 4000D-X": the type first, then year, make and
            // model the way the Trucks list prints them, each part only when it is on record.
            const subline = [
              TYPE_LABEL[trailer.type] ?? trailer.type,
              trailer.lengthFt ? `${trailer.lengthFt} ft` : '',
              unitIdentity([trailer.year, trailer.make, trailer.model]),
            ]
              .filter(Boolean)
              .join(' · ');
            return (
              <span className="flex min-w-0 flex-col leading-tight">
                <Link
                  to="/fleet/trailers/$trailerId"
                  params={{ trailerId: trailer.id }}
                  className="w-fit font-semibold text-primary-text hover:underline"
                >
                  {trailer.unitNumber}
                </Link>
                <span className="truncate text-xs font-normal text-muted" title={subline}>
                  {subline}
                </span>
              </span>
            );
          },
        }),
        col.display({
          id: 'status',
          header: 'Status',
          meta: { width: 300 },
          cell: ({ row }) => (
            <span className="flex items-center gap-1.5">
              <UnitStatusCell
                entity="trailer"
                id={row.original.trailer.id}
                unitNumber={row.original.trailer.unitNumber}
                status={row.original.trailer.status}
                tone={getStatus(row.original.trailer.status).tone}
                label={
                  trailerStatusLabel(row.original.trailer.status) ??
                  getStatus(row.original.trailer.status).label
                }
              />
              {/* A PTI defect recorded on the trailer itself (owner, 2026-10-21). */}
              <TrailerPtiIssueBadge trailerId={row.original.trailer.id} />
            </span>
          ),
        }),
        col.display({
          id: 'availability',
          header: 'Availability',
          meta: { width: 140 },
          cell: ({ row }) => (
            <Badge
              dot
              tone={
                unitStatusLook(
                  row.original.trailer.id,
                  row.original.trailer.status,
                  '',
                  AVAILABILITY_TONE[row.original.availability.availability],
                ).tone
              }
              title={row.original.availability.reasons.join('. ')}
            >
              {AVAILABILITY_LABEL[row.original.availability.availability]}
            </Badge>
          ),
        }),
        col.display({
          id: 'currentLoad',
          header: 'Current load',
          meta: { width: 120 },
          cell: ({ row }) =>
            row.original.currentLoad ? (
              <Link
                to="/loads/$loadNumber"
                params={{ loadNumber: row.original.currentLoad.loadNumber }}
                className="hover:underline"
              >
                {row.original.currentLoad.loadNumber}
              </Link>
            ) : (
              <span className="text-faint">{DASH}</span>
            ),
        }),
        col.display({
          id: 'truck',
          header: 'Truck / Driver',
          meta: { width: 160, label: 'Truck / Driver' },
          cell: ({ row }) =>
            row.original.truck ? (
              <span className="flex min-w-0 flex-col leading-tight">
                <Link
                  to="/fleet/trucks/$truckId"
                  params={{ truckId: row.original.truck.id }}
                  className="w-fit font-semibold hover:underline"
                >
                  {row.original.truck.unitNumber}
                </Link>
                <span className="truncate text-xs text-muted">
                  {row.original.truck.currentDriverName ?? DASH}
                </span>
              </span>
            ) : (
              <span className="flex min-w-0 flex-col leading-tight">
                <span className="text-muted">Unassigned</span>
                <span className="text-xs text-faint">{DASH}</span>
              </span>
            ),
        }),
        col.display({
          id: 'location',
          header: 'Location',
          cell: ({ row }) => {
            const location = row.original.truck?.location ?? row.original.trailer.location;
            return location ? (
              `${location.city}, ${location.state}`
            ) : (
              <span
                className="text-muted"
                title="A trailer has no telematics of its own; its position is the position of the truck pulling it."
              >
                No position
              </span>
            );
          },
        }),
        col.display({
          id: 'nextInspection',
          header: 'Next inspection',
          meta: { width: 150 },
          // The later of the trailer's own date and its annual inspection certificate.
          cell: ({ row }) => formatIsoDate(row.original.nextInspection.date),
        }),
        // How long since the shop last said something, for a unit in maintenance (owner, 2026-10-19).
        col.display({
          id: 'lastUpdate',
          header: 'Last update',
          meta: { width: 150 },
          cell: ({ row }) => <InShopUpdateCell unitId={row.original.trailer.id} />,
        }),
      ]),
    [],
  );

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Trailers"
        description="Trailer availability, assignments and inspections."
      />

      <FleetSummaryStrip
        segments={segments}
        activeKey={search.status ?? null}
        loading={fleetQuery.isPending}
        iconRight
      />

      {/* One quiet line per finding in place of a panel of coloured cards: an unassigned pool is
          a fact to act on, not an alarm. The link opens exactly the trailers behind it. */}
      {findings.map((item) => (
        <div
          key={item.key}
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-lg border border-info-border bg-info-soft px-4 py-2.5 text-sm text-info-text"
        >
          <Info aria-hidden className="size-4 shrink-0" />
          <span className="min-w-0 flex-1" title={item.reason}>
            {item.ids.length > 0 ? `${formatNumber(item.count)} ` : ''}
            {item.key === 'trailers_unassigned' ? 'trailers are unassigned' : item.label}
          </span>
          <button
            type="button"
            className="inline-flex items-center gap-1 font-medium hover:underline"
            onClick={() =>
              updateSearch({
                ...item.target.search,
                truck: item.key === 'trailers_unassigned' ? 'unassigned' : search.truck,
                ids: item.ids.length > 0 ? item.ids.join(',') : undefined,
                page: undefined,
              })
            }
          >
            View trailers
            <ArrowRight aria-hidden className="size-3.5" />
          </button>
        </div>
      ))}

      <DataTable
        columns={columns}
        data={rows}
        rowKey={(row) => row.trailer.id}
        state={{
          sorting: [],
          pagination: { page: search.page ?? 1, pageSize },
          // Nothing selects rows on this page; the table asks for the field all the same.
          rowSelection: {},
          columnVisibility,
          globalFilter: '',
        }}
        onStateChange={(patch) => {
          if (patch.pagination !== undefined) {
            // Rows per page is the person's choice (owner, 2026-10-10); a new size starts at page 1.
            if (patch.pagination.pageSize !== pageSize) {
              setPageSize(patch.pagination.pageSize);
              updateSearch({ page: undefined });
            } else {
              updateSearch({
                page: patch.pagination.page > 1 ? patch.pagination.page : undefined,
              });
            }
          }
          if (patch.columnVisibility !== undefined) setColumnVisibility(patch.columnVisibility);
        }}
        loading={fleetQuery.isPending}
        error={fleetQuery.error ?? undefined}
        onRetry={() => void fleetQuery.refetch()}
        emptyTitle="No trailers match"
        emptyDescription="Try another search or clear the filters."
        caption="Trailers"
        // A row opens the trailer; nothing selects rows here, so there is no checkbox column.
        onRowClick={(row) =>
          void navigate({
            to: '/fleet/trailers/$trailerId',
            params: { trailerId: row.trailer.id },
          })
        }
        toolbar={
          <FilterBar
            search={{
              value: search.q ?? '',
              onChange: (value) => updateSearch({ q: value || undefined, page: undefined }),
              placeholder: 'Search trailer, VIN or truck…',
            }}
            filters={filters}
            values={{ status: search.status, type: search.type, truck: search.truck }}
            onChange={(key, value) =>
              updateSearch({
                [key]: (value as string | undefined) || undefined,
                ids: undefined,
                page: undefined,
              })
            }
            onClear={() =>
              updateSearch({
                status: undefined,
                type: undefined,
                truck: undefined,
                ids: undefined,
                page: undefined,
              })
            }
          >
            <Button variant="primary" size="sm" icon={<Plus />} onClick={() => setAdding(true)}>
              Add trailer
            </Button>
          </FilterBar>
        }
        rowActions={(row) => (
          <>
            <MenuItem
              icon={<ExternalLink />}
              onSelect={() =>
                void navigate({
                  to: '/fleet/trailers/$trailerId',
                  params: { trailerId: row.trailer.id },
                })
              }
            >
              Open trailer
            </MenuItem>
            {row.truck ? (
              <MenuItem
                icon={<Unlink />}
                onSelect={() =>
                  void navigate({
                    to: '/fleet/trucks/$truckId',
                    params: { truckId: row.truck?.id ?? '' },
                  })
                }
              >
                Manage on unit {row.truck.unitNumber}
              </MenuItem>
            ) : null}
          </>
        )}
      />

      {/* Adding happens over the register, like booking a load. */}
      <Modal
        open={adding}
        onOpenChange={setAdding}
        size="lg"
        title="Add trailer"
        description="What it is, what plate it carries, and when it is next due for inspection."
      >
        <TrailerForm
          onCancel={() => setAdding(false)}
          onCreated={(trailerId) => {
            setAdding(false);
            void navigate({ to: '/fleet/trailers/$trailerId', params: { trailerId } });
          }}
        />
      </Modal>
    </div>
  );
}
