import { useGo } from '@/features/dashboard/links';

/**
 * Opens a driver's page.
 *
 * Lives beside the page rather than inside it so the module exports a component and nothing else -
 * mixing the two breaks fast refresh for every consumer of the hook.
 */
export function useOpenDriver() {
  const go = useGo();
  return (driverId: string) => go(`/drivers/${encodeURIComponent(driverId)}`);
}
