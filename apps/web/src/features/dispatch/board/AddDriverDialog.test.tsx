import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { OffBoardDriver, RosterRow } from '@neway/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { AddDriverDialog } from './RosterDialogs';

/*
 * Add driver (owner, 2026-10-26): "Gerald Ashford (D-2112) is on the Drivers page but the board's
 * Add Driver finds nothing for D-2112 or his name". Driver files with no board row, and rows
 * removed from the board, are offered too; picking one goes through POST /dispatch/roster/assign.
 */
const calls = vi.hoisted(() => ({ assign: [] as unknown[], update: [] as unknown[], add: [] as unknown[] }));

const onBoard: RosterRow = {
  id: 'drv_mark',
  driverId: 'drv_mark',
  name: 'MARK DOE',
  coDriver: null,
  sourceName: null,
  payTag: null,
  truckUnit: '0053',
  phone: '5551112222',
  dispatcherId: '',
  dispatcherName: '',
  comment: '',
  unassignedAt: null,
  unassignedReason: null,
  truckConflict: false,
  version: 2,
  driverNumber: 'D-1001',
};
const jerry: OffBoardDriver = {
  kind: 'file',
  driverId: 'drv_jerry',
  rosterId: null,
  version: null,
  name: 'Gerald Ashford',
  driverNumber: 'D-2112',
  truckUnit: '241062',
  phone: '5550002112',
  coDriver: null,
  dispatcherId: '',
  dispatcherName: '',
  removedFrom: null,
  removedReason: null,
};
const removed: OffBoardDriver = {
  ...jerry,
  kind: 'removed',
  driverId: 'drv_paul',
  rosterId: 'drv_paul',
  version: 7,
  name: 'Paul Removed',
  driverNumber: 'D-3000',
  truckUnit: null,
  dispatcherId: 'team_mark',
  dispatcherName: 'MARK',
  removedFrom: '2026-10-12',
  removedReason: 'Home time',
};

vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  useRoster: () => ({ data: [onBoard], isPending: false }),
  useOffBoardDrivers: () => ({ data: [jerry, removed], isPending: false }),
  useUpdateRosterRow: () => ({ mutateAsync: async (i: unknown) => calls.update.push(i), isPending: false }),
  useAssignDriverToTeam: () => ({ mutateAsync: async (i: unknown) => calls.assign.push(i), isPending: false }),
  useAddRosterRow: () => ({
    mutateAsync: async (i: { name: string; phone: string; dispatcherId: string; dispatcherName: string }) => {
      calls.add.push(i);
      return { ...onBoard, id: 'dbr_new', driverId: null, name: i.name, phone: i.phone, dispatcherId: i.dispatcherId, dispatcherName: i.dispatcherName, version: 1 };
    },
    isPending: false,
  }),
}));
vi.mock('@/features/operations/usePermissions', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/operations/usePermissions')>()),
  useHasPermission: (code: string) => code === 'drivers.edit',
}));

const team = { id: 'team_alex_samuel', name: 'AXEL / SOREN' };

describe('Add driver: drivers not on the board', () => {
  beforeEach(() => {
    calls.assign.length = 0;
    calls.update.length = 0;
  });

  it('finds a driver file with no board row by D-number and adds him through the assign path', async () => {
    const user = userEvent.setup();
    renderPage(<AddDriverDialog open team={team} onClose={() => undefined} />);
    await user.type(await screen.findByRole('searchbox', { name: 'Search drivers' }), 'D-2112');
    const line = await screen.findByRole('button', { name: /Gerald Ashford/i });
    expect(line).toHaveTextContent('not on board');
    expect(screen.queryByRole('button', { name: /MARK DOE/i })).toBeNull();
    await user.click(line);
    await waitFor(() => expect(calls.assign).toHaveLength(1));
    expect(calls.assign[0]).toMatchObject({ driverId: 'drv_jerry', dispatcherId: team.id, dispatcherName: team.name });
    expect((calls.assign[0] as { expectedVersion?: number }).expectedVersion).toBeUndefined();
  });

  it('finds him by name and by phone', async () => {
    const user = userEvent.setup();
    renderPage(<AddDriverDialog open team={team} onClose={() => undefined} />);
    const search = await screen.findByRole('searchbox', { name: 'Search drivers' });
    await user.type(search, 'gerald ashford');
    expect(await screen.findByRole('button', { name: /Gerald Ashford/i })).toBeInTheDocument();
    await user.clear(search);
    await user.type(search, '555-000-2112');
    expect(await screen.findByRole('button', { name: /Gerald Ashford/i })).toBeInTheDocument();
  });

  it('offers Put back on board for a removed row; leaving his old team asks why, then sends the row and its version', async () => {
    const user = userEvent.setup();
    renderPage(<AddDriverDialog open team={team} onClose={() => undefined} />);
    await user.type(await screen.findByRole('searchbox', { name: 'Search drivers' }), 'D-3000');
    const line = await screen.findByRole('button', { name: /Paul Removed/i });
    expect(line).toHaveTextContent('Put back on board');
    await user.click(line);
    expect(calls.assign).toHaveLength(0);
    const trigger = await screen.findByRole('combobox', { name: 'Why the driver leaves MARK' });
    trigger.focus();
    await user.keyboard('{Enter}');
    await user.click((await screen.findAllByRole('option'))[0]!);
    await user.click(screen.getByRole('button', { name: 'Move driver' }));
    await waitFor(() => expect(calls.assign).toHaveLength(1));
    expect(calls.assign[0]).toMatchObject({ driverId: 'drv_paul', rosterId: 'drv_paul', expectedVersion: 7, dispatcherId: team.id });
    expect((calls.assign[0] as { reason: string }).reason.length).toBeGreaterThan(1);
  });

  /** Owner, 2026-10-26: the quick board-only add stays, and says the row needs a driver file. */
  it('Create new driver adds the board row, then offers Create driver file prefilled from it', async () => {
    const user = userEvent.setup();
    renderPage(<AddDriverDialog open team={team} onClose={() => undefined} />);
    await user.click(await screen.findByRole('button', { name: /Create new driver/ }));
    expect(screen.getByRole('dialog')).toHaveTextContent(/Loads can be assigned once the driver has a driver file/);
    await user.type(screen.getByPlaceholderText('JOHN SMITH'), 'XAVIER SUTTON');
    await user.click(screen.getByRole('button', { name: 'Add driver' }));
    await waitFor(() => expect(calls.add).toHaveLength(1));
    expect(await screen.findByText('No load can be assigned yet')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Create driver file' }));
    expect(await screen.findByLabelText(/First name/)).toHaveValue('Xavier');
    expect(screen.getByLabelText(/Last name/)).toHaveValue('Sutton');
  });

  it('still finds a board row by its driver number', async () => {
    const user = userEvent.setup();
    renderPage(<AddDriverDialog open team={team} onClose={() => undefined} />);
    await user.type(await screen.findByRole('searchbox', { name: 'Search drivers' }), 'd-1001');
    await user.click(await screen.findByRole('button', { name: /MARK DOE/i }));
    await waitFor(() => expect(calls.update).toHaveLength(1));
    expect(calls.update[0]).toMatchObject({ id: 'drv_mark', dispatcherId: team.id, expectedVersion: 2 });
  });
});
