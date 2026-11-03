import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { setClockForTests } from '@/lib/clock';
import { TEST_ACCOUNT } from '@/test/roster-server';
import { ShopWorkOrderPage } from './ShopWorkOrderPage';

const NOW = '2026-09-17T14:30:00-05:00';

beforeEach(() => setClockForTests(NOW));
afterEach(() => setClockForTests(null));

function render() {
  return renderPage(<ShopWorkOrderPage orderId="wo_1" />, {
    routePath: '/fleet/shop/$orderId',
    path: '/fleet/shop/wo_1',
  });
}

/** Signs the suite in with exactly these permission codes, for the reopen rule. */
function signedInWith(permissions: string[]): void {
  window.localStorage.setItem(
    'neway.session.account',
    JSON.stringify({ ...TEST_ACCOUNT, permissions }),
  );
}

describe('ShopWorkOrderPage', () => {
  it('shows the stage, the live downtime and the history, and no money', async () => {
    render();

    expect(await screen.findByText('Unit 3008 · Repair')).toBeInTheDocument();
    // Counted to the company clock: 2026-09-08 13:00Z to 2026-09-17 19:30Z.
    expect(await screen.findByText('9d 6h')).toBeInTheDocument();
    expect(screen.getByText('Injector ordered from Fort Worth')).toBeInTheDocument();
    expect(document.body.textContent).not.toMatch(/\$/);
  });

  it('will not complete a work order until somebody says what was done', async () => {
    render();
    const user = userEvent.setup();

    const complete = await screen.findByRole('button', { name: 'Complete' });
    expect(complete).toBeDisabled();
    expect(screen.getByText('Say what was done before completing it.')).toBeInTheDocument();

    await user.type(
      screen.getByLabelText(/What was done/),
      'Injector replaced, road tested clean.',
    );
    expect(complete).toBeEnabled();

    await user.click(complete);
    // Closed: the form is gone, what was done is on the record, and the downtime is the frozen
    // figure the server sent rather than a number that keeps climbing.
    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument(),
    );
    // On the record and in the history, which is two places by design.
    expect(screen.getAllByText('Injector replaced, road tested clean.').length).toBeGreaterThan(0);
    expect(screen.getByText('9d 6h')).toBeInTheDocument();
  });

  it('writes a history entry for every stage change', async () => {
    render();
    const user = userEvent.setup();

    const stages = await screen.findByText('Where it is now');
    const panel = stages.closest('section') as HTMLElement;
    await user.click(within(panel).getByRole('button', { name: /In repair/ }));

    await waitFor(() =>
      expect(within(panel).getByRole('button', { name: /In repair/ })).toHaveAttribute(
        'aria-pressed',
        'true',
      ),
    );
    const history = screen.getByText('Activity').closest('section') as HTMLElement;
    expect(within(history).getByText('In repair')).toBeInTheDocument();
  });

  it('offers reopening only to an account that may edit the fleet', async () => {
    signedInWith([]);
    const { unmount } = render();
    // Nothing to reopen while it is open; the rule shows on a completed record.
    expect(await screen.findByRole('button', { name: 'Complete' })).toBeInTheDocument();
    unmount();

    signedInWith(['maintenance.view', 'maintenance.edit']);
    render();
    const user = userEvent.setup();
    await user.type(await screen.findByLabelText(/What was done/), 'Done.');
    await user.click(screen.getByRole('button', { name: 'Complete' }));

    await waitFor(() =>
      expect(screen.queryByRole('button', { name: 'Complete' })).not.toBeInTheDocument(),
    );
    expect(screen.queryByRole('button', { name: 'Reopen repair' })).not.toBeInTheDocument();
    expect(
      screen.getByText("Reopening a completed work order is a fleet manager's action."),
    ).toBeInTheDocument();
  });

  it('offers reopening to a fleet manager', async () => {
    signedInWith(['maintenance.view', 'maintenance.edit', 'trucks.edit']);
    render();
    const user = userEvent.setup();

    await user.type(await screen.findByLabelText(/What was done/), 'Done.');
    await user.click(screen.getByRole('button', { name: 'Complete' }));

    await waitFor(() => expect(screen.getByRole('button', { name: 'Reopen repair' })).toBeInTheDocument());
  });
});
