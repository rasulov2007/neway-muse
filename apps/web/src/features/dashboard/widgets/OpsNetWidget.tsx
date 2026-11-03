import type { DashboardOpsNet, OpsNetBucket, OpsNetTotals } from '@neway/shared';
import { ChartPie, EyeOff, TriangleAlert } from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import {
  Button,
  Card,
  CardSkeleton,
  DonutChart,
  EmptyState,
  SectionLabel,
  chartTheme,
  cn,
  type DonutSlice,
} from '@/design-system';
import { formatMoney, formatNumber, formatPercent } from '@/lib/format';
import type { DrilldownRequest } from '../drilldown/types';
import { DASH, MASK, formatKind, type MetricKind } from '../metric';
import type { Visibility } from '../visibility';

export interface OpsNetWidgetProps {
  opsNet: DashboardOpsNet;
  visibility: Visibility;
  onDrilldown?: (request: DrilldownRequest) => void;
}

const MINUS = '−';
const compactMoney = (value: number) => formatMoney(value, { compact: true });

/** How many untagged driver names the footnote lists before collapsing into "and N more". */
const MAX_NAMED_DRIVERS = 6;

/**
 * A P&L line: one table ROW, rendered across every pay-type column plus the Total column.
 *
 * `read` is `undefined` for the accounting lines the reference screenshot shows but our data
 * pipeline has no source for — those render "—" everywhere rather than a fabricated 0.
 */
interface Line {
  key: string;
  label: string;
  /** Reads the line out of a column; the Total column is a bucket without a `payType`. */
  read?: (bucket: OpsNetTotals) => number | null;
  /** Costs render negative and red; gross/profit render positive; units are not money. */
  tone: 'gross' | 'cost' | 'profit' | 'unit';
  /** Non-money lines format by kind and stay visible while money is masked. */
  kind?: MetricKind;
  /** A unit line that is still a money amount, so financial masking hides it. */
  sensitive?: boolean;
  /** Row emphasis: section header, subtotal, or the highlighted profit lines. */
  emphasis?: 'strong' | 'subtotal' | 'primary';
  /** Company-level lines carry a value in the Total column only. */
  companyOnly?: boolean;
  title?: string;
  /** Extra text under the amount, e.g. the estimated portion of driver pay. */
  sub?: (bucket: OpsNetTotals) => ReactNode;
}

/** `maintenance + repairs`; `null` only when the API has neither. */
function repairAndMaintenance(bucket: OpsNetTotals): number | null {
  const { maintenance, repairs } = bucket.costs;
  if (maintenance === null && repairs === null) return null;
  return (maintenance ?? 0) + (repairs ?? 0);
}

const NO_SOURCE_TITLE = 'No data source for this line yet';

function unsourced(key: string, label: string): Line {
  return { key, label, tone: 'cost', title: NO_SOURCE_TITLE };
}

/**
 * The chart of accounts, in the owner's reference order. Lines without a `read` are placeholders
 * for expense categories we do not yet ingest; the card caption explains the "—".
 */
const LINES: readonly Line[] = [
  { key: 'gross', label: 'Total gross', tone: 'gross', emphasis: 'strong', read: (b) => b.gross },
  {
    key: 'driver_pay',
    label: 'Driver gross pay',
    tone: 'cost',
    read: (b) => b.costs.driver_pay,
    sub: (b) =>
      b.driverPayEstimated !== null && b.driverPayEstimated > 0 ? (
        <span className="text-2xs text-warning-text">
          incl. {compactMoney(b.driverPayEstimated)} est.
        </span>
      ) : null,
  },
  unsourced('driver_other_pay', 'Driver other pay'),
  unsourced('vendor_gross_pay', 'Vendor gross pay'),
  { key: 'fuel', label: 'Fuel cost', tone: 'cost', read: (b) => b.costs.fuel },
  unsourced('truck_payment', 'Truck payment'),
  unsourced('trailer_payment', 'Trailer payment'),
  { key: 'insurance', label: 'Truck insurance', tone: 'cost', read: (b) => b.costs.insurance },
  { key: 'dispatch_fee', label: 'Dispatch fee', tone: 'cost', read: (b) => b.costs.dispatch_fee },
  { key: 'factoring', label: 'Factoring', tone: 'cost', read: (b) => b.costs.factoring },
  { key: 'tolls', label: 'Toll cost', tone: 'cost', read: (b) => b.costs.tolls },
  unsourced('eld_sam', 'ELD & SAM'),
  unsourced('ifta', 'IFTA'),
  unsourced('safety', 'Safety'),
  { key: 'staff_payroll', label: 'Staff payroll', tone: 'cost', read: (b) => b.costs.staff_payroll },
  unsourced('admin', 'Other admin cost'),
  {
    key: 'repair_maintenance',
    label: 'Repair & maintenance',
    tone: 'cost',
    read: repairAndMaintenance,
  },
  { key: 'other', label: 'Other expenses', tone: 'cost', read: (b) => b.costs.other },
  {
    key: 'total_cost',
    label: 'Total cost',
    tone: 'cost',
    emphasis: 'subtotal',
    read: (b) => b.totalCost,
  },
  {
    key: 'operating_profit',
    label: 'Operating profit',
    tone: 'profit',
    emphasis: 'primary',
    read: (b) => b.operatingProfit,
  },
  {
    key: 'inactive_truck_loss',
    label: 'Loss on inactive trucks',
    tone: 'cost',
    companyOnly: true,
    title: 'Company-level: an idle truck has no revenue to attribute it to a pay type',
  },
  {
    key: 'net_operating_profit',
    label: 'Net operating profit',
    tone: 'profit',
    emphasis: 'primary',
    companyOnly: true,
    title: 'Company-level: operating profit after the unattributable inactive-truck loss',
  },
  { key: 'rpm', label: 'RPM', tone: 'unit', kind: 'rate', sensitive: true, read: (b) => b.rpm },
  { key: 'miles', label: 'Total miles', tone: 'unit', kind: 'miles', read: (b) => b.totalMiles },
  {
    key: 'active_trucks',
    label: 'Active trucks',
    tone: 'unit',
    kind: 'number',
    read: (b) => b.activeTrucks,
  },
  {
    key: 'avg_gross_per_truck',
    label: 'Avg gross / truck',
    tone: 'unit',
    kind: 'money',
    sensitive: true,
    read: (b) => b.avgGrossPerTruck,
  },
  {
    key: 'avg_miles_per_truck',
    label: 'Avg miles / truck',
    tone: 'unit',
    kind: 'miles',
    read: (b) => b.avgMilesPerTruck,
  },
];

/** `−$98,600.99` for costs, `$4,120.00` otherwise; the sign is part of the reading, not a minus key. */
function moneyText(value: number, negate: boolean): string {
  const signed = negate ? -Math.abs(value) : value;
  return signed < 0 ? `${MINUS}${formatMoney(Math.abs(signed))}` : formatMoney(signed);
}

/**
 * Slices for the revenue donut: only buckets that actually earned gross, coloured by their fixed
 * position in the categorical series order so a bucket keeps its hue when another drops out.
 * `unknown` is deliberately neutral — it is a data-quality bucket, not a real driver type.
 */
function revenueSlices(buckets: readonly OpsNetBucket[]): DonutSlice[] {
  return buckets
    .map((bucket, index) => ({
      name: bucket.label,
      value: bucket.gross ?? 0,
      color:
        bucket.payType === 'unknown'
          ? chartTheme.other
          : (chartTheme.series[index] ?? chartTheme.other),
    }))
    .filter((slice) => slice.value > 0);
}

interface Column {
  key: string;
  label: string;
  driverCount: number;
  bucket: OpsNetTotals;
  /** The Total column: company-level lines land here and it is visually separated. */
  isTotal: boolean;
  isUnknown: boolean;
}

interface CellProps {
  line: Line;
  column: Column;
  masked: boolean;
  /** Company-level amount, used only in the Total column. */
  companyValue: number | null;
}

/** One money/unit cell: the amount, and under it the line as a share of that column's gross. */
function Cell({ line, column, masked, companyValue }: CellProps) {
  const isMoney = line.tone !== 'unit';
  const hasSource = line.companyOnly ? column.isTotal : Boolean(line.read);
  const raw = !hasSource
    ? null
    : line.companyOnly
      ? companyValue
      : (line.read?.(column.bucket) ?? null);
  const hidden = masked && (isMoney || line.sensitive === true);

  let text: string;
  if (hidden) text = MASK;
  else if (raw === null) text = DASH;
  else if (isMoney) text = moneyText(raw, line.tone === 'cost');
  else text = formatKind(raw, line.kind ?? 'number');

  const gross = column.bucket.gross;
  const share =
    !hidden && isMoney && raw !== null && gross !== null && gross !== 0
      ? formatPercent((raw / gross) * 100, { signed: false })
      : null;

  const unavailable = text === DASH || text === MASK;
  const negative = !hidden && raw !== null && (line.tone === 'cost' ? raw !== 0 : raw < 0);

  return (
    <td
      className={cn(
        'tabular h-(--table-row-height-dense) border-r-2 border-b-2 border-line-strong px-4 text-center align-middle whitespace-nowrap last:border-r-0',
        column.isTotal && 'bg-surface-muted font-medium',
      )}
      title={hasSource ? undefined : (line.title ?? NO_SOURCE_TITLE)}
    >
      <span className="inline-flex flex-col items-center leading-tight">
        <span
          className={cn(
            unavailable
              ? 'text-faint'
              : negative
                ? 'text-danger-text'
                : line.emphasis === 'primary'
                  ? 'text-primary-text'
                  : 'text-ink',
          )}
        >
          {text}
        </span>
        {share ? <span className="text-2xs text-muted">{share}</span> : null}
        {hidden || !hasSource ? null : line.sub?.(column.bucket)}
      </span>
    </td>
  );
}

/** Week detail by driver type: P&L lines as rows, driver pay types as columns (docs/DASHBOARD.md §5). */
export function OpsNetWidget({ opsNet, visibility, onDrilldown }: OpsNetWidgetProps) {
  const masked = !visibility.financial || opsNet.masked;
  const unknown = opsNet.unknown;
  const investigate = onDrilldown ? (
    <Button
      variant="link"
      size="sm"
      onClick={() => onDrilldown({ kind: 'unknown_pay_types', unknown })}
    >
      Investigate
    </Button>
  ) : null;

  const slices = useMemo(() => revenueSlices(opsNet.buckets), [opsNet.buckets]);
  const sliceTotal = slices.reduce((sum, slice) => sum + slice.value, 0);
  const total = opsNet.totals.gross;
  const centerValue = masked ? MASK : total === null ? DASH : compactMoney(total);
  const chartLabel = `Proportion of gross revenue by driver type. Total ${centerValue}. ${slices
    .map(
      (slice) =>
        `${slice.name}: ${compactMoney(slice.value)}, ${Math.round((slice.value / sliceTotal) * 100)} percent`,
    )
    .join('. ')}`;

  const columns: Column[] = useMemo(() => {
    const bucketColumns: Column[] = opsNet.buckets.map((bucket) => ({
      key: bucket.payType,
      label: bucket.label,
      driverCount: bucket.driverCount,
      bucket,
      isTotal: false,
      isUnknown: bucket.payType === 'unknown',
    }));
    return [
      ...bucketColumns,
      {
        key: '__total',
        label: 'Total',
        driverCount: opsNet.totals.driverCount,
        bucket: opsNet.totals,
        isTotal: true,
        isUnknown: false,
      },
    ];
  }, [opsNet.buckets, opsNet.totals]);

  let donut: ReactNode;
  if (masked) {
    donut = (
      <EmptyState
        size="sm"
        icon={<EyeOff />}
        title="Revenue split hidden"
        description="Your financial visibility hides the amounts behind this chart."
      />
    );
  } else if (slices.length === 0) {
    donut = (
      <EmptyState
        size="sm"
        icon={<ChartPie />}
        title="No revenue in this period"
        description="No driver type recorded gross, so there is nothing to split."
      />
    );
  } else {
    donut = (
      <DonutChart
        bare
        className="mt-1"
        // The ring stays a fixed size and the legend runs beside it inside the capped band, so
        // pay-type labels sit next to the ring rather than stretching across the card.
        height={150}
        width={150}
        data={slices}
        valueFormatter={compactMoney}
        centerLabel="Total"
        centerValue={centerValue}
        legendPosition="right"
        tableView={false}
        ariaLabel={chartLabel}
      />
    );
  }

  const named = unknown.drivers.slice(0, MAX_NAMED_DRIVERS);
  const moreDrivers = unknown.drivers.length - named.length;

  return (
    <Card
      title="Week detail by driver type"
      description="% = line ÷ that type's gross · lines without a data source show —"
      padding="none"
      className="@container min-w-0"
      data-testid="ops-net-widget"
    >
      {unknown.driverCount > 0 ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-line bg-warning-soft px-(--card-padding) py-2.5 text-xs text-secondary"
        >
          <span
            aria-hidden
            className="flex size-5 shrink-0 items-center justify-center rounded-full bg-warning-border"
          >
            <TriangleAlert className="size-3 text-warning-text" />
          </span>
          <span className="min-w-0 flex-1">
            <span className="tabular font-medium text-ink">
              {formatNumber(unknown.driverCount)}
            </span>{' '}
            {unknown.driverCount === 1 ? 'driver has' : 'drivers have'} an unknown pay type
            {' · '}
            <span className="tabular font-medium text-ink">
              {masked || unknown.gross === null ? MASK : formatMoney(unknown.gross)}
            </span>{' '}
            of gross is unclassified
          </span>
          {investigate}
        </div>
      ) : null}

      {/* Ring and table are stacked, not columned: with five pay types plus the company Total the
          table needs the full card width, and a full-width band lets the legend breathe too. */}
      <div className="flex flex-col">
        <div className="min-w-0 border-b border-line-soft px-(--card-padding) py-3">
          <SectionLabel className="text-center">Proportion of revenue</SectionLabel>
          {/* Capped so the ring and its legend read as one compact unit instead of the labels and
              amounts drifting to opposite edges, then centred over the table it introduces. */}
          <div className="mx-auto max-w-md">{donut}</div>
        </div>
        <div className="min-w-0 p-(--card-padding)">
          {/* The cage: one framed grid block. Rounding lives on the scroll wrapper so the
              header and the sticky Line column clip cleanly at the corners. */}
          {/* `relative` makes this the containing block for the absolutely positioned sr-only
              spans inside the cells; without it they escape this scroll container and
              stretch the page itself once the table is wider than the viewport. */}
          <div className="scroll-quiet relative w-full overflow-x-auto rounded-lg border-2 border-line-strong">
            {/* `border-separate` (spacing 0) draws the same 2px grid as a collapsed table
                but keeps the borders of the sticky header and sticky first column painted. */}
            <table className="w-full border-separate border-spacing-0 text-sm">
              <caption className="sr-only">
                Week detail by driver type: profit and loss lines by driver pay type, with a company
                total column.
              </caption>
              <thead>
                <tr className="bg-surface-muted">
                  <th
                    scope="col"
                    className="sticky top-0 left-0 z-30 h-9 border-r-2 border-b-2 border-r-line-strong border-b-line-strong bg-surface-muted px-4 text-left text-xs font-semibold whitespace-nowrap text-secondary"
                  >
                    Line
                  </th>
                  {columns.map((column) => (
                    <th
                      key={column.key}
                      scope="col"
                      className={cn(
                        'sticky top-0 z-20 h-9 border-r-2 border-b-2 border-r-line-strong border-b-line-strong bg-surface-muted px-4 text-center text-xs font-semibold whitespace-nowrap text-secondary last:border-r-0',
                        column.isUnknown && 'bg-warning-soft',
                        column.isTotal && 'text-ink',
                      )}
                    >
                      {column.label}{' '}
                      <span className="tabular text-2xs text-faint normal-case">
                        {formatNumber(column.driverCount)}
                      </span>
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="[&_tr:last-child_td]:border-b-0 [&_tr:last-child_th]:border-b-0">
                {LINES.map((line) => {
                  const rowBg =
                    line.emphasis === 'primary'
                      ? 'bg-primary-soft'
                      : line.emphasis === 'subtotal'
                        ? 'bg-surface-muted'
                        : 'bg-surface';
                  // The Line column carries its own fill so it reads as a header rail against the
                  // white value grid; the profit rows keep their tint straight through it.
                  const labelBg =
                    line.emphasis === 'primary' ? 'bg-primary-soft' : 'bg-surface-muted';
                  // Tinted rows own their colour: hover would flatten the subtotal and profit lines.
                  const hoverable = line.emphasis !== 'primary' && line.emphasis !== 'subtotal';
                  const companyValue = line.companyOnly
                    ? line.key === 'inactive_truck_loss'
                      ? opsNet.inactiveTruckLoss
                      : opsNet.netOperatingProfit
                    : null;
                  const sourceless = !line.read && !line.companyOnly;
                  return (
                    <tr
                      key={line.key}
                      className={cn(
                        'group transition-colors',
                        rowBg,
                        hoverable && 'hover:bg-surface-hover',
                      )}
                    >
                      <th
                        scope="row"
                        title={line.title}
                        className={cn(
                          'sticky left-0 z-10 h-(--table-row-height-dense) border-r-2 border-b-2 border-line-strong px-4 text-left font-normal whitespace-nowrap',
                          labelBg,
                          hoverable && 'group-hover:bg-surface-hover',
                          line.emphasis === 'strong' && 'font-semibold text-ink',
                          line.emphasis === 'subtotal' && 'font-medium text-ink',
                          line.emphasis === 'primary' && 'font-semibold text-primary-text',
                          !line.emphasis && (sourceless ? 'text-muted' : 'text-secondary'),
                        )}
                      >
                        {line.label}
                      </th>
                      {columns.map((column) => (
                        <Cell
                          key={column.key}
                          line={line}
                          column={column}
                          masked={masked}
                          companyValue={companyValue}
                        />
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {unknown.gross !== null && unknown.gross !== 0 ? (
            <p className="mt-2 text-2xs text-muted">
              <span className="tabular">{masked ? MASK : formatMoney(unknown.gross)}</span> of gross
              belongs to drivers without a parseable pay tag.
              {named.length > 0 ? (
                <>
                  {' '}
                  {named.map((driver) => driver.name).join(', ')}
                  {moreDrivers > 0 ? ` and ${formatNumber(moreDrivers)} more` : ''}.
                </>
              ) : null}
            </p>
          ) : null}
        </div>
      </div>
    </Card>
  );
}

export function OpsNetWidgetSkeleton() {
  return <CardSkeleton lines={6} />;
}
