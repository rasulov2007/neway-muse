import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DriverTeamStanding, DriverTeamView } from '@neway/shared';
import { ToastProvider } from '@/design-system/components/Toast';
import { setClockForTests } from '@/lib/clock';

/** Team or Solo (owner, 2026-10-25): the Pair dialog's search and confirm, and Unpair's reason. */

const apiPost = vi.fn();
let postOverride: ((...args: unknown[]) => Promise<unknown>) | null = null;
vi.mock('@/lib/api-client', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/api-client')>();
  return { ...real, apiPost: (...args: unknown[]) => (postOverride ? postOverride(...args) : apiPost(...args)) };
});

const { PairDriverModal, TeamBadge, UnpairDriverModal } = await import('./DriverTeam');

const drivers = [
  { id: 'drv_a', name: 'Ali Karimov', driverNumber: 'D-1', status: 'available', archivedAt: null, currentTruckUnit: '0016' },
  { id: 'drv_b', name: 'Bek Tursunov', driverNumber: 'D-2', status: 'driving', archivedAt: null, currentTruckUnit: null },
  { id: 'drv_c', name: 'Bobur Aliev', driverNumber: 'D-3', status: 'available', archivedAt: null, currentTruckUnit: null },
  { id: 'drv_t', name: 'Botir Gone', driverNumber: 'D-4', status: 'terminated', archivedAt: null, currentTruckUnit: null },
];

const team: DriverTeamView = {
  id: 'dtm_1',
  pairId: 'dtp_1',
  driverId: 'drv_a',
  driverName: 'Ali Karimov',
  driverNumber: 'D-1',
  partnerId: 'drv_b',
  partnerName: 'Bek Tursunov',
  partnerNumber: 'D-2',
  state: 'active',
  startedOn: '2026-10-01',
  endedOn: null,
  note: null,
  startedBy: 'Dina',
  endedBy: null,
  endReason: null,
  version: 3,
};

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Pair dialog', () => {
  beforeAll(() => setClockForTests('2026-10-25T12:00:00-04:00'));
  afterAll(() => setClockForTests(null));
  beforeEach(() => {
    apiPost.mockReset();
    postOverride = null;
  });

  it('offers only active, unpaired drivers other than this one, filtered by the search', async () => {
    const user = userEvent.setup();
    wrap(<PairDriverModal driverId="drv_a" driverName="Ali Karimov" drivers={drivers} pairedIds={new Set(['drv_c'])} onClose={() => {}} />);
    const list = screen.getByTestId('pair-candidates');
    expect(within(list).getAllByRole('option').map((o) => o.textContent)).toEqual(['Bek TursunovD-2']);
    await user.type(screen.getByLabelText('Search partner'), 'zzz');
    expect(within(list).getByText('No unpaired active driver matches.')).toBeTruthy();
    expect((screen.getByTestId('confirm-pair') as HTMLButtonElement).disabled).toBe(true);
  });

  it('searches, picks the partner and confirms: posts the pairing from today (Eastern) and closes', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const standing: DriverTeamStanding = { today: '2026-10-25', current: { ...team, startedOn: '2026-10-25', version: 1 }, history: [] };
    apiPost.mockResolvedValue(standing);
    wrap(<PairDriverModal driverId="drv_a" driverName="Ali Karimov" drivers={drivers} pairedIds={new Set()} onClose={onClose} />);
    await user.type(screen.getByLabelText('Search partner'), 'bek');
    const list = screen.getByTestId('pair-candidates');
    expect(within(list).getAllByRole('option')).toHaveLength(1);
    await user.click(within(list).getByText('Bek Tursunov'));
    const confirm = screen.getByTestId('confirm-pair');
    expect(confirm.textContent).toContain('Pair with Bek Tursunov');
    await user.click(confirm);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(apiPost).toHaveBeenCalledWith('/drivers/drv_a/team', { partnerId: 'drv_b', startedOn: '2026-10-25', note: null });
  });

  it('a refused pairing (409) keeps the dialog open and says why', async () => {
    const user = userEvent.setup();
    const onClose = vi.fn();
    const { ApiError } = await import('@/lib/api-client');
    // A plain function: a vi.fn() that rejects is reported by vitest as a failure of its own.
    postOverride = async () => {
      throw new ApiError(409, 'Conflict', 'Bek Tursunov is already in a team with Bobur Aliev. Unpair them first.', null);
    };
    wrap(<PairDriverModal driverId="drv_a" driverName="Ali Karimov" drivers={drivers} pairedIds={new Set()} onClose={onClose} />);
    await user.click(screen.getByText('Bek Tursunov'));
    await user.click(screen.getByTestId('confirm-pair'));
    expect((await screen.findAllByText(/already in a team with Bobur Aliev/)).length).toBeGreaterThan(0);
    expect(screen.getByText('Not paired')).toBeTruthy();
    expect(onClose).not.toHaveBeenCalled();
    postOverride = null;
  });
});

describe('Unpair dialog and the badge', () => {
  beforeAll(() => setClockForTests('2026-10-25T12:00:00-04:00'));
  afterAll(() => setClockForTests(null));
  beforeEach(() => apiPost.mockReset());

  it('needs a reason, then posts the version read', async () => {
    const user = userEvent.setup();
    apiPost.mockResolvedValue({ today: '2026-10-25', current: null, history: [] });
    const onClose = vi.fn();
    wrap(<UnpairDriverModal driverId="drv_a" driverName="Ali Karimov" team={team} onClose={onClose} />);
    const confirm = screen.getByTestId('confirm-unpair') as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    await user.type(screen.getByLabelText('Unpair reason'), 'Bek goes solo');
    expect(confirm.disabled).toBe(false);
    await user.click(confirm);
    await waitFor(() => expect(onClose).toHaveBeenCalled());
    expect(apiPost).toHaveBeenCalledWith('/drivers/drv_a/team/dtp_1/end', { version: 3, reason: 'Bek goes solo', endedOn: '2026-10-25' });
  });

  it('reads Team with the partner, Solo, or Loading… before data', () => {
    const { rerender } = render(<TeamBadge team={team} />);
    expect(screen.getByTestId('team-badge').textContent).toBe('Teamwith Bek Tursunov');
    rerender(<TeamBadge team={null} />);
    expect(screen.getByTestId('team-badge').textContent).toBe('Solo');
    rerender(<TeamBadge team={undefined} pending />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });
});
