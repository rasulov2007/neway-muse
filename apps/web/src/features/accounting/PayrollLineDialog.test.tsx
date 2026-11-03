import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import type { ServerPayrollPeriod } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { PayrollLineDialog } from './PayrollLineDialog';
import { classifyCommissionNote, formatDayRange } from './payroll-review';

const setPayrollLine = vi.fn(async () => ({}));
vi.mock('@/demo', async (orig) => ({ ...(await orig<typeof import('@/demo')>()), setPayrollLine: (...args: unknown[]) => (setPayrollLine as (...a: unknown[]) => unknown)(...args) }));

const UNATTRIBUTED = 'Not attributed: ARLO / MAXWELL (12.00) — "ARLO / MAXWELL" is shared and has no allocation, or its shares do not total 100 %. Set the split in Dispatch › Salary report before this period can be finalized.';
const GRID = 'This payroll period (2026-09-27 – 2026-10-24) is not the four-week block the dispatch board uses (2026-09-07 – 2026-10-04). The commission weeks and the payroll period do not line up; an administrator should align the anchor in Settings › Accounting.';

function period(exceptions: string[]): ServerPayrollPeriod {
  return {
    id: 'pp_1',
    periodNumber: 'DP-20260927',
    kind: 'dispatcher',
    periodStart: '2026-09-27',
    periodEnd: '2026-10-24',
    payDate: '2026-10-31',
    status: 'draft',
    blocked: 0,
    netCents: 5700,
    lines: [{
      employeeId: 'emp_oscar',
      employeeName: 'Oscar Brown',
      role: 'Dispatcher',
      plan: { kind: 'dispatcher_commission' } as never,
      commissionCents: 5700,
      commissionSource: 'computed',
      commissionReason: null,
      bonusCents: 0,
      advanceCents: 0,
      adjustments: [],
      baseCents: 5700,
      grossCents: 5700,
      netCents: 5700,
      exceptions: [],
      commissionDetail: {
        employeeId: 'emp_oscar', dispatcherId: 'emp_oscar', dispatcherName: 'Oscar Brown', periodStart: '2026-09-27', periodEnd: '2026-10-24',
        payableCents: 5700, commissionCents: 5700, bonusesCents: 0, penaltiesCents: 0, sharePct: null, policyVersions: ['2026-09-23'], needsMiles: 0, weeks: [], adjustments: [], exceptions,
        trucks: [
          { weekStart: '2026-09-28', truckUnit: '0042', unit: 'solo', grossCents: 570000, miles: 1202, rpm: 4.74, basePct: 1, bonusPct: 0, tier: 'Below floor', overrideCents: null, payableCents: 5700, formula: 'f' },
          { weekStart: '2026-10-05', truckUnit: '0043', unit: 'team', grossCents: 0, miles: 0, rpm: null, basePct: 0, bonusPct: 0, tier: 'No gross', overrideCents: null, payableCents: 0, formula: 'f' },
        ],
      } as never,
    }],
  } as unknown as ServerPayrollPeriod;
}

const open = (exceptions: string[] = []) => renderPage(<PayrollLineDialog period={period(exceptions)} employeeId="emp_oscar" onClose={() => {}} onDone={async () => {}} />);

describe('dispatcher pay review', () => {
  it('reads the KPI as the mockup lays it out', async () => {
    open();
    expect(await screen.findByText('Review dispatcher pay')).toBeVisible();
    expect(screen.getByText('Oscar Brown · DP-20260927')).toBeVisible();
    expect(screen.getByText('Sep 27 – Oct 24, 2026')).toBeVisible();
    expect(screen.getByText('KPI rule · Sep 23, 2026')).toBeVisible();
    expect(screen.getByText('2 truck-weeks')).toBeVisible();
    const table = screen.getByRole('table');
    expect(within(table).getByText('Sep 28, 2026')).toBeVisible();
    expect(within(table).getByText('Solo')).toBeVisible();
    expect(within(table).getByText('Team')).toBeVisible();
    expect(within(table).getByText('$5,700.00')).toBeVisible();
    expect(within(table).getByText('Below floor')).toBeVisible();
    expect(within(table).getByText('1,202')).toBeVisible();
    expect(within(table).getByText('$4.74')).toBeVisible();
    expect(within(table).getByText('1.00%')).toBeVisible();
    expect(within(table).getByText('Period commission')).toBeVisible();
    expect(screen.queryByText('Dispatcher allocation incomplete')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Total pay' })).toHaveValue('$57.00');
  });

  it('turns the KPI notes into warning cards with a way to fix each', async () => {
    open([UNATTRIBUTED, GRID, 'Something else to check.']);
    expect(await screen.findByText('Dispatcher allocation incomplete')).toBeVisible();
    expect(screen.getByText('ARLO / MAXWELL has no complete allocation. Review the split before finalizing.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Review allocation' })).toBeVisible();
    expect(screen.getByText('Payroll and KPI periods differ')).toBeVisible();
    expect(screen.getByText('Payroll Sep 27 – Oct 24 · Board Sep 7 – Oct 4')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Review periods' })).toBeVisible();
    expect(screen.getByText('Something else to check.')).toBeVisible();
  });

  it('asks for a reason when the KPI commission is changed, and saves through the same call', async () => {
    const user = userEvent.setup();
    open();
    await screen.findByText('Review dispatcher pay');
    expect(screen.queryByLabelText('Override reason')).toBeNull();
    const commission = screen.getByLabelText('Commission');
    await user.clear(commission);
    await user.type(commission, '60');
    await user.type(screen.getByLabelText('Override reason'), 'missed load');
    await user.clear(screen.getByLabelText('Bonus'));
    await user.type(screen.getByLabelText('Bonus'), '10');
    expect(screen.getByRole('textbox', { name: 'Total pay' })).toHaveValue('$70.00');
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(setPayrollLine).toHaveBeenCalledWith('pp_1', expect.objectContaining({ employeeId: 'emp_oscar', commissionCents: 6000, reason: 'missed load', bonusCents: 1000, advanceCents: 0 }));
  });

  it('keeps advances and approved adjustments under Pay adjustments', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('tab', { name: 'Pay adjustments' }));
    expect(screen.getByLabelText('Advance')).toBeVisible();
    expect(screen.getByLabelText('Adjustment description')).toBeVisible();
  });
});

describe('payroll review helpers', () => {
  it('formats ranges', () => {
    expect(formatDayRange('2026-09-27', '2026-10-24')).toBe('Sep 27 – Oct 24, 2026');
    expect(formatDayRange('2026-12-28', '2027-01-24')).toBe('Dec 28, 2026 – Jan 24, 2027');
  });
  it('classifies server notes', () => {
    expect(classifyCommissionNote(UNATTRIBUTED)).toMatchObject({ kind: 'allocation', name: 'ARLO / MAXWELL' });
    expect(classifyCommissionNote(GRID)).toMatchObject({ kind: 'grid', payroll: { start: '2026-09-27', end: '2026-10-24' }, board: { start: '2026-09-07', end: '2026-10-04' } });
  });
});
