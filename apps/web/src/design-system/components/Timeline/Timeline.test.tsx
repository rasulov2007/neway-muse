import { render, screen } from '@testing-library/react';
import { Truck } from 'lucide-react';
import { describe, expect, it } from 'vitest';
import { Timeline } from './Timeline';

const at = new Date(2026, 8, 6, 14, 14); // local 2:14 PM

describe('Timeline', () => {
  it('renders items with formatted time and an absolute title', () => {
    render(
      <Timeline
        items={[
          {
            id: '1',
            at,
            title: 'Load dispatched',
            description: 'To Unit 2785',
            tone: 'info',
            actor: { name: 'Sarah Chen' },
          },
          { id: '2', at: at.toISOString(), title: 'Arrived at pickup', icon: <Truck /> },
        ]}
      />,
    );
    expect(screen.getAllByRole('listitem')).toHaveLength(2);
    expect(screen.getByText('Load dispatched')).toBeInTheDocument();
    expect(screen.getByText('To Unit 2785')).toBeInTheDocument();
    expect(screen.getByText('by Sarah Chen')).toBeInTheDocument();
    const times = screen.getAllByText('2:14 PM');
    expect(times).toHaveLength(2);
    expect(times[0]).toHaveAttribute('title', at.toISOString());
    expect(times[0]).toHaveAttribute('datetime', at.toISOString());
  });

  it('accepts a custom time formatter', () => {
    render(<Timeline items={[{ id: '1', at, title: 'T' }]} formatTime={() => 'now'} dense />);
    expect(screen.getByText('now')).toBeInTheDocument();
  });
});
