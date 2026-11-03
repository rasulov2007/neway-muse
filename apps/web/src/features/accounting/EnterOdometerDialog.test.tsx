import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { Statement } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { EnterOdometerButton, hasOdometerProblem } from './EnterOdometerDialog';

/** The write goes to the server; nothing here calculates. */
const mocks = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiPost: (path: string, body: unknown) => mocks.apiPost(path, body),
}));

function statement(over: Partial<Statement> = {}): Statement {
  return {
    id: 'stm_drv_1_2026-10-12',
    settlementNumber: 'ST-20261012-DRV001',
    batchId: 'bat_1',
    kind: 'lo_oo',
    partyType: 'driver',
    partyId: 'drv_1',
    partyName: 'E2E Lease',
    truckId: 'trk_700123',
    unitNumber: '700123',
    periodStart: '2026-10-12',
    periodEnd: '2026-10-18',
    cutoffAt: '2026-10-19T22:00:00.000Z',
    payDate: '2026-10-22',
    status: 'review',
    netCents: 0,
    payableCents: 0,
    carryCents: 0,
    computation: null,
    vendor: null,
    snapshot: null,
    loadIds: [],
    exceptions: ['No odometer readings for unit 700123 at both ends of the week: the maintenance fee cannot be figured.'],
    approvedAt: null,
    approvedBy: null,
    paidAt: null,
    paymentId: null,
    paidCents: null,
    notes: null,
    versions: [],
    createdAt: '2026-10-19T22:00:00.000Z',
    updatedAt: '2026-10-19T22:00:00.000Z',
    ...over,
  };
}

describe('Enter odometer from a statement (owner, 2026-10-21)', () => {
  it('recognises the odometer problem among the statement warnings', () => {
    expect(hasOdometerProblem(statement())).toBe(true);
    expect(hasOdometerProblem(statement({ exceptions: ['Rate not confirmed.'] }))).toBe(false);
  });

  it('is offered only on a draft with a truck, to someone who can edit', async () => {
    // The router mounts the page after a tick, so each case is awaited through a marker.
    const cases: Array<[string, Statement, boolean]> = [
      ['approved', statement({ status: 'approved' }), true],
      ['no truck', statement({ truckId: null }), true],
      ['no edit', statement(), false],
      ['no odometer problem', statement({ exceptions: ['Rate not confirmed.'] }), true],
    ];
    for (const [name, s, canEdit] of cases) {
      const { unmount } = renderPage(<><span>case {name}</span><EnterOdometerButton s={s} canEdit={canEdit} onDone={async () => {}} /></>);
      await screen.findByText(`case ${name}`);
      expect(screen.queryByRole('button', { name: 'Enter odometer' }), name).toBeNull();
      unmount();
    }
  });

  it('saves both ends of the week for the statement and reads it back', async () => {
    const user = userEvent.setup();
    const onDone = vi.fn(async () => {});
    mocks.apiPost.mockResolvedValueOnce({ statement: statement({ exceptions: [] }), readings: [{ end: 'start', readingAt: '2026-10-12T03:59:00.000Z', odometerMiles: 120000, status: 'ok', conflictReason: null }, { end: 'end', readingAt: '2026-10-19T03:59:00.000Z', odometerMiles: 122000, status: 'ok', conflictReason: null }] });
    renderPage(<EnterOdometerButton s={statement()} canEdit onDone={onDone} />);
    await user.click(await screen.findByRole('button', { name: 'Enter odometer' }));
    expect(await screen.findByRole('dialog', { name: 'Enter odometer · unit 700123' })).toBeVisible();
    const save = screen.getByRole('button', { name: 'Save readings' });
    expect(save).toBeDisabled();

    await user.type(screen.getByLabelText('Odometer at the start of the week'), '120,000');
    expect(save).toBeEnabled();
    await user.type(screen.getByLabelText('Odometer at the end of the week'), '119000');
    expect(screen.getByText('Cannot be below the start.')).toBeVisible();
    expect(save).toBeDisabled();
    await user.clear(screen.getByLabelText('Odometer at the end of the week'));
    await user.type(screen.getByLabelText('Odometer at the end of the week'), '122000');
    await user.type(screen.getByLabelText('Odometer note'), 'dash photo');
    await user.click(save);

    expect(mocks.apiPost).toHaveBeenCalledWith('/accounting/settlements/stm_drv_1_2026-10-12/odometer', { startMiles: 120000, endMiles: 122000, note: 'dash photo' });
    expect(onDone).toHaveBeenCalled();
    expect(await screen.findByText('Odometer entered')).toBeVisible();
  });
});
