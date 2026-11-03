import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { Truck } from 'lucide-react';
import { describe, expect, it, vi } from 'vitest';
import { KpiCard } from './KpiCard';

describe('KpiCard', () => {
  it('renders label, value, delta tone and hint', () => {
    const { rerender } = render(
      <KpiCard
        label="Revenue"
        value="$128,400"
        delta={{ value: 4.2, label: 'vs last week' }}
        hint="MTD"
        icon={<Truck />}
      />,
    );
    // Porcelain number card: the label is 13/600 text-2, not an uppercase eyebrow, and the value
    // carries the 22/800 step.
    expect(screen.getByText('Revenue')).toHaveClass('text-nw-text-2');
    // A size smaller on a phone so a long figure fits its card; the SPEC size from sm up.
    expect(screen.getByText('$128,400')).toHaveClass('text-xl', 'sm:text-2xl');
    expect(screen.getByText('+4.2%')).toBeInTheDocument();
    expect(screen.getByText('+4.2%').closest('span.inline-flex')).toHaveClass('text-nw-done-text');
    expect(screen.getByText('vs last week')).toBeInTheDocument();
    expect(screen.getByText('MTD')).toBeInTheDocument();

    // an increase that is bad (e.g. overdue invoices) renders in danger
    rerender(<KpiCard label="Overdue" value={12} delta={{ value: 10, positiveIsGood: false }} />);
    expect(screen.getByText('+10%').closest('span.inline-flex')).toHaveClass('text-nw-urgent-text');

    rerender(<KpiCard label="Idle" value={3} delta={{ value: 0 }} />);
    expect(screen.getByText('0%').closest('span.inline-flex')).toHaveClass('text-nw-text-3');
  });

  it('renders a skeleton while loading', () => {
    const { container } = render(<KpiCard label="Revenue" value="1" loading />);
    expect(screen.queryByText('Revenue')).toBeNull();
    expect(container.querySelector('.animate-pulse')).toBeInTheDocument();
  });

  it('becomes a button when onClick is given and renders a sparkline', async () => {
    const onClick = vi.fn();
    const { container } = render(
      <KpiCard label="Active loads" value={42} onClick={onClick} sparkline={[3, 5, 4, 8, 6]} />,
    );
    await userEvent.click(screen.getByRole('button', { name: /Active loads/ }));
    expect(onClick).toHaveBeenCalledTimes(1);
    expect(container.querySelector('svg.recharts-surface')).toBeInTheDocument();
  });
});
