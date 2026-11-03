import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AreaChart } from './AreaChart';
import { BarChart } from './BarChart';
import { ChartContainer } from './ChartContainer';
import { DonutChart } from './DonutChart';
import { LineChart } from './LineChart';
import { Sparkline } from './Sparkline';
import { chartTheme, humanizeKey, seriesColor } from './chartTheme';

const data = [
  { month: 'Jan', revenue: 1200, cost: 800 },
  { month: 'Feb', revenue: 1500, cost: 900 },
  { month: 'Mar', revenue: 1100, cost: 950 },
];
const series = [
  { key: 'revenue', label: 'Revenue' },
  { key: 'cost', label: 'Cost' },
];
const money = (v: number) => `$${v.toLocaleString('en-US')}`;

describe('ChartContainer', () => {
  it('renders loading, empty and error states', async () => {
    const onRetry = vi.fn();
    const { rerender } = render(<ChartContainer title="Revenue" loading />);
    expect(screen.getByRole('region', { name: 'Revenue' })).toHaveAttribute('aria-busy', 'true');
    expect(screen.queryByRole('img')).toBeNull();

    rerender(<ChartContainer title="Revenue" empty />);
    expect(screen.getByText('No data')).toBeInTheDocument();

    rerender(<ChartContainer title="Revenue" error={new Error('boom')} onRetry={onRetry} />);
    expect(screen.getByText('Unable to load chart')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('toggles between the chart and its table view', async () => {
    render(
      <ChartContainer
        title="Revenue"
        tableView={{
          columns: [
            { key: 'month', label: 'Month' },
            { key: 'revenue', label: 'Revenue', align: 'right' },
          ],
          rows: [{ month: 'Jan', revenue: '$1,200' }],
        }}
      >
        <svg data-testid="plot" />
      </ChartContainer>,
    );
    expect(screen.getByRole('img', { name: 'Revenue' })).toContainElement(
      screen.getByTestId('plot'),
    );
    const toggle = screen.getByRole('button', { name: 'View as table' });
    expect(toggle).toHaveAttribute('aria-pressed', 'false');
    await userEvent.click(toggle);
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Revenue' })).toBeInTheDocument();
    expect(within(table).getByText('$1,200')).toBeInTheDocument();
    expect(screen.queryByTestId('plot')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'View as chart' }));
    expect(screen.getByTestId('plot')).toBeInTheDocument();
  });
});

describe('LineChart / AreaChart', () => {
  it('renders the title, an auto legend for two series and a generated table', async () => {
    render(
      <LineChart
        title="Revenue vs cost"
        data={data}
        xKey="month"
        series={series}
        valueFormatter={money}
        width={480}
      />,
    );
    expect(screen.getByRole('img', { name: 'Revenue vs cost' })).toBeInTheDocument();
    const legend = screen.getByRole('list', { name: 'Legend' });
    expect(within(legend).getByText('Revenue')).toBeInTheDocument();
    expect(within(legend).getByText('Cost')).toBeInTheDocument();

    await userEvent.click(screen.getByRole('button', { name: 'View as table' }));
    const table = screen.getByRole('table');
    expect(within(table).getByRole('columnheader', { name: 'Month' })).toBeInTheDocument();
    expect(within(table).getByText('$1,500')).toBeInTheDocument();
    expect(within(table).getAllByRole('row')).toHaveLength(4);
  });

  it('skips the legend for a single series and honors legend={false}', () => {
    const { rerender } = render(
      <AreaChart title="Revenue" data={data} xKey="month" series={[series[0]!]} width={480} />,
    );
    expect(screen.queryByRole('list', { name: 'Legend' })).toBeNull();
    rerender(
      <AreaChart
        title="Revenue"
        data={data}
        xKey="month"
        series={series}
        legend={false}
        width={480}
      />,
    );
    expect(screen.queryByRole('list', { name: 'Legend' })).toBeNull();
  });
});

describe('BarChart', () => {
  it('renders stacked and horizontal-bar variants with a legend', () => {
    const { rerender } = render(
      <BarChart
        title="Loads by status"
        data={data}
        xKey="month"
        series={series}
        stacked
        width={480}
      />,
    );
    expect(screen.getByRole('img', { name: 'Loads by status' })).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Legend' })).toBeInTheDocument();
    rerender(
      <BarChart
        title="Loads by status"
        data={data}
        xKey="month"
        series={series}
        layout="vertical"
        width={480}
      />,
    );
    expect(screen.getByRole('img', { name: 'Loads by status' })).toBeInTheDocument();
  });
});

describe('DonutChart', () => {
  it('lists each slice with value and percent and shows the total in the center', () => {
    render(
      <DonutChart
        title="Fleet health"
        data={[
          { name: 'Healthy', value: 30, color: chartTheme.status.good },
          { name: 'Due soon', value: 15, color: chartTheme.status.warning },
          { name: 'Overdue', value: 5, color: chartTheme.status.critical },
        ]}
        centerLabel="Trucks"
        width={160}
      />,
    );
    const legend = screen.getByRole('list', { name: 'Legend' });
    const rows = within(legend).getAllByRole('listitem');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('Healthy');
    expect(rows[0]).toHaveTextContent('30');
    expect(rows[0]).toHaveTextContent('60%');
    expect(rows[2]).toHaveTextContent('10%');
    expect(screen.getByText('50')).toBeInTheDocument();
    expect(screen.getByText('Trucks')).toBeInTheDocument();
  });

  it('places the legend beside the ring by default and under it when asked', () => {
    const slices = [
      { name: 'Healthy', value: 30 },
      { name: 'Overdue', value: 5 },
    ];
    const { rerender } = render(<DonutChart title="Fleet" data={slices} valueFormatter={money} />);
    const beside = screen.getByRole('list', { name: 'Legend' });
    // Ring and legend share a row: the legend is a flex sibling, not a stacked block.
    expect(beside.parentElement).toHaveClass('items-center');
    expect(beside.parentElement).not.toHaveClass('flex-col');
    expect(beside).toHaveClass('flex-1');

    rerender(
      <DonutChart title="Fleet" data={slices} valueFormatter={money} legendPosition="bottom" />,
    );
    const under = screen.getByRole('list', { name: 'Legend' });
    expect(under.parentElement).toHaveClass('flex-col');
    expect(under).toHaveClass('w-full');
    // The ring still comes first, and the row shape is unchanged in both positions.
    expect(under.previousElementSibling).toHaveClass('relative');
    const row = within(under).getAllByRole('listitem')[0]!;
    expect(row).toHaveTextContent('Healthy');
    expect(row).toHaveTextContent('$30');
    expect(row).toHaveTextContent('86%');
  });
});

describe('Sparkline', () => {
  it('renders a decorative svg at a fixed width', () => {
    const { container } = render(<Sparkline data={[1, 3, 2, 5, 4]} width={80} />);
    const root = container.firstElementChild as HTMLElement;
    expect(root).toHaveAttribute('aria-hidden', 'true');
    expect(root.style.height).toBe('32px');
    expect(container.querySelector('svg')).toBeInTheDocument();
  });
});

describe('chartTheme', () => {
  it('assigns series colors in fixed order and folds past the budget', () => {
    expect(seriesColor(0)).toBe('var(--nw-chart-1)');
    expect(seriesColor(5)).toBe('var(--chart-series-6)');
    expect(seriesColor(1, 'var(--chart-good)')).toBe('var(--chart-good)');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Six validated slots, then the fold. The budget is what the palette can actually keep
    // distinguishable, not how many hues would fit on a screen.
    expect(seriesColor(6)).toBe(chartTheme.other);
    warn.mockRestore();
    expect(humanizeKey('in_transit')).toBe('In transit');
    expect(humanizeKey('revenueUsd')).toBe('Revenue usd');
  });
});

describe('chart animation', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** Pretend the OS asks for reduced motion. */
  function stubReducedMotion(matches: boolean) {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(
        () =>
          ({
            matches,
            media: '(prefers-reduced-motion: reduce)',
            onchange: null,
            addEventListener: () => {},
            removeEventListener: () => {},
            addListener: () => {},
            removeListener: () => {},
            dispatchEvent: () => true,
          }) as unknown as MediaQueryList,
      ),
    );
  }

  it('marks the plot and fades it in by default', () => {
    const { container } = render(
      <LineChart title="Revenue" data={data} xKey="month" series={series} width={480} />,
    );
    expect(container.querySelector('.chart-fade-in')).toBeInTheDocument();
    expect(container.querySelector('.chart-plot')).toBeInTheDocument();
    expect(chartTheme.animationDuration).toBeGreaterThan(0);
  });

  it('drops the entrance fade for animate={false} and for reduced motion', () => {
    const { container, rerender } = render(
      <BarChart
        title="Loads"
        data={data}
        xKey="month"
        series={series}
        width={480}
        animate={false}
      />,
    );
    expect(container.querySelector('.chart-fade-in')).toBeNull();

    stubReducedMotion(true);
    rerender(<BarChart title="Loads" data={data} xKey="month" series={series} width={480} />);
    expect(container.querySelector('.chart-fade-in')).toBeNull();
  });

  it('keeps the plot node across a data change and swaps it when the series set changes', () => {
    const { container, rerender } = render(
      <AreaChart title="Revenue" data={data} xKey="month" series={series} width={480} />,
    );
    const plot = container.querySelector('.chart-fade-in');
    expect(plot).toBeInTheDocument();

    // Same series, new period: Recharts keeps its DOM and tweens instead of remounting.
    rerender(
      <AreaChart
        title="Revenue"
        data={[
          { month: 'Apr', revenue: 900, cost: 700 },
          { month: 'May', revenue: 1800, cost: 1000 },
        ]}
        xKey="month"
        series={series}
        width={480}
      />,
    );
    expect(container.querySelector('.chart-fade-in')).toBe(plot);

    // Different series set: the plot remounts, so the wrapper fades the swap in.
    rerender(
      <AreaChart title="Revenue" data={data} xKey="month" series={[series[0]!]} width={480} />,
    );
    expect(container.querySelector('.chart-fade-in')).not.toBe(plot);
  });

  it('renders the donut with a sweep and the tooltip card with a fade class', () => {
    const { container } = render(
      <DonutChart
        title="Fleet health"
        data={[
          { name: 'Healthy', value: 30 },
          { name: 'Overdue', value: 5 },
        ]}
        width={160}
      />,
    );
    expect(container.querySelector('.chart-plot')).toBeInTheDocument();
    expect(container.querySelectorAll('.recharts-pie-sector').length).toBeGreaterThan(0);
    expect(chartTheme.animationDurationSlow).toBeGreaterThan(chartTheme.animationDuration);
    expect(chartTheme.tooltip.className).toContain('chart-tooltip-in');
  });

  it('leaves the sparkline instant', () => {
    const { container } = render(<Sparkline data={[1, 3, 2, 5, 4]} width={80} />);
    expect(container.querySelector('.chart-fade-in')).toBeNull();
    expect(container.querySelector('.chart-plot')).toBeNull();
  });
});
