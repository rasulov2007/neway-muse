import { screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PtiDefect } from '@neway/shared';
import { demoData, setDemoLatency } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { setFlagForTests } from '@/lib/feature-flags';
import { servePtiDefects } from '@/test/roster-server';
import { TruckDetailPage } from '../TruckDetailPage';

beforeAll(() => setDemoLatency(false));

const found = demoData.trucks.find((t) => t.status === 'active' || t.status === 'available') ?? demoData.trucks[0];
if (!found) throw new Error('the demo book has no trucks');
const truck = found;

/** DEF-4417, the brake defect from the brief, on this truck. */
function brakeDefect(state: PtiDefect['state']): PtiDefect {
  return {
    id: 'pd_4417',
    defectNumber: 'DEF-4417',
    unitId: truck.id,
    unitNumber: truck.unitNumber,
    foundOnInspectionId: null,
    component: 'brakes',
    componentName: 'Brakes',
    description: 'Slack adjuster out of stroke on axle 3',
    quickPick: null,
    severity: 'oos_risk',
    state,
    evidence: { clipTime: '04:18', screenshots: [] },
    ownerId: null,
    ownerName: null,
    dueAt: '2026-09-17T23:59:00.000Z',
    workOrderId: null,
    workOrderNumber: null,
    resolution: { fixedAt: null, fixedVia: null, verifiedAt: null, verifiedBy: null, dismissedReason: null },
    needsReview: false,
    legacyRecordId: null,
    history: [],
    createdBy: 'Tom Brennan',
    createdAt: '2026-09-12T15:00:00.000Z',
    updatedAt: '2026-09-12T15:00:00.000Z',
    version: 1,
  };
}

function render(search = '') {
  return renderPage(<TruckDetailPage truckId={truck.id} />, {
    routePath: '/fleet/trucks/$truckId',
    path: `/fleet/trucks/${truck.id}${search}`,
  });
}

describe('the truck header carries one derived verdict (§4.2, WP3)', () => {
  beforeEach(() => setFlagForTests('fleet_v2', true));
  afterEach(() => {
    setFlagForTests('fleet_v2', null);
    vi.unstubAllGlobals();
  });

  it('reads out of service with DEF-4417 named while the defect is open, and never "Available"', async () => {
    servePtiDefects([brakeDefect('open')]);
    render();
    expect(await screen.findByText('Out of service')).toBeVisible();
    expect(screen.getByText(/hold: DEF-4417 — released when DEF-4417 is verified/)).toBeVisible();
    // The header carries one pill. (The map legend under Overview names every marker colour,
    // "Available" among them; that is a key, not a claim about this unit.)
    const header = screen.getByRole('heading', { name: `Unit ${truck.unitNumber}` }).closest('header');
    if (!header) throw new Error('the page header is missing');
    expect(within(header).queryByText('Available')).toBeNull();
    expect(within(header).queryByText('In maintenance')).toBeNull();
    expect(screen.queryByText('An open work order has the unit in a shop')).toBeNull();
  });

  it('a defect proposed for verification still holds the unit', async () => {
    servePtiDefects([brakeDefect('fixed_pending_verify')]);
    render();
    expect(await screen.findByText('Out of service')).toBeVisible();
  });

  it('flips to cleared once the defect is verified, with no other action', async () => {
    servePtiDefects([brakeDefect('verified')]);
    render();
    expect(await screen.findByText('Cleared')).toBeVisible();
    expect(screen.queryByText(/DEF-4417/)).toBeNull();
  });

  it('says "Loading…" rather than a verdict until the server has answered', async () => {
    // The status route is held back; every other route answers as usual.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const real = globalThis.fetch;
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
        if (url.includes('/fleet/pti/units/')) await gate;
        return real(input, init);
      }),
    );
    render();
    expect(await screen.findByText('Loading…', { selector: 'span' })).toBeVisible();
    expect(screen.queryByText('Cleared')).toBeNull();
    release();
    await waitFor(() => expect(screen.getByText('Cleared')).toBeVisible());
  });

  it('lists the defect under Maintenance with the same number and severity', async () => {
    servePtiDefects([brakeDefect('open')]);
    render('?tab=maintenance');
    expect(await screen.findByText('DEF-4417')).toBeVisible();
    expect(screen.getByText('Slack adjuster out of stroke on axle 3')).toBeVisible();
    expect(screen.getByText('Out-of-service risk')).toBeVisible();
  });
});
