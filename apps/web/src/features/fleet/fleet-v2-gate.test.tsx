import { screen, waitFor } from '@testing-library/react';
import { isRedirect } from '@tanstack/react-router';
import { afterEach, describe, expect, it } from 'vitest';
import { Route as ShopOrderRoute } from '@/routes/fleet/shop/$orderId';
import { Route as TodayRoute } from '@/routes/fleet/today';
import { NAVIGATION, findActiveItem, navVisible } from '@/app/navigation';
import { renderPage } from '@/features/common/test-router';
import { setClockForTests } from '@/lib/clock';
import { setFlagForTests } from '@/lib/feature-flags';
import { ShopWorkOrderDialog } from './components/ShopWorkOrderDialog';
import { ShopTodayPage } from './ShopTodayPage';

/**
 * The flag, proved rather than trusted.
 *
 * `fleet_v2` is off in a production build, and the point of it is that a build without it carries
 * none of the new Fleet screens — not merely no links to them. So this asserts, for every new
 * route, that it redirects to the page production already had, that the menu is the menu
 * production already had, and that the modal refuses to open. The endpoints are proved separately
 * in the API's own guard spec, because a hidden page with live endpoints is the failure this pair
 * exists to prevent.
 */

afterEach(() => {
  setFlagForTests('fleet_v2', null);
  setClockForTests(null);
});

type Guarded = { options: { beforeLoad?: unknown } };

/** Where a route's guard sends the reader, or null when it lets them through. */
function redirectOf(route: Guarded, params: Record<string, string> = {}): string | null {
  const guard = route.options.beforeLoad as ((ctx: unknown) => unknown) | undefined;
  try {
    guard?.({ params });
    return null;
  } catch (error) {
    if (!isRedirect(error)) throw error;
    return (error as { options: { to?: string } }).options.to ?? null;
  }
}

const NEW_ROUTES: [string, Guarded, string][] = [['/fleet/today', TodayRoute, '/fleet']];

function fleetMenu(): string[] {
  const group = NAVIGATION.find((g) => g.label === 'Fleet');
  return (group?.items ?? []).filter(navVisible).map((item) => item.label);
}

describe('with fleet_v2 off', () => {
  it('every new Fleet route redirects to the page production already had', () => {
    setFlagForTests('fleet_v2', false);
    for (const [path, route, fallback] of NEW_ROUTES) {
      expect(redirectOf(route), path).toBe(fallback);
    }
  });

  it('/fleet/shop/:id redirects to the work-order workspace, carrying the id', () => {
    setFlagForTests('fleet_v2', false);
    let thrown: unknown;
    try {
      ShopOrderRoute.options.beforeLoad?.({ params: { orderId: 'ro_1055' } } as never);
    } catch (error) {
      thrown = error;
    }
    expect(isRedirect(thrown)).toBe(true);
    const target = (thrown as { options: { to?: string; params?: { orderId?: string } } }).options;
    expect(target.to).toBe('/fleet/maintenance/$orderId');
    expect(target.params?.orderId).toBe('ro_1055');
  });

  it('the Fleet menu is the one production has: expense summary, maintenance views, PTI', () => {
    setFlagForTests('fleet_v2', false);
    expect(fleetMenu()).toEqual([
      'Expense summary',
      'Trucks',
      'Trailers',
      'Maintenance',
      'Pre-trip (PTI)',
      'Fuel',
      'Vendors',
    ]);
    // The maintenance views are still the six they were.
    const maintenance = NAVIGATION.flatMap((g) => g.items).find((i) => i.label === 'Maintenance');
    expect((maintenance?.children ?? []).filter(navVisible)).toHaveLength(6);
    // And highlighting resolves against that menu, not the hidden one.
    expect(findActiveItem('/fleet/maintenance/ro_1')?.label).toBe('Maintenance');
  });

  it('the work order modal refuses to open', () => {
    setFlagForTests('fleet_v2', false);
    renderPage(<ShopWorkOrderDialog open onOpenChange={() => {}} />, {
      routePath: '/fleet/today',
      path: '/fleet/today',
    });
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('with fleet_v2 on', () => {
  it('every new Fleet route loads its own page', () => {
    setFlagForTests('fleet_v2', true);
    for (const [path, route] of NEW_ROUTES) {
      expect(redirectOf(route), path).toBeNull();
    }
    expect(() =>
      ShopOrderRoute.options.beforeLoad?.({ params: { orderId: 'ro_1055' } } as never),
    ).not.toThrow();
  });

  it('/fleet/today is the shop board', async () => {
    setFlagForTests('fleet_v2', true);
    setClockForTests('2026-09-17T14:30:00-05:00');
    renderPage(<ShopTodayPage />, { routePath: '/fleet/today', path: '/fleet/today' });

    expect(await screen.findByText('Oil change')).toBeInTheDocument();
    expect(screen.getByText('In the shop')).toBeInTheDocument();
  });

  it('the Fleet menu is the items of the specification, plus Breakdowns (mobile M3)', () => {
    setFlagForTests('fleet_v2', true);
    // Costs moved ahead of Today by the owner (2026-09-29).
    expect(fleetMenu()).toEqual([
      'Costs',
      // Fleet Expenses folded into Costs and the Repair log (owner, 2026-10-13): no entry of its own.
      'Today',
      // Fleet → Breakdowns: cases drivers report from the driver app (owner brief, mobile M3, 2026-10-27).
      'Breakdowns',
      'Trucks',
      'Trailers',
      'Repairs',
      'PM & inspections',
      'Fuel',
      'Vendors',
    ]);
    expect(findActiveItem('/fleet/maintenance')?.label).toBe('Repairs');
  });

  it('the modal opens', async () => {
    setFlagForTests('fleet_v2', true);
    renderPage(<ShopWorkOrderDialog open onOpenChange={() => {}} />, {
      routePath: '/fleet/today',
      path: '/fleet/today',
    });
    await waitFor(() => expect(screen.getByRole('dialog')).toBeInTheDocument());
  });
});
