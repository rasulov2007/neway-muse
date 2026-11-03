import { listTerminations } from '@/demo';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  AlertTriangle,
  Home,
  ListFilter,
  Plus,
  ShieldAlert,
  Truck,
  Unlink,
  User,
  UserPlus,
  Users,
  type LucideIcon,
} from 'lucide-react';
import type { DriverAvailability } from '@neway/shared';
import { useMemo, useState, type ReactNode } from 'react';
import {
  Avatar,
  Badge,
  Button,
  Card,
  DataTable,
  ErrorState,
  FilterBar,
  MenuItem,
  Modal,
  PageHeader,
  Popover,
  PopoverContent,
  PopoverTrigger,
  Select,
  Skeleton,
  StatTile,
  Tabs,
  createColumns,
  useDataTableState,
  type StatusTone,
} from '@/design-system';
import { formatMoney, formatNumber } from '@/lib/format';
import { DriverForm } from './DriverFormPage';
import { DriverDrawer } from './DriverDrawer';
import { driversSearchSchema, type DriversSearch } from './drivers-search';
import { DASH, DRIVER_AVAILABILITY_LABEL, DRIVER_AVAILABILITY_TONE } from './operations-ui';
import { ArchivedDriversTab } from './ArchivedDriversTab';
import { TerminatedDriversTab } from './TerminatedDriversTab';
import { useOperations, type OperationalDriver } from './useOperations';
import { PairDriverModal, TeamBadge, UnpairDriverModal } from './DriverTeam';
import { teamsByDriver, useCanManageTeams, useDriverTeams } from './team-api';

/**
 * The states worth a tile, in the order a dispatcher reads them: who is working, then who cannot
 * run at all. The roster totals (all drivers, inactive drivers) are rendered ahead of them. The
 * remaining states stay valid URL filters via the schema even without a tile.
 */
const TILE_STATES: ReadonlyArray<{
  key: DriverAvailability;
  icon: LucideIcon;
  tone: StatusTone | 'primary';
}> = [
  { key: 'driving', icon: Truck, tone: 'success' },
  { key: 'off_duty', icon: Home, tone: 'info' },
  { key: 'compliance_hold', icon: ShieldAlert, tone: 'warning' },
  { key: 'safety_hold', icon: AlertTriangle, tone: 'danger' },
];

/** The availability states offered as a filter: every tile, plus the rest of the vocabulary. */
const AVAILABILITY_OPTIONS = (
  [
    'available',
    'assigned',
    'driving',
    'at_pickup',
    'at_delivery',
    'off_duty',
    'home_time',
    'compliance_hold',
    'safety_hold',
    'inactive',
  ] as const satisfies readonly DriverAvailability[]
).map((value) => ({ value, label: DRIVER_AVAILABILITY_LABEL[value] }));

function matches(haystack: Array<string | null | undefined>, needle: string): boolean {
  const q = needle.trim().toLowerCase();
  if (!q) return true;
  return haystack.some((value) => value && value.toLowerCase().includes(q));
}

/**
 * A money or percentage figure that may be unknown.
 *
 * `null` means the loads behind it could not be priced, which is not the same answer as `$0`, so it
 * is rendered as a stated gap with the engine's own reasons in the title.
 */
function Figure({
  value,
  format,
  reasons,
}: {
  value: number | null;
  format: (value: number) => ReactNode;
  reasons: string[];
}) {
  if (value === null) {
    return (
      <span
        className="text-faint"
        title={
          reasons.length > 0
            ? `Insufficient data: ${reasons.join(' · ')}`
            : 'Insufficient data: no priced loads for this driver yet'
        }
      >
        {DASH}
      </span>
    );
  }
  return <>{format(value)}</>;
}

/**
 * The driver operating layer: every driver, whether they can take freight right now, and what their
 * work has earned. Availability and compliance are read from the operations bundle rather than
 * re-derived here, so this page and the safety desk cannot disagree about the same driver.
 */
export function DriversPage() {
  // Hiring happens over the roster: the list stays put, and there is nothing to come back from.
  const [adding, setAdding] = useState(false);
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => driversSearchSchema.parse(rawSearch), [rawSearch]);
  const query = useOperations();
  const [state, onStateChange] = useDataTableState();
  // Team or Solo (owner, 2026-10-25): read beside the bundle, so a refused read never blanks the list.
  const teams = useDriverTeams();
  const teamOf = useMemo(() => teamsByDriver(teams.data), [teams.data]);
  const canTeam = useCanManageTeams();
  const [teamDialog, setTeamDialog] = useState<{ mode: 'pair' | 'unpair'; row: OperationalDriver } | null>(null);

  function updateSearch(patch: Partial<DriversSearch>) {
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
  const drivers = useMemo(() => bundle?.drivers ?? [], [bundle]);
  const terminatedCount = useMemo(() => listTerminations().length, []);

  const counts = useMemo(() => {
    const map = new Map<DriverAvailability, number>();
    for (const row of drivers) {
      map.set(row.availability.state, (map.get(row.availability.state) ?? 0) + 1);
    }
    return map;
  }, [drivers]);

  const rows = useMemo(
    () =>
      drivers
        .filter((row) => !search.availability || row.availability.state === search.availability)
        .filter((row) =>
          matches(
            [row.driver.name, row.driver.driverNumber, row.driver.currentTruckUnit],
            search.q ?? '',
          ),
        ),
    [drivers, search.availability, search.q],
  );

  // The drawer takes an already-resolved row, so a `?driver=` pointing at nothing simply stays shut.
  const openDriver = search.driver ? (bundle?.byDriverId.get(search.driver) ?? null) : null;

  const col = createColumns<OperationalDriver>();
  const columns = col.columns([
    col.accessor((row) => row.driver.name, {
      id: 'name',
      header: 'Driver',
      meta: { primary: true, width: 220 },
      cell: ({ row }) => (
        <span className="flex min-w-0 items-center gap-2.5">
          <Avatar
            name={row.original.driver.name}
            size="sm"
            className="bg-primary-soft text-primary-text"
          />
          <span className="truncate font-medium text-ink">{row.original.driver.name}</span>
        </span>
      ),
    }),
    col.display({
      id: 'availability',
      header: 'Availability',
      cell: ({ row }) => (
        <span title={row.original.availability.reasons.join(' · ')}>
          <Badge dot tone={DRIVER_AVAILABILITY_TONE[row.original.availability.state]}>
            {DRIVER_AVAILABILITY_LABEL[row.original.availability.state]}
          </Badge>
        </span>
      ),
    }),
    col.display({
      id: 'team',
      header: 'Team',
      meta: { width: 200 },
      cell: ({ row }) =>
        teams.isError ? (
          <span className="text-xs text-nw-text-3" title="Team pairings could not be loaded">Not available</span>
        ) : (
          <TeamBadge team={teamOf.get(row.original.driver.id) ?? null} pending={teams.isPending} />
        ),
    }),
    col.display({
      id: 'load',
      header: 'Current load',
      cell: ({ row }) =>
        row.original.currentLoad ? (
          <Link
            to="/loads/$loadNumber"
            params={{ loadNumber: row.original.currentLoad.loadNumber }}
            className="font-medium text-primary-text hover:underline"
          >
            {row.original.currentLoad.loadNumber}
          </Link>
        ) : (
          <span className="text-faint">{DASH}</span>
        ),
    }),
    col.display({
      id: 'unit',
      header: 'Unit',
      cell: ({ row }) =>
        row.original.driver.currentTruckUnit ?? <span className="text-faint">{DASH}</span>,
    }),
    col.display({
      id: 'compliance',
      header: 'Compliance',
      cell: ({ row }) => {
        const compliance = row.original.compliance;
        // No compliance record is a gap, not a pass; it must not read as "Clear".
        if (!compliance) return <span className="text-faint">{DASH}</span>;
        return compliance.dispatchable ? (
          <Badge tone="success" variant="outline">
            Clear
          </Badge>
        ) : (
          <span title={compliance.gateReasons.join(' · ')}>
            <Badge tone="danger" variant="outline">
              Held
            </Badge>
          </span>
        );
      },
    }),
    col.display({
      id: 'loads',
      header: 'Loads',
      meta: { align: 'right' },
      cell: ({ row }) => formatNumber(row.original.performance.counts.total),
    }),
    col.display({
      id: 'revenue',
      header: 'Revenue',
      meta: { align: 'right' },
      cell: ({ row }) => (
        <Figure
          value={row.original.performance.revenue}
          format={formatMoney}
          reasons={row.original.performance.reasons}
        />
      ),
    }),
    col.display({
      id: 'rptm',
      header: 'Rev / total mi',
      meta: { align: 'right' },
      cell: ({ row }) => (
        <Figure
          value={row.original.performance.revenuePerTotalMile}
          format={formatMoney}
          reasons={row.original.performance.reasons}
        />
      ),
    }),
    col.display({
      id: 'profit',
      header: 'Profit',
      meta: { align: 'right' },
      cell: ({ row }) => (
        <Figure
          value={row.original.performance.profit}
          format={formatMoney}
          reasons={row.original.performance.reasons}
        />
      ),
    }),
    col.display({
      id: 'margin',
      header: 'Margin',
      meta: { align: 'right' },
      cell: ({ row }) => (
        <Figure
          value={row.original.performance.marginPct}
          format={(value) => `${value}%`}
          reasons={row.original.performance.reasons}
        />
      ),
    }),
  ]);

  const availabilitySelect = (
    <Select
      size="sm"
      aria-label="Availability"
      placeholder="Availability"
      options={[{ value: '', label: 'Any availability' }, ...AVAILABILITY_OPTIONS]}
      value={search.availability ?? ''}
      onValueChange={(value) =>
        updateSearch({
          availability: (value || undefined) as DriverAvailability | undefined,
          driver: undefined,
        })
      }
      className="w-44"
    />
  );

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader title="Drivers" description="Availability, assignments and driver performance." />

      <Tabs
        items={[
          { value: 'active', label: 'On the roster', count: bundle ? drivers.length : undefined },
          { value: 'terminated', label: 'Terminated', count: terminatedCount },
          {
            value: 'archived',
            label: 'Archived',
            count: bundle ? bundle.archivedDrivers.length : undefined,
          },
        ]}
        value={search.tab ?? 'active'}
        onValueChange={(value: string) =>
          updateSearch({
            tab: value === 'terminated' || value === 'archived' ? value : undefined,
            driver: undefined,
          })
        }
        aria-label="Driver register"
      />

      {search.tab === 'terminated' ? (
        <TerminatedDriversTab onBackToRoster={() => updateSearch({ tab: undefined })} />
      ) : search.tab === 'archived' && bundle ? (
        <ArchivedDriversTab
          drivers={bundle.archivedDrivers}
          onBackToRoster={() => updateSearch({ tab: undefined })}
        />
      ) : query.isPending ? (
        <DriversSkeleton />
      ) : query.isError ? (
        <ErrorState
          title="Drivers could not be loaded"
          description="Please try again."
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : (
        <>
          {/* Every tile is a filter: the number it shows is the number of rows it opens. */}
          <div
            role="group"
            aria-label="Availability"
            className="flex flex-wrap gap-3 [&>*]:min-w-40 [&>*]:flex-1"
          >
            <StatTile
              label="Total drivers"
              value={formatNumber(drivers.length)}
              icon={<Users />}
              tone="primary"
              pressed={!search.availability}
              onClick={() => updateSearch({ availability: undefined, driver: undefined })}
            />
            <StatTile
              label="Inactive drivers"
              value={formatNumber(counts.get('inactive') ?? 0)}
              icon={<User />}
              tone="neutral"
              pressed={search.availability === 'inactive'}
              onClick={() =>
                updateSearch({
                  availability: search.availability === 'inactive' ? undefined : 'inactive',
                  driver: undefined,
                })
              }
            />
            {TILE_STATES.map((tile) => {
              const Icon = tile.icon;
              const active = search.availability === tile.key;
              return (
                <StatTile
                  key={tile.key}
                  label={DRIVER_AVAILABILITY_LABEL[tile.key]}
                  value={formatNumber(counts.get(tile.key) ?? 0)}
                  icon={<Icon />}
                  tone={tile.tone}
                  pressed={active}
                  onClick={() =>
                    updateSearch({
                      availability: active ? undefined : tile.key,
                      driver: undefined,
                    })
                  }
                />
              );
            })}
          </div>

          <DataTable
            columns={columns}
            data={rows}
            rowKey={(row) => row.driver.id}
            state={state}
            onStateChange={onStateChange}
            stickyHeader
            caption="Drivers with operational availability, compliance standing and total-mile economics"
            emptyTitle="No drivers match"
            emptyDescription="Clear the filter or widen the search."
            onRowClick={(row) =>
              void navigate({ to: '/drivers/$driverId', params: { driverId: row.driver.id } })
            }
            rowActions={
              canTeam && teams.isSuccess
                ? (row) =>
                    teamOf.has(row.driver.id) ? (
                      <MenuItem icon={<Unlink />} onSelect={() => setTeamDialog({ mode: 'unpair', row })}>
                        Unpair
                      </MenuItem>
                    ) : (
                      <MenuItem icon={<UserPlus />} onSelect={() => setTeamDialog({ mode: 'pair', row })}>
                        Pair
                      </MenuItem>
                    )
                : undefined
            }
            toolbar={
              <FilterBar
                search={{
                  value: search.q ?? '',
                  onChange: (q) => updateSearch({ q: q || undefined }),
                  placeholder: 'Search driver, driver # or unit',
                }}
                values={{}}
                onChange={() => {}}
                onClear={() => updateSearch({ q: undefined })}
              >
                <Button variant="primary" size="sm" icon={<Plus />} onClick={() => setAdding(true)}>
                  Add driver
                </Button>
                {availabilitySelect}
                <Popover>
                  <PopoverTrigger asChild>
                    <Button variant="secondary" size="sm" icon={<ListFilter />}>
                      Filters{search.availability ? ' · 1' : ''}
                    </Button>
                  </PopoverTrigger>
                  <PopoverContent align="start" className="flex w-64 flex-col gap-3">
                    <label className="flex flex-col gap-1 text-xs font-medium text-muted">
                      Availability
                      {availabilitySelect}
                    </label>
                    {search.availability ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => updateSearch({ availability: undefined, driver: undefined })}
                      >
                        Clear filters
                      </Button>
                    ) : null}
                  </PopoverContent>
                </Popover>
              </FilterBar>
            }
          />
        </>
      )}

      {adding ? (
        <Modal
          open
          onOpenChange={(next) => !next && setAdding(false)}
          size="lg"
          title="Add driver"
          description="Identity, licence and pay. Safety collects the documents next."
        >
          <DriverForm
            onCancel={() => setAdding(false)}
            onCreated={(driverId) => {
              setAdding(false);
              updateSearch({ driver: driverId });
            }}
          />
        </Modal>
      ) : null}

      {teamDialog?.mode === 'pair' ? (
        <PairDriverModal
          driverId={teamDialog.row.driver.id}
          driverName={teamDialog.row.driver.name}
          drivers={drivers.map((r) => r.driver)}
          pairedIds={new Set(teamOf.keys())}
          onClose={() => setTeamDialog(null)}
        />
      ) : null}
      {teamDialog?.mode === 'unpair' && teamOf.get(teamDialog.row.driver.id) ? (
        <UnpairDriverModal
          driverId={teamDialog.row.driver.id}
          driverName={teamDialog.row.driver.name}
          team={teamOf.get(teamDialog.row.driver.id)!}
          onClose={() => setTeamDialog(null)}
        />
      ) : null}

      <DriverDrawer driver={openDriver} onClose={() => updateSearch({ driver: undefined })} />
    </div>
  );
}

function DriversSkeleton() {
  return (
    <div role="status" aria-label="Loading drivers" className="flex flex-col gap-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-6">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
      <Card padding="md">
        <Skeleton variant="text" lines={8} />
      </Card>
    </div>
  );
}
