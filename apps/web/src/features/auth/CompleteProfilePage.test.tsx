import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from './AuthGate';
import { AuthProvider } from './AuthProvider';

/**
 * Complete your profile (owner, 2026-10-26): a new account is held on the page before anything
 * else opens, the warning is at the top, the email is the account's and read-only, Shift time is
 * required, and what is sent is the person's own fields only.
 */
const ACCOUNT = {
  membershipId: 'mbr_1',
  userId: 'usr_1',
  name: 'Dana Dispatch',
  email: 'dana@example.com',
  companyId: 'co_1',
  roles: ['dispatcher'],
  permissions: [],
  isOwner: false,
  appearance: 'system',
  mustChangePassword: false,
};

let put: Record<string, unknown> | null = null;

function stub(profileRequired: boolean) {
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      const path = new URL(raw, 'http://localhost').pathname.replace(/^\/api\/v1/, '');
      const reply = (b: unknown) =>
        Promise.resolve(new Response(JSON.stringify(b), { status: 200, headers: { 'Content-Type': 'application/json' } }));
      if (path === '/auth/me') return reply({ ...ACCOUNT, profileRequired, signedIn: true });
      if (path === '/me/profile' && init?.method === 'PUT') {
        put = JSON.parse(String(init.body)) as Record<string, unknown>;
        return reply({ required: false, completedAt: '2026-10-26T12:00:00.000Z', email: ACCOUNT.email, employee: null });
      }
      if (path === '/me/profile') return reply({ required: profileRequired, completedAt: null, email: ACCOUNT.email, employee: null });
      return reply({});
    }),
  );
}

function renderGate() {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <AuthGate>
          <h1>the application</h1>
        </AuthGate>
      </AuthProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  put = null;
  window.localStorage.clear();
  window.localStorage.setItem('neway.session.token', 'tok');
});
afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
  window.history.replaceState(null, '', '/');
});

describe('Complete your profile', () => {
  it('holds a new account on the page, whatever page was asked for', async () => {
    window.history.replaceState(null, '', '/dispatch/board');
    stub(true);
    renderGate();
    expect(await screen.findByRole('heading', { name: 'Complete your profile' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'the application' })).not.toBeInTheDocument();
    expect(window.location.pathname).toBe('/complete-profile');
    expect(await screen.findByText('Anyone who enters false information will be fined.')).toBeVisible();
  });

  it('prefills the account email read-only, requires the shift, and sends only personal fields', async () => {
    const user = userEvent.setup();
    stub(true);
    renderGate();
    const email = await screen.findByLabelText('Email');
    expect(email).toHaveValue('dana@example.com');
    expect(email).toHaveAttribute('readonly');
    expect(screen.getByLabelText('Full name')).toHaveValue('Dana Dispatch');
    // No department, title, role or pay on the page.
    // Nor Location (owner, 2026-10-26).
    for (const label of ['Department', 'Title', 'Role', 'Pay type', 'Hire date', 'Status', 'Location']) {
      expect(screen.queryByLabelText(label)).not.toBeInTheDocument();
    }

    await user.type(screen.getByLabelText('Primary phone'), '6145550101');
    await user.type(screen.getByLabelText('Nickname'), 'DD');
    const submit = screen.getByRole('button', { name: 'Submit and continue' });
    // Never a silently disabled button (owner, 2026-10-27): pressing it says what is missing.
    await user.click(submit);
    expect(await screen.findByText('Fill in: Shift time.')).toBeInTheDocument();
    expect(put).toBeNull();
    await user.type(screen.getByLabelText('Shift time'), 'Night');
    await user.click(submit);
    await waitFor(() => expect(put).not.toBeNull());
    expect(put).toMatchObject({ fullName: 'Dana Dispatch', nickname: 'DD', phone: '6145550101', shiftTime: 'Night', expectedUpdatedAt: null });
    expect(Object.keys(put!).sort()).toEqual(
      ['dateOfBirth', 'expectedUpdatedAt', 'fullName', 'homeAddress', 'idNumber', 'location', 'nickname', 'phone', 'secondaryPhone', 'shiftTime'].sort(),
    );
  });

  it('opens the application once the profile is complete; its address leads home', async () => {
    window.history.replaceState(null, '', '/complete-profile');
    stub(false);
    renderGate();
    expect(await screen.findByRole('heading', { name: 'the application' })).toBeVisible();
    expect(window.location.pathname).toBe('/');
  });
});
