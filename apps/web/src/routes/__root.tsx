import { createRootRoute } from '@tanstack/react-router';
import { RootLayout } from '@/app/shell/RootLayout';
import { RouteError } from '@/app/shell/RouteError';
import { RoutePending } from '@/app/shell/RoutePending';

export const Route = createRootRoute({
  component: RootLayout,
  pendingComponent: RoutePending,
  errorComponent: RouteError,
});
