import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { HERO_LOAD_NUMBER, demoData, type Load } from '@/demo';
import { migrateWorkspaceLoads } from '@/demo/loads-migration';
import { apiGet } from '@/lib/api-client';
import { LoadForm } from './LoadFormPage';

/**
 * Live / Drop on every stop, and the empty miles that fill themselves from the driver's last
 * drop as the server answers it (owner, 2026-10-25).
 */
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiGet: vi.fn(),
}));

const PICKUP = demoData.facilities[0]!.address;
const DROP = demoData.facilities.find((f) => f.address.city !== PICKUP.city)!.address;

function serve(drop: { loadNumber: string; city: string; state: string } | null) {
  vi.mocked(apiGet).mockImplementation(async (path?: string) => {
    if (path === '/drivers') return { data: structuredClone(demoData.drivers), total: demoData.drivers.length } as never;
    if (path === '/trucks') return { data: structuredClone(demoData.trucks), total: demoData.trucks.length } as never;
    if (path === '/trailers') return { data: [], total: 0 } as never;
    if (path === '/loads/driver-last-drop') {
      return { drop: drop && { loadId: 'ld_prev', zip: null, ...drop } } as never;
    }
    throw new Error(`no api for ${path} in this test`);
  });
}

function hero(): Load {
  const load = demoData.loads.find((l) => l.loadNumber === HERO_LOAD_NUMBER);
  if (!load) throw new Error('hero load missing');
  return load;
}

async function chooseDriver(user: ReturnType<typeof userEvent.setup>) {
  const driver = demoData.drivers.find((d) => !d.archivedAt)!;
  await user.click(screen.getByRole('button', { name: /^Driver/ }));
  await user.click(await screen.findByRole('option', { name: new RegExp(driver.name) }));
  return driver;
}

async function booking() {
  renderPage(<LoadForm onCancel={() => undefined} onBooked={() => undefined} />);
  await screen.findByRole('textbox', { name: 'PICKUP city' });
}

async function typePickup(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox', { name: 'PICKUP city' }), PICKUP.city);
  await user.type(screen.getByRole('textbox', { name: 'PICKUP state' }), PICKUP.state);
}

describe('Add load: empty miles from the driver’s last drop', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset();
  });

  it('fills the empty miles from the server’s last drop for a driver with an earlier load', async () => {
    serve({ loadNumber: 'L-PREV', city: DROP.city, state: DROP.state });
    const user = userEvent.setup();
    await booking();
    await typePickup(user);
    const driver = await chooseDriver(user);
    const empty = screen.getByRole('spinbutton', { name: /Empty miles/ });
    await waitFor(() => expect(Number((empty as HTMLInputElement).value)).toBeGreaterThan(0));
    expect(vi.mocked(apiGet)).toHaveBeenCalledWith('/loads/driver-last-drop', expect.objectContaining({ driverId: driver.id }));
  });

  it('never overwrites a figure somebody typed', async () => {
    serve({ loadNumber: 'L-PREV', city: DROP.city, state: DROP.state });
    const user = userEvent.setup();
    await booking();
    const empty = screen.getByRole('spinbutton', { name: /Empty miles/ });
    await user.type(empty, '12');
    await typePickup(user);
    await chooseDriver(user);
    // The server's figure is offered beside the field, and the typed one stays.
    expect(await screen.findByText(/From their last drop at/)).toHaveTextContent('L-PREV');
    expect(empty).toHaveValue(12);
  });

  it('stays empty for a driver with no earlier load', async () => {
    serve(null);
    const user = userEvent.setup();
    await booking();
    await typePickup(user);
    await chooseDriver(user);
    await waitFor(() => expect(vi.mocked(apiGet)).toHaveBeenCalledWith('/loads/driver-last-drop', expect.anything()));
    expect(screen.getByRole('spinbutton', { name: /Empty miles/ })).toHaveValue(null);
  });
});

describe('Live / Drop on each stop', () => {
  beforeEach(() => {
    vi.mocked(apiGet).mockReset();
    serve(null);
    migrateWorkspaceLoads(demoData, { strict: true });
  });

  it('every stop card offers Live and Drop, Live chosen', async () => {
    await booking();
    for (const name of ['Pickup 1 live or drop', 'Delivery 2 live or drop']) {
      const group = screen.getByRole('radiogroup', { name });
      expect(within(group).getByRole('radio', { name: 'Live' })).toHaveAttribute('aria-checked', 'true');
      expect(within(group).getByRole('radio', { name: 'Drop' })).toHaveAttribute('aria-checked', 'false');
    }
    const user = userEvent.setup();
    const delivery = screen.getByRole('radiogroup', { name: 'Delivery 2 live or drop' });
    await user.click(within(delivery).getByRole('radio', { name: 'Drop' }));
    expect(within(delivery).getByRole('radio', { name: 'Drop' })).toHaveAttribute('aria-checked', 'true');
    // Add stop moves the delivery to the middle with its Drop; the new last delivery is Live.
    await user.click(screen.getByRole('button', { name: 'Add stop' }));
    expect(within(screen.getByRole('radiogroup', { name: 'Stop 2 live or drop' })).getByRole('radio', { name: 'Drop' })).toHaveAttribute('aria-checked', 'true');
    expect(within(screen.getByRole('radiogroup', { name: 'Delivery 3 live or drop' })).getByRole('radio', { name: 'Live' })).toHaveAttribute('aria-checked', 'true');
  });

  it('is saved on the stop when an existing load is edited', async () => {
    const user = userEvent.setup();
    const onBooked = vi.fn();
    renderPage(<LoadForm initial={hero()} onCancel={() => undefined} onBooked={onBooked} />);
    await screen.findByRole('button', { name: 'Save changes' });
    const last = hero().stops.length;
    const group = screen.getByRole('radiogroup', { name: `Delivery ${last} live or drop` });
    await user.click(within(group).getByRole('radio', { name: 'Drop' }));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onBooked).toHaveBeenCalledWith(HERO_LOAD_NUMBER));
    expect(hero().stops.at(-1)!.handling).toBe('drop');
    expect(hero().stops[0]!.handling ?? 'live').toBe('live');
  });
});
