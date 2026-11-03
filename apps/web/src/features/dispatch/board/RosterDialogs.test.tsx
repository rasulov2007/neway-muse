import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { RosterRow } from '@neway/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { EditDriverDialog } from './RosterDialogs';

/*
 * Edit driver (owner, 2026-10-26): "I unassign a driver, pick a reason and a week, but the driver
 * doesn't move". Save used to send only the PUT and drop the Unassign box; now every way of saying
 * Unassign sends POST /unassign with the reason and the week, and Remove from board is its own call.
 */
const calls = vi.hoisted(() => ({ update: [] as unknown[], unassign: [] as unknown[], remove: [] as unknown[] }));
const mutation = (list: unknown[], answer: (input: { id: string; expectedVersion: number }) => unknown) => ({
  mutateAsync: async (input: { id: string; expectedVersion: number }) => {
    list.push(input);
    return answer(input);
  },
  isPending: false,
});
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  useRoster: () => ({ data: undefined, isPending: false }),
  useUpdateRosterRow: () => mutation(calls.update, (i) => ({ id: i.id, version: i.expectedVersion + 1 })),
  useUnassignRosterRow: () => mutation(calls.unassign, (i) => ({ id: i.id, version: i.expectedVersion + 1 })),
  useRemoveRosterRowFromBoard: () => mutation(calls.remove, (i) => ({ id: i.id, version: i.expectedVersion + 1 })),
  useRestoreRosterRow: () => ({ mutateAsync: async () => undefined, isPending: false }),
}));
vi.mock('@/features/people/useDispatchers', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/people/useDispatchers')>()),
  useDispatchers: () => ({
    data: [
      { id: 'team_alex_samuel', name: 'AXEL / SOREN', active: true, position: 'Dispatcher', employeeNumber: 'E-1', status: 'active' },
      { id: 'team_mark', name: 'MARK', active: true, position: 'Dispatcher', employeeNumber: 'E-2', status: 'active' },
    ],
  }),
}));

const destin: RosterRow = {
  id: 'drv_ditat_Destry Prowse',
  driverId: 'drv_ditat_Destry Prowse',
  name: 'DESTRY PROWSE',
  coDriver: null,
  sourceName: null,
  payTag: null,
  truckUnit: '0033',
  phone: '',
  dispatcherId: 'team_alex_samuel',
  dispatcherName: 'AXEL / SOREN',
  comment: '',
  unassignedAt: null,
  unassignedReason: null,
  truckConflict: false,
  version: 4,
};

async function pickReason(user: ReturnType<typeof userEvent.setup>, label: string) {
  const trigger = screen.getByRole('combobox', { name: label });
  trigger.focus();
  await user.keyboard('{Enter}');
  const options = await screen.findAllByRole('option');
  await user.click(options[0]!);
}

describe('Edit driver: Unassign', () => {
  beforeEach(() => {
    calls.update.length = 0;
    calls.unassign.length = 0;
    calls.remove.length = 0;
  });

  it('a reason in the Unassign box and the dialog Save sends POST /unassign with the week Monday (the owner\'s clicks)', async () => {
    const user = userEvent.setup();
    renderPage(<EditDriverDialog row={destin} week="2026-10-28" onClose={() => undefined} />);
    await screen.findByRole('dialog');
    await pickReason(user, 'Why the driver leaves AXEL / SOREN');
    await user.click(screen.getByRole('button', { name: 'Save and unassign' }));
    await waitFor(() => expect(calls.unassign).toHaveLength(1));
    expect(calls.unassign[0]).toMatchObject({ id: destin.id, fromWeek: '2026-10-26', expectedVersion: 4 });
    expect((calls.unassign[0] as { reason: string }).reason.length).toBeGreaterThan(1);
    expect(calls.update).toHaveLength(0); // nothing else changed, so no PUT
  });

  it('Team = "No dispatcher" asks why, then sends the Unassign from the chosen week', async () => {
    const user = userEvent.setup();
    renderPage(<EditDriverDialog row={destin} week="2026-10-26" onClose={() => undefined} />);
    await screen.findByRole('dialog');
    const team = screen.getByRole('combobox', { name: 'Team' });
    team.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('option', { name: /No dispatcher/ }));
    await user.click(screen.getByRole('button', { name: 'Save and unassign' }));
    expect(await screen.findByText('Say why the driver leaves AXEL / SOREN')).toBeVisible();
    expect(calls.unassign).toHaveLength(0);

    await user.click(screen.getByRole('button', { name: 'Previous week' }));
    await pickReason(user, 'Why the driver leaves AXEL / SOREN');
    await user.click(screen.getByRole('button', { name: 'Unassign' }));
    await waitFor(() => expect(calls.unassign).toHaveLength(1));
    expect(calls.unassign[0]).toMatchObject({ fromWeek: '2026-10-19', expectedVersion: 4 });
  });

  it('other changes saved with an Unassign go first, and the Unassign carries the new version', async () => {
    const user = userEvent.setup();
    renderPage(<EditDriverDialog row={destin} week="2026-10-26" onClose={() => undefined} />);
    await screen.findByRole('dialog');
    const truck = screen.getByDisplayValue('0033');
    await user.clear(truck);
    await user.type(truck, '0034');
    await pickReason(user, 'Why the driver leaves AXEL / SOREN');
    await user.click(screen.getByRole('button', { name: 'Save and unassign' }));
    await waitFor(() => expect(calls.unassign).toHaveLength(1));
    expect(calls.update).toHaveLength(1);
    expect(calls.update[0]).toMatchObject({ truckUnit: '0034', dispatcherId: undefined, expectedVersion: 4 });
    expect(calls.unassign[0]).toMatchObject({ expectedVersion: 5 });
  });

  it('a driver in Unassigned drivers is moved back to a team from the chosen week', async () => {
    const user = userEvent.setup();
    renderPage(<EditDriverDialog row={{ ...destin, dispatcherId: '', dispatcherName: '' }} week="2026-10-26" onClose={() => undefined} />);
    await screen.findByRole('dialog');
    expect(screen.getByText('In Unassigned drivers')).toBeVisible();
    const team = screen.getByRole('combobox', { name: 'Team' });
    team.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('option', { name: /MARK/ }));
    await user.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(calls.update).toHaveLength(1));
    expect(calls.update[0]).toMatchObject({ dispatcherId: 'team_mark', dispatcherName: 'MARK', fromWeek: '2026-10-26' });
    expect(calls.unassign).toHaveLength(0);
  });

  it('Remove from board is a separate, clearly named call', async () => {
    const user = userEvent.setup();
    renderPage(<EditDriverDialog row={destin} week="2026-10-26" onClose={() => undefined} />);
    await screen.findByRole('dialog');
    await user.click(screen.getByRole('button', { name: 'Remove from board instead…' }));
    const box = screen.getByTestId('remove-from-board');
    await pickReason(user, 'Why the row is removed from the board');
    await user.click(within(box).getByRole('button', { name: 'Remove from board' }));
    await waitFor(() => expect(calls.remove).toHaveLength(1));
    expect(calls.remove[0]).toMatchObject({ id: destin.id, fromWeek: '2026-10-26' });
    expect(calls.unassign).toHaveLength(0);
  });
});
