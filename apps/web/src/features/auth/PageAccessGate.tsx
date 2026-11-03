import { Navigate, useLocation } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { homeFor, pathForbidden } from '@/app/navigation';
import { useAccount } from './auth-context';

/**
 * A page the account may not see is not shown, not even as an error: the URL lands on the first
 * page the account may open, as if the address had never existed (owner's rule, 2026-09-21).
 *
 * Inside `AuthGate`, so there is always an account here. The server still refuses the data
 * behind the page on its own; this only keeps the page's existence out of sight.
 */
export function PageAccessGate({ children }: { children: ReactNode }) {
  const account = useAccount();
  const { pathname } = useLocation();
  if (account && pathForbidden(pathname, account)) {
    const home = homeFor(account);
    if (home !== pathname) return <Navigate to={home} replace />;
  }
  return <>{children}</>;
}
