import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { VacationRequestList, VacationRequestRow } from '@neway/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { VacationRequests } from './VacationRequests';

/**
 * Vacation requests from the driver app on the Dispatch vacations page (mobile M3): Approve, Reject
 * with a reason the driver reads, and the parked-truck confirmation after approval.
 */
const row = (over: Partial<VacationRequestRow>): VacationRequestRow => ({
  id: 'dvac_1',
  driverId: 'drv_1',
  driverName: 'Ali Driver',
  driverNumber: 'D-1',
  unitNumber: '2718',
  dispatcherName: 'Mobile Dispatcher',
  from: '2026-11-02',
  to: '2026-11-09',
  note: 'Family wedding',
  status: 'requested',
  requestedAt: '2026-10-27T13:00:00.000Z',
  decidedBy: null,
  decidedAt: null,
  decidedReason: null,
  truckParkedAt: null,
  truckParkedBy: null,
  truckParkedNote: null,
  truckParkedPhotoFileId: null,
  keysHandedAt: null,
  version: 1,
  ...over,
});

const posted: Array<{ url: string; body: unknown }> = [];
let rows: VacationRequestRow[] = [];

beforeEach(() => {
  posted.length = 0;
  rows = [row({}), row({ id: 'dvac_2', driverName: 'Bea Driver', status: 'approved', decidedBy: 'Dispatch Lead' })];
  const original = globalThis.fetch;
  vi.spyOn(globalThis, 'fetch').mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (!url.includes('/drivers/vacation-requests')) return original(input, init);
    if ((init?.method ?? 'GET') !== 'GET') posted.push({ url, body: JSON.parse(String(init?.body ?? 'null')) });
    const list: VacationRequestList = { requests: rows, counts: { requested: 1, approved: 1 } };
    return new Response(JSON.stringify(list), { status: 200, headers: { 'content-type': 'application/json' } });
  });
});
afterEach(() => vi.restoreAllMocks());

describe('vacation requests from the driver app', () => {
  it('approves a request, and a rejection needs a reason', async () => {
    const user = userEvent.setup();
    renderPage(<VacationRequests />, { routePath: '/dispatch/vacations', path: '/dispatch/vacations' });
    const table = await screen.findByTestId('vacation-requests');
    const ali = within(table).getByText('Ali Driver').closest('tr') as HTMLElement;
    expect(within(ali).getByText('Requested')).toBeInTheDocument();
    await user.click(within(ali).getByRole('button', { name: 'Reject…' }));
    expect(within(ali).getByRole('button', { name: 'Reject' })).toBeDisabled();
    await user.click(within(ali).getByRole('button', { name: 'Back' }));
    await user.click(within(ali).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(posted[0]).toMatchObject({ url: expect.stringContaining('/drivers/vacation-requests/dvac_1/decision'), body: { version: 1, decision: 'approve' } }));
  });

  it('confirms the truck parked on an approved request, with the keys', async () => {
    const user = userEvent.setup();
    renderPage(<VacationRequests />, { routePath: '/dispatch/vacations', path: '/dispatch/vacations' });
    const table = await screen.findByTestId('vacation-requests');
    const bea = within(table).getByText('Bea Driver').closest('tr') as HTMLElement;
    expect(within(bea).getByText('Not confirmed yet')).toBeInTheDocument();
    await user.click(within(bea).getByRole('checkbox', { name: 'Keys handed over' }));
    await user.click(within(bea).getByRole('button', { name: 'Confirm truck parked' }));
    await waitFor(() => expect(posted[0]).toMatchObject({ url: expect.stringContaining('/dvac_2/parked'), body: { version: 1, keysHandedOver: true } }));
  });
});
