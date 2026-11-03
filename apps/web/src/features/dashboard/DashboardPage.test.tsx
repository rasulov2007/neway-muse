import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { DashboardPage } from './DashboardPage';
import {
  allFixtures,
  fetchStub,
  maskedMetric,
  nullMetric,
  overviewFixture,
  type DashboardFixtures,
} from './__fixtures__';

vi.mock('@/demo', () => ({
  demoCompany: { id: 'co_test', name: 'Northwind Freight' },
  getDashboard: vi.fn(() =>
    Promise.resolve({
      kpis: { asOf: '2026-09-06T19:30:00.000Z' },
      atRiskLoads: [
        {
          id: 'ld_1',
          loadNumber: 'L-100245',
          exception: { code: 'at_risk', reason: 'Running 2 h behind appointment' },
          origin: { city: 'Chicago', state: 'IL' },
          destination: { city: 'Dallas', state: 'TX' },
          etaAt: '2026-09-07T01:00:00.000Z',
        },
      ],
      upcomingMaintenance: [
        {
          id: 'pm_1',
          unitNumber: '2801',
          typeLabel: 'Oil change',
          intervalMiles: 15000,
          intervalDays: null,
          milesUntilDue: -420,
          daysUntilDue: -3,
          status: 'overdue',
          scheduledFor: null,
        },
      ],
      safetyAlerts: [],
      insights: [],
    }),
  ),
  listDrivers: vi.fn(() => Promise.resolve({ data: [], total: 0, page: 1, pageSize: 200 })),
  listAiInsights: vi.fn(() =>
    Promise.resolve([
      {
        id: 'ai_1',
        severity: 'warning',
        status: 'open',
        title: 'Fuel cost per mile rising on Unit 2790',
        detail: 'Fuel CPM is up 12% over four weeks. Compare fill-up prices by state.',
      },
    ]),
  ),
}));

function stubFetch(
  fixtures: DashboardFixtures,
  failing: ReadonlyArray<keyof DashboardFixtures> = [],
) {
  const stub = vi.fn(fetchStub(fixtures, failing));
  vi.stubGlobal('fetch', stub);
  return stub;
}

function requestedUrls(stub: ReturnType<typeof vi.fn>): string[] {
  return stub.mock.calls.map((call) => String(call[0]));
}

function render(path = '/dashboard') {
  return renderPage(<DashboardPage />, { routePath: '/dashboard', path });
}

describe('DashboardPage', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('renders the header and every section in §13 order', async () => {
    stubFetch(allFixtures());
    render();

    expect(await screen.findByRole('heading', { level: 1, name: 'Dashboard' })).toBeInTheDocument();
    expect(await screen.findByText('Northwind Freight')).toBeInTheDocument();
    expect(screen.getByText('Demo data')).toBeInTheDocument();

    // The resolved range is stated exactly once, on the Executive overview heading.
    const periodLabels = await screen.findAllByTestId('period-labels');
    expect(periodLabels).toHaveLength(1);
    expect(periodLabels[0]).toHaveTextContent('Aug 31 – Sep 6, 2026 · vs Aug 24 – Aug 30');
    expect(periodLabels[0]).toHaveTextContent('Period in progress');

    const eyebrows = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent?.trim());
    expect(eyebrows).toEqual([
      'Executive overview',
      '8-week performance',
      'Operating economics',
      'Operations',
      'Insurance claims',
      'Fleet economics',
      'Vendor trucks',
      'Driver type detail',
    ]);

    expect(
      await screen.findByRole('heading', { name: /Weekly operating performance/ }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Week detail by driver type' }),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', { name: 'Dispatch performance' }),
    ).toBeInTheDocument();
    expect(await screen.findByRole('heading', { name: 'Fuel by state' })).toBeInTheDocument();
    // The Attention section was removed; its signals live where they are earned instead —
    // reconciliation on the Gross card, unknown pay types in Ops net, expense gaps in the trend.
    expect(screen.queryByRole('heading', { name: 'Data health' })).not.toBeInTheDocument();
    expect(screen.queryByText('Needs attention')).not.toBeInTheDocument();
    // AI insights was removed from the dashboard too; the AI Command Center still carries it.
    expect(screen.queryByTestId('ai-insights-widget')).not.toBeInTheDocument();
    expect(screen.queryByText('Fuel cost per mile rising on Unit 2790')).not.toBeInTheDocument();
    expect(await screen.findByText('L-100245')).toBeInTheDocument();
  });

  it('sends the demo role header and the period to every endpoint', async () => {
    const stub = stubFetch(allFixtures());
    render('/dashboard?period=last_month&role=operations');

    await screen.findByRole('heading', { name: /Weekly operating performance/ });
    const urls = requestedUrls(stub);
    expect(urls.some((u) => u.includes('/dashboard/overview?period=last_month'))).toBe(true);
    // Every dashboard read carries the role. The session lookup the provider makes is not one of
    // them and does not answer to a dashboard role.
    const dashboardCalls = stub.mock.calls.filter((call) =>
      String(call[0]).includes('/dashboard/'),
    );
    expect(dashboardCalls.length).toBeGreaterThan(0);
    for (const call of dashboardCalls) {
      const init = call[1] as RequestInit;
      expect(new Headers(init.headers).get('X-Demo-Role')).toBe('operations');
    }
  });

  it('renders null metrics as "—" with reasons and masked metrics as "••••••"', async () => {
    const overview = overviewFixture();
    overview.financial.cost = nullMetric('no_expense_data');
    overview.unitEconomics.rpm = maskedMetric();
    stubFetch(allFixtures({ overview }));
    render();

    const cost = await screen.findByTitle('No expense data for this period');
    expect(within(cost).getByText('—')).toBeInTheDocument();
    expect(cost).toHaveAttribute('data-metric-state', 'null');

    const rpm = screen.getByTitle('Hidden by your financial visibility');
    expect(within(rpm).getByText('••••••')).toBeInTheDocument();
    expect(rpm).toHaveAttribute('data-metric-state', 'masked');
  });

  it('shows estimated labels from the API', async () => {
    stubFetch(allFixtures());
    render();

    expect(await screen.findByText('estimated $5K')).toBeInTheDocument();
    expect((await screen.findAllByText(/incl\. .* est\./)).length).toBeGreaterThan(0);
    expect((await screen.findAllByText('Estimated')).length).toBeGreaterThan(0);
    // The incomplete week is marked in words in its column header ("Selected · Partial").
    expect(screen.getAllByText(/Partial/).length).toBeGreaterThan(0);
    expect(screen.getByText(/No expense data available for one week/)).toBeInTheDocument();
  });

  it('states a reconciliation gap as a footnote, not a banner', async () => {
    const overview = overviewFixture({
      reconciliation: {
        status: 'mismatch',
        dashboardGross: 125000.5,
        ledgerGross: 124000,
        difference: 1000.5,
      },
    });
    stubFetch(allFixtures({ overview }));
    render();

    // A reconciliation gap is stated as a footnote with a link to where it is fixed, not as a
    // warning banner an executive viewer cannot act on.
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    expect(await screen.findByText(/differs from the revenue ledger/)).toHaveTextContent(
      '$1,000.50',
    );
    expect(screen.getByRole('link', { name: 'Reconcile in Accounting' })).toHaveAttribute(
      'href',
      '/accounting',
    );
    expect(screen.getByText('Mismatch')).toBeInTheDocument();
  });

  it('changes the period from the selector, updates the URL and refetches', async () => {
    const stub = stubFetch(allFixtures());
    const user = userEvent.setup();
    const { router } = render();
    await screen.findByRole('heading', { name: /Weekly operating performance/ });
    const before = requestedUrls(stub).filter((u) => u.includes('/dashboard/overview')).length;

    const select = screen.getByRole('combobox', { name: 'Period' });
    select.focus();
    await user.keyboard('{Enter}');
    await user.keyboard('{ArrowDown}{Enter}');

    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ period: 'last_week' });
    });
    await waitFor(() => {
      const overviewCalls = requestedUrls(stub).filter((u) =>
        u.includes('/dashboard/overview?period=last_week'),
      );
      expect(overviewCalls.length).toBeGreaterThan(0);
    });
    expect(requestedUrls(stub).filter((u) => u.includes('/dashboard/overview')).length).toBe(
      before + 1,
    );
  });

  it('opens the drill-down drawer with the contributing rows', async () => {
    stubFetch(allFixtures());
    const user = userEvent.setup();
    render();

    // The KPI card, not the table header button that is named just "Gross".
    const grossCard = await screen.findByRole('button', { name: /^Gross\s*\$125,000\.50/ });
    await user.click(grossCard);

    const dialog = await screen.findByRole('dialog');
    expect((await within(dialog).findAllByText('Gross revenue')).length).toBeGreaterThan(0);
    expect(within(dialog).getByTestId('drilldown-total')).toHaveTextContent('$125,000.50');
    expect(within(dialog).getByText('L-100245')).toBeInTheDocument();
    expect(within(dialog).getByText('L-100246')).toBeInTheDocument();
    expect(within(dialog).getByRole('link', { name: /Open in Loads/ })).toBeInTheDocument();
  });

  it('tints and badges inactive-loss rows and appends a totals row', async () => {
    stubFetch(allFixtures());
    render();

    const table = await screen.findByTestId('truck-pnl-widget');
    const badge = await within(table).findByText('Inactive truck loss');
    expect(badge).toHaveAttribute('data-inactive-loss');
    const row = badge.closest('tr');
    expect(row).not.toBeNull();
    expect(within(row!).getByText('2801')).toBeInTheDocument();
    expect(table.innerHTML).toContain('bg-danger-soft/40');
    expect(within(table).getByText('Total · 26 trucks')).toBeInTheDocument();
  });

  it('keeps the page up when one section fails and offers a retry', async () => {
    stubFetch(allFixtures(), ['fuel']);
    render();

    expect(
      await screen.findByRole('heading', { name: /Weekly operating performance/ }),
    ).toBeInTheDocument();
    const errors = await screen.findAllByText('Unable to load fuel analytics');
    expect(errors.length).toBe(1);
    expect(screen.getByText('Unable to load fuel by state')).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'Try again' }).length).toBeGreaterThan(0);
    expect(screen.getByText('Week detail by driver type')).toBeInTheDocument();
  });
});
