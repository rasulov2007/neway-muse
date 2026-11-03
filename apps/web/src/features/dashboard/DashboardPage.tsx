import { useQuery } from '@tanstack/react-query';
import { Minimize2, MonitorPlay, RefreshCw, SlidersHorizontal } from 'lucide-react';
import { useDisplayMode } from '@/app/shell/display-mode';
import { useEffect, useState } from 'react';
import { Badge, Button, IconButton, PageHeader, Select, useToast } from '@/design-system';
import { demoCompany, getDashboard } from '@/demo';
import {
  DEMO_ROLES,
  fetchDispatchPerformance,
  fetchFuel,
  fetchOpsNet,
  fetchVendors,
  fetchOverview,
  fetchTrends,
  type DemoRole,
} from '@/lib/dashboard-api';
import { formatRelative } from '@/lib/format';
import { DrilldownDrawer } from './drilldown/DrilldownDrawer';
import type { DrilldownRequest } from './drilldown/types';
import { PeriodSelector } from './period/PeriodSelector';
import { usePeriod } from './period/usePeriod';
import { useDashboardSection } from './queries';
import { FULL_VISIBILITY, visibilityOf } from './visibility';
import { AtRiskLoadsWidget } from './widgets/AtRiskLoadsWidget';
import { ClaimsWidget } from './widgets/ClaimsWidget';
import { DispatchWidget, DispatchWidgetSkeleton } from './widgets/DispatchWidget';
import { ExecutiveKpiStrip, ExecutiveKpiStripSkeleton } from './widgets/ExecutiveKpiStrip';
import { FuelByStateWidget, FuelByStateWidgetSkeleton } from './widgets/FuelByStateWidget';
import { FuelWidget, FuelWidgetSkeleton } from './widgets/FuelWidget';
import { OpsNetWidget, OpsNetWidgetSkeleton } from './widgets/OpsNetWidget';
import { VendorTrucksWidget } from './widgets/VendorTrucksWidget';
import { TrendWidget, TrendWidgetSkeleton } from './widgets/TrendWidget';
import { TruckPnlWidget } from './widgets/TruckPnlWidget';
import { QueryBoundary, SectionHeading } from './widgets/WidgetFrame';

const ROLE_OPTIONS = DEMO_ROLES.map((role) => ({
  value: role,
  label: role.charAt(0).toUpperCase() + role.slice(1),
}));

const twoThirds = 'grid grid-cols-1 gap-4 xl:grid-cols-3';

/** Company dashboard: one page of independent widgets in docs/DASHBOARD.md §13 order. */
export function DashboardPage() {
  const period = usePeriod();
  const { toast } = useToast();
  const [drilldown, setDrilldown] = useState<DrilldownRequest | null>(null);
  const display = useDisplayMode();

  const overview = useDashboardSection('overview', period, fetchOverview);
  const trends = useDashboardSection('trends', period, fetchTrends);
  const opsNet = useDashboardSection('ops-net', period, fetchOpsNet);
  const vendors = useDashboardSection('vendors', period, fetchVendors);
  const dispatch = useDashboardSection('dispatch', period, fetchDispatchPerformance);
  const fuel = useDashboardSection('fuel', period, fetchFuel);
  // At-risk loads still come from the Phase 2 demo API until dispatch ships in Phase 5.
  const demo = useQuery({ queryKey: ['dashboard', 'demo-lists'], queryFn: () => getDashboard() });

  const resolved = overview.data?.meta.period;
  const isDemo = overview.data?.meta.source === 'demo';
  const fetching = [overview, trends, opsNet, dispatch, fuel].some((q) => q.isFetching);
  const refetchAll = () => {
    for (const q of [overview, trends, opsNet, dispatch, fuel]) void q.refetch();
  };
  // The resolved range is stated once, on the Executive overview heading, so the page header and
  // the period selector do not repeat it.
  const periodNote = resolved ? (
    <span data-testid="period-labels">
      <span className="text-secondary">{resolved.label}</span> · vs {resolved.comparison.label}
      {resolved.isComplete ? null : ' · Period in progress'}
    </span>
  ) : undefined;

  const overviewVisibility = overview.data
    ? visibilityOf(overview.data.financial.gross.masked)
    : FULL_VISIBILITY;

  return (
    // `page-surface-workspace` tells the shell's <main> to paint the analytics ground (tokens.css).
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Dashboard"
        description={demoCompany.name || undefined}
        meta={
          <>
            {isDemo ? (
              <Badge tone="neutral" variant="outline" size="sm">
                Demo data
              </Badge>
            ) : null}
            <UpdatedAt at={overview.dataUpdatedAt} fetching={fetching} />
            {import.meta.env.DEV ? (
              <label className="inline-flex items-center gap-1.5 text-xs text-muted">
                Demo role
                <Select
                  size="sm"
                  aria-label="Demo role"
                  options={ROLE_OPTIONS}
                  value={period.role}
                  onValueChange={(value) => period.setRole(value as DemoRole)}
                  className="w-32"
                />
              </label>
            ) : null}
          </>
        }
        actions={
          <>
            <PeriodSelector period={period} />
            <IconButton label="Refresh" variant="secondary" loading={fetching} onClick={refetchAll}>
              <RefreshCw />
            </IconButton>
            {display.on ? (
              <Button variant="primary" icon={<Minimize2 />} onClick={display.exit} data-testid="display-exit">
                Exit display mode
              </Button>
            ) : (
              <Button variant="secondary" icon={<MonitorPlay />} onClick={display.enter} data-testid="display-enter">
                Display mode
              </Button>
            )}
            <Button
              variant="secondary"
              icon={<SlidersHorizontal />}
              onClick={() =>
                toast({ tone: 'info', title: 'Dashboard customization arrives in a later phase' })
              }
            >
              Customize
            </Button>
          </>
        }
      />

      <section aria-labelledby="sec-executive" className="flex flex-col gap-3">
        <SectionHeading id="sec-executive" label="Executive overview" note={periodNote} />
        <QueryBoundary
          query={overview}
          skeleton={<ExecutiveKpiStripSkeleton />}
          errorTitle="Unable to load the executive overview"
        >
          {(data) => (
            <ExecutiveKpiStrip
              overview={data}
              visibility={overviewVisibility}
              onDrilldown={(metric) => setDrilldown({ kind: 'metric', metric })}
            />
          )}
        </QueryBoundary>
      </section>

      <section aria-labelledby="sec-trend" className="flex flex-col gap-3">
        <SectionHeading id="sec-trend" label="8-week performance" />
        <QueryBoundary
          query={trends}
          skeleton={<TrendWidgetSkeleton />}
          errorTitle="Unable to load the 8-week trend"
        >
          {(data) => <TrendWidget trends={data} visibility={visibilityOf(data.masked)} />}
        </QueryBoundary>
      </section>

      <section aria-labelledby="sec-economics" className="flex flex-col gap-3">
        <SectionHeading id="sec-economics" label="Operating economics" />
        <TruckPnlWidget period={period} />
      </section>

      <section aria-labelledby="sec-operations" className="flex flex-col gap-3">
        <SectionHeading id="sec-operations" label="Operations" />
        <div className={twoThirds}>
          <div className="min-w-0 xl:col-span-2">
            <QueryBoundary
              query={dispatch}
              skeleton={<DispatchWidgetSkeleton />}
              errorTitle="Unable to load dispatch performance"
              isEmpty={(data) => data.teams.length === 0}
              empty={{ title: 'No dispatch teams', description: 'No team delivered a load.' }}
            >
              {(data) => <DispatchWidget dispatch={data} visibility={visibilityOf(data.masked)} />}
            </QueryBoundary>
          </div>
          <QueryBoundary query={demo} errorTitle="Unable to load at-risk loads">
            {(data) => <AtRiskLoadsWidget loads={data.atRiskLoads} now={data.kpis.asOf} />}
          </QueryBoundary>
        </div>
      </section>

      <section aria-labelledby="sec-claims" className="flex flex-col gap-3">
        <SectionHeading id="sec-claims" label="Insurance claims" />
        <ClaimsWidget />
      </section>

      <section aria-labelledby="sec-fleet" className="flex flex-col gap-3">
        <SectionHeading id="sec-fleet" label="Fleet economics" />
        <div className={twoThirds}>
          <div className="min-w-0 xl:col-span-2">
            <QueryBoundary
              query={fuel}
              skeleton={<FuelWidgetSkeleton />}
              errorTitle="Unable to load fuel analytics"
            >
              {(data) => (
                <FuelWidget
                  fuel={data}
                  visibility={visibilityOf(data.masked)}
                  onDrilldown={setDrilldown}
                />
              )}
            </QueryBoundary>
          </div>
          <QueryBoundary
            query={fuel}
            skeleton={<FuelByStateWidgetSkeleton />}
            errorTitle="Unable to load fuel by state"
          >
            {(data) => <FuelByStateWidget fuel={data} visibility={visibilityOf(data.masked)} />}
          </QueryBoundary>
        </div>
      </section>

      {/* Vendor trucks (owner, 2026-10-28): the company share is already in revenue and profit;
          here it sits beside the vendor's side, truck by truck. */}
      <section aria-labelledby="sec-vendors" className="flex flex-col gap-3">
        <SectionHeading id="sec-vendors" label="Vendor trucks" />
        <QueryBoundary query={vendors} errorTitle="Unable to load vendor trucks">
          {(data) => <VendorTrucksWidget summary={data} masked={data.masked} />}
        </QueryBoundary>
      </section>

      {/* The deepest table on the page: the full chart of accounts split by driver pay type. It
          sits last, after the operating sections it summarises, and spans the full width. */}
      <section aria-labelledby="sec-driver-type" className="flex flex-col gap-3">
        <SectionHeading id="sec-driver-type" label="Driver type detail" />
        <QueryBoundary
          query={opsNet}
          skeleton={<OpsNetWidgetSkeleton />}
          errorTitle="Unable to load the driver type detail"
        >
          {(data) => (
            <OpsNetWidget
              opsNet={data}
              visibility={visibilityOf(data.masked)}
              onDrilldown={setDrilldown}
            />
          )}
        </QueryBoundary>
      </section>

      {display.on ? (
        // Always within reach on a wall screen, wherever the page is scrolled.
        <Button variant="secondary" size="sm" icon={<Minimize2 />} onClick={display.exit} className="fixed right-4 bottom-4 z-30 shadow-menu" data-testid="display-exit-float">
          Exit (Esc)
        </Button>
      ) : null}
      <DrilldownDrawer period={period} request={drilldown} onClose={() => setDrilldown(null)} />
    </div>
  );
}

const TICK_MS = 30_000;

/** "Updated 2 min ago", re-evaluated every 30 s so it stays honest. */
function UpdatedAt({ at, fetching }: { at: number; fetching: boolean }) {
  // The clock is read only inside the effect (never during render) and stored as state.
  const [nowMs, setNowMs] = useState(0);
  useEffect(() => {
    const read = () => setNowMs(new Date().getTime());
    const id = window.setInterval(read, TICK_MS);
    read();
    return () => window.clearInterval(id);
  }, [at]);
  if (!at || !nowMs) return null;
  const age = nowMs - at;
  const label = fetching
    ? 'Updating…'
    : age < 60_000
      ? 'Updated just now'
      : `Updated ${formatRelative(at, { now: nowMs })}`;
  return (
    <span className="text-xs text-muted" aria-live="polite">
      {label}
    </span>
  );
}
