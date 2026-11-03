import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { dispatchFixture } from '../__fixtures__';
import { FULL_VISIBILITY, visibilityOf } from '../visibility';
import { DispatchWidget } from './DispatchWidget';

function rowOf(name: string) {
  const cell = screen.getByText(name);
  const row = cell.closest('tr');
  if (!row) throw new Error(`no row for ${name}`);
  return row;
}

describe('DispatchWidget', () => {
  it('ranks teams by gross, marks the leader and draws a gross bar per team', () => {
    render(<DispatchWidget dispatch={dispatchFixture()} visibility={FULL_VISIBILITY} />);

    const alpha = rowOf('Team Alpha');
    const bravo = rowOf('Team Bravo');
    expect(within(alpha).getByTitle('Rank 1 by gross')).toHaveTextContent('1');
    expect(within(bravo).getByTitle('Rank 2 by gross')).toHaveTextContent('2');
    expect(within(alpha).getByText('Leader')).toBeInTheDocument();
    expect(within(bravo).queryByText('Leader')).not.toBeInTheDocument();

    // Proportion-of-best bars: the leader is full width, the runner-up proportionally shorter.
    expect(screen.getAllByTestId('gross-bar')).toHaveLength(2);
    const alphaBar = within(alpha).getByTestId('gross-bar').firstElementChild as HTMLElement;
    const bravoBar = within(bravo).getByTestId('gross-bar').firstElementChild as HTMLElement;
    expect(alphaBar.style.width).toBe('100%');
    expect(bravoBar.style.width).toBe('92%');
  });

  it('sums the visible rows into a header strip of week totals', () => {
    render(<DispatchWidget dispatch={dispatchFixture()} visibility={FULL_VISIBILITY} />);

    const totals = screen.getByTestId('dispatch-totals');
    expect(within(totals).getByText('$80.5K')).toBeInTheDocument(); // 42,000 + 38,500
    expect(within(totals).getByText('36')).toBeInTheDocument(); // 18 + 18 loads
    expect(within(totals).getByText('18')).toBeInTheDocument(); // 9 + 9 active trucks
    expect(within(totals).getByText('$2.41')).toBeInTheDocument(); // blended RPM
    expect(within(totals).getByText('2 teams')).toBeInTheDocument();
  });

  it('labels a projected full-week gross with an Estimated badge', () => {
    render(<DispatchWidget dispatch={dispatchFixture()} visibility={FULL_VISIBILITY} />);

    const alpha = rowOf('Team Alpha');
    expect(within(alpha).getByText('$58.8K')).toBeInTheDocument(); // 42,000 x 1.4
    expect(within(alpha).getByText('Estimated')).toBeInTheDocument();
    // The actual gross total is never presented as the projection.
    expect(within(screen.getByTestId('dispatch-totals')).queryByText('Estimated')).toBeNull();
  });

  it('renders the RPM bucket tiles and an accessible bar chart of the same counts', () => {
    render(<DispatchWidget dispatch={dispatchFixture()} visibility={FULL_VISIBILITY} />);

    for (const label of ['RPM < $1.50', 'RPM $1.50 – 2.00', 'RPM $2.00 – 2.50', 'RPM $2.50+']) {
      expect(screen.getByText(label)).toBeInTheDocument();
    }
    const chart = screen.getByRole('img', { name: /Trucks by weekly RPM band/ });
    expect(chart).toHaveAttribute('aria-label', expect.stringContaining('$2.50+: 4 trucks'));
  });

  it('switches to the cumulative tab and shows one column per week plus a total', async () => {
    render(<DispatchWidget dispatch={dispatchFixture()} visibility={FULL_VISIBILITY} />);

    await userEvent.click(screen.getByRole('tab', { name: 'Cumulative' }));

    expect(screen.getByRole('columnheader', { name: /Wk 1/ })).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: /Wk 2/ })).toBeInTheDocument();
    const week3 = screen.getByRole('columnheader', { name: /Wk 3/ });
    expect(week3).toHaveTextContent('In progress');
    expect(screen.getByRole('columnheader', { name: 'Total' })).toBeInTheDocument();

    const alpha = rowOf('Team Alpha');
    expect(within(alpha).getByText('$46.2K')).toBeInTheDocument(); // week 1
    expect(within(alpha).getByText('$90.3K')).toBeInTheDocument(); // cumulative total
    // The projected week is labelled, never folded silently into an actual.
    expect(within(alpha).getAllByText('Est.').length).toBeGreaterThan(0);
    // The week-3 column footer is a mixed sum, so it is labelled too.
    expect(screen.getAllByText('Est.').length).toBeGreaterThan(2);

    expect(screen.queryByTestId('dispatch-totals')).toBeNull();
  });

  it('masks money and hides the gross bars when financial visibility is off', () => {
    render(
      <DispatchWidget
        dispatch={dispatchFixture({ masked: true })}
        visibility={visibilityOf(true)}
      />,
    );

    expect(screen.getAllByText('••••••').length).toBeGreaterThan(8);
    expect(screen.queryByText('$42K')).not.toBeInTheDocument();
    expect(screen.queryByText('$80.5K')).not.toBeInTheDocument();
    expect(screen.queryAllByTestId('gross-bar')).toHaveLength(0);
    // Non-financial operational counts stay visible.
    expect(screen.getByText('RPM $2.50+')).toBeInTheDocument();
  });
});
