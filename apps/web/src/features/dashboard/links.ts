import { useNavigate } from '@tanstack/react-router';

/**
 * Cross-module links from the dashboard. Several targets (load detail, truck drawer) are built in
 * later phases, so hrefs are plain strings and the typed router is bypassed in exactly one place.
 */

/**
 * Cross-module destinations.
 *
 * Every operational entity resolves through here, so "open the driver" means the same URL whether
 * it is clicked from a load, the tracking map or the dispatch board. Drivers, customers and brokers
 * open as a search param on their list route (`?driver=drv_01`); fleet units and work orders have
 * their own pages, because a unit's whole history does not fit in a drawer.
 */
export const hrefs = {
  loads: '/loads',
  load: (loadNumber: string) => `/loads/${encodeURIComponent(loadNumber)}`,
  trucks: '/fleet/trucks',
  /** Accepts an id or a unit number; the Truck 360 page resolves either. */
  truck: (unitOrId: string) => `/fleet/trucks/${encodeURIComponent(unitOrId)}`,
  trailer: (trailerId: string) => `/fleet/trailers/${encodeURIComponent(trailerId)}`,
  workOrder: (orderId: string) => `/fleet/maintenance/${encodeURIComponent(orderId)}`,
  trailers: '/fleet/trailers',
  maintenance: '/fleet/maintenance',
  fuel: '/fleet/fuel',
  /** Loads is the single load workspace; Dispatch was the same page under another name. */
  dispatch: '/loads',
  drivers: '/drivers',
  driver: (driverId: string) => `/drivers?driver=${encodeURIComponent(driverId)}`,
  tracking: '/tracking',
  trackUnit: (unitNumber: string) => `/tracking?unit=${encodeURIComponent(unitNumber)}`,
  customers: '/customers',
  customer: (customerId: string) => `/customers?customer=${encodeURIComponent(customerId)}`,
  brokers: '/brokers',
  broker: (brokerId: string) => `/brokers?broker=${encodeURIComponent(brokerId)}`,
  safety: '/safety',
  compliance: '/safety/compliance',
  inspections: '/safety/inspections',
  inspection: (id: string) => `/safety/inspections/${encodeURIComponent(id)}`,
  accidents: '/safety/accidents',
  accident: (id: string) => `/safety/accidents/${encodeURIComponent(id)}`,
  violations: '/safety/violations',
  violation: (id: string) => `/safety/violations/${encodeURIComponent(id)}`,
  notifications: '/notifications',
  accounting: '/accounting',
  invoices: '/accounting/invoices',
  expenses: '/accounting/expenses',
  settlements: '/accounting/settlements',
  reports: '/reports',
  ai: '/ai',
} as const;

export interface ParsedHref {
  to: string;
  search?: Record<string, string>;
}

export function parseHref(href: string): ParsedHref {
  const [to = '/', query] = href.split('?');
  if (!query) return { to };
  const search: Record<string, string> = {};
  for (const [key, value] of new URLSearchParams(query)) search[key] = value;
  return { to, search };
}

/** Imperative navigation for clickable cards and table rows. */
export function useGo(): (href: string) => void {
  const navigate = useNavigate();
  return (href) => {
    const parsed = parseHref(href);
    void navigate({ to: parsed.to as never, search: parsed.search as never });
  };
}

export const linkClass =
  'rounded-xs font-medium text-ink underline-offset-2 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus';

export const viewAllClass =
  'inline-flex items-center gap-1 rounded-xs text-sm font-medium text-primary-text underline-offset-4 hover:underline';
