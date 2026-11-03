import { format, parseISO } from 'date-fns';
import { useMemo, useState } from 'react';
import {
  AreaChart,
  BarChart,
  Button,
  ChartContainer,
  DonutChart,
  LineChart,
  Sparkline,
  chartTheme,
  getStatus,
  useToast,
  type DonutSlice,
  type StatusTone,
} from '@/design-system';
import { formatMoney, formatNumber } from '@/lib/format';
import {
  fleetHealthCounts,
  fuelCostSeries,
  lanesByDay,
  loadStatusCounts,
  milesByDriver,
  revenueProfitSeries,
  revenueSparkline,
} from '../galleryData';
import { Example, ExampleGrid, ExampleGroup, GallerySection } from './Section';

const money = (v: number) => formatMoney(v, { compact: true });
const shortDate = (v: string | number) => format(parseISO(String(v)), 'MMM d');

const statusColor: Record<StatusTone, string> = {
  success: chartTheme.status.good,
  info: chartTheme.series[0],
  warning: chartTheme.status.warning,
  danger: chartTheme.status.critical,
  neutral: chartTheme.other,
  // Slot 5 is the purple hue; the violet status family maps onto it.
  violet: chartTheme.series[4],
};

function toSlices(counts: { status: string; label: string; count: number }[]): DonutSlice[] {
  return counts
    .filter((c) => c.count > 0)
    .map((c) => ({ name: c.label, value: c.count, color: statusColor[getStatus(c.status).tone] }));
}

export function ChartsSection() {
  const { toast } = useToast();
  const [retrying, setRetrying] = useState(false);
  const error = useMemo(() => new Error('analytics-service timed out after 10 s'), []);
  const fleetSlices = useMemo(() => toSlices(fleetHealthCounts), []);
  const loadSlices = useMemo(() => toSlices(loadStatusCounts).slice(0, 6), []);

  return (
    <GallerySection
      id="charts"
      index={12}
      title="Charts"
      note="Recharts through ChartContainer: one y-axis, tokens for series, grid and axis, legend for ≥ 2 series, a table twin behind “View as table”. Status colours only with a label."
    >
      <ExampleGroup title="Cartesian">
        <ExampleGrid columns={2}>
          <Example caption="LineChart · 2 series with legend, 30 daily points" bare>
            <LineChart
              title="Revenue and profit"
              description="Last 30 days"
              data={revenueProfitSeries}
              xKey="date"
              xLabel="Date"
              series={[
                { key: 'revenue', label: 'Revenue' },
                { key: 'profit', label: 'Gross profit' },
              ]}
              valueFormatter={money}
              xFormatter={shortDate}
            />
          </Example>
          <Example caption="AreaChart · single series, 12 weekly points" bare>
            <AreaChart
              title="Fuel cost"
              description="Weekly, last 12 weeks"
              data={fuelCostSeries}
              xKey="week"
              xLabel="Week"
              series={[{ key: 'cost', label: 'Fuel cost' }]}
              valueFormatter={money}
              xFormatter={shortDate}
              footer="Source: fuel card imports"
            />
          </Example>
          <Example caption="BarChart · vertical columns" bare>
            <BarChart
              title="Loads per day"
              description="This week"
              data={lanesByDay.map((d) => ({
                day: d.day,
                loads: d.midwest + d.southeast + d.west,
              }))}
              xKey="day"
              xLabel="Day"
              series={[{ key: 'loads', label: 'Loads' }]}
              valueFormatter={(v) => formatNumber(v)}
            />
          </Example>
          <Example caption="BarChart · stacked by lane" bare>
            <BarChart
              stacked
              title="Loads per day by lane"
              description="This week"
              data={lanesByDay}
              xKey="day"
              xLabel="Day"
              series={[
                { key: 'midwest', label: 'Midwest' },
                { key: 'southeast', label: 'Southeast' },
                { key: 'west', label: 'West' },
              ]}
              valueFormatter={(v) => formatNumber(v)}
            />
          </Example>
          <Example caption="BarChart · horizontal (layout vertical) for long labels" bare>
            <BarChart
              layout="vertical"
              title="Miles by driver"
              description="Last 7 days"
              data={milesByDriver}
              xKey="driver"
              xLabel="Driver"
              series={[{ key: 'miles', label: 'Miles' }]}
              valueFormatter={(v) => formatNumber(v)}
              height={260}
            />
          </Example>
          <Example caption="AreaChart · stacked, 2 series" bare>
            <AreaChart
              stacked
              title="Revenue mix"
              description="Profit stacked on cost, last 30 days"
              data={revenueProfitSeries.map((p) => ({
                date: p.date,
                cost: p.revenue - p.profit,
                profit: p.profit,
              }))}
              xKey="date"
              xLabel="Date"
              series={[
                { key: 'cost', label: 'Cost' },
                { key: 'profit', label: 'Gross profit' },
              ]}
              valueFormatter={money}
              xFormatter={shortDate}
            />
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="Donut and sparkline">
        <ExampleGrid columns={2}>
          <Example caption="DonutChart · fleet health with status colours" bare>
            <DonutChart
              title="Fleet health"
              description="48 trucks"
              data={fleetSlices}
              centerLabel="Trucks"
            />
          </Example>
          <Example caption="DonutChart · load status, categorical fallback for info tone" bare>
            <DonutChart title="Load status" data={loadSlices} centerLabel="Loads" />
          </Example>
          <Example caption="Sparkline · series 1 (default) and status good; decorative" wide>
            <div className="flex flex-col gap-4">
              <div>
                <p className="mb-1 text-xs text-muted">Weekly revenue</p>
                <Sparkline data={revenueSparkline} height={40} />
              </div>
              <div>
                <p className="mb-1 text-xs text-muted">On-time %</p>
                <Sparkline
                  data={[92, 94, 91, 95, 96, 95, 97, 98]}
                  height={40}
                  color={chartTheme.status.good}
                />
              </div>
            </div>
          </Example>
        </ExampleGrid>
      </ExampleGroup>

      <ExampleGroup title="ChartContainer states">
        <ExampleGrid columns={3}>
          <Example caption="Loading" bare>
            <ChartContainer
              title="Revenue and profit"
              description="Last 30 days"
              loading
              height={180}
            />
          </Example>
          <Example caption="Empty" bare>
            <ChartContainer title="Fuel cost" description="Selected range" empty height={180} />
          </Example>
          <Example caption="Error · retry" bare>
            <ChartContainer
              title="Miles by driver"
              error={error}
              height={180}
              aria-busy={retrying}
              onRetry={() => {
                setRetrying(true);
                setTimeout(() => {
                  setRetrying(false);
                  toast({ tone: 'warning', title: 'Still unavailable' });
                }, 600);
              }}
            />
          </Example>
          <Example
            caption="Table view toggle · same data as a table; bare container inside a custom toolbar"
            bare
            wide
          >
            <LineChart
              title="Revenue and profit"
              description="Click “View as table” to see the twin"
              data={revenueProfitSeries.slice(-14)}
              xKey="date"
              xLabel="Date"
              series={[
                { key: 'revenue', label: 'Revenue' },
                { key: 'profit', label: 'Gross profit' },
              ]}
              valueFormatter={money}
              xFormatter={shortDate}
              height={200}
              toolbar={
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => toast({ tone: 'info', title: 'Opens Reports › Analytics' })}
                >
                  Open report
                </Button>
              }
            />
          </Example>
        </ExampleGrid>
      </ExampleGroup>
    </GallerySection>
  );
}
