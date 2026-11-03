import { loadStatusLabel } from '@/features/loads/loads-search';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { useEffect, useMemo, useState } from 'react';
import { RefreshCw, Search, Truck, X } from 'lucide-react';
import {
  Badge,
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  SectionCard,
  Select,
  Skeleton,
  StatusBadge,
  cn,
} from '@/design-system';
import { formatNumber } from '@/lib/format';
import { hrefs, useGo } from '@/features/dashboard/links';
import { formatShortDateTime } from '@/features/loads/loadUtils';
import { FleetPositionMap, type MapUnit } from './FleetPositionMap';
import {
  DASH,
  RISK_LABEL,
  RISK_TONE,
  TRACKING_LABEL,
  TRACKING_TONE,
  TRUCK_AVAILABILITY_LABEL,
  TRUCK_AVAILABILITY_TONE,
} from './operations-ui';
import {
  FOCUS_LABEL,
  TRACKING_FOCUSES,
  trackingSearchSchema,
  type TrackingFocus,
  type TrackingSearch,
} from './tracking-search';
import {
  useOperations,
  type OperationalLoad,
  type OperationalTruck,
  type OperationsBundle,
} from './useOperations';

/**
 * Fleet and load visibility.
 *
 * The map answers "where is everything"; the panel answers "what is happening to this one". Both
 * read the same operations bundle as dispatch, so a unit that is held there is held here, with the
 * same stated reason.
 */
export function TrackingPage() {
  const navigate = useNavigate();
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => trackingSearchSchema.parse(rawSearch), [rawSearch]);
  const query = useOperations();

  function updateSearch(patch: Partial<TrackingSearch>) {
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

  return (
    /*
     * The map is the page, so it runs to the edges.
     *
     * The shell pads every page by `--page-padding`; here that padding is cancelled and the map
     * takes the whole height the topbar leaves. A live map inset in a card with a margin around it
     * reads as a picture of the fleet rather than the fleet.
     */
    /*
     * The negative margin is spelled out rather than `-m-(--page-padding)`: that token is a
     * three-value shorthand (20px 24px 24px), Tailwind compiles a negative margin to
     * `calc(var(--page-padding) * -1)`, and `calc()` cannot multiply a shorthand — the whole
     * declaration was dropped and the page kept its padding. They follow the token at each
     * width it takes (phone, tablet, laptop, 1920+; owner, 2026-10-15).
     */
    <div className="-mx-3 -mt-[14px] -mb-5 flex h-[calc(100dvh-var(--topbar-height))] flex-col sm:-mx-[18px] sm:-mt-[18px] sm:-mb-[22px] lg:-mx-6 lg:-mt-5 lg:-mb-6 min-[1920px]:-mx-8 min-[1920px]:-mt-6 min-[1920px]:-mb-8">
      {/*
       * No page heading. The sidebar already says which page this is, and a title bar over a live
       * map spends a strip of the screen restating it. Refresh moved onto the map itself, where
       * the rest of the map's own controls live.
       */}
      <h1 className="sr-only">Live map</h1>

      {query.isPending ? (
        <TrackingSkeleton />
      ) : query.isError ? (
        <ErrorState
          title="Tracking could not be loaded"
          description="Please try again."
          error={query.error}
          onRetry={() => void query.refetch()}
          retrying={query.isFetching}
        />
      ) : bundle ? (
        <TrackingBoard
          bundle={bundle}
          search={search}
          updateSearch={updateSearch}
          refreshing={query.isFetching && !query.isPending}
          onRefresh={() => void query.refetch()}
        />
      ) : null}
    </div>
  );
}

interface FocusSet {
  focus: TrackingFocus;
  truckIds: Set<string>;
  count: number;
}

/** Which units each focus selects. Built once so a tile's count and its filtered map agree. */
function buildFocusSets(bundle: OperationsBundle): FocusSet[] {
  const activeLoadTruckIds = new Set(
    bundle.loads
      .filter((row) => row.risk.state !== 'not_applicable' && row.load.truckId)
      .map((row) => row.load.truckId as string),
  );
  const atRiskTruckIds = new Set(
    bundle.loads
      .filter(
        (row) =>
          (row.risk.state === 'at_risk' || row.risk.state === 'critical') && row.load.truckId,
      )
      .map((row) => row.load.truckId as string),
  );
  const day = bundle.nowIso.slice(0, 10);
  const deliveredTodayTruckIds = new Set(
    bundle.loads
      .filter((row) => row.load.deliveredAt?.slice(0, 10) === day && row.load.truckId)
      .map((row) => row.load.truckId as string),
  );

  const ids = (rows: OperationalTruck[]) => new Set(rows.map((row) => row.truck.id));

  const sets: Record<TrackingFocus, Set<string>> = {
    active: activeLoadTruckIds,
    moving: ids(
      bundle.trucks.filter(
        (row) => activeLoadTruckIds.has(row.truck.id) && (row.truck.location?.speedMph ?? 0) > 0,
      ),
    ),
    stopped: ids(
      bundle.trucks.filter(
        (row) => activeLoadTruckIds.has(row.truck.id) && (row.truck.location?.speedMph ?? 0) === 0,
      ),
    ),
    at_risk: atRiskTruckIds,
    stale: ids(
      bundle.trucks.filter(
        (row) => row.tracking.state === 'stale' || row.tracking.state === 'offline',
      ),
    ),
    available: ids(bundle.trucks.filter((row) => row.availability.assignable)),
    delivered_today: deliveredTodayTruckIds,
  };

  return TRACKING_FOCUSES.map((focus) => ({
    focus,
    truckIds: sets[focus],
    count: sets[focus].size,
  }));
}

/** How each focus tile looks: the icon says what is counted, the tone says whether it is good. */

/** Rolling, idle or stopped: what the last position says the truck is doing right now. */
type Motion = 'rolling' | 'idle' | 'stopped';
const MOTION_LABEL: Record<Motion, string> = {
  rolling: 'Rolling',
  idle: 'Idle',
  stopped: 'Stopped',
};
const MOTION_DOT: Record<Motion, string> = {
  rolling: 'bg-nw-done-icon',
  idle: 'bg-nw-warning-icon',
  stopped: 'bg-nw-neutral-icon',
};

function motionOf(row: OperationalTruck): Motion {
  const loc = row.truck.location;
  if (!loc || row.tracking.state === 'none' || row.tracking.state === 'offline') return 'stopped';
  if (loc.speedMph >= 5) return 'rolling';
  if (loc.engineState === 'idle' || loc.engineState === 'on') return 'idle';
  return 'stopped';
}

/** "fix 3h old" - how stale the position is, said only when it is. */
function fixAge(row: OperationalTruck, nowIso: string): string | null {
  const loc = row.truck.location;
  if (!loc) return null;
  const hours = Math.floor((Date.parse(nowIso) - Date.parse(loc.updatedAt)) / 3_600_000);
  if (hours < 1) return null;
  return `fix ${hours}h old`;
}

type MotionFilter = 'all' | Motion;
type LoadFilter = 'all' | 'with' | 'without';

/**
 * The live map as the owner drew it (2026-09-22): the map fills the page, a panel on the right
 * carries the search, the status and load filters, the Rolling / Idle / Stopped counts and a
 * card per unit - unit and driver, its load, speed and location. Clicking a card or a marker
 * opens the unit's panel in the same place. Everything is read from the operations bundle;
 * nothing here is computed twice.
 */
function TrackingBoard({
  bundle,
  search,
  updateSearch,
  refreshing,
  onRefresh,
}: {
  bundle: OperationsBundle;
  search: TrackingSearch;
  updateSearch: (patch: Partial<TrackingSearch>) => void;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const focusSets = useMemo(() => buildFocusSets(bundle), [bundle]);
  const activeSet = focusSets.find((set) => set.focus === search.focus) ?? null;
  const [motion, setMotion] = useState<MotionFilter>('all');
  const [loads, setLoads] = useState<LoadFilter>('all');
  // Only the topbar is above it; everything else on the page is map.
  const mapHeight = useViewportHeight(56, 420);

  const loadByTruckId = useMemo(() => {
    const map = new Map<string, OperationalLoad>();
    for (const row of bundle.loads) {
      if (row.load.truckId && row.risk.state !== 'not_applicable') map.set(row.load.truckId, row);
    }
    return map;
  }, [bundle.loads]);

  const query = search.q?.trim().toLowerCase() ?? '';
  const visible = useMemo(
    () =>
      bundle.trucks
        .filter((row) => (activeSet ? activeSet.truckIds.has(row.truck.id) : true))
        .filter((row) => motion === 'all' || motionOf(row) === motion)
        .filter((row) => {
          if (loads === 'all') return true;
          const has = loadByTruckId.has(row.truck.id);
          return loads === 'with' ? has : !has;
        })
        .filter((row) => {
          if (!query) return true;
          const load = loadByTruckId.get(row.truck.id);
          return [
            row.truck.unitNumber,
            row.truck.currentDriverName,
            load?.load.loadNumber,
            load?.load.customerName,
            row.truck.location?.city,
          ].some((value) => value && value.toLowerCase().includes(query));
        })
        // Moving trucks first, then idling, then the parked and the unplaced; units in order within.
        .sort((x, y) => {
          const rank = (r: OperationalTruck) => ({ rolling: 0, idle: 1, stopped: 2 })[motionOf(r)];
          return (
            rank(x) - rank(y) ||
            Number(x.truck.location === null) - Number(y.truck.location === null) ||
            x.truck.unitNumber.localeCompare(y.truck.unitNumber, undefined, { numeric: true })
          );
        }),
    [bundle.trucks, activeSet, motion, loads, query, loadByTruckId],
  );
  const counts = useMemo(() => {
    const c: Record<Motion, number> = { rolling: 0, idle: 0, stopped: 0 };
    for (const row of bundle.trucks) c[motionOf(row)] += 1;
    return c;
  }, [bundle.trucks]);

  const positioned = visible.filter((row) => row.truck.location !== null);
  const units: MapUnit[] = positioned.map((row) => {
    const load = loadByTruckId.get(row.truck.id);
    const atRisk = load && (load.risk.state === 'at_risk' || load.risk.state === 'critical');
    const tone: MapUnit['tone'] = atRisk
      ? 'at_risk'
      : !row.availability.assignable && !load
        ? 'held'
        : row.tracking.state === 'stale' || row.tracking.state === 'offline'
          ? 'stale'
          : load
            ? 'active'
            : 'available';
    const location = row.truck.location!;
    return {
      id: row.truck.id,
      unitNumber: row.truck.unitNumber,
      lat: location.lat,
      lng: location.lng,
      city: location.city,
      state: location.state,
      tone,
      tracking: row.tracking.state,
      motion: motionOf(row),
      headingDegrees: location.headingDegrees ?? null,
      label: `Unit ${row.truck.unitNumber} · ${location.city}, ${location.state} · ${TRACKING_LABEL[row.tracking.state]}${load ? ` · ${load.load.loadNumber}` : ''}`,
    };
  });
  const unpositioned = visible.length - positioned.length;
  const selected = bundle.trucks.find((row) => row.truck.unitNumber === search.unit) ?? null;

  return (
    <section
      aria-label="Live map"
      className="grid min-h-0 flex-1 grid-cols-1 xl:grid-cols-[minmax(0,1fr)_380px]"
      style={{ height: mapHeight }}
    >
      <div className="relative min-h-0 min-w-0">
        {/* Beside the map's own layer button, which sits in the corner. */}
        <div className="absolute top-3 right-16 z-[1000] flex h-10 items-center gap-2">
          <Button
            size="sm"
            variant="secondary"
            icon={<RefreshCw />}
            loading={refreshing}
            onClick={onRefresh}
          >
            Refresh
          </Button>
        </div>
        <FleetPositionMap
          units={units}
          selectedUnit={search.unit}
          onSelect={(unitNumber) =>
            updateSearch({ unit: search.unit === unitNumber ? undefined : unitNumber })
          }
          unpositioned={unpositioned}
          height={mapHeight}
          showLegend={false}
          full
        />
      </div>

      <aside className="flex min-h-0 flex-col gap-2.5 overflow-hidden border-l border-nw-border bg-nw-panel p-3">
        <Input
          size="sm"
          type="search"
          prefix={<Search />}
          aria-label="Search unit, driver or load"
          placeholder="Search unit · driver · load…"
          value={search.q ?? ''}
          onChange={(event) => updateSearch({ q: event.target.value || undefined })}
        />
        <div className="grid grid-cols-2 gap-2">
          <Select
            size="sm"
            aria-label="Status"
            value={motion}
            onValueChange={(v) => setMotion(v as MotionFilter)}
            options={[
              { value: 'all', label: 'All statuses' },
              { value: 'rolling', label: 'Rolling' },
              { value: 'idle', label: 'Idle' },
              { value: 'stopped', label: 'Stopped' },
            ]}
          />
          <Select
            size="sm"
            aria-label="Loads"
            value={loads}
            onValueChange={(v) => setLoads(v as LoadFilter)}
            options={[
              { value: 'all', label: 'All loads' },
              { value: 'with', label: 'With a load' },
              { value: 'without', label: 'No load' },
            ]}
          />
        </div>
        <Select
          size="sm"
          aria-label="Show units"
          value={search.focus ?? 'all'}
          onValueChange={(v) =>
            updateSearch({ focus: v === 'all' ? undefined : (v as TrackingFocus) })
          }
          options={[
            { value: 'all', label: `All units · ${formatNumber(bundle.trucks.length)}` },
            ...focusSets.map((set) => ({
              value: set.focus,
              label: `${FOCUS_LABEL[set.focus]} · ${set.count}`,
            })),
          ]}
        />
        <p
          className="flex flex-wrap items-center gap-x-3 text-xs text-nw-text-2"
          aria-label="Motion counts"
        >
          {(['rolling', 'idle', 'stopped'] as const).map((m) => (
            <span key={m} className="inline-flex items-center gap-1.5">
              <span aria-hidden className={cn('size-2 rounded-full', MOTION_DOT[m])} />
              {MOTION_LABEL[m]}: <b className="font-bold text-nw-text">{counts[m]}</b>
            </span>
          ))}
          {unpositioned > 0 ? (
            <span className="text-nw-text-3">· {unpositioned} without a position</span>
          ) : null}
        </p>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {selected ? (
            <SelectedUnitPanel
              row={selected}
              load={loadByTruckId.get(selected.truck.id) ?? null}
              bundle={bundle}
              onClose={() => updateSearch({ unit: undefined })}
            />
          ) : visible.length === 0 ? (
            <EmptyState
              size="sm"
              title="No units match"
              description="Clear the filters or widen the search."
            />
          ) : (
            <ul className="flex flex-col gap-2.5" aria-label="Units">
              {visible.slice(0, 80).map((row) => (
                <UnitCard
                  key={row.truck.id}
                  row={row}
                  load={loadByTruckId.get(row.truck.id) ?? null}
                  nowIso={bundle.nowIso}
                  onSelect={() => updateSearch({ unit: row.truck.unitNumber })}
                />
              ))}
              {visible.length > 80 ? (
                <li className="py-2 text-center text-xs text-nw-text-3">
                  {visible.length - 80} more — narrow the search to see them.
                </li>
              ) : null}
            </ul>
          )}
        </div>
      </aside>
    </section>
  );
}

/** The page's height, so the map fills it; never below the floor. */
function useViewportHeight(reserve: number, floor: number): number {
  const read = () =>
    typeof window === 'undefined' ? floor : Math.max(floor, window.innerHeight - reserve);
  const [height, setHeight] = useState(read);
  useEffect(() => {
    const onResize = () => setHeight(read());
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  return height;
}

/** One unit on the panel: who and where, what it carries, how fast it is going. */
function UnitCard({
  row,
  load,
  nowIso,
  onSelect,
}: {
  row: OperationalTruck;
  load: OperationalLoad | null;
  nowIso: string;
  onSelect: () => void;
}) {
  const { truck } = row;
  const m = motionOf(row);
  const age = fixAge(row, nowIso);
  return (
    <li>
      <button
        type="button"
        onClick={onSelect}
        className="w-full rounded-[10px] border border-nw-border bg-nw-panel px-3 py-2.5 text-left hover:bg-nw-hover focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus"
      >
        <span className="flex items-center gap-2">
          <span aria-hidden className={cn('size-2 shrink-0 rounded-full', MOTION_DOT[m])} />
          <span className="text-[13.5px] font-bold text-nw-text">{truck.unitNumber}</span>
          <span className="min-w-0 flex-1 truncate text-[13px] text-nw-text-2">
            {truck.currentDriverName ?? 'No driver'}
          </span>
          {load ? (
            <Badge tone="info" size="sm">
              {load.load.loadNumber}
            </Badge>
          ) : (
            <Badge tone="neutral" size="sm">
              Unassigned
            </Badge>
          )}
        </span>
        <span className="mt-1.5 block text-xs text-nw-text-2">
          <b className="font-semibold text-nw-text">Speed:</b>{' '}
          {truck.location ? `${truck.location.speedMph.toFixed(1)} mph` : '—'}
          {truck.location?.engineState === 'idle' ? ' · engine idling' : ''}
        </span>
        <span className="block truncate text-xs text-nw-text-2">
          <b className="font-semibold text-nw-text">Location:</b>{' '}
          {truck.location
            ? `${truck.location.city}, ${truck.location.state}`
            : 'No position reported'}
        </span>
        {age ? (
          <span className="block text-[11px] text-nw-warning-text">
            {age} · {TRACKING_LABEL[row.tracking.state]}
          </span>
        ) : null}
      </button>
    </li>
  );
}

/** Minutes between the scheduled delivery and the current projection. Null when either is absent. */
function etaVariance(scheduled: string | null, current: string | null): number | null {
  if (!scheduled || !current) return null;
  const a = Date.parse(scheduled);
  const b = Date.parse(current);
  if (Number.isNaN(a) || Number.isNaN(b)) return null;
  return Math.round((b - a) / 60_000);
}

function SelectedUnitPanel({
  row,
  load,
  bundle,
  onClose,
}: {
  row: OperationalTruck;
  load: OperationalLoad | null;
  bundle: OperationsBundle;
  onClose: () => void;
}) {
  const go = useGo();
  const location = row.truck.location;
  const variance = load ? etaVariance(load.load.deliveryAt, load.load.etaAt) : null;
  const driver = load?.load.driverId ? bundle.byDriverId.get(load.load.driverId) : null;

  return (
    <SectionCard
      icon={<Truck />}
      padding="none"
      data-testid="selected-unit-panel"
      title={`Unit ${row.truck.unitNumber}`}
      description={row.truck.currentDriverName ?? 'No driver assigned'}
      actions={
        <Button variant="ghost" size="sm" icon={<X />} onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col divide-y divide-line-soft">
        <Section title="Status">
          <Row label="Availability">
            <span title={row.availability.reasons.join(' · ')}>
              <Badge tone={TRUCK_AVAILABILITY_TONE[row.availability.state]} size="sm">
                {TRUCK_AVAILABILITY_LABEL[row.availability.state]}
              </Badge>
            </span>
          </Row>
          <Row label="Tracking">
            <span title={row.tracking.reasons.join(' · ')}>
              <Badge tone={TRACKING_TONE[row.tracking.state]} size="sm">
                {TRACKING_LABEL[row.tracking.state]}
              </Badge>
            </span>
          </Row>
          <Row label="Last position">
            {location ? `${location.city}, ${location.state}` : 'Tracking unavailable'}
          </Row>
          <Row label="Last update">
            {row.tracking.ageMinutes === null
              ? 'Never reported'
              : `${formatNumber(row.tracking.ageMinutes)} min ago`}
          </Row>
          <Row label="Speed">{location ? `${formatNumber(location.speedMph)} mph` : DASH}</Row>
          {row.availability.blocker ? (
            <p className="px-4 pb-2 text-xs text-warning-text">{row.availability.blocker}</p>
          ) : null}
        </Section>

        {load ? (
          <>
            <Section title="Active load">
              <Row label="Load">
                <button
                  type="button"
                  className="text-primary-text hover:underline"
                  onClick={() => go(hrefs.load(load.load.loadNumber))}
                >
                  {load.load.loadNumber}
                </button>
              </Row>
              <Row label="Status">
                <StatusBadge
                  status={load.load.status}
                  label={loadStatusLabel(load.load.status)}
                  size="sm"
                />
              </Row>
              <Row label="Lane">
                {load.load.origin.city}, {load.load.origin.state} → {load.load.destination.city},{' '}
                {load.load.destination.state}
              </Row>
              <Row label="Risk">
                <span title={load.risk.reasons.join(' · ')}>
                  <Badge tone={RISK_TONE[load.risk.state]} size="sm">
                    {RISK_LABEL[load.risk.state]}
                  </Badge>
                </span>
              </Row>
            </Section>

            <Section title="ETA">
              <Row label="Scheduled">
                {load.load.deliveryAt ? formatShortDateTime(load.load.deliveryAt) : DASH}
              </Row>
              <Row label="Current">
                {load.load.etaAt ? formatShortDateTime(load.load.etaAt) : 'Not available'}
              </Row>
              <Row label="Variance">
                {variance === null ? (
                  <span
                    className="text-faint italic"
                    title="Needs both a scheduled delivery and a current ETA"
                  >
                    Insufficient data
                  </span>
                ) : (
                  <span className={variance > 0 ? 'text-danger-text' : 'text-success-text'}>
                    {variance > 0 ? '+' : ''}
                    {formatNumber(variance)} min
                  </span>
                )}
              </Row>
              {/* The engine states the cause where it can; it never guesses at traffic or weather. */}
              {load.risk.reasons.length > 0 ? (
                <ul className="flex flex-col gap-0.5 px-4 pb-2">
                  {load.risk.reasons.map((reason) => (
                    <li key={reason} className="text-xs text-muted">
                      {reason}
                    </li>
                  ))}
                </ul>
              ) : null}
            </Section>

            <Section title="Related">
              <Row label="Customer">
                {load.load.customerId ? (
                  <button
                    type="button"
                    className="text-primary-text hover:underline"
                    onClick={() => go(hrefs.customer(load.load.customerId))}
                  >
                    {load.load.customerName}
                  </button>
                ) : (
                  DASH
                )}
              </Row>
              <Row label="Broker">
                {load.load.brokerId ? (
                  <button
                    type="button"
                    className="text-primary-text hover:underline"
                    onClick={() => go(hrefs.broker(load.load.brokerId as string))}
                  >
                    {load.load.brokerName}
                  </button>
                ) : (
                  DASH
                )}
              </Row>
              <Row label="Driver">
                {driver ? (
                  <button
                    type="button"
                    className="text-primary-text hover:underline"
                    onClick={() => go(hrefs.driver(driver.driver.id))}
                  >
                    {driver.driver.name}
                  </button>
                ) : (
                  DASH
                )}
              </Row>
            </Section>
          </>
        ) : (
          <div className="px-4 py-3 text-sm text-muted">This unit is not carrying a load.</div>
        )}

        <div className="flex flex-wrap gap-2 p-4">
          <Button
            variant="secondary"
            size="sm"
            onClick={() => go(hrefs.truck(row.truck.unitNumber))}
          >
            Open unit
          </Button>
          <Button variant="secondary" size="sm" onClick={() => go(hrefs.maintenance)}>
            Maintenance
          </Button>
          {load ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={() => go(hrefs.load(load.load.loadNumber))}
            >
              Open load
            </Button>
          ) : null}
        </div>
      </div>
    </SectionCard>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="py-2">
      <p className="eyebrow px-4 pb-1">{title}</p>
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex items-start justify-between gap-3 px-4 py-1 text-sm">
      <span className="shrink-0 text-muted">{label}</span>
      <span className="min-w-0 text-right text-ink">{children}</span>
    </div>
  );
}

function TrackingSkeleton() {
  return (
    <div role="status" aria-label="Loading tracking" className="flex flex-col gap-4">
      <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-7">
        {Array.from({ length: 7 }).map((_, i) => (
          <Skeleton key={i} className="h-16 rounded-lg" />
        ))}
      </div>
      <div className="grid grid-cols-1 gap-4 xl:grid-cols-3">
        <Card padding="none" className="xl:col-span-2">
          <Skeleton className="h-96 rounded-lg" />
        </Card>
        <Card padding="none">
          <Skeleton className="h-96 rounded-lg" />
        </Card>
      </div>
    </div>
  );
}
