import { useUnitsOff } from './units-off';
import { useAccount } from '@/features/auth/auth-context';
import { EditVendorPercentDialog, RenameVendorDialog } from './components/TruckVendorDialog';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import type { SortingState } from '@tanstack/react-table';
import {
  AlertTriangle,
  Archive,
  Ban,
  CalendarClock,
  CheckCircle2,
  CircleArrowRight,
  CircleHelp,
  Clock,
  ExternalLink,
  Handshake,
  Link2,
  ListFilter,
  Pencil,
  Percent,
  PowerOff,
  Plus,
  Users,
  Wrench,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { MaintenanceDue, UnitAvailability } from '@neway/shared';
import {
  Badge,
  Select,
  PopoverTrigger,
  PopoverContent,
  Popover,
  Modal,
  Button,
  DataTable,
  FilterBar,
  MenuItem,
  MenuSeparator,
  PageHeader,
  Tabs,
  createColumns,
  getStatus,
  type DataTableState,
  type FilterDefinition,
} from '@/design-system';
import { formatIsoDate, formatMiles, formatMoney, formatNumber } from '@/lib/format';
import { FleetExceptionPanel } from './components/FleetExceptionPanel';
import { TruckForm } from './TruckFormPage';
import { FleetSummaryStrip, type FleetSummarySegment } from './components/FleetSummaryStrip';
import { AVAILABILITY_LABEL, AVAILABILITY_TONE, DASH, MAINTENANCE_LABEL } from './fleet-ui';
import { matchesTruckFilters, trucksSearchSchema, type TrucksSearch } from './trucks-search';
import { UnitExitsTab } from './components/UnitExitsTab';
import { ArchivedTrucksTab } from './components/ArchivedTrucksTab';
import { InShopUpdateCell } from './components/InShopUpdateCell';
import { UnitStatusCell } from './components/UnitStatusCell';
import { isEnabled } from '@/lib/feature-flags';
import { usePtiUnitIssues } from './pti/api';
import { TruckPtiIssueBadge } from './pti/PtiIssueBadge';
import { useFleet, type FleetTruck } from './useFleet';

const PAGE_SIZE = 25;

/**
 * The strip's buckets, in the order the brief asks for.
 *
 * Every truck lands in exactly one availability, so the tiles add up to the total under Available
 * (owner, 2026-10-22). The `whenAny` ones are rare - a truck moving on a load, a sold unit still on
 * the books, a status nobody recognises - and show only while they hold a truck, rather than
 * leaving trucks counted in the total and in no tile.
 */
const SUMMARY_BUCKETS: ReadonlyArray<{
  key: UnitAvailability;
  tone?: FleetSummarySegment['tone'];
  icon: FleetSummarySegment['icon'];
  valueTone?: boolean;
  whenAny?: boolean;
}> = [
  { key: 'available', tone: 'success', icon: <CheckCircle2 />, valueTone: true },
  // A driver on the unit, or a load on it standing still (owner, 2026-10-22).
  { key: 'assigned', tone: 'info', icon: <Users /> },
  { key: 'in_transit', tone: 'info', icon: <CircleArrowRight />, whenAny: true },
  { key: 'in_maintenance', tone: 'warning', icon: <Wrench /> },
  // Vendor took this tile's place (owner, 2026-10-28); a unit out of service still shows here when there is one.
  { key: 'out_of_service', tone: 'danger', icon: <Ban />, valueTone: true, whenAny: true },
  { key: 'retired', tone: 'neutral', icon: <Archive />, whenAny: true },
  { key: 'unknown', tone: 'neutral', icon: <CircleHelp />, whenAny: true },
];

/**
 * The maintenance cell: a coloured verdict on the first line, the distance to it on the second.
 * The engine's own summary stays in the tooltip so nothing it says is lost.
 */
function MaintenanceCell({ service }: { service: MaintenanceDue }) {
  const { urgency, milesRemaining, daysRemaining } = service;
  const parts: string[] = [];
  if (urgency === 'overdue') {
    if (milesRemaining !== null && milesRemaining < 0) {
      parts.push(`${formatNumber(Math.abs(milesRemaining))} mi`);
    }
    if (daysRemaining !== null && daysRemaining < 0) {
      parts.push(`${formatNumber(Math.abs(daysRemaining))} days`);
    }
  } else if (urgency === 'ok' || urgency === 'due_soon') {
    if (milesRemaining !== null) parts.push(`${formatNumber(milesRemaining)} mi`);
    if (daysRemaining !== null) parts.push(`${formatNumber(daysRemaining)} days`);
  }
  const bookedFor = service.summary.match(/(\d{4}-\d{2}-\d{2})\s*$/)?.[1];
  const detail =
    urgency === 'overdue' && parts.length > 0
      ? `${parts.join(' · ')} past due`
      : (urgency === 'ok' || urgency === 'due_soon') && parts.length > 0
        ? `${parts.join(' · ')} remaining`
        : urgency === 'scheduled' && bookedFor
          ? formatIsoDate(bookedFor)
          : urgency === 'unknown'
            ? 'No interval recorded'
            : service.summary;
  const look = {
    ok: { icon: <CheckCircle2 />, text: 'text-success-text' },
    due_soon: { icon: <Clock />, text: 'text-warning-text' },
    overdue: { icon: <AlertTriangle />, text: 'text-danger-text' },
    scheduled: { icon: <Wrench />, text: 'text-info-text' },
    unknown: { icon: <Clock />, text: 'text-muted' },
  }[urgency];
  const label = urgency === 'scheduled' ? 'Shop booked' : MAINTENANCE_LABEL[urgency];
  return (
    <span className="flex items-center gap-2" title={service.summary}>
      <span aria-hidden className={`shrink-0 [&_svg]:size-4 ${look.text}`}>
        {look.icon}
      </span>
      <span className="flex min-w-0 flex-col leading-tight">
        <span className={`text-sm font-medium ${look.text}`}>{label}</span>
        <span className="truncate text-xs text-muted">{detail}</span>
      </span>
    </span>
  );
}

function parseSort(value: string | undefined): SortingState {
  if (!value) return [];
  const desc = value.startsWith('-');
  return [{ id: desc ? value.slice(1) : value, desc }];
}

function serializeSort(sorting: SortingState): string | undefined {
  const first = sorting[0];
  if (!first) return undefined;
  return first.desc ? `-${first.id}` : first.id;
}

const col = createColumns<FleetTruck>();

/**
 * The Trucks list.
 *
 * Three deliberate choices worth stating:
 *
 *  - A single click **selects**; only a double click or the unit number opens. A list whose every
 *    click navigates away cannot be used to compare two rows, which is most of what this list is
 *    for.
 *  - Availability is a separate column from status because the stored status answers "what is this
 *    unit doing" and availability answers "can I put freight on it" — a truck can be `driving` in
 *    the record and still be undispatchable because a work order has it in a shop.
 *  - Revenue and profit come from the same engine the load board uses, so a unit that deadheads
 *    200 miles to every load cannot look identical here to one that deadheads 20.
 */
export function TrucksPage() {
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => trucksSearchSchema.parse(rawSearch), [rawSearch]);
  const navigate = useNavigate();

  const [columnVisibility, setColumnVisibility] = useState<DataTableState['columnVisibility']>({});

  const fleetQuery = useFleet();
  const bundle = fleetQuery.data;

  function updateSearch(patch: Partial<TrucksSearch>) {
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

  function openTruck(row: FleetTruck) {
    void navigate({ to: '/fleet/trucks/$truckId', params: { truckId: row.truck.id } });
  }

  // Units with a PTI issue (owner, 2026-10-21), from the server; behind fleet_v2 with its routes.
  const fleetV2 = isEnabled('fleet_v2');
  const ptiQuery = usePtiUnitIssues(fleetV2);
  const ptiIssueUnits = useMemo(
    () => (ptiQuery.data ? new Set(Object.keys(ptiQuery.data)) : null),
    [ptiQuery.data],
  );
  const ptiPending = search.pti === 'issue' && fleetV2 && ptiQuery.isPending;

  // A search finds the truck whatever tile is pressed: while something is typed, the strip's own
  // facets (availability, the Inactive tile's status) step aside (owner, 2026-10-22).
  const searching = Boolean(search.q?.trim());
  const rows = useMemo(
    () =>
      (bundle?.trucks ?? []).filter((row) =>
        matchesTruckFilters(
          row,
          searching
            ? {
                ...search,
                availability: undefined,
                status: search.status === 'inactive' ? undefined : search.status,
              }
            : search,
          ptiIssueUnits,
        ),
      ),
    [bundle, search, searching, ptiIssueUnits],
  );

  // The strip counts with the same predicate the table filters on, minus the facets the strip
  // itself sets (availability, and the Inactive tile's status) and minus the search — so a
  // segment reading 12 opens a list of exactly 12, and Total keeps reading the whole fleet while
  // a tile is pressed or a unit is searched for.
  const counts = useMemo(() => {
    const base = (bundle?.trucks ?? []).filter((row) =>
      matchesTruckFilters(row, {
        ...search,
        q: undefined,
        availability: undefined,
        status: search.status === 'inactive' ? undefined : search.status,
      }, ptiIssueUnits),
    );
    const map = new Map<string, number>();
    for (const row of base) {
      const key = row.availability.availability;
      // A vendor truck with a driver is counted under Vendor, not Assigned (owner, 2026-10-30).
      if (key === 'assigned' && row.truck.vendor) continue;
      map.set(key, (map.get(key) ?? 0) + 1);
    }
    return { map, total: base.length };
  }, [bundle, search, ptiIssueUnits]);

  // Adding a unit happens over the list, not on a page of its own.
  const [adding, setAdding] = useState(false);
  const [editingPercent, setEditingPercent] = useState<FleetTruck | null>(null);
  const [renamingVendor, setRenamingVendor] = useState<{ id: string; name: string } | null>(null);
  const account = useAccount();
  const canEditTrucks = account !== null && (account.isOwner || account.permissions.includes('trucks.edit'));

  const filterValues: Record<string, string | undefined> = {
    status: search.status,
    make: search.make,
    state: search.state,
    driver: search.driver,
    maintenance: search.maintenance,
    availability: search.availability,
    pti: search.pti,
  };
  const activeFilterCount = Object.values(filterValues).filter(Boolean).length;
  const clearFilters = () =>
    updateSearch({
      status: undefined,
      make: undefined,
      state: undefined,
      driver: undefined,
      maintenance: undefined,
      availability: undefined,
      pti: undefined,
      telematics: undefined,
      ids: undefined,
      page: undefined,
    });

  const attentionItems = useMemo(
    () => (bundle?.exceptions.items ?? []).filter((item) => item.target.to === '/fleet/trucks'),
    [bundle],
  );
  const attentionCount = attentionItems.length;

  // Counted with the strip's own predicate, so Inactive and the availability tiles add up to the
  // total under Available whatever other filter is on. A stored `inactive` status is always the
  // `inactive` availability, so this is the same set the tile's status filter opens.
  const inactiveCount = counts.map.get('inactive') ?? 0;

  // Drivers at home or on vacation today (owner, 2026-10-28): counted under Assigned, from the Daily board.
  const unitsOff = useUnitsOff();
  const offCounts = useMemo(() => {
    let home = 0;
    let vacation = 0;
    for (const row of bundle?.trucks ?? []) {
      const off = unitsOff.data?.get(row.truck.unitNumber.trim().toUpperCase());
      if (off?.status === 'HOME') home += 1;
      else if (off?.status === 'VACATION') vacation += 1;
    }
    return { home, vacation };
  }, [bundle, unitsOff.data]);

  // Vendor trucks (owner, 2026-10-28): a vendor's own truck in the fleet. Not an availability - a
  // vendor truck is also available or assigned - so the tile opens exactly those units.
  const vendorIds = useMemo(
    () => (bundle?.trucks ?? []).filter((row) => row.truck.vendor).map((row) => row.truck.id),
    [bundle],
  );

  const segments: FleetSummarySegment[] = useMemo(() => {
    // No Total tile (owner, 2026-10-10): the fleet total reads under Available.
    const all: FleetSummarySegment[] = [];
    for (const bucket of SUMMARY_BUCKETS) {
      // The findings sit immediately before the worst segment, so the eye reaches "what is wrong"
      // on its way to "what is out of service". With nothing to show the tile is a plain zero.
      if (bucket.key === 'out_of_service') {
        all.push({
          key: '__attention',
          label: 'Needs attention',
          count: bundle ? attentionCount : null,
          tone: 'danger',
          valueTone: true,
          icon: <AlertTriangle />,
          popover:
            attentionCount === 0 ? undefined : (
              <FleetExceptionPanel
                className="border-0 shadow-none"
                items={attentionItems}
                unavailable={bundle?.exceptions.unavailable}
                onSelect={(item) =>
                  updateSearch({
                    availability: undefined,
                    maintenance: undefined,
                    telematics: undefined,
                    ...item.target.search,
                    ids: item.ids.length > 0 ? item.ids.join(',') : undefined,
                    page: undefined,
                  })
                }
              />
            ),
        });
      }
      if (bucket.key === 'out_of_service') {
        const ids = vendorIds.join(',');
        all.push({
          key: '__vendor',
          label: 'Vendor',
          count: bundle ? vendorIds.length : null,
          tone: 'info',
          icon: <Handshake />,
          onSelect: () =>
            updateSearch({
              ids: search.ids === ids || vendorIds.length === 0 ? undefined : ids,
              availability: undefined,
              page: undefined,
            }),
        });
      }
      // Inactive is a stored status, not a derived availability: a unit parked for the season and
      // one sitting in a shop are both "out of service" to the yard, and an owner needs them apart.
      if (bucket.key === 'in_maintenance') {
        all.push({
          key: '__inactive',
          label: 'Inactive',
          count: bundle ? inactiveCount : null,
          // Red, with its own symbol, so it never reads as a paused unit (owner, 2026-10-14).
          tone: 'danger',
          icon: <PowerOff />,
          onSelect: () =>
            updateSearch({
              status: search.status === 'inactive' ? undefined : 'inactive',
              availability: undefined,
              ids: undefined,
              page: undefined,
            }),
        });
      }
      const count = counts.map.get(bucket.key) ?? 0;
      if (bucket.whenAny && (!bundle || count === 0)) continue;
      all.push({
        key: bucket.key,
        label: AVAILABILITY_LABEL[bucket.key],
        count: bundle ? count : null,
        tone: bucket.tone,
        icon: bucket.icon,
        hint:
          bucket.key === 'available' && bundle
            ? `of ${formatNumber(counts.total)} total`
            : bucket.key === 'assigned' && bundle && unitsOff.data
              ? `Home ${formatNumber(offCounts.home)} · Vacation ${formatNumber(offCounts.vacation)}`
              : undefined,
        valueTone: bucket.valueTone,
        onSelect: () =>
          updateSearch({
            availability: search.availability === bucket.key ? undefined : bucket.key,
            ids: undefined,
            page: undefined,
          }),
      });
    }
    return all;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    bundle,
    counts,
    search.availability,
    search.status,
    inactiveCount,
    offCounts,
    unitsOff.data,
    vendorIds,
    search.ids,
    attentionCount,
    attentionItems,
  ]);

  const filters = useMemo<FilterDefinition[]>(() => {
    const trucks = bundle?.trucks ?? [];
    const makes = [...new Set(trucks.map((r) => r.truck.make))].sort();
    const states = [
      ...new Set(trucks.flatMap((r) => (r.truck.location ? [r.truck.location.state] : []))),
    ].sort();
    return [
      {
        key: 'make',
        label: 'Type',
        type: 'select',
        options: makes.map((make) => ({ value: make, label: make })),
      },
      {
        key: 'state',
        label: 'Location',
        type: 'select',
        options: states.map((state) => ({ value: state, label: state })),
      },
      {
        key: 'driver',
        label: 'Driver',
        type: 'select',
        options: [
          { value: 'assigned', label: 'Driver assigned' },
          { value: 'unassigned', label: 'No driver' },
        ],
      },
      {
        key: 'maintenance',
        label: 'Maintenance',
        type: 'select',
        options: [
          { value: 'overdue', label: 'Overdue' },
          { value: 'due_soon', label: 'Due soon' },
          { value: 'scheduled', label: 'Scheduled' },
          { value: 'ok', label: 'On schedule' },
          { value: 'unknown', label: 'No interval' },
        ],
      },
      {
        // Named for the column it filters, now that there is only one.
        key: 'availability',
        label: 'Status',
        type: 'select',
        options: SUMMARY_BUCKETS.map((bucket) => ({
          value: bucket.key,
          label: AVAILABILITY_LABEL[bucket.key],
        })),
      },
      // A PTI defect not yet fixed (owner, 2026-10-21); the defect records are fleet_v2's.
      ...(fleetV2
        ? [
            {
              key: 'pti',
              label: 'PTI',
              type: 'select' as const,
              options: [{ value: 'issue', label: 'PTI issue' }],
            },
          ]
        : []),
    ];
  }, [bundle, fleetV2]);

  const columns = useMemo(
    () =>
      col.columns([
        col.display({
          id: 'unitNumber',
          header: 'Unit / Vehicle',
          meta: { primary: true, width: 170, label: 'Unit / Vehicle' },
          cell: ({ row }) => (
            <span className="flex min-w-0 flex-col leading-tight">
              <Link
                to="/fleet/trucks/$truckId"
                params={{ truckId: row.original.truck.id }}
                className="w-fit font-semibold text-primary-text hover:underline"
              >
                {row.original.truck.unitNumber}
              </Link>
              {row.original.truck.vendor ? (
                <span className="w-fit text-[11px] font-semibold text-info-text" title={`Vendor ${row.original.truck.vendor.vendorName}: company keeps ${row.original.truck.vendor.companyPercent}%`}>
                  Vendor · {row.original.truck.vendor.vendorName}
                </span>
              ) : null}
              <span className="truncate text-xs font-normal text-muted">
                {row.original.truck.year} {row.original.truck.make} {row.original.truck.model}
              </span>
            </span>
          ),
        }),
        // One status column. Availability and the stored status were separate because they answer
        // different questions - "what is this unit doing" against "can I put freight on it" - but
        // on screen they printed the same four words next to each other, which reads as the list
        // saying the same thing twice. The operational verdict wins the column; the record's own
        // status stays in the tooltip with the reasons, so nothing is lost.
        col.display({
          id: 'availability',
          header: 'Status',
          meta: { width: 340 },
          cell: ({ row }) => (
            // The PTI sign sits right beside the status (owner, 2026-10-21), so an "Available"
            // truck with a defect not yet fixed says so at a glance.
            <span className="flex items-center gap-1.5">
              <UnitStatusCell
                entity="truck"
                id={row.original.truck.id}
                unitNumber={row.original.truck.unitNumber}
                status={row.original.truck.status}
                tone={AVAILABILITY_TONE[row.original.availability.availability]}
                label={AVAILABILITY_LABEL[row.original.availability.availability]}
                title={[
                  `Record status: ${getStatus(row.original.truck.status).label}`,
                  ...row.original.availability.reasons,
                ].join('. ')}
              />
              <TruckPtiIssueBadge truckId={row.original.truck.id} />
              {(() => {
                const off = unitsOff.data?.get(row.original.truck.unitNumber.trim().toUpperCase());
                return off ? (
                  <Badge dot size="md" tone="neutral" title={`${off.driverName} is ${off.status} on today's Daily board`} data-unit-off={off.status}>
                    {off.status}
                  </Badge>
                ) : null;
              })()}
            </span>
          ),
        }),
        col.display({
          id: 'driver',
          header: 'Driver',
          cell: ({ row }) =>
            row.original.truck.currentDriverId ? (
              <Link
                to="/drivers"
                search={{ driver: row.original.truck.currentDriverId }}
                className="truncate hover:underline"
              >
                {row.original.truck.currentDriverName}
              </Link>
            ) : (
              <span className="text-faint">Unassigned</span>
            ),
        }),
        col.display({
          id: 'location',
          header: 'Current location',
          cell: ({ row }) => {
            const location = row.original.truck.location;
            if (!location) {
              return (
                <span
                  className="text-muted"
                  title="This unit is not reporting a position. It needs a connected telematics feed."
                >
                  No position
                </span>
              );
            }
            return (
              <span title={`Reported ${row.original.tracking.state}`}>
                {location.city}, {location.state}
              </span>
            );
          },
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
          id: 'odometer',
          header: 'Mileage',
          meta: { align: 'right', width: 110 },
          cell: ({ row }) => formatMiles(row.original.truck.odometer),
        }),
        col.display({
          id: 'nextService',
          header: 'Next maintenance',
          meta: { width: 210 },
          cell: ({ row }) => <MaintenanceCell service={row.original.service} />,
        }),
        // How long since the shop last said something, for a unit in maintenance (owner, 2026-10-19).
        col.display({
          id: 'lastUpdate',
          header: 'Last update',
          meta: { width: 150 },
          cell: ({ row }) => <InShopUpdateCell unitId={row.original.truck.id} />,
        }),
        col.display({
          id: 'revenue',
          header: 'Revenue',
          meta: { align: 'right', width: 120 },
          cell: ({ row }) => {
            const economics = row.original.economics;
            if (economics.revenue === null) {
              return (
                <span
                  className="text-faint"
                  title="No load on this unit has enough detail to price."
                >
                  {DASH}
                </span>
              );
            }
            return (
              <span
                title={`From ${economics.coverage.priced} of ${economics.coverage.loads} loads`}
              >
                {formatMoney(economics.revenue, { compact: true })}
              </span>
            );
          },
        }),
        col.display({
          id: 'profit',
          header: 'Profit / Margin',
          meta: { align: 'right', width: 130, label: 'Profit / Margin' },
          cell: ({ row }) => {
            const economics = row.original.economics;
            if (economics.profit === null) {
              return <span className="text-faint">{DASH}</span>;
            }
            return (
              <span
                title={
                  economics.estimated
                    ? 'Includes an estimated cost for the empty miles this unit ran.'
                    : undefined
                }
              >
                {formatMoney(economics.profit, { compact: true })}
                {economics.marginPct === null ? '' : ` · ${economics.marginPct}%`}
              </span>
            );
          },
        }),
      ]),
    // The HOME / VACATION marks come from the Daily board (owner, 2026-10-28).
    [unitsOff.data],
  );

  const page = search.page ?? 1;
  // The person's choice from the Rows-per-page select; 25 until they change it.
  const [pageSize, setPageSize] = useState(PAGE_SIZE);
  const tableState: DataTableState = {
    sorting: parseSort(search.sort),
    pagination: { page, pageSize },
    // Nothing selects rows on this page; the table asks for the field all the same.
    rowSelection: {},
    columnVisibility,
    globalFilter: '',
  };

  const activeSegment =
    search.status === 'inactive'
      ? '__inactive'
      : (search.availability ?? null);

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Trucks"
        description="Manage fleet availability, assignments and maintenance."
      />

      <Tabs
        items={[
          { value: 'fleet', label: 'The fleet' },
          { value: 'off_road', label: 'Off the road' },
          // Archived trucks (owner, 2026-10-05) are listed here and nowhere else.
          { value: 'archived', label: 'Archived' },
        ]}
        value={search.tab ?? 'fleet'}
        onValueChange={(value: string) =>
          updateSearch({
            tab: value === 'off_road' || value === 'archived' ? value : undefined,
            page: undefined,
          })
        }
        aria-label="Truck register"
      />

      {search.tab === 'off_road' ? <UnitExitsTab /> : null}
      {search.tab === 'archived' ? (
        <ArchivedTrucksTab
          rows={fleetQuery.data?.archivedTrucks ?? []}
          loading={fleetQuery.isPending}
        />
      ) : null}

      {/* The findings live behind a segment of the strip instead of a panel above it: five
          coloured cards was the first thing the page said, every time, before the fleet itself. */}
      {search.tab === 'off_road' || search.tab === 'archived' ? null : (
        <FleetSummaryStrip
          segments={segments}
          activeKey={activeSegment}
          loading={fleetQuery.isPending}
        />
      )}

      {search.ids ? (
        <p className="text-sm text-secondary">
          Showing the {parseIdCount(search.ids)} units behind one finding.{' '}
          <button
            type="button"
            className="font-medium text-primary-text hover:underline"
            onClick={() => updateSearch({ ids: undefined, page: undefined })}
          >
            Show the whole fleet
          </button>
        </p>
      ) : null}

      <div hidden={search.tab === 'off_road' || search.tab === 'archived'}>
        <DataTable
          columns={columns}
          data={rows}
          rowKey={(row) => row.truck.id}
          state={tableState}
          onStateChange={(patch) => {
            if (patch.sorting !== undefined) {
              updateSearch({
                sort: serializeSort(patch.sorting as SortingState),
                page: undefined,
              });
            }
            if (patch.pagination !== undefined) {
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
          loading={fleetQuery.isPending || ptiPending}
          error={fleetQuery.error ?? undefined}
          onRetry={() => void fleetQuery.refetch()}
          emptyTitle="No trucks match"
          emptyDescription="Try another search or clear the filters."
          caption="Trucks"
          // A row opens the unit. There is nothing to select rows for, and a checkbox column that
          // leads nowhere is a column of dead weight on every row.
          onRowClick={openTruck}
          toolbarRight={
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="secondary" size="sm" icon={<ListFilter />}>
                  Filters{activeFilterCount > 0 ? ` · ${activeFilterCount}` : ''}
                </Button>
              </PopoverTrigger>
              <PopoverContent align="end" className="flex w-64 flex-col gap-3">
                {filters.map((filter) => (
                  <label
                    key={filter.key}
                    className="flex flex-col gap-1 text-xs font-medium text-muted"
                  >
                    {filter.label}
                    <Select
                      options={[
                        { value: '', label: `Any ${filter.label.toLowerCase()}` },
                        ...(filter.options ?? []),
                      ]}
                      value={(filterValues[filter.key] as string | undefined) ?? ''}
                      onValueChange={(value) =>
                        updateSearch({
                          [filter.key]: value || undefined,
                          ids: undefined,
                          page: undefined,
                        })
                      }
                    />
                  </label>
                ))}
                {activeFilterCount > 0 ? (
                  <Button variant="ghost" size="sm" onClick={clearFilters}>
                    Clear filters
                  </Button>
                ) : null}
              </PopoverContent>
            </Popover>
          }
          toolbar={
            <FilterBar
              search={{
                value: search.q ?? '',
                onChange: (value) => updateSearch({ q: value || undefined, page: undefined }),
                placeholder: 'Search unit, VIN, driver or load…',
              }}
              values={filterValues}
              onChange={() => {}}
              onClear={clearFilters}
            >
              <Button variant="primary" size="sm" icon={<Plus />} onClick={() => setAdding(true)}>
                Add truck
              </Button>
            </FilterBar>
          }
          rowActions={(row) => (
            <TruckRowActions
              row={row}
              onEditPercent={canEditTrucks && row.truck.vendor ? () => setEditingPercent(row) : undefined}
              onRenameVendor={canEditTrucks && row.truck.vendor ? () => setRenamingVendor({ id: row.truck.vendor!.vendorId, name: row.truck.vendor!.vendorName }) : undefined}
              onOpen={() => openTruck(row)}
              onNavigate={(to, params) => void navigate({ to, params })}
            />
          )}
        />
      </div>
      {renamingVendor ? (
        <RenameVendorDialog open vendorId={renamingVendor.id} vendorName={renamingVendor.name} onClose={() => setRenamingVendor(null)} />
      ) : null}
      {editingPercent?.truck.vendor ? (
        <EditVendorPercentDialog
          open
          truckId={editingPercent.truck.id}
          unitNumber={editingPercent.truck.unitNumber}
          vendorName={editingPercent.truck.vendor.vendorName}
          currentPercent={editingPercent.truck.vendor.companyPercent}
          updatedAt={editingPercent.truck.updatedAt}
          onClose={() => setEditingPercent(null)}
        />
      ) : null}
      <Modal
        open={adding}
        onOpenChange={setAdding}
        size="lg"
        title="Add truck"
        description="Register a power unit so it can be dispatched, maintained and tracked."
      >
        <TruckForm
          onCancel={() => setAdding(false)}
          onCreated={(truck) => {
            setAdding(false);
            void navigate({ to: '/fleet/trucks/$truckId', params: { truckId: truck.id } });
          }}
        />
      </Modal>
    </div>
  );
}

function parseIdCount(ids: string): number {
  return ids.split(',').filter(Boolean).length;
}

/**
 * The actions a unit offers depend on what it is doing.
 *
 * An available truck can be dispatched; one in a shop cannot, and offering "Assign load" on it
 * would be a button that exists only to be refused.
 */
function TruckRowActions({
  row,
  onOpen,
  onNavigate,
  onEditPercent,
  onRenameVendor,
}: {
  row: FleetTruck;
  onOpen: () => void;
  /** A vendor truck (owner, 2026-10-28): change what the company keeps. */
  onEditPercent?: () => void;
  /** A vendor truck (owner, 2026-10-30): correct the vendor's name. */
  onRenameVendor?: () => void;
  onNavigate: (to: string, params: Record<string, string>) => void;
}) {
  const availability = row.availability.availability;
  return (
    <>
      <MenuItem icon={<ExternalLink />} onSelect={onOpen}>
        Open unit
      </MenuItem>
      {availability === 'available' ? (
        <MenuItem icon={<Link2 />} onSelect={onOpen}>
          Assign driver or trailer
        </MenuItem>
      ) : null}
      {availability === 'in_transit' || availability === 'assigned' ? (
        <MenuItem icon={<Link2 />} onSelect={onOpen}>
          View current assignment
        </MenuItem>
      ) : null}
      {onEditPercent ? (
        <MenuItem icon={<Percent />} onSelect={onEditPercent}>
          Edit percentage
        </MenuItem>
      ) : null}
      {onRenameVendor ? (
        <MenuItem icon={<Pencil />} onSelect={onRenameVendor}>
          Edit vendor name
        </MenuItem>
      ) : null}
      <MenuSeparator />
      <MenuItem
        icon={<CalendarClock />}
        onSelect={() => onNavigate('/fleet/trucks/$truckId', { truckId: row.truck.id })}
      >
        Schedule maintenance
      </MenuItem>
      {row.openWorkOrders.length > 0 ? (
        <MenuItem
          icon={<Wrench />}
          onSelect={() => onNavigate('/fleet/trucks/$truckId', { truckId: row.truck.id })}
        >
          {row.openWorkOrders.length === 1
            ? 'Open work order'
            : `${formatNumber(row.openWorkOrders.length)} open work orders`}
        </MenuItem>
      ) : null}
    </>
  );
}
