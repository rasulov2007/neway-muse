import type { DashboardFuel, FuelGroup } from '@neway/shared';
import { useState } from 'react';
import { Card, CardSkeleton, Tabs, cn } from '@/design-system';
import { formatNumber } from '@/lib/format';
import type { DrilldownRequest } from '../drilldown/types';
import { DASH, MASK, REASON_LABELS, formatValue } from '../metric';
import { Value } from './Value';
import type { Visibility } from '../visibility';
import { CompactTable, type CompactColumn } from './CompactTable';

export interface FuelWidgetProps {
  fuel: DashboardFuel;
  visibility: Visibility;
  onDrilldown?: (request: DrilldownRequest) => void;
}

const TOP = 10;

/** Why retail total, discount and discount % read "—" when the feed carries the final price only. */
const RETAIL_PENDING = 'The fuel feed carries the final price only — retail/discount pending';

/** One label/value line of the totals list. */
interface FuelStat {
  key: string;
  label: string;
  value: string;
  /** Native tooltip, normally the reason the value is "—". */
  title?: string;
  onClick?: () => void;
}

/**
 * Price per gallon to three decimals (`$3.114`). Cents alone round away the spread that makes a
 * fuel programme worth measuring, so this one metric is not `formatValue(..., 'rate')`.
 */
function formatPricePerGallon(value: number | null, masked: boolean): string {
  if (masked) return MASK;
  if (value === null) return DASH;
  return `$${formatNumber(value, 3)}`;
}

/**
 * Retail minus discounted, and the same difference as a share of retail. Both are `null` unless
 * the API gave both numbers: an equal pair is a real `$0.00` saving, a missing one is unknown.
 */
function discountOf(totals: DashboardFuel['totals']): {
  amount: number | null;
  pct: number | null;
} {
  const { grossCost, discountedCost } = totals;
  if (grossCost === null || discountedCost === null) return { amount: null, pct: null };
  const amount = grossCost - discountedCost;
  return { amount, pct: grossCost === 0 ? null : (amount / grossCost) * 100 };
}

/** Two-column label/value list: label as a row header, value right-aligned in tabular figures. */
function StatList({ caption, stats }: { caption: string; stats: readonly FuelStat[] }) {
  return (
    <table className="w-full border-collapse text-sm">
      <caption className="sr-only">{caption}</caption>
      <tbody>
        {stats.map((stat) => {
          const unavailable = stat.value === DASH || stat.value === MASK;
          return (
            <tr key={stat.key} className="border-b border-line-soft last:border-b-0">
              <th
                scope="row"
                className="h-(--table-row-height-dense) pr-3 text-left font-normal whitespace-nowrap text-muted"
              >
                {stat.label}
              </th>
              <td
                title={stat.title}
                className={cn(
                  'tabular h-(--table-row-height-dense) text-right font-medium whitespace-nowrap',
                  unavailable ? 'text-faint' : 'text-ink',
                )}
              >
                {stat.onClick ? (
                  <button
                    type="button"
                    onClick={stat.onClick}
                    className="rounded-xs underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus"
                  >
                    {stat.value}
                  </button>
                ) : (
                  stat.value
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

/** Fuel totals plus the top consumers by truck and by driver (docs/DASHBOARD.md §7). */
export function FuelWidget({ fuel, visibility, onDrilldown }: FuelWidgetProps) {
  const [tab, setTab] = useState<'truck' | 'driver'>('truck');
  const masked = !visibility.financial || fuel.masked;
  const totals = fuel.totals;
  const discount = discountOf(totals);
  const maskedTitle = masked ? REASON_LABELS.masked : undefined;

  const volumeStats: FuelStat[] = [
    {
      key: 'pricePerGallon',
      label: 'Price per gallon',
      value: formatPricePerGallon(totals.avgPricePerGallon, masked),
      title: masked
        ? maskedTitle
        : totals.avgPricePerGallon === null
          ? 'No gallons purchased in this period'
          : undefined,
    },
    { key: 'gallons', label: 'Gallons', value: formatNumber(totals.gallons) },
    { key: 'fillUps', label: 'Fill-ups', value: formatNumber(totals.fillUps) },
    {
      key: 'fuelCostPerMile',
      label: 'Fuel cost / mile',
      value: formatValue(totals.fuelCostPerMile, 'rate', { masked }),
      title: masked
        ? maskedTitle
        : totals.fuelCostPerMile === null
          ? REASON_LABELS.no_mileage_data
          : undefined,
    },
  ];

  const costStats: FuelStat[] = [
    {
      key: 'discountedCost',
      label: 'Discounted total',
      value: formatValue(totals.discountedCost, 'money', { masked }),
      title: masked
        ? maskedTitle
        : totals.discountedCost === null
          ? 'No fuel cost in the feed for this period'
          : undefined,
      onClick:
        onDrilldown && !masked ? () => onDrilldown({ kind: 'metric', metric: 'fuel' }) : undefined,
    },
    {
      key: 'grossCost',
      label: 'Retail total',
      value: formatValue(totals.grossCost, 'money', { masked }),
      title: masked ? maskedTitle : totals.grossCost === null ? RETAIL_PENDING : undefined,
    },
    {
      key: 'discount',
      label: 'Discount',
      value: formatValue(discount.amount, 'money', { masked }),
      title: masked ? maskedTitle : discount.amount === null ? RETAIL_PENDING : undefined,
    },
    {
      key: 'discountPct',
      label: 'Discount %',
      value: formatValue(discount.pct, 'percent', { masked }),
      title: masked
        ? maskedTitle
        : discount.pct === null
          ? discount.amount === null
            ? RETAIL_PENDING
            : 'Retail total is zero'
          : undefined,
    },
  ];

  const columns = (entity: string): CompactColumn<FuelGroup>[] => [
    { key: 'label', label: entity, render: (g) => <span className="font-medium">{g.label}</span> },
    { key: 'fillUps', label: 'Fill-ups', align: 'right', render: (g) => formatNumber(g.fillUps) },
    {
      key: 'gallons',
      label: 'Gallons',
      align: 'right',
      render: (g) => formatNumber(g.gallons),
    },
    {
      key: 'cost',
      label: 'Cost',
      align: 'right',
      render: (g) => <Value value={g.cost} kind="moneyCompact" masked={masked} />,
    },
    {
      key: 'share',
      label: 'Share',
      align: 'right',
      render: (g) => <Value value={g.share} kind="percent" />,
    },
  ];

  const rows = (tab === 'truck' ? fuel.byTruck : fuel.byDriver).slice(0, TOP);

  return (
    <Card
      title="Fuel"
      description="What the fleet burned and what it actually paid"
      padding="none"
      className="min-w-0"
      data-testid="fuel-widget"
    >
      <div data-testid="fuel-totals" className="px-(--card-padding) pt-2 pb-1">
        <div className="grid grid-cols-1 gap-x-8 md:grid-cols-2">
          <StatList caption="Fuel volume totals" stats={volumeStats} />
          <StatList caption="Fuel cost totals" stats={costStats} />
        </div>
        {!masked && totals.grossCost === null ? (
          <p className="pt-2 pb-1 text-xs text-muted">
            The fuel feed carries the final price only — retail total and discount are pending.
          </p>
        ) : null}
      </div>
      <div className="flex items-center justify-between gap-3 border-t border-line-soft px-(--card-padding) py-2">
        <span className="text-xs text-muted">Top {TOP} by gallons</span>
        <Tabs
          variant="segmented"
          size="sm"
          aria-label="Fuel breakdown"
          items={[
            { value: 'truck', label: 'By truck' },
            { value: 'driver', label: 'By driver' },
          ]}
          value={tab}
          onValueChange={(v) => setTab(v as 'truck' | 'driver')}
        />
      </div>
      {rows.length === 0 ? (
        <p className="px-(--card-padding) py-6 text-center text-sm text-muted">
          No fuel transactions in this period.
        </p>
      ) : (
        <CompactTable
          caption={tab === 'truck' ? 'Fuel by truck' : 'Fuel by driver'}
          columns={columns(tab === 'truck' ? 'Truck' : 'Driver')}
          rows={rows}
          rowKey={(g) => g.id}
        />
      )}
    </Card>
  );
}

export function FuelWidgetSkeleton() {
  return <CardSkeleton lines={8} />;
}
