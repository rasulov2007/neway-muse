import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from './AuthGate';
import { AuthProvider } from './AuthProvider';

/**
 * The gate asks the server, and only the server.
 *
 * The regression this pins: the account cached at sign-in was passed as `initialData`, which
 * TanStack treats as a real cache entry — so with a staleTime, `/auth/me` was never called and the
 * gate decided from a copy that is written once and never updated. After somebody replaced their
 * temporary password the copy still said `mustChangePassword: true`, and the change screen would
 * not let go: the password was right, the approval came back, and no page ever opened.
 */

const ACCOUNT = {
  membershipId: 'mbr_1',
  userId: 'usr_1',
  name: 'Robert Lindqvist',
  email: 'robert@example.com',
  companyId: 'co_1',
  roles: ['administrator'],
  permissions: [],
  isOwner: true,
  appearance: 'system',
};

function renderGate() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
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
  window.localStorage.clear();
  window.sessionStorage.clear();
});

afterEach(() => {
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe('AuthGate', () => {
  it('opens the application when the server says the password is settled', async () => {
    // The browser kept a copy from sign-in saying the credential was temporary...
    window.localStorage.setItem('neway.session.token', 'tok');
    window.localStorage.setItem(
      'neway.session.account',
      JSON.stringify({ ...ACCOUNT, mustChangePassword: true }),
    );
    // ...while the server, which is the authority, says it has been replaced.
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ...ACCOUNT, mustChangePassword: false, signedIn: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    );

    renderGate();
    expect(await screen.findByRole('heading', { name: 'the application' })).toBeVisible();
    expect(screen.queryByText('Choose a password')).not.toBeInTheDocument();
  });

  it('holds a temporary credential at the change screen', async () => {
    window.localStorage.setItem('neway.session.token', 'tok');
    vi.stubGlobal(
      'fetch',
      vi.fn(() =>
        Promise.resolve(
          new Response(JSON.stringify({ ...ACCOUNT, mustChangePassword: true, signedIn: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          }),
        ),
      ),
    );

    renderGate();
    expect(await screen.findByRole('heading', { name: 'Choose a password' })).toBeVisible();
    expect(screen.queryByRole('heading', { name: 'the application' })).not.toBeInTheDocument();
  });

  it('shows the login screen when there is no session at all', async () => {
    vi.stubGlobal('fetch', vi.fn());
    renderGate();
    expect(await screen.findByRole('heading', { name: 'NeWay' })).toBeVisible();
    // With no token there is nothing to ask about.
    expect(screen.queryByRole('heading', { name: 'the application' })).not.toBeInTheDocument();
  });
});
