import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { DailyBoard, DailyBoardRow } from '@neway/shared';
import { describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { DailyBoardPage } from './DailyBoardPage';

/* The board's data layer, so a row can be put on the page without a server. Default: no data. */
const mocks = vi.hoisted(() => ({ board: null as DailyBoard | null, canCreateDrivers: false }));
vi.mock('@/features/operations/usePermissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/operations/usePermissions')>()),
  useHasPermission: (code: string) => (code === 'drivers.edit' ? mocks.canCreateDrivers : false),
}));
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  useDailyBoard: () =>
    mocks.board
      ? { data: mocks.board, isPending: false, isFetching: false, isError: false, error: null, refetch: async () => undefined }
      : { data: undefined, isPending: true, isFetching: true, isError: false, error: null, refetch: async () => undefined },
  useWriteCells: () => ({ mutateAsync: async () => undefined, isPending: false }),
  useWriteFills: () => ({ mutateAsync: async () => undefined, isPending: false }),
}));

function row(over: Partial<DailyBoardRow> & { driverId: string }): DailyBoardRow {
  return {
    driverName: 'Remy Calloway',
    coDriver: null,
    payTag: null,
    driverNumber: 'D-2001',
    driverType: 'company',
    dispatcherId: 'dsp_1',
    dispatcherName: 'Team 1',
    phone: '5550000000',
    truckUnit: '412',
    truckConflict: false,
    cdlHold: [],
    primaryLoad: null,
    queuedLoads: [],
    auto: {},
    cells: {},
    fills: {},
    status: 'ENROUTE',
    statusSince: '2026-10-20T12:00:00.000Z',
    rosterVersion: 1,
    ...over,
  };
}

const load = (loadNumber: string, brokerReference: string | null) => ({
  id: `ld_${loadNumber}`,
  loadNumber,
  brokerReference,
  status: 'in_transit',
  origin: 'Laredo, TX',
  destination: 'Atlanta, GA',
  pickupAt: '2026-10-20T13:00:00.000Z',
  pickupZone: 'America/Chicago',
  deliveryAt: '2026-10-22T13:00:00.000Z',
  deliveryZone: 'America/New_York',
  rate: 3200,
  loadedMiles: 1100,
  trailer: 'T-55',
});

function board(rows: DailyBoardRow[]): DailyBoard {
  return { day: '2026-10-21', today: '2026-10-21', nowIso: '2026-10-21T15:00:00.000Z', rows, teams: [{ dispatcherId: 'dsp_1', dispatcherName: 'Team 1', driverCount: rows.length }], canWrite: true, canManage: false, liveTracking: false };
}

describe('the daily board', () => {
  /** Board T has a plain way back to the Daily Board, next to its status filter. */
  it('Board T offers "Back to Daily Board", which returns to the team view', async () => {
    mocks.board = null;
    const user = userEvent.setup();
    renderPage(<DailyBoardPage />, { routePath: '/dispatch/daily', path: '/dispatch/daily' });
    expect(screen.queryByRole('button', { name: 'Back to Daily Board' })).toBeNull();

    await user.click(await screen.findByRole('button', { name: 'Board T' }));
    expect(screen.getByRole('button', { name: 'Board T' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('group', { name: 'Status filter' })).toBeVisible();

    await user.click(screen.getByRole('button', { name: 'Back to Daily Board' }));
    expect(screen.getByRole('button', { name: 'Teams' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.queryByRole('group', { name: 'Status filter' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Back to Daily Board' })).toBeNull();
  });

  /** LOAD # reads the broker reference only, and opens the load (owner, 2026-10-26). */
  it('shows the load as its broker reference, or the load number alone, and opens the load', async () => {
    mocks.board = board([
      row({ driverId: 'drv_1', driverName: 'Remy Calloway', primaryLoad: load('L-100009', '4471823') }),
      row({ driverId: 'drv_2', driverName: 'Marcus Bell', driverNumber: 'D-2002', primaryLoad: load('L-100010', null) }),
    ]);
    renderPage(<DailyBoardPage />, { routePath: '/dispatch/daily', path: '/dispatch/daily?day=2026-10-21' });
    const withRef = await screen.findByRole('link', { name: '4471823' });
    expect(withRef).toHaveAttribute('href', '/loads/L-100009');
    expect(screen.getByRole('link', { name: 'L-100010' })).toHaveAttribute('href', '/loads/L-100010');
    expect(screen.queryByRole('link', { name: '4471823/L-100009' })).toBeNull();
    mocks.board = null;
  });

  /** "ADIN is not a team, he's solo" (owner, 2026-10-26): the badge is the server's team number, never the band's position. */
  it("shows TEAM n from the team number and no badge on a solo dispatcher, in the server's order", async () => {
    mocks.board = board([
      row({ driverId: "drv_1", dispatcherId: "d_adam", dispatcherName: "ARLO / MAXWELL", teamNumber: 1 }),
      row({ driverId: "drv_2", driverNumber: "D-2002", dispatcherId: "d_alex", dispatcherName: "AXEL / SOREN", teamNumber: 2 }),
      row({ driverId: "drv_3", driverNumber: "D-2003", dispatcherId: "emp_adin", dispatcherName: "ADIN", teamNumber: null }),
    ]);
    renderPage(<DailyBoardPage />, { routePath: "/dispatch/daily", path: "/dispatch/daily?day=2026-10-21" });
    const adam = await screen.findByRole("button", { name: /ARLO \/ MAXWELL/ });
    expect(adam).toHaveTextContent("Team 1");
    expect(screen.getByRole("button", { name: /AXEL \/ SOREN/ })).toHaveTextContent("Team 2");
    const adin = screen.getByRole("button", { name: /^ADIN/ });
    expect(adin).not.toHaveTextContent(/Team/i);
    const bands = screen.getAllByRole("button", { expanded: true }).map((b) => b.textContent ?? "");
    expect(bands.findIndex((t) => t.includes("ADIN"))).toBeGreaterThan(bands.findIndex((t) => t.includes("ALEX")));
    mocks.board = null;
  });

  /** The No driver file mark is off the board (owner, 2026-10-26: "take it off"). */
  it('shows no No driver file mark or Create driver file action on a board-only row', async () => {
    mocks.canCreateDrivers = true;
    mocks.board = board([row({ driverId: 'dbr_xs', driverName: 'XAVIER SUTTON', driverNumber: '', driverType: 'roster' })]);
    renderPage(<DailyBoardPage />, { routePath: '/dispatch/daily', path: '/dispatch/daily?day=2026-10-21' });
    await screen.findByText('XAVIER SUTTON');
    expect(screen.queryByText('No driver file')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Create driver file' })).toBeNull();
    mocks.board = null;
    mocks.canCreateDrivers = false;
  });

  /** "I collapse dispatchers, go to another page, come back - they are open again" (owner, 2026-10-26). */
  it("keeps a folded band folded after the page is left and opened again, and only that band", async () => {
    window.localStorage.clear();
    mocks.board = board([
      row({ driverId: "drv_1", dispatcherId: "d_adam", dispatcherName: "ARLO / MAXWELL", teamNumber: 1 }),
      row({ driverId: "drv_2", driverNumber: "D-2002", dispatcherId: "d_alex", dispatcherName: "AXEL / SOREN", teamNumber: 2 }),
    ]);
    const user = userEvent.setup();
    const first = renderPage(<DailyBoardPage />, { routePath: "/dispatch/daily", path: "/dispatch/daily?day=2026-10-21" });
    await user.click(await screen.findByRole("button", { name: /ARLO \/ MAXWELL/ }));
    expect(screen.getByRole("button", { name: /ARLO \/ MAXWELL/ })).toHaveAttribute("aria-expanded", "false");
    first.unmount();

    renderPage(<DailyBoardPage />, { routePath: "/dispatch/daily", path: "/dispatch/daily?day=2026-10-21" });
    expect(await screen.findByRole("button", { name: /ARLO \/ MAXWELL/ })).toHaveAttribute("aria-expanded", "false");
    expect(screen.getByRole("button", { name: /AXEL \/ SOREN/ })).toHaveAttribute("aria-expanded", "true");
    window.localStorage.clear();
    mocks.board = null;
  });
});
