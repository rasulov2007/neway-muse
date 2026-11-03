import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import * as demo from '@/demo';
import { markAllNotificationsRead, markNotificationRead } from '@/demo';
import { renderShell } from './test-utils';

vi.mock('@/demo', async () => (await import('./demo-mock')).createDemoMock());

describe('NotificationCenter', () => {
  beforeEach(() => {
    // The mocked module is shared across tests in this file; restore the seeded notifications.
    (demo as unknown as { __reset: () => void }).__reset();
    vi.clearAllMocks();
  });

  it('opens from the bell, lists items and marks one read', async () => {
    const user = userEvent.setup();
    renderShell('/dashboard');
    await user.click(await screen.findByRole('button', { name: /Notifications/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    expect(await within(dialog).findByText(/Load L-100245 at risk/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Invoice INV-2041 paid/)).toBeInTheDocument();
    expect(within(dialog).getAllByText('Unread')).toHaveLength(2); // tab label + unread marker

    await user.click(within(dialog).getByRole('button', { name: /Load L-100245 at risk/ }));
    await waitFor(() => expect(vi.mocked(markNotificationRead)).toHaveBeenCalledWith('ntf_1'));
    // The list refetches; the unread marker disappears (only the tab label remains).
    await waitFor(() => expect(within(dialog).getAllByText('Unread')).toHaveLength(1));
  });

  it('filters to unread and marks all read', async () => {
    const user = userEvent.setup();
    renderShell('/dashboard');
    await user.click(await screen.findByRole('button', { name: /Notifications/ }));
    const dialog = await screen.findByRole('dialog', { name: 'Notifications' });
    await within(dialog).findByText(/Load L-100245 at risk/);
    await user.click(within(dialog).getByRole('tab', { name: /Unread/ }));
    expect(within(dialog).queryByText(/Invoice INV-2041 paid/)).not.toBeInTheDocument();

    await user.click(within(dialog).getByRole('button', { name: 'Mark all read' }));
    await waitFor(() => expect(vi.mocked(markAllNotificationsRead)).toHaveBeenCalled());
    expect(await within(dialog).findByText("You're all caught up")).toBeInTheDocument();
  });
});
