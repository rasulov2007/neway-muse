import { act, fireEvent, render, renderHook, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UseQueryResult } from '@tanstack/react-query';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compareMetricPeriods, type Insight } from '@neway/shared';
import type { RankedEntity, RankingPage, RankingParams, TrendPoint } from '../useInsights';

vi.mock('@tanstack/react-router', () => ({
  Link: ({ to, children, ...rest }: { to: string; children: React.ReactNode }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

const chooseAppearance = vi.fn(() => Promise.resolve());
vi.mock('@/features/auth/appearance', () => ({
  chooseAppearance: (...args: unknown[]) => chooseAppearance(...(args as [])),
}));
vi.mock('@/features/auth/auth-context', () => ({
  useAuth: () => ({ account: { userId: 'u1' } }),
}));

import { AlertCard, NeedsAttention } from './AlertCard';
import { KpiTile } from './KpiTile';
import { RankedList } from './RankedList';
import { RankingExplorer } from './RankingExplorer';
import { ThemeToggle } from './ThemeToggle';
import { useCountUp } from './useCountUp';
import {
  categoryLabel,
  chartAxis,
  formatMetric,
  attentionOrder,
  easternDateTime,
  profitTag,
  shareOfRevenueRanking,
  sparklineFor,
} from './view-model';
import { WeeklyChart } from './WeeklyChart';

/** Reduced motion on or off for the hooks that read it. */
function setReducedMotion(on: boolean) {
  window.matchMedia = ((query: string) =>
    ({
      matches: on && query.includes('reduce'),
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    }) as MediaQueryList) as typeof window.matchMedia;
}

const originalMatchMedia = window.matchMedia;
beforeEach(() => setReducedMotion(true));
afterEach(() => {
  window.matchMedia = originalMatchMedia;
  chooseAppearance.mockClear();
});

const week = (weekStart: string, gross: number, cost: number | null): TrendPoint => ({
  weekStart,
  gross,
  cost,
  profit: cost === null ? null : gross - cost,
  miles: 1000,
});

// ----------------------------------------------------------------------------------- view model

describe('view model', () => {
  it('writes metrics exactly as the page always has', () => {
    expect(formatMetric('money', 1084314.39)).toBe('$1,084,314.39');
    expect(formatMetric('percent', 12.345)).toBe('12.3%');
    expect(formatMetric('miles', 1234.6)).toBe('1,235');
    expect(formatMetric('money_per_mile', 2.5)).toBe('$2.50');
    expect(formatMetric('count', 58)).toBe('58');
    expect(formatMetric('money', null)).toBe('—');
  });

  it('offers sparklines only for gross, cost, profit and miles, and never from one week', () => {
    const trend = [week('2026-08-03', 100, 50), week('2026-08-10', 120, null), week('2026-08-17', 90, 40)];
    expect(sparklineFor('gross', trend)).toEqual([100, 120, 90]);
    expect(sparklineFor('cost', trend)).toEqual([50, null, 40]);
    expect(sparklineFor('profit', trend)).toEqual([50, null, 50]);
    expect(sparklineFor('miles', trend)).toEqual([1000, 1000, 1000]);
    for (const key of ['rpm', 'cpm', 'marginPct', 'ppm', 'activeTrucks', 'grossPerTruck'] as const) {
      expect(sparklineFor(key, trend)).toBeNull();
    }
    expect(sparklineFor('gross', [week('2026-08-03', 100, 50)])).toBeNull();
    expect(sparklineFor('cost', [week('2026-08-03', 1, null), week('2026-08-10', 2, 5)])).toBeNull();
  });

  it('tags trucks Profitable, Loss, Break-even or No cost data', () => {
    expect(profitTag({ profit: 10 })).toBe('profitable');
    expect(profitTag({ profit: -1 })).toBe('loss');
    expect(profitTag({ profit: 0 })).toBe('break_even');
    expect(profitTag({ profit: null })).toBe('no_cost');
  });

  it('keeps the old category wording and ranks share of revenue with unknowns last', () => {
    expect(categoryLabel('driver_pay')).toBe('Driver Pay');
    const ranked = shareOfRevenueRanking([
      { category: 'a', amount: 1, perMile: null, shareOfRevenue: 5, changePct: null },
      { category: 'b', amount: 1, perMile: null, shareOfRevenue: null, changePct: null },
      { category: 'c', amount: 1, perMile: null, shareOfRevenue: 20, changePct: null },
    ]);
    expect(ranked.map((r) => r.category)).toEqual(['c', 'a', 'b']);
  });

  it('builds an axis that reaches below zero only for a loss', () => {
    expect(chartAxis([week('2026-08-03', 4000, 1000)]).bottom).toBe(0);
    const loss = chartAxis([week('2026-08-03', 1000, 3000)]);
    expect(loss.bottom).toBeLessThan(0);
    expect(loss.top).toBeGreaterThanOrEqual(3000);
    expect(loss.ticks).toContain(0);
  });
});

// ------------------------------------------------------------------------------------ KPI card

describe('KpiTile', () => {
  it('shows the value, a better change in the done colour, and the comparison caption', () => {
    render(<KpiTile metric={compareMetricPeriods('gross', 1200, 1000)} icon={<span />} />);
    const card = screen.getByTestId('kpi-gross');
    expect(within(card).getAllByText('$1,200.00').length).toBeGreaterThan(0);
    const pill = within(card).getByText('+20.0%').closest('span');
    expect(pill?.className).toContain('text-nw-done-text');
    expect(within(card).getByText('vs previous period')).toBeInTheDocument();
  });

  it('a cost going up is worse, in the urgent colour', () => {
    render(<KpiTile metric={compareMetricPeriods('cost', 1200, 1000)} icon={<span />} />);
    expect(screen.getByText('+20.0%').closest('span')?.className).toContain('text-nw-urgent-text');
  });

  it('with no value shows a dash and says there is no comparison — never 0', () => {
    render(<KpiTile metric={compareMetricPeriods('profit', null, 500)} icon={<span />} />);
    const card = screen.getByTestId('kpi-profit');
    expect(within(card).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(card).queryByText(/\$0/)).toBeNull();
    expect(within(card).getByText('No comparable figure for the previous period')).toBeInTheDocument();
  });

  it('the formula opens by keyboard as well as by pointer', async () => {
    const user = userEvent.setup();
    render(<KpiTile metric={compareMetricPeriods('rpm', 2.4, 2.2)} icon={<span />} />);
    const trigger = screen.getByRole('button', { name: 'How RPM is worked out' });
    trigger.focus();
    await user.keyboard('{Enter}');
    expect(await screen.findByText(/^Gross revenue ÷ load miles/)).toBeInTheDocument();
  });

  it('renders a metric the server adds before this build knows it, without a formula', () => {
    const unknown = { ...compareMetricPeriods('gross', 10, 5), key: 'futureMetric', label: 'Future metric' };
    render(<KpiTile metric={unknown as never} icon={<span />} />);
    expect(screen.getByText('Future metric')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /worked out/ })).toBeNull();
  });

  it('draws a sparkline only when given weekly values', () => {
    const { rerender } = render(
      <KpiTile metric={compareMetricPeriods('gross', 1, 1)} icon={<span />} sparkline={[1, 2]} sparkSeries="gross" />,
    );
    expect(screen.getByTestId('spark-gross')).toBeInTheDocument();
    rerender(<KpiTile metric={compareMetricPeriods('gross', 1, 1)} icon={<span />} sparkline={null} sparkSeries="gross" />);
    expect(screen.queryByTestId('spark-gross')).toBeNull();
  });
});

describe('useCountUp', () => {
  it('lands on the target at once under reduced motion, and keeps null as null', () => {
    const { result, rerender } = renderHook(({ v }) => useCountUp(v), {
      initialProps: { v: 1234.56 as number | null },
    });
    expect(result.current).toBe(1234.56);
    rerender({ v: null });
    expect(result.current).toBeNull();
  });

  it('counts from zero to the exact target when motion is allowed', () => {
    setReducedMotion(false);
    vi.useFakeTimers();
    let now = 0;
    const frames: FrameRequestCallback[] = [];
    vi.spyOn(performance, 'now').mockImplementation(() => now);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      frames.push(cb);
      return frames.length;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => {});
    const { result } = renderHook(() => useCountUp(500));
    expect(result.current).toBe(0);
    act(() => {
      now = 300;
      frames.shift()?.(now);
    });
    expect(result.current).toBeGreaterThan(0);
    expect(result.current).toBeLessThan(500);
    act(() => {
      now = 700;
      frames.shift()?.(now);
    });
    expect(result.current).toBe(500);
    vi.useRealTimers();
    vi.restoreAllMocks();
  });
});

// ---------------------------------------------------------------------------------- chart

describe('WeeklyChart', () => {
  it('draws no cost or profit bar for a week without cost data, and says so in the tooltip', () => {
    const { container } = render(
      <WeeklyChart points={[week('2026-08-03', 4000, 1000), week('2026-08-10', 3000, null)]} />,
    );
    expect(container.querySelectorAll('[data-series="gross"]')).toHaveLength(2);
    expect(container.querySelectorAll('[data-series="cost"]')).toHaveLength(1);
    expect(container.querySelectorAll('[data-series="profit"]')).toHaveLength(1);

    const second = screen.getByLabelText(/Week of .*Cost no cost data/);
    fireEvent.focus(second);
    const tooltip = screen.getByRole('tooltip');
    expect(within(tooltip).getAllByText('No cost data')).toHaveLength(1);
    expect(within(tooltip).queryByText('Profit')).toBeNull();
  });

  it('shows an empty state with no weeks', () => {
    render(<WeeklyChart points={[]} />);
    expect(screen.getByText('No financial data for this period')).toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------------- alerts

const insight = (severity: Insight['severity'], key: string): Insight => ({
  key,
  severity,
  title: `Unit 101 cost per mile rose 31.0% to $0.52`,
  action: 'Open the truck and check its fuel and maintenance in this period.',
  entity: { type: 'truck', id: 'T1', label: 'Unit 101' },
  evidence: { metric: 'cpm', current: 0.52, previous: 0.4, change: 0.12, changePct: 31 },
  href: '/fleet/trucks/T1',
});

describe('AlertCard', () => {
  it('shows severity as a word with its symbol, the evidence, and an in-app Open link', () => {
    render(
      <ul>
        <AlertCard insight={insight('critical', 'a')} />
      </ul>,
    );
    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(screen.getByText('CPM: 0.40 → 0.52')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open Unit 101' })).toHaveAttribute('href', '/fleet/trucks/T1');
  });

  it('lists findings in the order the server ranked them, and says when there are none', () => {
    const { rerender } = render(
      <NeedsAttention insights={[insight('critical', 'a'), insight('warning', 'b')]} />,
    );
    const words = screen.getAllByText(/^(Critical|Warning)$/).map((el) => el.textContent);
    expect(words).toEqual(['Critical', 'Warning']);
    rerender(<NeedsAttention insights={[]} />);
    expect(screen.getByText(/Nothing moved far enough/)).toBeInTheDocument();
  });
});

// ------------------------------------------------------------------------------ ranked list

describe('RankedList', () => {
  it('keeps the given order and always prints the figure', () => {
    render(
      <RankedList
        label="Departments"
        items={[
          { key: 'a', label: 'Dispatch', value: 8, display: '8' },
          { key: 'b', label: 'Safety', value: 2, display: '2' },
        ]}
      />,
    );
    const rows = within(screen.getByRole('list', { name: 'Departments' })).getAllByRole('listitem');
    expect(rows.map((row) => row.textContent)).toEqual(['1Dispatch8', '2Safety2']);
  });
});

// ------------------------------------------------------------------------- truck table / grid

const truckRow = (id: string, profit: number | null, marginPct: number | null): RankedEntity => ({
  id,
  label: id,
  gross: 1000,
  cost: profit === null ? null : 1000 - profit,
  profit,
  miles: 2000,
  rpm: 0.5,
  cpm: profit === null ? null : (1000 - profit) / 2000,
  marginPct,
  href: `/fleet/trucks/${id}`,
});

function pageQuery(rows: RankedEntity[]): UseQueryResult<RankingPage> {
  return {
    data: { rows, total: rows.length, totalAll: rows.length, page: 1, pageSize: 25, sort: 'profit', dir: 'desc', q: '' },
    error: null,
    isPending: false,
  } as unknown as UseQueryResult<RankingPage>;
}

const params: RankingParams = { page: 1, pageSize: 25, sort: 'profit', dir: 'desc', q: '' };

describe('RankingExplorer', () => {
  const rows = [truckRow('101', 300, 30), truckRow('102', -50, -5), truckRow('103', 0, 0), truckRow('104', null, null)];

  it('switches between the list and the tagged grid', async () => {
    const user = userEvent.setup();
    render(<RankingExplorer entity="truck" title="Truck profitability" query={pageQuery(rows)} params={params} onParamsChange={() => {}} />);
    expect(screen.getByRole('table')).toBeInTheDocument();
    expect(screen.getByText('4 trucks')).toBeInTheDocument();

    await user.click(screen.getByRole('radio', { name: 'Grid' }));
    expect(screen.queryByRole('table')).toBeNull();
    const cards = screen.getAllByTestId('truck-card');
    expect(cards.map((card) => within(card).getByText(/^(Profitable|Loss|Break-even|No cost data)$/).textContent)).toEqual([
      'Profitable',
      'Loss',
      'Break-even',
      'No cost data',
    ]);
  });

  it('asks the server to sort when a header is pressed, and marks the sorted column', async () => {
    const user = userEvent.setup();
    const onParamsChange = vi.fn();
    render(<RankingExplorer entity="truck" title="Trucks" query={pageQuery(rows)} params={params} onParamsChange={onParamsChange} />);
    expect(screen.getByRole('columnheader', { name: /Profit/ })).toHaveAttribute('aria-sort', 'descending');
    await user.click(screen.getByRole('button', { name: 'Gross' }));
    expect(onParamsChange).toHaveBeenCalledWith({ ...params, sort: 'gross', dir: 'desc', page: 1 });
  });

  it('driver rows show a dash with the reason, never 0, for cost and profit', () => {
    const driver: RankedEntity = { ...truckRow('Ann', null, null), cost: null, cpm: null };
    render(<RankingExplorer entity="driver" title="Driver revenue" query={pageQuery([driver])} params={{ ...params, sort: 'gross' }} onParamsChange={() => {}} />);
    const cells = screen.getAllByTitle("Profit per driver isn't available: costs aren't allocated to drivers.");
    expect(cells).toHaveLength(4);
    for (const cell of cells) expect(cell.textContent).toBe('—');
  });
});

// ---------------------------------------------------------------------------------- theme toggle

describe('ThemeToggle', () => {
  afterEach(() => {
    document.documentElement.removeAttribute('data-theme');
    delete (document as { startViewTransition?: unknown }).startViewTransition;
  });

  it('saves the other theme through the account appearance setting', async () => {
    document.documentElement.setAttribute('data-theme', 'light');
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(chooseAppearance).toHaveBeenCalledWith('u1', 'dark');
  });

  it('wipes with a view transition when motion is allowed', async () => {
    setReducedMotion(false);
    const startViewTransition = vi.fn((update: () => void) => {
      update();
      return { finished: Promise.resolve() };
    });
    (document as { startViewTransition?: unknown }).startViewTransition = startViewTransition;
    document.documentElement.setAttribute('data-theme', 'dark');
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole('button', { name: 'Switch to light theme' }));
    expect(startViewTransition).toHaveBeenCalledTimes(1);
    expect(chooseAppearance).toHaveBeenCalledWith('u1', 'light');
  });

  it('changes at once, without a transition, under reduced motion', async () => {
    setReducedMotion(true);
    const startViewTransition = vi.fn();
    (document as { startViewTransition?: unknown }).startViewTransition = startViewTransition;
    render(<ThemeToggle />);
    await userEvent.click(screen.getByRole('button', { name: 'Switch to dark theme' }));
    expect(startViewTransition).not.toHaveBeenCalled();
    expect(chooseAppearance).toHaveBeenCalledWith('u1', 'dark');
  });
});

// ------------------------------------------------------------------- data integrity (2026-10-25)

describe('data-integrity fields', () => {
  it('a withheld profit shows a dash with the reason, never 0 and never a change', () => {
    render(
      <KpiTile
        metric={compareMetricPeriods('profit', null, null)}
        icon={<span />}
        unavailableReason="Revenue is not connected, so profit would be cost alone."
      />,
    );
    const card = screen.getByTestId('kpi-profit');
    expect(within(card).getAllByText('—').length).toBeGreaterThan(0);
    expect(within(card).getByTestId('withheld-profit')).toHaveTextContent('Revenue is not connected');
    expect(within(card).queryByText(/\$0/)).toBeNull();
    expect(within(card).queryByText('vs previous period')).toBeNull();
  });

  it('the cost card explains net cost with before-recovery and recovered figures', async () => {
    const user = userEvent.setup();
    render(
      <KpiTile
        metric={compareMetricPeriods('cost', 900, 1000)}
        icon={<span />}
        details={[
          { label: 'Before recovery', value: '$1,000.00' },
          { label: 'Recovered', value: '-$100.00' },
        ]}
      />,
    );
    await user.click(screen.getByRole('button', { name: /worked out/ }));
    expect(await screen.findByText('Before recovery')).toBeInTheDocument();
    expect(screen.getByText('-$100.00')).toBeInTheDocument();
  });

  it('tags a one-sided truck No revenue / No cost data', () => {
    expect(profitTag({ profit: null, oneSided: 'cost_only' })).toBe('no_revenue');
    expect(profitTag({ profit: null, oneSided: 'revenue_only' })).toBe('no_cost');
  });

  it('puts data gaps first in Needs attention, and shows info as a word', () => {
    const order = attentionOrder([{ key: 'cpm_T1' }, { key: 'data_no_revenue' }, { key: 'margin_T1' }]);
    expect(order.map((i) => i.key)).toEqual(['data_no_revenue', 'cpm_T1', 'margin_T1']);
    render(
      <ul>
        <AlertCard
          insight={{
            key: 'data_no_revenue',
            severity: 'info',
            title: 'No loads in NeWay Loads',
            action: 'Add loads to connect revenue.',
            entity: null,
            evidence: { metric: 'gross', current: null, previous: null, change: null, changePct: null },
          }}
        />
      </ul>,
    );
    expect(screen.getByText('Info')).toBeInTheDocument();
    expect(screen.queryByRole('link')).toBeNull();
  });

  it('writes the fuel feed time in US Eastern', () => {
    expect(easternDateTime('2026-10-24T18:05:00Z')).toBe('Oct 24, 2:05 PM ET');
  });
});
