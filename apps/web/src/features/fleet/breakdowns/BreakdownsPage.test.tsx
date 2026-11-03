import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { FleetBreakdown, FleetBreakdownList } from '@neway/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { setFlagForTests } from '@/lib/feature-flags';
import { BreakdownDetailPage } from './BreakdownDetailPage';
import { BreakdownsPage } from './BreakdownsPage';

/**
 * Fleet → Breakdowns (mobile M3): the list reads the server's cases with status as symbol + word,
 * and the case page sends Fleet's actions to the breakdown routes. In repair stays off until the
 * linked work order has the unit in the shop.
 */
const base: FleetBreakdown = {
  id: 'bd_1',
  number: 'BD-0007',
  category: 'tire',
  categoryLabel: 'Tire',
  description: 'Right steer tire blew out',
  status: 'received',
  statusLabel: 'Received',
  steps: [],
  truck: { id: 'trk_1', unitNumber: '2718' },
  trailer: { id: 'trl_1', unitNumber: 'T-55' },
  load: { id: 'ld_1', loadNumber: 'L-1042' },
  location: { text: 'I-65 mile 112', lat: 35.9, lng: -86.8, source: 'gps' },
  responsible: null,
  shopName: null,
  latestUpdate: null,
  fileIds: ['file_1'],
  createdAt: '2026-10-27T13:00:00.000Z',
  updatedAt: '2026-10-27T13:00:00.000Z',
  driver: { id: 'drv_1', name: 'Ali Driver' },
  assignedUserId: null,
  vendor: null,
  estimateCents: null,
  workOrder: null,
  loadProblemId: 'lpr_1',
  history: [{ at: '2026-10-27T13:00:00.000Z', kind: 'created', status: 'received', byName: 'Ali Driver (driver app)', note: null }],
  source: 'driver_app',
  closedAt: null,
  version: 1,
};

let current: FleetBreakdown = base;
const posted: Array<{ url: string; method: string; body: unknown }> = [];

beforeEach(() => {
  setFlagForTests('fleet_v2', true);
  current = structuredClone(base);
  posted.length = 0;
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('/fleet/breakdowns')) return original(input, init);
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
    const method = init?.method ?? 'GET';
    if (method !== 'GET') {
      const body = init?.body ? JSON.parse(String(init.body)) : null;
      posted.push({ url, method, body });
      if (url.endsWith('/work-order')) current = { ...current, status: 'in_repair', statusLabel: 'In repair', workOrder: { id: 'wo_1', number: 'RO-2026-1001', status: 'in_shop' }, version: current.version + 1 };
      return json(current);
    }
    if (url.endsWith('/shops')) return json([{ id: 'ven_1', name: 'TA Truck Service', city: 'Nashville', state: 'TN' }]);
    if (url.endsWith('/people')) return json([{ id: 'usr_test_admin', name: 'System Administrator' }]);
    if (url.includes('/fleet/breakdowns/bd_1')) return json(current);
    const list: FleetBreakdownList = {
      breakdowns: [current, { ...base, id: 'bd_2', number: 'BD-0008', status: 'ready', statusLabel: 'Ready', category: 'engine', categoryLabel: 'Engine', responsible: { name: 'Sam Fleet' } }],
      counts: { open: 2, received: 1, byStatus: { received: 1, assigned: 0, shop_arranged: 0, in_repair: 0, ready: 1, closed: 0 } },
    };
    return json(list);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  setFlagForTests('fleet_v2', null);
});

describe('Fleet → Breakdowns', () => {
  it('lists the cases with status as a symbol and a word, who is working each and the load', async () => {
    renderPage(<BreakdownsPage />, { routePath: '/fleet/breakdowns', path: '/fleet/breakdowns' });
    const table = await screen.findByTestId('breakdowns-table');
    expect(within(table).getByText('BD-0007')).toBeInTheDocument();
    expect(within(table).getByText('Received')).toBeInTheDocument();
    expect(within(table).getByText('Ready')).toBeInTheDocument();
    expect(within(table).getAllByText('Load L-1042').length).toBe(2);
    expect(within(table).getByText('Sam Fleet')).toBeInTheDocument();
    expect(screen.getByText('2 open · 1 not picked up yet')).toBeInTheDocument();
  });

  it('the case page: In repair waits for a work order in the shop; opening one posts to the breakdown', async () => {
    const user = userEvent.setup();
    renderPage(<BreakdownDetailPage id="bd_1" />, { routePath: '/fleet/breakdowns/bd_1', path: '/fleet/breakdowns/bd_1' });
    expect(await screen.findByText('Right steer tire blew out')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'In repair' })).toBeDisabled();
    await user.click(screen.getByRole('button', { name: 'Open work order · in the shop' }));
    await waitFor(() => expect(posted.find((p) => p.url.endsWith('/fleet/breakdowns/bd_1/work-order'))?.body).toEqual({ version: 1, create: { status: 'in_shop' } }));
    expect(await screen.findByText(/RO-2026-1001/)).toBeInTheDocument();
    // Closing says plainly what it does not do.
    expect(screen.getByText(/does not complete the work order/)).toBeInTheDocument();
  });
});
