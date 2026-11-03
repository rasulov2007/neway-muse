import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AuthAccount } from '@neway/shared';
import { AuthContext, type AuthState } from './auth-context';
import { NoAccessPage } from './NoAccessPage';

/**
 * Signing in with an account that carries no role used to drop the person into the application,
 * where every screen answered 403 and nothing said why. That reads as "the system will not let me
 * in", which is how it was reported.
 */
const account = {
  membershipId: 'mbr_1',
  userId: 'usr_1',
  name: 'New Joiner',
  email: 'joiner@example.com',
  companyId: 'co_1',
  roles: [],
  permissions: [],
  isOwner: false,
  mustChangePassword: false,
  appearance: 'system',
} as unknown as AuthAccount;

function renderPage() {
  const value = { account, loading: false, offline: false, signOut: vi.fn(), refresh: vi.fn() };
  return render(
    <AuthContext.Provider value={value as unknown as AuthState}>
      <NoAccessPage account={account} />
    </AuthContext.Provider>,
  );
}

describe('NoAccessPage', () => {
  it('says the account has no role, names the person, and points at who can fix it', () => {
    renderPage();
    expect(screen.getByRole('heading', { name: /no access yet/i })).toBeInTheDocument();
    expect(screen.getByText(/joiner@example.com/)).toBeInTheDocument();
    expect(screen.getByText(/Users and access/)).toBeInTheDocument();
    // And it does not blame the credential, which is the thing people change first.
    expect(screen.getByText(/your sign-in and your password are fine/i)).toBeInTheDocument();
  });

  it('offers a way on: check again, or sign out', () => {
    renderPage();
    expect(screen.getByRole('button', { name: /check again/i })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /sign out/i })).toBeInTheDocument();
  });
});
