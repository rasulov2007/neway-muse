import { createRouter } from '@tanstack/react-router';
import { routeTree } from '../routeTree.gen';
import { NotFound } from './NotFound';
import { RouteError } from './shell/RouteError';
import { RoutePending } from './shell/RoutePending';

export const router = createRouter({
  routeTree,
  defaultPreload: 'intent',
  scrollRestoration: true,
  defaultNotFoundComponent: NotFound,
  defaultPendingComponent: RoutePending,
  defaultErrorComponent: RouteError,
  defaultPendingMs: 200,
});

declare module '@tanstack/react-router' {
  interface Register {
    router: typeof router;
  }
}
