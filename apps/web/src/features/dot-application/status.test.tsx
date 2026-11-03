import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { DOT_APP_STATUSES } from '@neway/shared';
import { DOT_APP_STATUS_FAMILY, DotAppStatusBadge, EmailStatusBadge, dotAppStatusFamily, driverNumber } from './status';

/** Status = symbol + word + colour: every application status has a family and a word. */
describe('DOT application status look', () => {
  it('maps the journey onto Porcelain families', () => {
    expect(dotAppStatusFamily('sent')).toBe('moving');
    expect(dotAppStatusFamily('opened')).toBe('moving');
    expect(dotAppStatusFamily('in_progress')).toBe('moving');
    expect(dotAppStatusFamily('submitted')).toBe('info');
    expect(dotAppStatusFamily('under_review')).toBe('info');
    expect(dotAppStatusFamily('changes_requested')).toBe('warning');
    expect(dotAppStatusFamily('approved')).toBe('done');
    expect(dotAppStatusFamily('hired')).toBe('done');
    expect(dotAppStatusFamily('rejected')).toBe('urgent');
    expect(Object.keys(DOT_APP_STATUS_FAMILY).sort()).toEqual([...DOT_APP_STATUSES].sort());
  });

  it('draws the symbol and the word, never colour alone', () => {
    const { container } = render(<DotAppStatusBadge status="under_review" />);
    const badge = screen.getByTestId('dot-app-status');
    expect(badge).toHaveTextContent('Under Safety review');
    expect(badge).toHaveAttribute('data-family', 'info');
    expect(container.querySelector('svg')).not.toBeNull();
  });

  it('says a bounced link email plainly', () => {
    render(<EmailStatusBadge status="bounced" />);
    expect(screen.getByTestId('dot-app-email-bounced')).toHaveTextContent('Email bounced — check address');
  });

  it('shows the reserved driver number', () => {
    expect(driverNumber('drv_2118')).toBe('D-2118');
    expect(driverNumber(null)).toBe('—');
  });
});
