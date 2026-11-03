import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';

/*
 * The restricted driver profile (owner, 2026-10-26): only Accounting and the Administrator
 * (drivers.view_pay) see the full profile. Everybody else sees Contact information, Assignment
 * and equipment, CDL information and the CDL document — no tabs, no pay plan, nothing else.
 */
const state = vi.hoisted(() => ({
  permissions: [] as string[],
  listDocuments: vi.fn(),
}));

vi.mock('@/features/auth/auth-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/auth/auth-context')>()),
  useAccount: () => ({ permissions: state.permissions, roles: [], isOwner: false }),
}));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiGet: vi.fn(async () => ({ data: [] })),
}));
vi.mock('@/demo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/demo')>()),
  fetchDriverAccount: vi.fn(async () => {
    throw new Error('no account');
  }),
}));
vi.mock('@/features/safety/compliance-api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/safety/compliance-api')>()),
  listComplianceDocuments: (q: unknown) => state.listDocuments(q),
}));
vi.mock('./useOperations', () => ({ useOperations: () => operations }));
vi.mock('./vacation-api', () => ({
  useDriverVacations: () => ({ data: [] }),
  currentVacation: () => null,
  useCanManageVacations: () => false,
}));
vi.mock('./team-api', () => ({
  useDriverTeam: () => ({ isSuccess: true, isError: false, isPending: false, data: { current: null, history: [] } }),
  useDriverTeams: () => ({ isSuccess: false }),
  useCanManageTeams: () => false,
  teamsByDriver: () => new Map(),
}));
vi.mock('./DriverTeam', () => ({
  TeamBadge: () => <span>Solo</span>,
  TeamHistory: () => <p>Team history</p>,
  PairDriverModal: () => null,
  UnpairDriverModal: () => null,
}));
vi.mock('./DriverVacation', () => ({
  VacationBanner: () => null,
  VacationSection: () => <p>Vacation history</p>,
  SendOnVacationModal: () => null,
  ManageVacationModal: () => null,
}));
vi.mock('./DriverPaymentCard', () => ({ DriverPaymentCard: () => <p>Payment card</p> }));
vi.mock('./DriverEscrowPanel', () => ({ DriverEscrowPanel: () => <p>Escrow panel</p> }));
vi.mock('./DriverDocumentsTab', () => ({ DriverDocumentsTab: () => <p>All documents</p> }));
vi.mock('./DriverSections', () => ({ LoadsTab: () => <p>Loads tab</p>, PerformanceTab: () => <p>Performance tab</p> }));
vi.mock('./DriverHiringTabs', () => ({
  DriverCostsTab: () => <p>Costs tab</p>,
  DriverOnboardingTab: () => <p>Onboarding tab</p>,
  DriverSafetyTab: () => <p>Safety tab</p>,
}));
vi.mock('@/features/fleet/expenses/investigations', () => ({ InvestigationPanel: () => <p>Investigations</p> }));
vi.mock('@/features/safety/v2/claims/DriverChargesPanel', () => ({ DriverChargesPanel: () => <p>Driver charges</p> }));
vi.mock('./DriverBoardDispatcher', () => ({ BoardDispatcherFact: () => <span>No dispatcher</span>, canSeeBoardDispatcher: () => true }));
vi.mock('./DriverDispatcherButton', () => ({ DispatcherFact: () => <span>Dispatcher fact</span> }));

const driver = {
  id: 'drv_1',
  name: 'Gerald Ashford',
  driverNumber: 'D-2004',
  driverType: 'company',
  status: 'active',
  phone: '+13125550142',
  email: 'jerry@example.com',
  secondaryPhone: null,
  secondaryPhoneLabel: null,
  homeCity: 'Chicago',
  homeState: 'IL',
  preferredLanguage: 'en',
  dateOfBirth: null,
  currentTruckUnit: '241062',
  cdlClass: 'A',
  cdlState: 'IL',
  cdlExpiresOn: '2029-05-14',
  cdlStatus: 'valid',
  medicalCardExpiresOn: '2027-05-14',
  medicalCardStatus: 'valid',
  cdlEndorsements: [],
  payPlan: { kind: 'percent_of_linehaul', rate: 0 },
  hireDate: '2026-01-05',
  dispatcherId: null,
  dispatcherName: null,
};
const row = {
  driver,
  availability: { state: 'available', assignable: true, blocker: null, reasons: [] },
  currentLoad: null,
  compliance: null,
};
const operations = {
  isPending: false,
  isError: false,
  data: { byDriverId: new Map([['drv_1', row]]), drivers: [row] },
};

const doc = (id: string, requirementCode: string) => ({
  id,
  requirementCode,
  ownerType: 'driver',
  ownerId: 'drv_1',
  title: requirementCode,
  fileName: `${requirementCode}.pdf`,
  contentType: 'application/pdf',
  hasFile: true,
  source: 'staff',
  uploadedAt: '2026-10-20T12:00:00Z',
  uploadedBy: 'Safety',
});

const { DriverProfilePage } = await import('./DriverProfilePage');

const DISPATCHER = ['dispatch.view', 'dispatch.edit', 'drivers.view', 'drivers.edit', 'drivers.view_contact'];

describe('Driver profile: restricted vs full view', () => {
  beforeEach(() => {
    state.listDocuments.mockReset();
    state.listDocuments.mockResolvedValue([doc('d1', 'cdl'), doc('d2', 'cdl_back'), doc('d3', 'medical_card')]);
  });

  it('a dispatcher sees the three cards and the CDL only: no tabs, no pay plan, no Open safety', async () => {
    state.permissions = DISPATCHER;
    renderPage(<DriverProfilePage driverId="drv_1" />);
    expect(await screen.findByText('Contact information')).toBeInTheDocument();
    expect(screen.getByText('Assignment and equipment')).toBeInTheDocument();
    expect(screen.getByText('CDL information')).toBeInTheDocument();
    expect(screen.getByText('Driver D-2004 · Company driver')).toBeInTheDocument();
    expect(screen.getByText('Can take a load now')).toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    for (const hidden of ['Pay plan', 'Hired', 'Driver type', 'Payment card', 'Escrow and employment', 'Pay and organization', 'Investigations', 'Driver charges', 'Vacation history', 'Team history']) {
      expect(screen.queryByText(hidden)).not.toBeInTheDocument();
    }
    expect(screen.queryByRole('button', { name: 'Open safety' })).not.toBeInTheDocument();
    expect(await screen.findByText('On file')).toBeInTheDocument();
    const user = userEvent.setup();
    await user.click(screen.getByRole('button', { name: 'View' }));
    const viewer = await screen.findByTestId('cdl-pair-viewer');
    expect(viewer).toBeInTheDocument();
    expect(screen.getByTestId('cdl-side-cdl')).toBeInTheDocument();
    expect(screen.getByTestId('cdl-side-cdl_back')).toBeInTheDocument();
    expect(screen.queryByText('medical_card.pdf', { exact: false })).not.toBeInTheDocument();
  });

  it('Safety without drivers.view_pay gets the restricted view too, and ?tab=costs draws no hidden tab', async () => {
    state.permissions = ['safety.view', 'compliance.view', 'drivers.view'];
    renderPage(<DriverProfilePage driverId="drv_1" />, { path: '/?tab=costs' });
    expect(await screen.findByText('Contact information')).toBeInTheDocument();
    expect(screen.queryByText('Costs tab')).not.toBeInTheDocument();
    expect(screen.queryByRole('tablist')).not.toBeInTheDocument();
    expect(screen.queryByText('Pay plan')).not.toBeInTheDocument();
  });

  it('drivers.view_pay (Accounting, Administrator) keeps the full profile with its tabs and pay plan', async () => {
    state.permissions = ['accounting.view', 'drivers.view', 'drivers.view_pay'];
    renderPage(<DriverProfilePage driverId="drv_1" />);
    expect(await screen.findByRole('tablist')).toBeInTheDocument();
    expect(screen.getAllByText('Pay plan').length).toBeGreaterThan(0);
    expect(screen.getByText('Hired')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Open safety' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByText('Payment card')).toBeInTheDocument());
  });
});
