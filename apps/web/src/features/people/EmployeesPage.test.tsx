import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { EmployeesPage } from './EmployeesPage';

/**
 * Employees (owner, 2026-10-26): only people who filled in Complete your profile are listed by
 * default; the rest sit behind "Not yet filled"; drivers are on the Drivers page.
 */
const original = globalThis.fetch;
const listScopes: (string | null)[] = [];
const summaryScopes: (string | null)[] = [];

function person(id: string, name: string, profileState: string) {
  return {
    id,
    employeeNumber: `EMP-${id}`,
    name,
    firstName: name.split(' ')[0],
    lastName: name.split(' ')[1],
    position: 'Dispatcher',
    department: 'dispatch',
    employmentType: 'full_time',
    location: null,
    status: 'active',
    hireDate: '2026-10-01',
    workEmail: `${id}@example.com`,
    phone: '+1 312 555 0100',
    driverId: null,
    profileState,
  };
}

beforeEach(() => {
  listScopes.length = 0;
  summaryScopes.length = 0;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://localhost');
    const path = url.pathname.replace(/^\/api\/v1/, '');
    const reply = (b: unknown) =>
      new Response(JSON.stringify(b), { status: 200, headers: { 'content-type': 'application/json' } });
    const scope = url.searchParams.get('scope');
    if (path === '/admin/me') {
      return reply({ userId: 'u1', name: 'HR', roles: ['hr'], permissions: ['employees.view'] });
    }
    if (path === '/employees/summary') {
      summaryScopes.push(scope);
      return reply({
        total: scope === 'profile_incomplete' ? 2 : 1,
        byStatus: [{ status: 'active', count: scope === 'profile_incomplete' ? 2 : 1 }],
        byDepartment: [],
        drivers: 0,
        staff: 1,
        profileViews: { complete: 1, incomplete: 2 },
      });
    }
    if (path === '/employees') {
      listScopes.push(scope);
      const data =
        scope === 'profile_incomplete'
          ? [person('e2', 'Adam Adam', 'asked'), person('e3', 'Ali Ali', 'no_account')]
          : [person('e1', 'Ann Lee', 'complete')];
      return reply({ data, total: data.length, page: 1, pageSize: 25 });
    }
    return reply({});
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = original;
});

describe('Employees page', () => {
  it('lists only profile-complete employees by default and points drivers to the Drivers page', async () => {
    renderPage(<EmployeesPage />);
    expect(await screen.findByText('Ann Lee')).toBeInTheDocument();
    expect(listScopes).toContain('profile_complete');
    expect(listScopes).not.toContain(null);
    expect(summaryScopes).toContain('profile_complete');
    expect(await screen.findByRole('button', { name: 'Profile complete (1)' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('button', { name: 'Not yet filled (2)' })).toHaveAttribute('aria-pressed', 'false');
    expect(screen.queryByText('Adam Adam')).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Drivers page' })).toHaveAttribute('href', '/drivers');
  });

  it('the Not yet filled view lists the others with a profile word per row', async () => {
    const user = userEvent.setup();
    renderPage(<EmployeesPage />);
    await user.click(await screen.findByRole('button', { name: 'Not yet filled (2)' }));
    expect(await screen.findByText('Adam Adam')).toBeInTheDocument();
    expect(screen.getByText('Ali Ali')).toBeInTheDocument();
    expect(screen.queryByText('Ann Lee')).not.toBeInTheDocument();
    expect(listScopes).toContain('profile_incomplete');
    expect(screen.getByText('Asked to complete profile')).toBeInTheDocument();
    expect(screen.getByText('No account')).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Not yet filled (2)' })).toHaveAttribute('aria-pressed', 'true'),
    );
  });
});
