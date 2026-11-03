import { fireEvent, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import type { Load } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { PayDatePanel } from './PayDatePanel';

/**
 * "Counts for pay on" (owner, 2026-10-21): the load page says when a delivered load counts for
 * driver pay and which Monday-noon pay week that is; Accounting can set another time, Eastern,
 * with a reason, and the page then says who changed it.
 */
const delivered = { id: 'ld_pay', loadNumber: 'L-100245', status: 'delivered' } as unknown as Load;

describe('the load’s pay date', () => {
  it('shows the delivered time and the pay week it puts the load in', async () => {
    renderPage(<PayDatePanel load={delivered} />);
    const panel = await screen.findByTestId('pay-date-panel');
    expect(within(panel).getByText('Delivered time')).toBeVisible();
    expect(within(panel).getByText('Mon Oct 19, 12:00 PM – Mon Oct 26, 12:00 PM ET')).toBeVisible();
    expect(within(panel).getAllByText('Mon Oct 19, 2026, 7:30 PM ET').length).toBeGreaterThan(0);
    expect(within(panel).queryByTestId('pay-date-changed-by')).toBeNull();
  });

  it('Accounting sets “Counts for pay on” with a reason; the load moves to that week and says who changed it', async () => {
    const user = userEvent.setup();
    renderPage(<PayDatePanel load={delivered} />);
    await user.click(await screen.findByRole('button', { name: 'Change pay date' }));
    const form = screen.getByTestId('pay-date-form');
    const save = within(form).getByRole('button', { name: 'Save pay date' });
    fireEvent.change(within(form).getByLabelText('Counts for pay on date'), { target: { value: '2026-10-19' } });
    fireEvent.change(within(form).getByLabelText('Counts for pay on time'), { target: { value: '10:00' } });
    // The reason is required.
    expect(save).toBeDisabled();
    await user.type(within(form).getByLabelText('Pay date reason'), 'Facility closed Sunday; driver was there');
    expect(save).toBeEnabled();
    await user.click(save);

    const panel = await screen.findByTestId('pay-date-panel');
    expect(await within(panel).findByText('Set by Accounting')).toBeVisible();
    expect(within(panel).getByText('Mon Oct 12, 12:00 PM – Mon Oct 19, 12:00 PM ET')).toBeVisible();
    expect(within(panel).getByText('Mon Oct 19, 2026, 10:00 AM ET')).toBeVisible();
    expect(within(panel).getByTestId('pay-date-changed-by')).toHaveTextContent('Changed by System Administrator');
    expect(within(panel).getByTestId('pay-date-changed-by')).toHaveTextContent('Facility closed Sunday; driver was there');
  });

  it('is not shown before the load is completed', () => {
    renderPage(<PayDatePanel load={{ ...delivered, status: 'in_transit' } as unknown as Load} />);
    expect(screen.queryByText('Driver pay')).toBeNull();
  });
});
