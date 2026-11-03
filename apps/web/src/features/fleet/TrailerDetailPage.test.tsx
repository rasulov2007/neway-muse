import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { generateDemoData } from '@/demo/data';
import { renderPage } from '@/features/common/test-router';
import { setFlagForTests } from '@/lib/feature-flags';
import { TrailerDetailPage } from './TrailerDetailPage';

/**
 * A work order created for a trailer lands in the server's table. The trailer's page read only
 * the older workspace records, so the new order never appeared and it was created twice
 * (Dalton Mattox, 2026-09-30). The page must show the server's orders too.
 */
const trailer = generateDemoData().trailers[0]!;
const original = globalThis.fetch;

beforeEach(() => {
  setFlagForTests('fleet_v2', true);
  const inner = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const url = new URL(raw, 'http://localhost');
    const path = url.pathname.replace(/^\/api\/v1/, '');
    if (path === '/fleet/work-orders' && url.searchParams.get('unitId') === trailer.id) {
      const now = new Date().toISOString();
      return new Response(
        JSON.stringify([
          {
            id: 'wo_srv_1', number: 'RO-2026-1034', assetType: 'trailer', unitId: trailer.id, unitNumber: trailer.unitNumber,
            status: 'completed', shopStage: null, workType: 'repair', workDone: 'Brake chamber replaced', shopInAt: now,
            completedAt: now, downtimeMinutes: null, odometer: null, assignedTo: null, label: 'Brake chamber replaced',
            lastAction: null, defectId: null, pmServiceCode: null, scheduledFor: null, responsibleName: null,
            vendorName: 'TEST Shop', driverName: null, charge: { party: 'company', driverId: null, driverInformed: null },
            createdBy: 'DALTON MATTOX', createdAt: now, updatedAt: now,
            total: 553.57, invoiceFileIds: [],
          },
        ]),
        { status: 200, headers: { 'content-type': 'application/json' } },
      );
    }
    return inner(input, init);
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = original;
  setFlagForTests('fleet_v2', null);
});

describe('trailer work orders', () => {
  it('lists a work order that lives on the server', async () => {
    const user = userEvent.setup();
    renderPage(<TrailerDetailPage trailerId={trailer.id} />, { routePath: '/', path: '/' });
    await user.click(await screen.findByRole('tab', { name: 'Maintenance' }, { timeout: 15_000 }));
    const table = await screen.findByRole('table', { name: 'Trailer work orders' }, { timeout: 10_000 });
    await waitFor(() => expect(within(table).getByText('RO-2026-1034')).toBeVisible());
    expect(within(table).getByText('Brake chamber replaced')).toBeVisible();
    expect(within(table).getByText('$553.57')).toBeVisible();
  }, 30_000);
});

describe('trailer make and model (owner, 2026-10-22)', () => {
  it('edits the model from Trailer information and shows year, make and model', async () => {
    const user = userEvent.setup();
    renderPage(<TrailerDetailPage trailerId={trailer.id} />, { routePath: '/', path: '/' });
    const card = (
      await screen.findByRole('heading', { name: 'Trailer information' }, { timeout: 15_000 })
    ).closest('section');
    if (!card) throw new Error('No Trailer information card');
    expect(within(card).getByText('Year / make / model')).toBeVisible();

    await user.click(within(card).getByRole('button', { name: 'Edit' }));
    const dialog = await screen.findByRole('dialog', { name: `Edit trailer ${trailer.unitNumber}` });
    const model = within(dialog).getByLabelText('Model');
    await user.clear(model);
    await user.type(model, '4000D-X');
    await user.click(within(dialog).getByRole('button', { name: 'Save' }));

    await waitFor(
      () =>
        expect(
          within(card).getByText(`${trailer.year} ${trailer.make} 4000D-X`),
        ).toBeVisible(),
      { timeout: 10_000 },
    );
  }, 30_000);
});
