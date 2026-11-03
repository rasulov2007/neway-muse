import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import { AuthProvider } from '@/features/auth/AuthProvider';
import type { ReactNode } from 'react';
import { ToastProvider, TooltipProvider } from '@/design-system';

export interface RenderPageOptions {
  /** Route pattern the page is mounted at, e.g. `/loads/$loadNumber`. */
  routePath?: string;
  /** Initial URL (path + search), e.g. `/loads/L-100245?tab=financial`. */
  path?: string;
}

/**
 * Renders a page inside a memory-history router with the app providers (query client, toast,
 * tooltip). The page is the only route, so `useNavigate` / `useSearch` behave as in the app.
 */
export function renderPage(element: ReactNode, options: RenderPageOptions = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const rootRoute = createRootRoute();
  const pageRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: options.routePath ?? '/',
    component: () => element,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([pageRoute]),
    history: createMemoryHistory({ initialEntries: [options.path ?? '/'] }),
  });
  const utils = render(
    <QueryClientProvider client={queryClient}>
      <AuthProvider>
        <TooltipProvider>
          <ToastProvider>
            <RouterProvider router={router} />
          </ToastProvider>
        </TooltipProvider>
      </AuthProvider>
    </QueryClientProvider>,
  );
  return { ...utils, router, queryClient };
}
