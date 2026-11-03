import { CatchBoundary, Outlet, useLocation } from '@tanstack/react-router';
import { AuthGate } from '@/features/auth/AuthGate';
import { PageAccessGate } from '@/features/auth/PageAccessGate';
import { AppShell } from './AppShell';
import { RouteError } from './RouteError';

/**
 * Root route component: the shell with a per-page error boundary around the outlet, behind the
 * authentication gate. The gate is outside `AppShell` on purpose - the login screen is not a page
 * of the application and must not be drawn inside its chrome.
 */
export function RootLayout() {
  const { pathname } = useLocation();
  return (
    <AuthGate>
      <AppShell>
        <CatchBoundary getResetKey={() => pathname} errorComponent={RouteError}>
          <PageAccessGate>
            <Outlet />
          </PageAccessGate>
        </CatchBoundary>
      </AppShell>
    </AuthGate>
  );
}
