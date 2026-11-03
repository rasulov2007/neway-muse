import type { DashboardOverview, DrilldownMetric, MoneyMetric } from '@neway/shared';
import { CircleCheck, TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { Alert, KpiCard, KpiSkeleton, Tooltip, cn } from '@/design-system';
import { formatMoney } from '@/lib/format';
import {
  DASH,
  MASK,
  estimatedLabel,
  metricDeltaText,
  metricText,
  metricTitle,
  reasonLabel,
  type MetricKind,
} from '../metric';
import type { Visibility } from '../visibility';

export interface ExecutiveKpiStripProps {
  overview: DashboardOverview;
  visibility: Visibility;
  onDrilldown?: (metric: DrilldownMetric) => void;
}

interface MetricCardProps {
  label: string;
  metric: MoneyMetric;
  kind: MetricKind;
  positiveIsGood?: boolean;
  /** Extra line under the change (reconciliation indicator, estimate, inactive-truck loss). */
  extra?: ReactNode;
  onClick?: () => void;
  className?: string;
}

/**
 * One headline KpiCard driven entirely by the API metric: value, absolute change, reasons,
 * estimate, mask. The change is `metric.delta` rather than `metric.deltaPct`, so it still reads
 * when the previous period was a real zero and no percentage exists. The comparison period is
 * named once in the section heading, so no card repeats a "vs …" caption.
 */
export function MetricCard({
  label,
  metric,
  kind,
  positiveIsGood = true,
  extra,
  onClick,
  className,
}: MetricCardProps) {
  const value = metricText(metric, kind);
  const title = metricTitle(metric);
  const estimated = estimatedLabel(metric);
  const delta =
    metric.masked || metric.delta === null
      ? undefined
      : { value: metric.delta, text: metricDeltaText(metric, kind), positiveIsGood };
  const unavailable = value === DASH || value === MASK;
  const hint = (
    <span className="flex flex-wrap items-center gap-x-1.5">
      {unavailable ? (
        <span>
          {metric.masked ? 'Hidden for this role' : reasonLabel(metric.reasons[0] ?? 'unavailable')}
        </span>
      ) : delta ? null : (
        <span>{DASH} no comparison</span>
      )}
      {estimated ? <span className="text-warning-text">{estimated}</span> : null}
      {extra}
    </span>
  );
  return (
    <KpiCard
      variant="feature"
      label={label}
      value={value}
      delta={delta}
      hint={hint}
      title={title}
      aria-label={title ? `${label}: ${title}` : undefined}
      onClick={unavailable ? undefined : onClick}
      className={cn(unavailable && 'text-faint', className)}
      data-metric-state={metric.masked ? 'masked' : metric.value === null ? 'null' : 'value'}
    />
  );
}

function ReconciliationIndicator({
  reconciliation,
}: {
  reconciliation: DashboardOverview['reconciliation'];
}) {
  if (reconciliation.status === 'unavailable') return null;
  const ok = reconciliation.status === 'ok';
  const money = (v: number | null) => (v === null ? DASH : formatMoney(v));
  const content = (
    <span className="tabular">
      Dashboard {money(reconciliation.dashboardGross)} · Ledger {money(reconciliation.ledgerGross)}
      {' · '}Difference {money(reconciliation.difference)}
    </span>
  );
  return (
    <Tooltip content={content}>
      <span
        tabIndex={0}
        className={cn(
          'inline-flex items-center gap-0.5 rounded-xs font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
          ok ? 'text-success-text' : 'text-warning-text',
        )}
      >
        {ok ? (
          <CircleCheck aria-hidden className="size-3" />
        ) : (
          <TriangleAlert aria-hidden className="size-3" />
        )}
        {ok ? 'Reconciled' : 'Mismatch'}
      </span>
    </Tooltip>
  );
}

const row1 = 'grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4';
const row2 = 'grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-5';
const row3 = 'grid grid-cols-2 gap-4 md:grid-cols-3 xl:grid-cols-6';

/** Row 1 money, row 2 unit economics, row 3 fleet averages (docs/DASHBOARD.md §1 question 1). */
export function ExecutiveKpiStrip({ overview, visibility, onDrilldown }: ExecutiveKpiStripProps) {
  const { financial, unitEconomics, fleet, reconciliation, expenseCoverage, costMix } = overview;
  const mismatch = reconciliation.status === 'mismatch';
  const drill = (metric: DrilldownMetric) =>
    visibility.financial && onDrilldown ? () => onDrilldown(metric) : undefined;

  return (
    <div className="flex flex-col gap-4">
      {/* A reconciliation gap is real, but it is not a dashboard action: the remedy is in
          Accounting, and a warning banner here interrupts everyone who can only read the number.
          Stated as a footnote on the figure it qualifies, with the link to where it is fixed. */}
      {mismatch ? (
        <p className="tabular -mb-1 text-xs text-muted">
          Gross differs from the revenue ledger by {formatMoney(reconciliation.difference ?? 0)} for
          this period.{' '}
          <a href="/accounting" className="text-primary-text hover:underline">
            Reconcile in Accounting
          </a>
        </p>
      ) : null}
      {!expenseCoverage.hasData ? (
        <Alert
          tone="neutral"
          title="No expense data for this period"
          description={
            expenseCoverage.note ??
            `Cost, profit and margin are shown as ${DASH} until expenses are recorded (${reasonLabel('no_expense_data').toLowerCase()}).`
          }
        />
      ) : null}
      <div className={row1}>
        <MetricCard
          label="Gross"
          metric={financial.gross}
          kind="money"
          onClick={drill('gross')}
          extra={<ReconciliationIndicator reconciliation={reconciliation} />}
        />
        <MetricCard
          label="Cost"
          metric={financial.cost}
          kind="money"
          positiveIsGood={false}
          onClick={drill('cost')}
        />
        <MetricCard label="Operating profit" metric={financial.operatingProfit} kind="money" />
        <MetricCard
          label="Net operating profit"
          metric={financial.netOperatingProfit}
          kind="money"
          extra={
            financial.inactiveTruckLoss.value !== null && !financial.inactiveTruckLoss.masked ? (
              <span className="text-faint">
                after {formatMoney(financial.inactiveTruckLoss.value, { compact: true })} inactive
                loss
              </span>
            ) : undefined
          }
        />
      </div>
      {expenseCoverage.hasData && expenseCoverage.note ? (
        <p className="-mt-1 text-xs text-muted">{expenseCoverage.note}</p>
      ) : null}
      {/* The books and the projection are different claims. A reader deciding anything on this
          number needs to know which part Accounting has actually posted. */}
      {expenseCoverage.hasData && costMix ? (
        <p className="-mt-1 text-xs text-muted">
          {costMix.hasEstimates ? (
            <>
              Of this cost, {formatMoney(costMix.posted)} is posted by Accounting and{' '}
              {formatMoney(costMix.estimated)} is incurred but not yet posted.{' '}
            </>
          ) : (
            <>All of this cost is posted by Accounting. </>
          )}
          {costMix.unallocatedPosted !== 0 ? (
            <>
              {formatMoney(costMix.unallocatedPosted)} of it belongs to no truck, driver or load, so
              it is not in any per-truck figure.{' '}
            </>
          ) : null}
          {costMix.dateBasis}
        </p>
      ) : null}
      <div className={row2}>
        <MetricCard label="RPM" metric={unitEconomics.rpm} kind="rate" />
        <MetricCard label="CPM" metric={unitEconomics.cpm} kind="rate" positiveIsGood={false} />
        <MetricCard label="PPM" metric={unitEconomics.ppm} kind="rate" />
        <MetricCard label="Profit margin" metric={unitEconomics.marginPct} kind="percent" />
        <MetricCard label="Total miles" metric={unitEconomics.totalMiles} kind="miles" />
      </div>
      <div className={row3}>
        <MetricCard label="Active trucks" metric={fleet.activeTrucks} kind="number" />
        <MetricCard
          label="Inactive trucks"
          metric={fleet.inactiveTrucks}
          kind="number"
          positiveIsGood={false}
        />
        <MetricCard label="Avg gross / truck" metric={fleet.avgGrossPerTruck} kind="money" />
        <MetricCard
          label="Avg cost / truck"
          metric={fleet.avgCostPerTruck}
          kind="money"
          positiveIsGood={false}
        />
        <MetricCard label="Avg profit / truck" metric={fleet.avgProfitPerTruck} kind="money" />
        <MetricCard label="Avg miles / truck" metric={fleet.avgMilesPerTruck} kind="miles" />
      </div>
      {/* The "/ truck" labels above would otherwise hide which trucks the divisor counts. */}
      <p className="text-xs text-muted">
        Per-truck averages divide by the trucks that ran revenue in this period, not the whole
        fleet.
      </p>
    </div>
  );
}

export function ExecutiveKpiStripSkeleton() {
  return (
    <div className="flex flex-col gap-4" aria-busy>
      <div className={row1}>
        {Array.from({ length: 4 }).map((_, i) => (
          <KpiSkeleton key={i} />
        ))}
      </div>
      <div className={row2}>
        {Array.from({ length: 5 }).map((_, i) => (
          <KpiSkeleton key={i} />
        ))}
      </div>
      <div className={row3}>
        {Array.from({ length: 6 }).map((_, i) => (
          <KpiSkeleton key={i} />
        ))}
      </div>
    </div>
  );
}
