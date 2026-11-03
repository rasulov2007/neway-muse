import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { weekStartMonday, type RosterRow, type TeamOrderView } from '@neway/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { today } from '@/lib/clock';
import { BoardDispatcherFact, teamChoices } from './DriverBoardDispatcher';

/*
 * The driver profile's Assignment and equipment card (owner, 2026-10-26): "there should be Assign
 * dispatcher, so clicking it assigns a dispatcher". It saves through the board's assign path.
 */
const state = vi.hoisted(() => ({ assign: [] as unknown[], roster: [] as unknown[], permissions: ['dispatch.view', 'dispatch.manage'] as string[] }));

const order: TeamOrderView = {
  version: 1,
  stored: true,
  teams: [{ dispatcherId: 'team_alex_samuel', dispatcherName: 'AXEL / SOREN', dispatcherNickname: 'Alex & Sam', teamNumber: 1 }],
  solos: [{ dispatcherId: 'solo_mark', dispatcherName: 'MARK', dispatcherNickname: null, teamNumber: null }],
};

vi.mock('@/features/auth/auth-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/auth/auth-context')>()),
  useAccount: () => ({ permissions: state.permissions }),
}));
vi.mock('@/features/dispatch/board/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/dispatch/board/api')>()),
  useRoster: () => ({ data: state.roster, isPending: false }),
  useOffBoardDrivers: () => ({ data: [], isPending: false }),
  useTeamOrder: () => ({ data: order, isPending: false }),
  useAssignDriverToTeam: () => ({ mutateAsync: async (i: unknown) => state.assign.push(i), isPending: false }),
}));
vi.mock('@/features/people/useDispatchers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/people/useDispatchers')>()),
  useDispatchers: () => ({ data: [{ id: 'solo_zed', name: 'ZED', active: true, position: 'Dispatcher', employeeNumber: 'E-9', status: 'active' }], isPending: false }),
}));

const row = (over: Partial<RosterRow>): RosterRow => ({
  id: 'drv_jerry',
  driverId: 'drv_jerry',
  name: 'Gerald Ashford',
  coDriver: null,
  sourceName: null,
  payTag: null,
  truckUnit: '241062',
  phone: '',
  dispatcherId: '',
  dispatcherName: '',
  comment: '',
  unassignedAt: null,
  unassignedReason: null,
  truckConflict: false,
  version: 3,
  ...over,
});

describe('Driver profile: Assign dispatcher', () => {
  beforeEach(() => {
    state.assign.length = 0;
    state.roster = [];
    state.permissions = ['dispatch.view', 'dispatch.manage'];
  });

  it('lists teams first (with nickname), then solos, then other dispatchers', () => {
    expect(teamChoices(order, [{ id: 'solo_zed', name: 'ZED', active: true, position: 'Dispatcher', employeeNumber: 'E-9', status: 'active' }]).map((o) => o.label)).toEqual([
      'TEAM 1 · AXEL / SOREN (Alex & Sam)',
      'MARK',
      'ZED',
    ]);
  });

  it('a driver with no board row: "No dispatcher", Assign dispatcher picks a team and saves from this week', async () => {
    const user = userEvent.setup();
    renderPage(<BoardDispatcherFact driverId="drv_jerry" driverName="Gerald Ashford" />);
    expect(await screen.findByText('No dispatcher')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Assign dispatcher' }));
    const trigger = await screen.findByRole('combobox', { name: 'Dispatcher' });
    trigger.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('option', { name: /TEAM 1 · AXEL \/ SOREN/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.assign).toHaveLength(1));
    expect(state.assign[0]).toMatchObject({ driverId: 'drv_jerry', dispatcherId: 'team_alex_samuel', dispatcherName: 'AXEL / SOREN', fromWeek: weekStartMonday(today()) });
    expect((state.assign[0] as { expectedVersion?: number }).expectedVersion).toBeUndefined();
  });

  it('a driver under a team shows it with the nickname; Change dispatcher asks why and sends the row version', async () => {
    state.roster = [row({ dispatcherId: 'team_alex_samuel', dispatcherName: 'AXEL / SOREN' })];
    const user = userEvent.setup();
    renderPage(<BoardDispatcherFact driverId="drv_jerry" driverName="Gerald Ashford" />);
    expect(await screen.findByText('(Alex & Sam)')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Change dispatcher' }));
    const trigger = await screen.findByRole('combobox', { name: 'Dispatcher' });
    trigger.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('option', { name: 'MARK' }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('Say why the driver leaves AXEL / SOREN')).toBeInTheDocument();
    const why = screen.getByRole('combobox', { name: 'Why the driver leaves AXEL / SOREN' });
    why.focus();
    await user.keyboard('{Enter}');
    await user.click((await screen.findAllByRole('option'))[0]!);
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(state.assign).toHaveLength(1));
    expect(state.assign[0]).toMatchObject({ driverId: 'drv_jerry', rosterId: 'drv_jerry', dispatcherId: 'solo_mark', expectedVersion: 3 });
  });

  it('without dispatch.manage there is no button', async () => {
    state.permissions = ['dispatch.view'];
    state.roster = [row({ dispatcherId: 'solo_mark', dispatcherName: 'MARK' })];
    renderPage(<BoardDispatcherFact driverId="drv_jerry" driverName="Gerald Ashford" />);
    expect(await screen.findByText('MARK')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /dispatcher/i })).toBeNull();
  });
});
