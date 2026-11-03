import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { accidentsV2 as A } from '@neway/shared';
import { ToastProvider } from '@/design-system/components/Toast';
import { setClockForTests } from '@/lib/clock';

/**
 * Accident & Claims v2 — P5 web checks: the Analytics view draws the server's analytics (sample banner M4, KPIs, a
 * table for every chart M6, drill-down to exactly the bucket's cases M5, no money for a role without it), and the
 * profile section shows the SPEC §6.3 note and a lock line for a restricted personnel action (L2).
 */
const analytics = vi.fn();
const profile = vi.fn();
vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => vi.fn(),
  Link: ({ children }: { children: ReactNode }) => <a href="#case">{children}</a>,
}));
vi.mock('./api', async (importOriginal) => {
  const real = await importOriginal<typeof import('./api')>();
  return { ...real, useAnalytics: (...a: unknown[]) => analytics(...a), useProfileAccidents: (...a: unknown[]) => profile(...a) };
});

const { AnalyticsView } = await import('./AnalyticsView');
const { ProfileAccidents } = await import('./ProfileAccidents');

const ref = (id: string, number: string): A.AnalyticsCaseRef => ({ id, number, occurredAt: '2026-09-10T15:00:00.000Z', tz: 'America/Chicago', truckUnit: '118', driverName: 'Andre Lewis', type: 'Backing', severity: 'minor', preventability: 'preventable', netCostCents: 120_000 });

function data(over: Partial<A.AnalyticsResponse> = {}): A.AnalyticsResponse {
  return {
    from: '2026-07-21T17:00:00.000Z',
    to: '2026-10-19T17:00:00.000Z',
    months: ['2026-09', '2026-10'],
    sample: { cases: 3, smallSample: true },
    kpis: {
      accidents: 3,
      dotRecordable: 1,
      caseIds: ['a1', 'a2', 'a3'],
      ratePerMillionMiles: { value: null, reason: 'No mileage data', qualifyingMonths: 0, totalMonths: 2 },
      preventableShare: { value: 0.75, preventable: 3, decided: 4, notDecided: 2, caseIds: ['a1'] },
      investigationDays: { median: 9, within14: 2, count: 2 },
      netCostCents: 3_384_000,
      spentCents: 3_083_000,
      recoveredCents: 1_589_000,
      downtime: { truckDays: 19.4, lostRevenueCents: 1_218_000 },
    },
    insights: [{ id: 'backing', tone: 'warning', text: 'Low-speed backing and parking incidents: 2 of 3 preventable cases.', caseIds: ['a1', 'a2'] }],
    byMonth: [
      { month: '2026-09', minor: 2, moderate: 0, serious: 0, critical: 0, caseIds: ['a1', 'a2'] },
      { month: '2026-10', minor: 0, moderate: 1, serious: 0, critical: 0, caseIds: ['a3'] },
    ],
    ratePerMonth: [
      { month: '2026-09', value: null, coverage: null, cases: 2, miles: null, note: 'No mileage data', caseIds: ['a1', 'a2'] },
      { month: '2026-10', value: null, coverage: null, cases: 1, miles: null, note: 'No mileage data', caseIds: ['a3'] },
    ],
    byType: [{ type: 'Backing', count: 2, caseIds: ['a1', 'a2'] }, { type: 'Other', count: 1, caseIds: ['a3'] }],
    preventability: [
      { outcome: 'preventable', count: 2, caseIds: ['a1', 'a2'] },
      { outcome: 'non_preventable', count: 0, caseIds: [] },
      { outcome: 'not_determined', count: 1, caseIds: ['a3'] },
    ],
    cashByMonth: [
      { month: '2026-09', spentCents: 200_000, recoveredCents: 0, caseIds: ['a1', 'a2'] },
      { month: '2026-10', spentCents: 100_000, recoveredCents: 50_000, caseIds: ['a3'] },
    ],
    estimateVsFinal: [],
    estimateBias: null,
    downtimeByTruck: [{ truckId: 't118', unit: '118', truckDays: 19.4, caseIds: ['a3'] }],
    whereByCorridor: [{ label: 'I-80 · IL', count: 3, caseIds: ['a1', 'a2', 'a3'] }],
    repeatInvolvement: [{ kind: 'driver', id: 'd2', label: 'Andre Lewis', cases: 2, preventable: 1, caseIds: ['a1', 'a2'], numbers: ['ACC-2026-005', 'ACC-2026-016'] }],
    followThrough: { correctiveActions: { total: 3, done: 1, onTime: 1, overdue: 1 }, ownDamageReceivedCents: 1_589_000, ownDamageExpectedCents: 1_589_000, recoveriesCents: 0, recoveriesPursuedCents: 0, medianDaysToSettle: 30, settled: 1, cpdp: { submitted: 0, notPreventable: 0, eligibleNotSubmitted: 1 } },
    cases: { a1: ref('a1', 'ACC-2026-001'), a2: ref('a2', 'ACC-2026-002'), a3: ref('a3', 'ACC-2026-003') },
    ...over,
  };
}

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  analytics.mockReset();
  profile.mockReset();
  setClockForTests('2026-10-19T17:00:00Z');
});

describe('Analytics view (P5)', () => {
  it('M4 shows the small-sample banner and the KPIs from the server', () => {
    analytics.mockReturnValue({ data: data(), isLoading: false, error: null });
    wrap(<AnalyticsView range={{ range: '90d' }} rangeLabel="last 90 days" />);
    expect(screen.getByText(/Based on 3 cases \(last 90 days\)\. Small sample — treat trends as directional, not conclusive\./)).toBeTruthy();
    const kpis = document.getElementById('analytics-kpis') as HTMLElement;
    expect(within(kpis).getByText('75%')).toBeTruthy();
    expect(within(kpis).getByText('3 of 4 decided · 2 not decided yet')).toBeTruthy();
    expect(within(kpis).getByText('Not shown: no mileage data')).toBeTruthy();
    expect(within(kpis).getByText('$33.8K')).toBeTruthy();
  });

  it('M6 “Show as tables” adds a table for every chart', async () => {
    analytics.mockReturnValue({ data: data(), isLoading: false, error: null });
    wrap(<AnalyticsView range={{ range: '90d' }} rangeLabel="last 90 days" />);
    expect(screen.queryAllByRole('table').filter((t) => !t.closest('#repeat'))).toHaveLength(0);
    await userEvent.click(screen.getByRole('button', { name: 'Show as tables' }));
    // month, rate, type, preventability, cash, downtime, where (estimate-vs-final has no closed cases)
    expect(screen.getAllByRole('table').filter((t) => !t.closest('#repeat'))).toHaveLength(7);
  });

  it('M5 an insight and a bar open exactly the cases behind them', async () => {
    analytics.mockReturnValue({ data: data(), isLoading: false, error: null });
    wrap(<AnalyticsView range={{ range: '90d' }} rangeLabel="last 90 days" />);
    await userEvent.click(within(document.getElementById('insights') as HTMLElement).getByRole('button', { name: '2 cases' }));
    let drill = document.getElementById('drill') as HTMLElement;
    expect(within(drill).getAllByText(/^ACC-2026-00/).map((n) => n.textContent)).toEqual(['ACC-2026-001', 'ACC-2026-002']);
    await userEvent.keyboard('{Escape}');
    await userEvent.click(screen.getByTitle('Other: 1'));
    drill = document.getElementById('drill') as HTMLElement;
    expect(within(drill).getAllByText(/^ACC-2026-00/).map((n) => n.textContent)).toEqual(['ACC-2026-003']);
  });

  it('a role without money sees no money charts and a reason on the KPI', () => {
    analytics.mockReturnValue({ data: data({ cashByMonth: null, estimateVsFinal: null, kpis: { ...data().kpis, netCostCents: null, spentCents: null, recoveredCents: null, downtime: { truckDays: 19.4, lostRevenueCents: null } } }), isLoading: false, error: null });
    wrap(<AnalyticsView range={{ range: '90d' }} rangeLabel="last 90 days" />);
    expect(screen.getByText('Repair costs are not shown to your role')).toBeTruthy();
    expect(screen.queryByText('Cash cost by month')).toBeNull();
  });

  it('shows Loading… before the numbers arrive', () => {
    analytics.mockReturnValue({ data: undefined, isLoading: true, error: null });
    wrap(<AnalyticsView range={{ range: '90d' }} rangeLabel="last 90 days" />);
    expect(screen.getByText('Loading…')).toBeTruthy();
  });
});

describe('Profile section (P5)', () => {
  it('L2 driver: both cases, the review note, and a lock line for a restricted personnel action', () => {
    profile.mockReturnValue({
      isLoading: false,
      error: null,
      data: {
        kind: 'driver',
        id: 'd2',
        cases: [
          { id: 'c16', number: 'ACC-2026-016', occurredAt: '2026-10-02T15:47:00.000Z', tz: 'America/Chicago', type: 'Rear-end — we struck the vehicle ahead', severity: 'serious', stage: 'investigation', dotRecordable: 'yes', preventability: 'not_determined', outcome: null, downtimeDays: 16.8, netCostCents: 1_035_000, workOrders: [{ id: 'w', number: 'RO-2026-9131', status: 'Waiting for approval', title: 'Front end' }] },
          { id: 'c05', number: 'ACC-2026-005', occurredAt: '2026-03-15T13:10:00.000Z', tz: 'America/Chicago', type: 'Rear-end — we struck the vehicle ahead', severity: 'serious', stage: 'closed', dotRecordable: 'yes', preventability: 'preventable', outcome: 'Preventable; retraining completed', downtimeDays: 19, netCostCents: 900_000, workOrders: [] },
        ],
        kpis: { total: 2, last12m: 2, preventable12m: 1, nonPreventable12m: 0, dotRecordable12m: 2, reviewSuggested: true, spendCents: null, downtimeDays: 35.8, openCorrectiveActions: 1 },
        note: '2 cases in 12 months. Review the circumstances with the driver before drawing conclusions — 0 of them were non-preventable.',
        correctiveActions: [{ id: 'r1', caseId: 'c16', caseNumber: 'ACC-2026-016', kind: 'Disciplinary review', title: 'Restricted personnel action', locked: true, status: 'Open', dueAt: '2026-10-26T21:00:00.000Z', completedAt: null }],
      } satisfies A.ProfileAccidentsResponse,
    });
    wrap(<ProfileAccidents kind="driver" id="d2" />);
    expect(screen.getAllByText('ACC-2026-016').length).toBeGreaterThan(0);
    expect(screen.getByText('ACC-2026-005')).toBeTruthy();
    expect(screen.getByTestId('accidents-note').textContent).toBe('2 cases in 12 months. Review the circumstances with the driver before drawing conclusions — 0 of them were non-preventable.');
    expect(screen.getByText('Review suggested')).toBeTruthy();
    expect(screen.getByText('Restricted personnel action')).toBeTruthy();
  });
});
