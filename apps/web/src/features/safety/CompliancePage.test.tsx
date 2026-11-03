import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { SYSTEM_REQUIREMENTS, type QualificationItem } from '@neway/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ComplianceDocument } from '@neway/shared';
import type { Driver, Trailer, Truck } from '@/demo';
import { renderPage } from '@/features/common/test-router';
import { CompliancePage } from './CompliancePage';

function driver(id: string, name: string): Driver {
  return {
    id,
    driverNumber: id.toUpperCase(),
    firstName: name,
    lastName: '',
    name,
    phone: '',
    email: '',
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
  } as Driver;
}

const DRIVER_RULES = SYSTEM_REQUIREMENTS.filter((r) => r.scope === 'driver');

function complete(
  id: string,
  label: string,
  tweak: (i: QualificationItem) => QualificationItem = (i) => i,
) {
  return DRIVER_RULES.map((r) =>
    tweak({
      id: `qi_${id}_${r.code}`,
      requirementCode: r.code,
      scope: 'driver',
      entityId: id,
      entityLabel: label,
      documentId: `doc_${id}_${r.code}`,
      // MVR and PSP fall due 6 months after their date (owner, 2026-10-24): keep them recent.
      issuedOn: r.validityMonths ? '2026-08-01' : '2025-01-01',
      expiresOn: r.hasExpiry ? '2027-06-01' : null,
      verifiedAt: '2025-01-02T00:00:00.000Z',
      verifiedBy: 'Dana Ortiz',
      verificationFailed: false,
      verificationNote: null,
      waivedUntil: null,
      waivedReason: null,
      notApplicable: false,
      notes: null,
    }),
  );
}

const ITEMS: QualificationItem[] = [
  ...complete('drv_1', 'Ana Ruiz'),
  ...complete('drv_2', 'Ben Cole', (i) =>
    i.requirementCode === 'cdl' ? { ...i, expiresOn: '2026-09-01' } : i,
  ),
  // Cy's medical card is on file but nobody has verified it yet.
  ...complete('drv_3', 'Cy Dunn', (i) =>
    i.requirementCode === 'medical_card' ? { ...i, verifiedAt: null, verifiedBy: null } : i,
  ),
];

const CY_MEDICAL_DOC: ComplianceDocument = {
  id: 'doc_drv_3_medical_card',
  ownerType: 'driver',
  ownerId: 'drv_3',
  ownerLabel: 'Cy Dunn',
  requirementCode: 'medical_card',
  title: 'DOT medical certificate',
  fileName: 'medical-cy-dunn.pdf',
  contentType: 'application/pdf',
  sizeBytes: 120_000,
  issuedOn: '2025-01-01',
  expiresOn: '2027-06-01',
  status: 'pending_review',
  source: 'driver_portal',
  uploadedAt: '2026-09-01T10:00:00.000Z',
  uploadedBy: 'Driver portal',
  verifiedAt: null,
  verifiedBy: null,
  rejectionReason: null,
  version: 1,
  supersedesDocumentId: null,
  containsPii: true,
  hasFile: false,
  extracted: null,
};

const verifyComplianceDocument = vi.fn();

vi.mock('@/demo', () => ({
  DEMO_TODAY: '2026-09-06',
  demoCurrentUser: { id: 'usr_1', name: 'Sarah Chen' },
  listDrivers: vi.fn(() =>
    Promise.resolve({
      data: [driver('drv_1', 'Ana Ruiz'), driver('drv_2', 'Ben Cole'), driver('drv_3', 'Cy Dunn')],
      total: 3,
      page: 1,
      pageSize: 200,
    }),
  ),
  listTrucks: vi.fn(() =>
    Promise.resolve({ data: [] as Truck[], total: 0, page: 1, pageSize: 200 }),
  ),
  listTrailers: vi.fn(() =>
    Promise.resolve({ data: [] as Trailer[], total: 0, page: 1, pageSize: 200 }),
  ),
}));

vi.mock('./compliance-api', () => ({
  listComplianceRequirements: vi.fn(() => Promise.resolve([...SYSTEM_REQUIREMENTS])),
  listQualificationItems: vi.fn(() => Promise.resolve(ITEMS)),
  listComplianceDocuments: vi.fn((q?: { ownerId?: string }) =>
    Promise.resolve(q?.ownerId === 'drv_3' || !q?.ownerId ? [CY_MEDICAL_DOC] : []),
  ),
  verifyComplianceDocument: (...args: unknown[]) => verifyComplianceDocument(...args),
  rejectComplianceDocument: vi.fn(),
  waiveQualificationItem: vi.fn(),
  listConsentRequests: vi.fn(() => Promise.resolve([])),
  listComplianceAudit: vi.fn(() => Promise.resolve([])),
  listVerificationCases: vi.fn(() => Promise.resolve([])),
  createConsentRequest: vi.fn(),
  sendConsentRequest: vi.fn(),
  cancelConsentRequest: vi.fn(),
  respondToConsentRequest: vi.fn(),
  recordVerificationDecision: vi.fn(),
  uploadComplianceDocument: vi.fn(),
}));

function render(path = '/safety/compliance') {
  return renderPage(<CompliancePage />, { routePath: '/safety/compliance', path });
}

describe('CompliancePage', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    verifyComplianceDocument.mockResolvedValue({ ...CY_MEDICAL_DOC, status: 'verified' });
  });

  it('lists drivers worst first with their open items', async () => {
    render();
    const table = await screen.findByTestId('compliance-driver-table');
    const rows = await within(table).findAllByRole('row');
    // header + 3 drivers
    expect(rows).toHaveLength(4);
    expect(rows[1]).toHaveTextContent('Ben Cole');
    expect(rows[1]).toHaveTextContent('Hold');
    expect(rows[1]).toHaveTextContent('Commercial driver licence');
    expect(rows[2]).toHaveTextContent('Cy Dunn');
    expect(rows[2]).toHaveTextContent('Pending verification');
    expect(rows[3]).toHaveTextContent('Ana Ruiz');
    expect(rows[3]).toHaveTextContent('None');
  });

  it('applies a focus from the URL so a command-centre number opens exactly its rows', async () => {
    render('/safety/compliance?tab=drivers&focus=held');
    const table = await screen.findByTestId('compliance-driver-table');
    const rows = await within(table).findAllByRole('row');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toHaveTextContent('Ben Cole');
    expect(screen.getByText('Not dispatchable')).toBeInTheDocument();
  });

  it('opens the entity drawer with evidence and lets safety verify a document', async () => {
    render('/safety/compliance?tab=drivers&entity=driver%3Adrv_3');
    const drawer = await screen.findByRole('dialog');
    expect(within(drawer).getByText('Cy Dunn')).toBeInTheDocument();
    expect(within(drawer).getByText(/Pending verification \(1\)/)).toBeInTheDocument();
    expect(
      within(drawer).getByText('· On file but not yet verified by safety'),
    ).toBeInTheDocument();
    expect(
      within(drawer).getByText('Verify the DOT medical certificate on file'),
    ).toBeInTheDocument();

    await userEvent.click(within(drawer).getByRole('tab', { name: 'Documents' }));
    await userEvent.click(await within(drawer).findByRole('button', { name: /Verify/ }));
    await waitFor(() =>
      expect(verifyComplianceDocument).toHaveBeenCalledWith('doc_drv_3_medical_card'),
    );
  });

  it('switches to the documents tab and shows what is waiting for review', async () => {
    render('/safety/compliance?tab=documents');
    expect(await screen.findByText(/1 on file · 1 waiting for review/)).toBeInTheDocument();
    expect(screen.getByText('medical-cy-dunn.pdf', { exact: false })).toBeInTheDocument();
  });
});
