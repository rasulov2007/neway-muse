import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Notification } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { NotificationsPage } from './NotificationsPage';

function notification(overrides: Partial<Notification> = {}): Notification {
  return {
    id: 'ntf_1',
    kind: 'dispatch',
    severity: 'critical',
    title: 'L-100235 at risk of missing appointment',
    body: 'ETA is 1h 20m past the appointment window.',
    department: 'dispatch',
    entity: { type: 'load', id: 'ld_1', label: 'L-100235' },
    source: 'ai',
    actionRequired: true,
    at: '2026-09-06T19:05:00.000Z',
    readAt: null,
    ...overrides,
  };
}

const FIXTURE: Notification[] = [
  notification(),
  notification({
    id: 'ntf_2',
    kind: 'maintenance',
    severity: 'warning',
    title: 'Unit 3091 PM service overdue',
    body: 'PM service is 1,800 mi past due.',
    department: 'maintenance',
    entity: { type: 'truck', id: 'trk_3091', label: 'Unit 3091' },
    source: 'system',
    actionRequired: true,
  }),
  notification({
    id: 'ntf_3',
    kind: 'comment',
    severity: 'info',
    title: 'Weekly safety meeting Monday 7:00 AM',
    body: 'Attendance required for drivers in the yard.',
    department: 'safety',
    entity: null,
    source: 'user',
    actionRequired: false,
    readAt: '2026-09-06T19:10:00.000Z',
  }),
];

const listNotifications = vi.fn();
const markNotificationRead = vi.fn();
const markNotificationUnread = vi.fn();
const markAllNotificationsRead = vi.fn();
const deleteNotification = vi.fn();

vi.mock('@/demo', () => ({
  listNotifications: (...args: unknown[]) => listNotifications(...args),
  markNotificationRead: (...args: unknown[]) => markNotificationRead(...args),
  markNotificationUnread: (...args: unknown[]) => markNotificationUnread(...args),
  markAllNotificationsRead: (...args: unknown[]) => markAllNotificationsRead(...args),
  deleteNotification: (...args: unknown[]) => deleteNotification(...args),
}));

function render() {
  return renderPage(<NotificationsPage />, { routePath: '/notifications', path: '/notifications' });
}

function tab(name: RegExp) {
  return screen.getByRole('tab', { name });
}

describe('NotificationsPage', () => {
  beforeEach(() => {
    window.localStorage.clear();
    vi.clearAllMocks();
    listNotifications.mockResolvedValue({ data: FIXTURE, total: 3, unread: 2 });
    markNotificationRead.mockResolvedValue(FIXTURE[0]);
    markNotificationUnread.mockResolvedValue(FIXTURE[2]);
    markAllNotificationsRead.mockResolvedValue(2);
    deleteNotification.mockResolvedValue(true);
  });

  it('renders each event with its object, priority and action, counted from real data', async () => {
    render();
    expect(await screen.findAllByTestId('notification-row')).toHaveLength(3);

    expect(screen.getByText('L-100235 at risk of missing appointment')).toBeInTheDocument();
    expect(screen.getAllByText('L-100235').length).toBeGreaterThan(0);
    expect(screen.getByText('Critical')).toBeInTheDocument();
    expect(screen.getAllByText('Action required')).toHaveLength(2);
    expect(screen.getByRole('button', { name: /Open load/ })).toBeInTheDocument();

    // Counts come from the data, never from a constant.
    expect(tab(/^All/)).toHaveTextContent('3');
    expect(tab(/^Needs action/)).toHaveTextContent('2');
    expect(tab(/^Unread/)).toHaveTextContent('2');
    expect(tab(/^Mentions/)).toHaveTextContent('1');
    expect(tab(/^System/)).toHaveTextContent('1');
  });

  it('separates "needs action" from "unread"', async () => {
    // The safety-meeting post is read; the two operational events are unread and need action.
    render();
    await screen.findAllByTestId('notification-row');

    await userEvent.click(tab(/^Needs action/));
    const rows = await screen.findAllByTestId('notification-row');
    expect(rows).toHaveLength(2);
    expect(within(rows[0]!).getByText(/at risk|PM service/)).toBeInTheDocument();
    expect(screen.queryByText('Weekly safety meeting Monday 7:00 AM')).not.toBeInTheDocument();
  });

  it('searches titles, bodies and related object labels', async () => {
    render();
    await screen.findAllByTestId('notification-row');

    await userEvent.type(screen.getByRole('searchbox'), '3091');
    await waitFor(async () =>
      expect(await screen.findAllByTestId('notification-row')).toHaveLength(1),
    );
    expect(screen.getByText('Unit 3091 PM service overdue')).toBeInTheDocument();
  });

  it('marks an event read and back to unread through the row menu', async () => {
    render();
    await screen.findAllByTestId('notification-row');

    const unreadRow = screen.getAllByTestId('notification-row')[0]!;
    await userEvent.click(within(unreadRow).getByRole('button', { name: /^Actions for/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Mark as read' }));
    await waitFor(() => expect(markNotificationRead).toHaveBeenCalledWith('ntf_1'));

    const readRow = screen.getAllByTestId('notification-row')[2]!;
    await userEvent.click(within(readRow).getByRole('button', { name: /^Actions for/ }));
    await userEvent.click(await screen.findByRole('menuitem', { name: 'Mark as unread' }));
    await waitFor(() => expect(markNotificationUnread).toHaveBeenCalledWith('ntf_3'));
  });

  it('muting a category hides its events and their counts', async () => {
    render();
    await screen.findAllByTestId('notification-row');
    expect(tab(/^All/)).toHaveTextContent('3');

    await userEvent.click(screen.getByRole('switch', { name: 'Fleet & maintenance' }));

    await waitFor(async () =>
      expect(await screen.findAllByTestId('notification-row')).toHaveLength(2),
    );
    expect(tab(/^All/)).toHaveTextContent('2');
    expect(screen.queryByText('Unit 3091 PM service overdue')).not.toBeInTheDocument();
  });

  it('shows a filter-specific empty state rather than the caught-up one', async () => {
    render();
    await screen.findAllByTestId('notification-row');

    await userEvent.type(screen.getByRole('searchbox'), 'zzzz');
    expect(await screen.findByText('No notifications found')).toBeInTheDocument();
    expect(screen.getByText('Try changing your filters or search query.')).toBeInTheDocument();
  });

  it('shows a retryable error state that keeps the raw failure out of the copy', async () => {
    listNotifications.mockRejectedValue(new Error('ECONNREFUSED 127.0.0.1:3000'));
    render();

    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText("Notifications couldn't be loaded")).toBeInTheDocument();
    expect(within(alert).getByText('Please try again.')).toBeInTheDocument();
    // The technical detail sits behind a disclosure that ships closed and is compiled out of
    // production builds, so the user-facing copy never carries the transport error.
    expect(alert.querySelector('details')?.open).toBe(false);

    listNotifications.mockResolvedValue({ data: FIXTURE, total: 3, unread: 2 });
    await userEvent.click(within(alert).getByRole('button', { name: /Try again/i }));
    expect(await screen.findAllByTestId('notification-row')).toHaveLength(3);
  });

  it('says plainly that email and Telegram are not connected', async () => {
    render();
    await screen.findAllByTestId('notification-row');

    const delivery = screen.getByTestId('notification-delivery');
    expect(within(delivery).getAllByText('Not connected')).toHaveLength(2);
    expect(within(delivery).getByRole('switch', { name: 'In-app' })).toBeDisabled();
  });
});
