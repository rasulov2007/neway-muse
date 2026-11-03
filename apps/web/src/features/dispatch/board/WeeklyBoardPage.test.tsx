import { screen, within } from '@testing-library/react';
import { addDays, type WeeklyBoard, type WeeklyBoardRow } from '@neway/shared';
import { describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { WeeklyBoardPage } from './WeeklyBoardPage';

const WEEK = '2026-10-26';
const mocks = vi.hoisted(() => ({ board: null as WeeklyBoard | null }));
vi.mock('./api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./api')>()),
  useWeeklyBoard: () =>
    mocks.board
      ? { data: mocks.board, isPending: false, isFetching: false, isError: false, error: null, refetch: async () => undefined }
      : { data: undefined, isPending: true, isFetching: true, isError: false, error: null, refetch: async () => undefined },
  useWriteCells: () => ({ mutateAsync: async () => undefined, isPending: false }),
  useWriteFills: () => ({ mutateAsync: async () => undefined, isPending: false }),
}));

const days = Array.from({ length: 7 }, (_, i) => addDays(WEEK, i));
function row(over: Partial<WeeklyBoardRow> & { driverId: string; driverName: string }): WeeklyBoardRow {
  return {
    coDriver: null,
    payTag: null,
    driverType: 'company',
    comment: '',
    driverNumber: 'D-1',
    truckUnit: '0033',
    dispatcherId: 'team_alex_samuel',
    dispatcherName: 'AXEL / SOREN',
    unit: 'solo',
    pinned: false,
    days: days.map((day) => ({ day, autoAmount: 0, autoMiles: 0, loadNumbers: [], loadLabels: [], loads: [], amount: 0, miles: 0, statusWord: null, amountCell: null, milesCell: null, loadCell: null, fills: {} })),
    weekComment: null,
    total: 0,
    miles: 0,
    rpm: null,
    goal: 10000,
    planReach: -10000,
    planAdj: -10000,
    daysWorked: 0,
    efficiencyPct: 0,
    commission: null,
    unassignedAt: null,
    rosterVersion: 1,
    ...over,
  };
}

describe('the weekly board', () => {
  /** An unassigned driver stays on the board, in his own group after the teams (owner, 2026-10-26). */
  it('shows a driver with no dispatcher this week under "Unassigned drivers", after the teams', async () => {
    mocks.board = {
      weekStart: WEEK,
      days,
      payBlock: { block: 1, week: 1, start: WEEK, end: addDays(WEEK, 20) },
      isoWeek: { year: 2026, week: 44 },
      policyVersion: 'v1',
      rows: [
        row({ driverId: 'drv_destin', driverName: 'DESTRY PROWSE', dispatcherId: '', dispatcherName: '' }),
        row({ driverId: 'drv_jean', driverName: 'REMY CALLOWAY', truckUnit: '0412' }),
      ],
      unassigned: [],
      teams: [
        { dispatcherId: '', dispatcherName: '', total: 0, miles: 0, rpm: null, goal: 10000, dayTotals: [0, 0, 0, 0, 0, 0, 0], trucks: 1, commissionCents: null },
        { dispatcherId: 'team_alex_samuel', dispatcherName: 'AXEL / SOREN', total: 0, miles: 0, rpm: null, goal: 10000, dayTotals: [0, 0, 0, 0, 0, 0, 0], trucks: 1, commissionCents: null },
      ],
      grand: { total: 0, miles: 0, rpm: null, dayTotals: [0, 0, 0, 0, 0, 0, 0], trucks: 2, commissionCents: null },
      canWrite: true,
      canManage: true,
      seesCommission: false,
    };
    renderPage(<WeeklyBoardPage />, { routePath: '/dispatch/weekly', path: `/dispatch/weekly?week=${WEEK}` });
    const destin = await screen.findByText('DESTRY PROWSE');
    const table = within(destin.closest('table')!);
    const group = table.getByText('Unassigned drivers');
    const team = table.getByText('AXEL / SOREN');
    // Document order: the team band, then the Unassigned band, then Destin under it.
    expect(team.compareDocumentPosition(group) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(group.compareDocumentPosition(destin) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // His row offers Assign (back to a team), the team's driver offers Unassign.
    expect(screen.getByRole('button', { name: 'Assign' })).toBeVisible();
    expect(screen.getByRole('button', { name: 'Unassign' })).toBeVisible();
    mocks.board = null;
  });
});
