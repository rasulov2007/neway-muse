import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SYSTEM_REQUIREMENTS, type QualificationItem } from '@neway/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Driver, Trailer, Truck } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { SafetyCommandCenterPage } from './SafetyCommandCenterPage';

// The engine is exercised for real against a fixed 'today'; only the data layer is stubbed.

function driver(id: string, name: string, overrides: Partial<Driver> = {}): Driver {
  return {
    id,
    driverNumber: id.toUpperCase(),
    firstName: name.split(' ')[0] ?? name,
    lastName: name.split(' ')[1] ?? '',
    name,
    phone: '+13125550100',
    email: `${id}@example.test`,
    driverType: 'company',
    cdlState: 'IL',
    cdlClass: 'A',
    cdlEndorsements: [],
    cdlExpiresOn: '2028-01-01',
    cdlStatus: 'verified',
    medicalCardExpiresOn: '2027-01-01',
    medicalCardStatus: 'verified',
    hireDate: '2024-01-01',
    status: 'available',
    dispatcherId: 'usr_1',
    dispatcherName: 'Dispatcher',
    currentTruckId: null,
    currentTruckUnit: null,
    currentTrailerId: null,
    homeCity: 'Chicago',
    homeState: 'IL',
    safetyScore: 90,
    safetyEvents30d: 0,
    payPlan: { kind: 'per_mile', rate: 0.6 },
    preferredLanguage: 'en',
    ...overrides,
  } as Driver;
}

function item(
  entityId: string,
  entityLabel: string,
  code: string,
  overrides: Partial<QualificationItem> = {},
): QualificationItem {
  return {
    id: `qi_${entityId}_${code}`,
    requirementCode: code,
    scope: 'driver',
    entityId,
    entityLabel,
    documentId: `doc_${entityId}_${code}`,
    issuedOn: '2025-01-01',
    expiresOn: '2027-06-01',
    verifiedAt: '2025-01-02T00:00:00.000Z',
    verifiedBy: 'Dana Ortiz',
    verificationFailed: false,
    verificationNote: null,
    waivedUntil: null,
    waivedReason: null,
    notApplicable: false,
    notes: null,
    ...overrides,
  };
}

const DRIVER_RULES = SYSTEM_REQUIREMENTS.filter((r) => r.scope === 'driver');

/** A fully compliant item set for one driver. */
function complete(id: string, label: string): QualificationItem[] {
  return DRIVER_RULES.map((r) =>
    item(id, label, r.code, {
      expiresOn: r.hasExpiry ? '2027-06-01' : null,
      // MVR and PSP fall due 6 months after their date (owner, 2026-10-24): keep them recent.
      ...(r.validityMonths ? { issuedOn: '2026-08-01' } : {}),
    }),
  );
}

const ana = driver('drv_1', 'Ana Ruiz');
const ben = driver('drv_2', 'Ben Cole');
const cy = driver('drv_3', 'Cy Dunn');

const ITEMS: QualificationItem[] = [
  ...complete('drv_1', 'Ana Ruiz'),
  // Ben: CDL expired five days ago → dispatch hold.
  ...complete('drv_2', 'Ben Cole').map((i) =>
    i.requirementCode === 'cdl' ? { ...i, expiresOn: '2026-09-01' } : i,
  ),
  // Cy: medical card expires in 12 days → warning, still dispatchable.
  ...complete('drv_3', 'Cy Dunn').map((i) =>
    i.requirementCode === 'medical_card' ? { ...i, expiresOn: '2026-09-18' } : i,
  ),
];

vi.mock('@/demo', () => ({
  DEMO_TODAY: '2026-09-06',
  demoCurrentUser: { id: 'usr_1', name: 'Sarah Chen' },
  listDrivers: vi.fn(() =>
    Promise.resolve({ data: [ana, ben, cy], total: 3, page: 1, pageSize: 200 }),
  ),
  listTrucks: vi.fn(() =>
    Promise.resolve({ data: [] as Truck[], total: 0, page: 1, pageSize: 200 }),
  ),
  listTrailers: vi.fn(() =>
    Promise.resolve({ data: [] as Trailer[], total: 0, page: 1, pageSize: 200 }),
  ),
}));

// The page is gated on compliance.view; these tests are about what it shows to somebody who
// holds it. The gate itself is the admin kit's, and is tested there.
vi.mock('@/features/admin/useAdmin', () => ({
  usePermissionCheck: () => ({ status: 'granted' as const }),
}));

vi.mock('./compliance-api', () => ({
  listComplianceRequirements: vi.fn(() => Promise.resolve([...SYSTEM_REQUIREMENTS])),
  listQualificationItems: vi.fn(() => Promise.resolve(ITEMS)),
  listConsentRequests: vi.fn(() => Promise.resolve([])),
  listVerificationCases: vi.fn(() => Promise.resolve([])),
  listComplianceAudit: vi.fn(() => Promise.resolve([])),
}));

function render() {
  return renderPage(<SafetyCommandCenterPage />, { routePath: '/safety', path: '/safety' });
}

describe('SafetyCommandCenterPage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('reports holds, expirations and compliance from the engine, not from constants', async () => {
    render();
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Safety command center' }),
    ).toBeInTheDocument();
    expect(await screen.findByText('1 cannot be dispatched')).toBeInTheDocument();

    const held = await screen.findByTestId('tile-held');
    expect(within(held).getByText('1')).toBeInTheDocument();
    const expiring = screen.getByTestId('tile-expiring');
    expect(within(expiring).getByText('1')).toBeInTheDocument();
    const expired = screen.getByTestId('tile-expired');
    expect(within(expired).getByText('1')).toBeInTheDocument();
    const compliant = screen.getByTestId('tile-compliant');
    expect(within(compliant).getByText('1')).toBeInTheDocument();
    expect(within(compliant).getByText(/1 at risk · 1 non-compliant of 3/)).toBeInTheDocument();
  });

  it('folds the open items into one row per requirement, worst first, and opens a record beside the list', async () => {
    render();
    // Default focus is dispatch holds: Ben's expired CDL is the only one.
    const table = await screen.findByTestId('held-table');
    const groups = within(table).getAllByTestId('requirement-group');
    expect(groups).toHaveLength(1);
    expect(groups[0]).toHaveTextContent('Commercial driver licence');
    expect(groups[0]).toHaveTextContent('1 open');
    expect(groups[0]).toHaveTextContent('1 blocking');
    expect(groups[0]).toHaveTextContent('Safety coordinator');
    expect(groups[0]).toHaveTextContent('5d overdue');
    // Catalog compliance is the share of drivers with the CDL in order: 2 of 3.
    expect(groups[0]).toHaveTextContent('67%');

    await userEvent.click(
      within(groups[0] as HTMLElement).getByRole('button', { expanded: false }),
    );
    expect(
      await within(table).findByText(/Renew the Commercial driver licence/),
    ).toBeInTheDocument();
    await userEvent.click(within(table).getByRole('button', { name: /Ben Cole/ }));

    // The chip switches to the record view with Ben's file beside the list.
    const panel = await screen.findByRole('complementary', { name: /Ben Cole file/ });
    expect(within(panel).getByText('Hold')).toBeInTheDocument();
    expect(within(panel).getByText('Non-compliant')).toBeInTheDocument();
    expect(within(panel).getByText(/Cannot be dispatched/)).toBeInTheDocument();
    expect(within(panel).getByText('Commercial driver licence')).toBeInTheDocument();
    expect(within(panel).getByText('Sep 1, 2026')).toBeInTheDocument();
    const row = screen.getByRole('row', { name: /Ben Cole/ });
    expect(row).toHaveAttribute('aria-selected', 'true');
    expect(within(row).getByText('Expired')).toBeInTheDocument();
    expect(within(row).getByText('5d overdue')).toBeInTheDocument();
  });

  it('keeps the tiles and the segments as one filter: a tile switches the workbench in place', async () => {
    const { router } = render();
    await userEvent.click(await screen.findByTestId('tile-expiring'));
    await waitFor(() => expect(router.state.location.pathname).toBe('/safety'));
    expect(router.state.location.search).toMatchObject({ focus: 'expiring' });
    const table = await screen.findByTestId('held-table');
    await waitFor(() => expect(within(table).getAllByTestId('requirement-group')).toHaveLength(1));
    expect(within(table).getByTestId('requirement-group')).toHaveTextContent(
      'DOT medical certificate',
    );
    // The segment's count is the tile's count is the row count.
    const segment = screen.getByRole('button', { name: /Expiring ≤ 30d/ });
    expect(segment).toHaveAttribute('aria-pressed', 'true');
    expect(segment).toHaveTextContent('1');
    expect(within(screen.getByTestId('tile-expiring')).getByText('1')).toBeInTheDocument();
  });

  it('the hint under "Cannot be dispatched" is the held records by scope and sums to the value', async () => {
    render();
    const held = await screen.findByTestId('tile-held');
    expect(within(held).getByText('0 units · 1 driver · 0 trailers')).toBeInTheDocument();
  });
});
