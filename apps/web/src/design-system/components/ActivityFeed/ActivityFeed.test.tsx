import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { ActivityFeed } from './ActivityFeed';

describe('ActivityFeed', () => {
  it('renders a sentence row with avatar, link target and relative time', () => {
    const at = new Date(Date.now() - 3 * 60_000);
    render(
      <ActivityFeed
        items={[
          {
            id: '1',
            actor: { name: 'Sarah Chen' },
            action: 'assigned Unit 2785 to',
            target: { label: 'Load L-100245', href: '/loads/100245' },
            at,
          },
        ]}
      />,
    );
    const row = screen.getByRole('listitem');
    expect(row).toHaveTextContent('Sarah Chen assigned Unit 2785 to Load L-100245');
    expect(screen.getByRole('img', { name: 'Sarah Chen' })).toHaveTextContent('SC');
    expect(screen.getByRole('link', { name: 'Load L-100245' })).toHaveAttribute(
      'href',
      '/loads/100245',
    );
    const time = screen.getByText('3 minutes ago');
    expect(time).toHaveAttribute('title', at.toISOString());
  });

  it('shows an empty message when there are no items', () => {
    render(<ActivityFeed items={[]} />);
    expect(screen.getByText('No recent activity')).toBeInTheDocument();
  });
});
