import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import { unitAvailability } from '@neway/shared';
import { setDemoLatency } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import type { FleetBundle, FleetTruck } from './useFleet';

/**
 * The Trucks summary strip against a fleet built by hand (owner, 2026-10-22): 137 trucks with an
 * open driver assignment read Available and the Assigned tile said 0. A truck with a driver is
 * Assigned, Available is a free truck with nobody in it, and the tiles add up to the total.
 */

const mocked = vi.hoisted(() => ({ bundle: undefined as FleetBundle | undefined }));

vi.mock('./useFleet', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./useFleet')>();
  return {
    ...actual,
    useFleet: () => ({
      data: mocked.bundle,
      isPending: mocked.bundle === undefined,
      error: null,
      refetch: async () => undefined,
    }),
  };
});

const { TrucksPage } = await import('./TrucksPage');
const { loadFleetBundle } = await import('./useFleet');

interface Spec {
  status: string;
  driver: boolean;
}

/** 3 with a driver, 2 without, and one of each hold - two of those with a driver in them. */
const FLEET: Spec[] = [
  { status: 'available', driver: true },
  { status: 'active', driver: true },
  { status: 'idle', driver: true },
  { status: 'available', driver: false },
  { status: 'active', driver: false },
  { status: 'inactive', driver: true },
  { status: 'in_shop', driver: true },
  { status: 'out_of_service', driver: false },
];

function truckRow(template: FleetTruck, spec: Spec, index: number): FleetTruck {
  const truck = {
    ...template.truck,
    id: `trk_card_${index}`,
    unitNumber: `C${100 + index}`,
    status: spec.status as FleetTruck['truck']['status'],
    currentDriverId: spec.driver ? `drv_card_${index}` : null,
    currentDriverName: spec.driver ? `Driver ${index}` : null,
    currentLoadId: null,
    location: template.truck.location ? { ...template.truck.location, speedMph: 0 } : null,
  };
  return {
    ...template,
    truck,
    availability: unitAvailability({
      status: truck.status,
      currentLoadId: null,
      speedMph: 0,
      inOpenWorkOrder: false,
      documentHold: null,
      driverAssigned: Boolean(truck.currentDriverId),
    }),
    openWorkOrders: [],
    allWorkOrders: [],
    currentLoad: null,
    documents: { ...template.documents, hold: null },
  };
}

beforeAll(async () => {
  setDemoLatency(false);
  const real = await loadFleetBundle();
  const template = real.trucks[0] as FleetTruck;
  const trucks = FLEET.map((spec, index) => truckRow(template, spec, index));
  mocked.bundle = {
    ...real,
    trucks,
    archivedTrucks: [],
    exceptions: { ...real.exceptions, items: [] },
    byTruckId: new Map(trucks.map((row) => [row.truck.id, row])),
    byUnitNumber: new Map(trucks.map((row) => [row.truck.unitNumber, row])),
  };
});

/** The first number on a tile ("Available 2 of 8 total" -> 2). */
function tileCount(name: RegExp): number {
  const tile = screen.getByRole('button', { name });
  return Number((tile.textContent ?? '').match(/[\d,]+/)?.[0]?.replace(/,/g, ''));
}

describe('Trucks summary strip', () => {
  it('counts a truck with a driver as Assigned, and the tiles add up to the total', async () => {
    renderPage(<TrucksPage />, { routePath: '/fleet/trucks', path: '/fleet/trucks' });
    await screen.findByRole('table', { name: 'Trucks' });

    await waitFor(() => expect(tileCount(/^Available/)).toBe(2));
    expect(screen.getByRole('button', { name: /^Available/ }).textContent).toContain('of 8 total');
    expect(tileCount(/^Assigned/)).toBe(3);
    expect(tileCount(/^Inactive/)).toBe(1);
    expect(tileCount(/^In maintenance/)).toBe(1);
    expect(tileCount(/^Out of service/)).toBe(1);
    // Nothing is moving, sold or unrecognised, so those tiles stay away.
    expect(screen.queryByRole('button', { name: /^In transit/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Retired/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Unknown/ })).toBeNull();
    expect(2 + 3 + 1 + 1 + 1).toBe(FLEET.length);
  });

  it('shows Assigned on the row and narrows the list to exactly the Assigned tile', async () => {
    const user = userEvent.setup();
    renderPage(<TrucksPage />, { routePath: '/fleet/trucks', path: '/fleet/trucks' });
    const table = await screen.findByRole('table', { name: 'Trucks' });
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBe(FLEET.length + 1));

    const row = within(table).getByText('C100').closest('tr') as HTMLElement;
    expect(within(row).getByText('Assigned')).toBeInTheDocument();
    const free = within(table).getByText('C103').closest('tr') as HTMLElement;
    expect(within(free).getByText('Available')).toBeInTheDocument();

    await user.click(screen.getByRole('button', { name: /^Assigned/ }));
    await waitFor(() => expect(within(table).getAllByRole('row').length).toBe(3 + 1));
    for (const unit of ['C100', 'C101', 'C102']) {
      expect(within(table).getByText(unit)).toBeInTheDocument();
    }
  });
});
