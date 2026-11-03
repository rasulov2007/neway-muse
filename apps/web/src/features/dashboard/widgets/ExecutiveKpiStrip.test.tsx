import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { TooltipProvider } from '@/design-system';
import { maskedMetric, metric, nullMetric, overviewFixture } from '../__fixtures__';
import { FULL_VISIBILITY } from '../visibility';
import { ExecutiveKpiStrip } from './ExecutiveKpiStrip';

function renderStrip(overview = overviewFixture(), onDrilldown = vi.fn()) {
  render(
    <TooltipProvider>
      <ExecutiveKpiStrip
        overview={overview}
        visibility={FULL_VISIBILITY}
        onDrilldown={onDrilldown}
      />
    </TooltipProvider>,
  );
  return { onDrilldown };
}

describe('ExecutiveKpiStrip', () => {
  it('renders the three rows with full API values and absolute changes', () => {
    renderStrip();
    expect(screen.getByText('$125,000.50')).toBeInTheDocument();
    expect(screen.getByText('$33,800.50')).toBeInTheDocument();
    expect(screen.getByText('$2.31')).toBeInTheDocument();
    expect(screen.getByText('28.0%')).toBeInTheDocument();
    expect(screen.getByText('54,000 mi')).toBeInTheDocument();
    expect(screen.getByText('Reconciled')).toBeInTheDocument();
    expect(screen.getByText('estimated $5K')).toBeInTheDocument();
  });

  it('shows the change as an absolute amount with a direction, not a percentage', () => {
    renderStrip();
    const gross = screen.getByRole('button', { name: /^Gross/ });
    // 125,000.50 - 110,000 = 15,000.50, announced as an increase.
    expect(within(gross).getByText('$15,000.50')).toBeInTheDocument();
    expect(within(gross).getByText('Up')).toBeInTheDocument();
    expect(within(gross).queryByText(/%/)).not.toBeInTheDocument();
    // 54,000 - 50,000 miles, without the unit the value above already carries.
    expect(screen.getByText('4,000')).toBeInTheDocument();
  });

  it('names the comparison period once in the heading, never on a card', () => {
    renderStrip();
    expect(screen.queryByText(/vs previous period/)).not.toBeInTheDocument();
    expect(screen.queryByText('vs prev.')).not.toBeInTheDocument();
  });

  it('says which trucks the per-truck averages divide by', () => {
    renderStrip();
    expect(screen.getByText('Avg gross / truck')).toBeInTheDocument();
    expect(screen.queryByText('per active truck')).not.toBeInTheDocument();
    expect(
      screen.getByText(/Per-truck averages divide by the trucks that ran revenue/),
    ).toBeInTheDocument();
  });

  it('renders "—" with the reasons and "••••••" when masked', () => {
    const overview = overviewFixture();
    overview.financial.operatingProfit = nullMetric('no_expense_data');
    overview.fleet.avgGrossPerTruck = {
      ...nullMetric('no_active_trucks'),
      reasons: ['no_active_trucks', 'zero_gross'],
    };
    overview.financial.gross = maskedMetric();
    renderStrip(overview);

    const profit = screen.getByTitle('No expense data for this period');
    expect(within(profit).getByText('—')).toBeInTheDocument();
    expect(
      screen.getByTitle('No active trucks in this period · No revenue in this period'),
    ).toBeInTheDocument();
    const gross = screen.getByTitle('Hidden by your financial visibility');
    expect(within(gross).getByText('••••••')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^Gross/ })).not.toBeInTheDocument();
  });

  it('still shows the change when the previous period was a real zero', () => {
    // previous 0 makes the percentage undefined, but the absolute change is known and real.
    const overview = overviewFixture();
    overview.financial.gross = metric(1000, 0);
    renderStrip(overview);
    const gross = screen.getByRole('button', { name: /^Gross/ });
    // Coming from zero, the whole value is the change: it appears as both.
    expect(within(gross).getAllByText('$1,000.00')).toHaveLength(2);
    expect(within(gross).getByText('Up')).toBeInTheDocument();
  });

  it('says "no comparison" when the API has no previous value at all', () => {
    const overview = overviewFixture();
    overview.financial.gross = { ...metric(1000, 0), previous: null, delta: null, deltaPct: null };
    renderStrip(overview);
    const gross = screen.getByRole('button', { name: /^Gross/ });
    expect(within(gross).getByText('— no comparison')).toBeInTheDocument();
  });

  it('footnotes a mismatch and opens a drill-down from the gross card', async () => {
    const overview = overviewFixture({
      reconciliation: {
        status: 'mismatch',
        dashboardGross: 125000.5,
        ledgerGross: 120000,
        difference: 5000.5,
      },
    });
    const { onDrilldown } = renderStrip(overview);
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(screen.getByText(/differs from the revenue ledger/)).toHaveTextContent('$5,000.50');
    expect(screen.getByText('Mismatch')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Gross/ }));
    expect(onDrilldown).toHaveBeenCalledWith('gross');
  });
});
