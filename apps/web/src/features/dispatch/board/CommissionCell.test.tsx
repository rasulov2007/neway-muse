import { render, screen } from '@testing-library/react';
import type { CommissionView, WeeklyBoardRow } from '@neway/shared';
import { describe, expect, it, vi } from 'vitest';
import { CommissionCell } from './CommissionCell';

vi.mock('./api', () => ({
  useWriteOverride: () => ({ mutateAsync: async () => null, isPending: false }),
  useWriteFlags: () => ({ mutateAsync: async () => null, isPending: false }),
}));

/** Commission with no gross (owner, 2026-10-26): $0 until the week has gross. */
function view(over: Partial<CommissionView>): CommissionView {
  return {
    status: 'no_gross',
    calculatedCents: 0,
    payableCents: 0,
    pct: 0,
    basePct: 0,
    bonusPct: 0,
    tier: 'No gross',
    formula: 'No positive gross this week → $0.00',
    bonusWithheld: false,
    override: null,
    flags: { complaint: false, junior: false, reason: '' },
    policyVersion: 'v1',
    ...over,
  };
}

const override = (mode: 'amount' | 'adjustment', amountCents: number) => ({ mode, amountCents, reason: 'check', byName: 'Admin', at: '2026-10-26T12:00:00.000Z', version: 1 });

function rowWith(commission: CommissionView): WeeklyBoardRow {
  return { driverId: 'r1', driverName: 'ANN LEE', coDriver: null, unit: 'solo', truckUnit: '0033', commission } as unknown as WeeklyBoardRow;
}

describe('the Commission cell with no gross', () => {
  it('shows $0.00 · No gross', () => {
    render(<CommissionCell row={rowWith(view({}))} week="2026-10-26" canManage />);
    expect(screen.getByText('$0.00')).toBeVisible();
    expect(screen.getByText(/No gross/)).toBeVisible();
  });

  it('an adjustment on a week with no gross is held: $0.00, and the cell says it waits for gross', () => {
    render(<CommissionCell row={rowWith(view({ override: override('adjustment', 5_000), adjustmentHeld: true }))} week="2026-10-26" canManage />);
    expect(screen.getByText('$0.00')).toBeVisible();
    expect(screen.getByText(/adjustment waits for gross/)).toBeVisible();
    expect(screen.queryByText(/Manual/)).not.toBeInTheDocument();
  });

  it('a manual approved amount stays and is marked Manual', () => {
    render(<CommissionCell row={rowWith(view({ override: override('amount', 25_000), payableCents: 25_000 }))} week="2026-10-26" canManage />);
    expect(screen.getByText('$250.00')).toBeVisible();
    expect(screen.getByText(/Manual/)).toBeVisible();
  });
});
