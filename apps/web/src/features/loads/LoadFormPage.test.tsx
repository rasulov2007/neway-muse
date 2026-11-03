import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { diffLoad } from '@neway/shared';
import { renderPage } from '@/features/common/test-router';
import { HERO_LOAD_NUMBER, demoData, type Load } from '@/demo';
import { migrateWorkspaceLoads } from '@/demo/loads-migration';
import { LoadForm } from './LoadFormPage';

/**
 * The edit form's promise (dispatch P0.2): saving a load without touching anything changes
 * nothing. These tests run the real store - `updateLoad` is not mocked - so the diff they
 * measure is the record before and after, not what the form meant to send.
 */
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  // The pickers ask the API for the roster; there is none here, and the form must not need one.
  apiGet: vi.fn(async () => {
    throw new Error('no api in this test');
  }),
}));

function hero(): Load {
  const load = demoData.loads.find((l) => l.loadNumber === HERO_LOAD_NUMBER);
  if (!load) throw new Error('hero load missing');
  return load;
}

describe('LoadForm (edit)', () => {
  let seed: Load;

  beforeEach(() => {
    // What the app does at boot: every record at the current schema before a screen reads it.
    migrateWorkspaceLoads(demoData, { strict: true });
    const live = hero();
    seed ??= structuredClone(live);
    // Reset the live record to the seed so each test starts from the same load.
    const index = demoData.loads.indexOf(live);
    demoData.loads[index] = structuredClone(seed);
  });

  async function open(user: ReturnType<typeof userEvent.setup>, onBooked = vi.fn()) {
    renderPage(<LoadForm initial={hero()} onCancel={() => undefined} onBooked={onBooked} />);
    await screen.findByRole('button', { name: 'Save changes' });
    return { onBooked, user };
  }

  it('saving without touching anything is a zero-field diff', async () => {
    const user = userEvent.setup();
    const before = structuredClone(hero());
    const { onBooked } = await open(user);
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onBooked).toHaveBeenCalledWith(HERO_LOAD_NUMBER));
    const after = hero();
    expect(diffLoad(before, after)).toEqual([]);
    // No "Load edited" line either: nothing happened, so nothing is written.
    expect(after.timeline).toHaveLength(before.timeline.length);
  });

  it('has no status field; the status is shown as it is and changed from the load page', async () => {
    const user = userEvent.setup();
    await open(user);
    expect(screen.queryByRole('combobox', { name: 'Status' })).not.toBeInTheDocument();
    // The status is read-only here and says where it moves: the Daily Board or the load page.
    expect(screen.getByRole('link', { name: 'Daily Board' })).toBeInTheDocument();
  });

  it('shows the dispatcher recorded on the load, and reassigns only through Reassign', async () => {
    const user = userEvent.setup();
    const stored = hero().dispatcherName;
    await open(user);
    expect(screen.getByText(stored)).toBeInTheDocument();
    // The picker is a labelled button until it is opened.
    expect(screen.queryByRole('button', { name: 'Dispatcher' })).not.toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Reassign' }));
    expect(await screen.findByRole('button', { name: 'Dispatcher' })).toHaveTextContent(stored);
    expect(screen.queryByRole('button', { name: 'Reassign' })).not.toBeInTheDocument();
  });

  it('offers the route miles as a suggestion and never rewrites the stored figure', async () => {
    const user = userEvent.setup();
    const before = structuredClone(hero());
    await open(user);
    const loaded = screen.getByRole('spinbutton', { name: /Loaded miles/ });
    expect(loaded).toHaveValue(before.loadedMiles);

    // A different destination makes a different route; the field is left alone and the
    // suggestion appears beside it.
    const city = screen.getByRole('textbox', { name: 'DELIVERY city' });
    await user.clear(city);
    await user.type(city, 'Atlanta');
    const state = screen.getByRole('textbox', { name: 'DELIVERY state' });
    await user.clear(state);
    await user.type(state, 'GA');
    expect(loaded).toHaveValue(before.loadedMiles);
    // The suggestions sit on one line under the row (owner's layout); loaded comes first.
    const use = screen.getAllByRole('button', { name: /^Use \d+ mi$/ })[0]!;
    const suggested = Number(/Use (\d+) mi/.exec(use.textContent ?? '')?.[1]);
    expect(suggested).not.toBe(before.loadedMiles);
    await user.click(use);
    expect(loaded).toHaveValue(suggested);
  });

  it('labels each stop with its own clock, and a moved city gets the new place, never the old zone', async () => {
    const user = userEvent.setup();
    const before = structuredClone(hero());
    const { onBooked } = await open(user);
    const stops = before.stops;
    const last = stops[stops.length - 1]!;
    // The delivery's clock is the stop's stored zone, shown by abbreviation.
    expect(screen.getAllByText(/^[A-Z]{2,4}T$|^GMT[+-]\d+$/).length).toBeGreaterThan(0);

    const city = screen.getByRole('textbox', { name: 'DELIVERY city' });
    await user.clear(city);
    await user.type(city, 'El Paso');
    const state = screen.getByRole('textbox', { name: 'DELIVERY state' });
    await user.clear(state);
    await user.type(state, 'TX');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));

    if (last.arrivedAt || last.departedAt) {
      // The stop had recorded times: the form asks first, and writes nothing until told.
      const dialog = await screen.findByRole('dialog');
      expect(dialog).toHaveTextContent('Clear recorded times at these stops?');
      expect(hero().stops[stops.length - 1]?.city).toBe(last.city);
      await user.click(within(dialog).getByRole('button', { name: 'Clear times and save' }));
    }
    await waitFor(() => expect(onBooked).toHaveBeenCalled());
    const saved = hero().stops[stops.length - 1]!;
    expect(saved.city).toBe('El Paso');
    expect(saved.timezone).toBe('America/Denver');
    expect(saved.id).toBe(last.id);
    expect(saved.arrivedAt).toBeNull();
    // Everything before it stayed exactly as it was.
    expect(diffLoad(before.stops.slice(0, -1), hero().stops.slice(0, -1))).toEqual([]);
  });

  it('saves a For driver rate beside the rate, and leaves the rate the broker pays alone', async () => {
    const user = userEvent.setup();
    const before = structuredClone(hero());
    const { onBooked } = await open(user);
    const forDriver = screen.getByRole('spinbutton', { name: 'For driver ($)' });
    expect(forDriver).toHaveValue(null);
    await user.type(forDriver, String(before.rate - 500));
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(onBooked).toHaveBeenCalledWith(HERO_LOAD_NUMBER));
    expect(hero().driverRate).toBe(before.rate - 500);
    expect(hero().rate).toBe(before.rate);
    expect(hero().charges.find((c) => c.type === 'linehaul')?.amount).toBe(before.charges.find((c) => c.type === 'linehaul')?.amount);
  });

  it('keeps recorded times when the person answers "Keep the times"', async () => {
    const user = userEvent.setup();
    const live = hero();
    const first = live.stops[0]!;
    first.arrivedAt = '2026-09-10T13:05:00.000Z';
    first.departedAt = '2026-09-10T14:00:00.000Z';
    first.status = 'completed';
    const before = structuredClone(live);
    const { onBooked } = await open(user);

    const city = screen.getByRole('textbox', { name: 'PICKUP city' });
    await user.clear(city);
    await user.type(city, 'Joliet');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Stop 1');
    await user.click(within(dialog).getByRole('button', { name: 'Keep the times' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(onBooked).not.toHaveBeenCalled();
    expect(diffLoad(before, hero())).toEqual([]);
  });
});
