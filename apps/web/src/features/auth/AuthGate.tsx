import { Loader2 } from 'lucide-react';
import type { ReactNode } from 'react';
import { useAuth } from './auth-context';
import { ChangePasswordPage } from './ChangePasswordPage';
import { CompleteProfilePage } from './CompleteProfilePage';
import { COMPLETE_PROFILE_PATH } from './complete-profile-path';
import { NoAccessPage } from './NoAccessPage';
import { LoginPage } from './LoginPage';

/**
 * Nothing renders until somebody is signed in.
 *
 * Written as a component wrapping the shell rather than as a router guard on every route: a guard
 * has to be remembered on each new route, and an async one either flashes the page it is meant to
 * protect or blocks navigation while it resolves. This is one decision, in one place, ahead of the
 * shell — so an unauthenticated visitor cannot reach a page by typing its URL, and the sidebar and
 * topbar never draw around a login form.
 *
 * The API enforces the same two rules independently (`AuthenticatedGuard`). This is the UI half;
 * neither half is load-bearing on its own.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const { account, loading, offline } = useAuth();

  if (loading) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-nw-bg">
        <Loader2 className="size-5 animate-spin text-nw-text-3" aria-label="Loading" />
      </div>
    );
  }

  // A server that cannot be reached is not the same as "not signed in": saying "invalid password"
  // when the API is down sends people to change a password that was never the problem.
  if (offline) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-nw-bg px-4">
        <div className="max-w-96 text-center">
          <h1 className="text-lg font-semibold text-nw-text">The server cannot be reached</h1>
          <p className="mt-2 text-sm text-nw-text-2">
            Nothing is wrong with your account. Check your connection; this page will work again as
            soon as the API answers.
          </p>
        </div>
      </div>
    );
  }

  if (!account) return <LoginPage />;
  if (account.mustChangePassword) return <ChangePasswordPage />;
  /*
   * Signed in, and allowed nothing.
   *
   * Every permission comes from a role, so an account with none is refused by every screen it
   * opens. Dropping that person into the application means a dashboard of silent failures and a
   * support call that sounds like "I cannot get in". They are told what is actually true, and who
   * can fix it, instead.
   */
  if (account.roles.length === 0) return <NoAccessPage account={account} />;
  /*
   * Complete your profile (owner, 2026-10-26): every page leads here until the person has filled
   * in their own information. The API refuses everything else for the session as well.
   */
  if (account.profileRequired) {
    if (typeof window !== 'undefined' && window.location.pathname !== COMPLETE_PROFILE_PATH) {
      window.history.replaceState(null, '', COMPLETE_PROFILE_PATH);
    }
    return <CompleteProfilePage />;
  }
  // The gate is not for this person (or no longer): its address leads home.
  if (typeof window !== 'undefined' && window.location.pathname === COMPLETE_PROFILE_PATH) {
    window.history.replaceState(null, '', '/');
  }
  return <>{children}</>;
}
