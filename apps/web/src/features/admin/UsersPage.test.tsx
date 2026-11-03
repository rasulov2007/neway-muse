import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { PERMISSION_CODES } from '@neway/shared';
import { renderPage } from '@/features/common/test-router';
import { UsersPage } from './UsersPage';

/** Users & access (owner's design, 2026-09-30): the status cards (archived on its own, 2026-10-22), the filters and the rows. */
const original = globalThis.fetch;
let listQueries: URLSearchParams[] = [];
const account = (over: Record<string, unknown>) => ({
  membershipId: 'mbr_1', userId: 'usr_1', name: 'Grace Harper', email: 'grace@test.local', phone: null,
  status: 'active', isOwner: false, roles: [{ id: 'rol_hr', code: 'hr_manager', name: 'HR Manager' }],
  employeeId: null, employeeName: null, employeeNumber: null, lastLoginAt: null, invitedAt: null,
  createdAt: '2026-09-01T00:00:00.000Z', ...over,
});

beforeEach(() => {
  listQueries = [];
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, 'http://localhost').pathname.replace(/^\/api\/v1/, '');
    const reply = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    if (path === '/admin/me') return reply({ permissions: [...PERMISSION_CODES] });
    if (path === '/admin/users/summary') return reply({ total: 17, active: 12, invited: 3, suspended: 1, disabled: 1, archived: 62 });
    if (path === '/admin/users') {
      listQueries.push(new URL(raw, 'http://localhost').searchParams);
      return reply({ data: [account({}), account({ membershipId: 'mbr_2', name: 'Ivan Invited', email: 'ivan@test.local', status: 'invited' })], total: 2, page: 1, pageSize: 25 });
    }
    if (path === '/admin/roles') return reply([]);
    return inner(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = original;
});

describe('Users & access', () => {
  it('shows the five status cards with their counts', async () => {
    renderPage(<UsersPage />, { routePath: '/', path: '/' });
    const cards = await screen.findByRole('region', { name: 'Accounts by status' });
    expect(await within(cards).findByText('17')).toBeVisible();
    for (const [label, n] of [['Active', '12'], ['Invited', '3'], ['Suspended', '1']] as const) {
      expect(within(within(cards).getByText(label).closest('button')!).getByText(n)).toBeVisible();
    }
  });

  it('lists users with status word, role, "Never" for no sign-in, and the right action', async () => {
    renderPage(<UsersPage />, { routePath: '/', path: '/' });
    const table = await screen.findByRole('table');
    expect(await within(table).findByText('Grace Harper')).toBeVisible();
    expect(within(table).getAllByText('HR Manager').length).toBe(2);
    expect(within(table).getAllByText('Never').length).toBe(2);
    expect(within(table).getByRole('button', { name: 'Issue password' })).toBeVisible();
    expect(within(table).getByRole('button', { name: 'Manage' })).toBeVisible();
    expect(screen.getByText(/2 matching accounts · 17 total accounts/)).toBeVisible();
  });

  it('leaves archived accounts out of Total and gives them a quiet card that lists them', async () => {
    renderPage(<UsersPage />, { routePath: '/admin/users', path: '/admin/users' });
    const cards = await screen.findByRole('region', { name: 'Accounts by status' });
    const total = (await within(cards).findByText('Total accounts')).closest('button')!;
    expect(await within(total).findByText('17')).toBeVisible();
    const archived = within(cards).getByText('Archived').closest('button')!;
    expect(within(archived).getByText('62')).toBeVisible();
    expect(archived).toHaveAttribute('aria-pressed', 'false');
    // The default list does not ask for archived accounts; the server leaves them out.
    await waitFor(() => expect(listQueries.length).toBeGreaterThan(0));
    expect(listQueries.every((q) => !q.get('status'))).toBe(true);
    await userEvent.click(archived);
    await waitFor(() => expect(listQueries.some((q) => q.get('status') === 'archived')).toBe(true));
    expect(await within(cards).findByRole('button', { pressed: true })).toBe(within(cards).getByText('Archived').closest('button'));
  });
});
