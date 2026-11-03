import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeTollGuruRoutes, type RouteOptionsResult } from '@neway/shared';
import type { Load } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { ApiError } from '@/lib/api-client';
import { RouteOptionsPanel } from './RouteOptionsPanel';

const api = vi.hoisted(() => ({ fetchRouteOptions: vi.fn(), chooseLoadRoute: vi.fn() }));
vi.mock('@/demo', async (original) => ({ ...(await original<typeof import('@/demo')>()), ...api }));

/**
 * Route options after Create load (owner, 2026-10-27): TollGuru's roads, cheapest first and
 * selected; Use this route saves it; a TollGuru failure is said plainly and Skip still works.
 */
const load = { id: 'ld_rt', loadNumber: 'L-100900', status: 'booked', updatedAt: '2026-10-27T10:00:00.000Z', stops: [], route: null } as unknown as Load;
const settings = { fuelPricePerGallon: 3.75, mpg: 6.5, grossWeightLbs: 80000, axles: 5 };
const result: RouteOptionsResult = {
  provider: 'tollguru',
  settings,
  computedAt: '2026-10-27T10:00:00.000Z',
  cached: false,
  options: normalizeTollGuruRoutes(
    {
      routes: [
        { summary: { name: 'I-65 S', distance: { text: '718 mi' }, duration: { value: 39900 }, hasTolls: true, url: 'https://maps.example/a' }, costs: { tag: 24.5, cash: 31, fuel: 440 } },
        { summary: { name: 'I-57 S', distance: { text: '702 mi' }, duration: { value: 41400 }, hasTolls: false }, costs: { fuel: 430 } },
        { summary: { name: 'I-55 S', distance: { text: '760 mi' }, duration: { value: 39000 }, hasTolls: true }, costs: { tag: 80, fuel: 470 } },
      ],
    },
    settings,
  ),
};

describe('the route options panel', () => {
  beforeEach(() => {
    api.fetchRouteOptions.mockReset();
    api.chooseLoadRoute.mockReset();
  });

  it('says Loading… first, then lists the roads cheapest first with tolls, fuel and total', async () => {
    api.fetchRouteOptions.mockResolvedValue(result);
    renderPage(<RouteOptionsPanel load={load} onChosen={() => undefined} onSkip={() => undefined} />);
    expect(await screen.findByText('Loading…')).toBeVisible();
    const rows = await screen.findAllByTestId('route-option');
    expect(rows).toHaveLength(3);
    expect(rows[0]).toHaveTextContent('I-57 S');
    expect(rows[0]).toHaveTextContent('No tolls');
    expect(rows[0]).toHaveTextContent('$430.00');
    expect(rows[0]).toHaveAttribute('aria-checked', 'true');
    expect(within(rows[0]!).getAllByText('Cheapest').length).toBeGreaterThan(0);
    expect(rows[1]).toHaveTextContent('$24.50');
    expect(rows[1]).toHaveTextContent('cash $31.00');
    expect(rows[1]).toHaveTextContent('$464.50');
    expect(within(rows[2]!).getAllByText('Fastest').length).toBeGreaterThan(0);
  });

  it('saves the road the dispatcher picks', async () => {
    const user = userEvent.setup();
    api.fetchRouteOptions.mockResolvedValue(result);
    const chosen = { ...load, route: { via: 'I-65 S' } } as unknown as Load;
    api.chooseLoadRoute.mockResolvedValue(chosen);
    const onChosen = vi.fn();
    renderPage(<RouteOptionsPanel load={load} onChosen={onChosen} />);
    const rows = await screen.findAllByTestId('route-option');
    await user.click(rows[1]!);
    expect(rows[1]).toHaveAttribute('aria-checked', 'true');
    await user.click(screen.getByTestId('use-route'));
    const i65 = result.options.find((o) => o.via === 'I-65 S')!;
    expect(api.chooseLoadRoute).toHaveBeenCalledWith('ld_rt', i65.id);
    await vi.waitFor(() => expect(onChosen).toHaveBeenCalledWith(chosen));
  });

  it('says the TollGuru account has no plan, and Skip still goes on', async () => {
    const user = userEvent.setup();
    const message = 'TollGuru: no active subscription — activate a plan in TollGuru.';
    api.fetchRouteOptions.mockRejectedValue(new ApiError(502, message, message, { title: message, status: 502, code: 'no_subscription' } as never));
    const onSkip = vi.fn();
    renderPage(<RouteOptionsPanel load={load} onChosen={() => undefined} onSkip={onSkip} />);
    const alert = await screen.findByTestId('route-options-error');
    expect(alert).toHaveTextContent(message);
    expect(alert).toHaveTextContent('The load is booked either way.');
    expect(screen.getByTestId('use-route')).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Skip' }));
    expect(onSkip).toHaveBeenCalled();
  });
});
