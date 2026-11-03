/* eslint-disable react-refresh/only-export-components -- test helper, not app code */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
  useLocation,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { AuthProvider } from '@/features/auth/AuthProvider';
import { AppShell } from './AppShell';

function PageStub() {
  const { pathname } = useLocation();
  return <h1 data-testid="page">{pathname}</h1>;
}

/**
 * Renders the shell inside a memory-history router (any path resolves to a stub page) and a
 * fresh QueryClient. Tests await `findByRole` since the router mounts asynchronously.
 */
export function renderShell(initialPath = '/dashboard') {
  const rootRoute = createRootRoute({
    component: () => (
      <AppShell>
        <Outlet />
      </AppShell>
    ),
  });
  const indexRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/',
    component: PageStub,
  });
  const splatRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '$',
    component: PageStub,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([indexRoute, splatRoute]),
    history: createMemoryHistory({ initialEntries: [initialPath] }),
  });
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
      <RouterProvider router={router} />
    </AuthProvider>
    </QueryClientProvider>,
  );
  return { ...utils, router, queryClient };
}
