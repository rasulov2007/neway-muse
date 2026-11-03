import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  SYSTEM_REQUIREMENTS,
  evaluateEntity,
  requirementsFor,
  type ComplianceDocument,
  type QualificationItem,
} from '@neway/shared';
import { ToastProvider } from '@/design-system/components/Toast';
import { setClockForTests } from '@/lib/clock';
import { setFlagForTests } from '@/lib/feature-flags';
import type { OperationalDriver } from './useOperations';

/** Owner requests of 2026-10-24 on the driver's Documents tab. */

const post = vi.fn();
const documents: ComplianceDocument[] = [];

vi.mock('@/features/safety/compliance-api', () => ({
  listComplianceDocuments: async (q: { requirementCode?: string }) =>
    documents.filter((d) => !q.requirementCode || d.requirementCode === q.requirementCode),
  uploadComplianceDocument: vi.fn(async (input: { title: string }) => ({ document: { id: 'doc_new', title: input.title } })),
}));
// The previews fetch the bytes with the session; here they are a tiny blob.
vi.mock('@/features/fleet/unit-documents', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/fleet/unit-documents')>()),
  fetchDocumentBlob: async () => new Blob(['x'], { type: 'image/png' }),
}));
vi.mock('./usePermissions', () => ({ useHasPermission: () => true }));
vi.mock('@/features/dashboard/links', () => ({ useGo: () => () => undefined, hrefs: { compliance: '/safety/compliance' } }));
vi.mock('@/features/safety/v2/api', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/features/safety/v2/api')>();
  return {
    ...real,
    useDriverDrugTests: () => ({ data: [], isLoading: false }),
    safetyApi: { ...real.safetyApi, post: (...args: unknown[]) => post(...args) },
  };
});

const { DriverDocumentsTab } = await import('./DriverDocumentsTab');
const { uploadComplianceDocument } = await import('@/features/safety/compliance-api');

const DRIVER = 'drv_42';
const doc = (over: Partial<ComplianceDocument> & { id: string; requirementCode: string }): ComplianceDocument => ({
  ownerType: 'driver',
  ownerId: DRIVER,
  ownerLabel: 'Ali Karimov',
  title: over.requirementCode,
  fileName: `${over.id}.pdf`,
  contentType: 'application/pdf',
  sizeBytes: 100,
  issuedOn: null,
  expiresOn: null,
  status: 'verified',
  source: 'staff',
  uploadedAt: '2026-04-01T14:00:00.000Z',
  uploadedBy: 'Safety',
  verifiedAt: '2026-04-02T14:00:00.000Z',
  verifiedBy: 'Safety',
  rejectionReason: null,
  version: 1,
  supersedesDocumentId: null,
  containsPii: true,
  hasFile: true,
  extracted: null,
  ...over,
});
const item = (code: string, over: Partial<QualificationItem> = {}): QualificationItem => ({
  id: `qi_${code}`,
  requirementCode: code,
  scope: 'driver',
  entityId: DRIVER,
  entityLabel: 'Ali Karimov',
  documentId: `doc_${code}`,
  issuedOn: null,
  expiresOn: null,
  verifiedAt: '2026-04-02T14:00:00.000Z',
  verifiedBy: 'Safety',
  verificationFailed: false,
  verificationNote: null,
  waivedUntil: null,
  waivedReason: null,
  notApplicable: false,
  notes: null,
  ...over,
});

function renderTab(extraItems: QualificationItem[] = []) {
  const compliance = evaluateEntity(
    { scope: 'driver', id: DRIVER, label: 'Ali Karimov' },
    requirementsFor('driver', SYSTEM_REQUIREMENTS),
    [
      // The front only, filed by an intake as "CDL (front)".
      item('cdl', { issuedOn: '2024-01-01', expiresOn: '2028-01-01' }),
      // An MVR dated 2026-04-01 under the old 12-month term.
      item('mvr_review', { issuedOn: '2026-04-01', expiresOn: '2027-04-01' }),
      ...extraItems,
    ],
    { today: '2026-10-24' },
  );
  const row = { driver: { id: DRIVER, name: 'Ali Karimov', driverNumber: 'D-042' }, compliance } as unknown as OperationalDriver;
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <DriverDocumentsTab row={row} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Driver documents (owner, 2026-10-24)', () => {
  beforeAll(() => {
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
    setClockForTests('2026-10-24T12:00:00-04:00');
    setFlagForTests('safety_v2', true);
  });
  afterAll(() => {
    setClockForTests(null);
    setFlagForTests('safety_v2', null);
  });
  beforeEach(() => {
    post.mockReset();
    vi.mocked(uploadComplianceDocument).mockClear();
    documents.length = 0;
    documents.push(
      doc({ id: 'doc_cdl', requirementCode: 'cdl', title: 'CDL (front)', issuedOn: '2024-01-01', expiresOn: '2028-01-01' }),
      doc({ id: 'doc_mvr_review', requirementCode: 'mvr_review', issuedOn: '2026-04-01', expiresOn: '2027-04-01' }),
      doc({ id: 'doc_photo', requirementCode: 'driver_photo', title: 'Driver photo', contentType: 'image/png' }),
    );
  });

  it('shows the CDL as one compact row, incomplete until both sides are on file (owner, 2026-10-26)', async () => {
    renderTab();
    const row = await screen.findByTestId('combined-cdl');
    await waitFor(() => expect(within(row).getByRole('button', { name: 'View' })).toBeTruthy());
    expect(within(row).getByText('Incomplete · Back missing')).toBeTruthy();
    // No inline Front / Back cards under the row any more.
    expect(screen.queryByTestId('slot-cdl')).toBeNull();
    expect(screen.queryByTestId('slot-cdl_back')).toBeNull();
    expect(screen.queryByTestId('cdl-pair-viewer')).toBeNull();
    // The back is no longer a row of its own.
    expect(screen.queryByText('CDL — back of the card')).toBeNull();
    // Replace front / Upload back stay in the row's menu.
    await userEvent.click(within(row).getByRole('button', { name: 'More for CDL' }));
    expect(await screen.findByRole('menuitem', { name: 'Replace front' })).toBeTruthy();
    expect(screen.getByRole('menuitem', { name: 'Upload back' })).toBeTruthy();
  });

  it('View opens the front on the left and the back on the right; a missing back offers its upload', async () => {
    renderTab();
    const row = await screen.findByTestId('combined-cdl');
    await waitFor(() => expect(within(row).getByRole('button', { name: 'View' })).toBeTruthy());
    await userEvent.click(within(row).getByRole('button', { name: 'View' }));
    const viewer = await screen.findByTestId('cdl-pair-viewer');
    // Two columns from the small breakpoint up, stacked on a phone.
    expect(viewer.className).toContain('sm:grid-cols-2');
    const sides = within(viewer).getAllByRole('heading', { level: 3 }).map((h) => h.textContent);
    expect(sides).toEqual(['Front', 'Back']);
    const front = within(viewer).getByTestId('cdl-side-cdl');
    // The front is a PDF here: previewed on paper, not as a link.
    expect(await within(front).findByTitle('CDL — Front')).toBeTruthy();
    expect(front.querySelector('.nw-paper')).toBeTruthy();
    const back = within(viewer).getByTestId('cdl-side-cdl_back');
    expect(within(back).getAllByText('Missing').length).toBeGreaterThan(0);
    await userEvent.click(within(back).getByRole('button', { name: 'Upload back' }));
    // The upload opens on the back of the card.
    expect(await screen.findByRole('dialog', { name: /Add document/ })).toBeTruthy();
    expect(screen.queryByTestId('cdl-pair-viewer')).toBeNull();
  });

  it('asks which paper a Work authorization is, saves it with the document and names the row by it', async () => {
    renderTab();
    const name = await screen.findByText('Work authorization');
    const row = name.closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Upload' }));
    const dialog = await screen.findByRole('dialog', { name: /Add document/ });
    const kind = within(dialog).getByRole('combobox', { name: 'Work authorization type' });
    await userEvent.click(kind);
    const options = (await screen.findAllByRole('option')).map((o) => o.textContent);
    expect(options).toEqual([
      'U.S. Passport / Passport Card',
      'Permanent Resident Card (Green Card)',
      'Employment Authorization',
      'Non-Domiciled',
    ]);
    await userEvent.click(screen.getByRole('option', { name: 'Permanent Resident Card (Green Card)' }));
    fireEvent.change(within(dialog).getByLabelText('Document file'), {
      target: { files: [new File(['%PDF-1.4'], 'gc.pdf', { type: 'application/pdf' })] },
    });
    const expiry = within(dialog).getByLabelText('Expiry date');
    await userEvent.type(expiry, '01/15/2030');
    await userEvent.tab();
    await userEvent.click(within(dialog).getByRole('button', { name: 'Add document' }));
    await waitFor(() => expect(uploadComplianceDocument).toHaveBeenCalled());
    expect(vi.mocked(uploadComplianceDocument).mock.calls[0]![0]).toMatchObject({
      requirementCode: 'work_authorization',
      extracted: { workAuthorizationKind: 'green_card' },
    });
  });

  it('keeps Add document disabled for a Work authorization until its type is chosen', async () => {
    renderTab();
    const row = (await screen.findByText('Work authorization')).closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Upload' }));
    const dialog = await screen.findByRole('dialog', { name: /Add document/ });
    fireEvent.change(within(dialog).getByLabelText('Document file'), {
      target: { files: [new File(['%PDF-1.4'], 'wa.pdf', { type: 'application/pdf' })] },
    });
    await userEvent.type(within(dialog).getByLabelText('Expiry date'), '01/15/2030');
    await userEvent.tab();
    expect((within(dialog).getByRole('button', { name: 'Add document' }) as HTMLButtonElement).disabled).toBe(true);
    expect(within(dialog).getByRole('combobox', { name: 'Work authorization type' }).textContent).toContain('Choose the document…');
    expect(uploadComplianceDocument).not.toHaveBeenCalled();
  });

  it('shows the filed paper on the row and prefills it on Replace', async () => {
    documents.push(
      doc({
        id: 'doc_wa',
        requirementCode: 'work_authorization',
        title: 'Work authorization',
        expiresOn: '2030-01-15',
        extracted: { workAuthorizationKind: 'green_card' } as ComplianceDocument['extracted'],
      }),
    );
    renderTab([item('work_authorization', { expiresOn: '2030-01-15' })]);
    const name = await screen.findByText('Work authorization · Green Card');
    const row = name.closest('tr') as HTMLElement;
    await userEvent.click(within(row).getByRole('button', { name: 'Replace' }));
    const dialog = await screen.findByRole('dialog', { name: /Replace document/ });
    expect(within(dialog).getByRole('combobox', { name: 'Work authorization type' }).textContent).toContain(
      'Permanent Resident Card (Green Card)',
    );
  });

  it('never asks the Work authorization type for another document', async () => {
    renderTab();
    const row = await screen.findByTestId('paper-w9');
    await userEvent.click(within(row).getByRole('button', { name: 'Upload' }));
    await screen.findByText('This document does not expire.');
    expect(screen.queryByRole('combobox', { name: 'Work authorization type' })).toBeNull();
  });

  it('ages the MVR and falls it due 6 months after its date', async () => {
    renderTab();
    expect(await screen.findByText(/6 months old/)).toBeTruthy();
    expect(screen.getByText(/every 6 months/)).toBeTruthy();
    const mvrRow = screen.getByText('MVR review').closest('tr') as HTMLElement;
    // Dated 2026-04-01 → due 2026-10-01: expired, the same badge as any other lapsed document.
    expect(within(mvrRow).getAllByText('Expired').length).toBeGreaterThan(0);
    expect(within(mvrRow).getByText(/due Oct 1, 2026|due 10\/01\/2026|due 2026-10-01/)).toBeTruthy();
  });

  it('no longer lists the driver photograph or the background check, but keeps a filed photo viewable', async () => {
    renderTab();
    await screen.findByText(/No longer required/);
    expect(screen.queryByText('Background check')).toBeNull();
    const retired = screen.getByText('Driver photograph').closest('tr') as HTMLElement;
    expect(within(retired).getByText('Retired')).toBeTruthy();
    expect(within(retired).getByRole('button', { name: 'View' })).toBeTruthy();
  });

  it('lists the W-9 as a paper that is never graded: Upload when absent, View once on file (owner, 2026-10-25)', async () => {
    renderTab();
    const row = await screen.findByTestId('paper-w9');
    expect(screen.getByText('Tax and pay papers')).toBeTruthy();
    expect(within(row).getByText('W-9')).toBeTruthy();
    expect(within(row).getByText('Not uploaded')).toBeTruthy();
    expect(within(row).queryByText('Missing')).toBeNull();
    // Upload opens the Add document dialog on the W-9, which does not expire.
    await userEvent.click(within(row).getByRole('button', { name: 'Upload' }));
    expect(await screen.findByText('This document does not expire.')).toBeTruthy();
  });

  it('shows a filed W-9 as on file with View', async () => {
    documents.push(doc({ id: 'doc_w9', requirementCode: 'w9', title: 'W-9', status: 'pending_review' }));
    renderTab();
    await waitFor(() => expect(within(screen.getByTestId('paper-w9')).getByText('On file')).toBeTruthy());
    const row = screen.getByTestId('paper-w9');
    expect(within(row).getByRole('button', { name: 'View' })).toBeTruthy();
    expect(within(row).getByRole('button', { name: 'Replace' })).toBeTruthy();
    expect(within(row).getByText('Does not expire')).toBeTruthy();
  });

  it('submits a random drug test with its date, result and paper', async () => {
    post.mockResolvedValue({ test: { number: 'DAT-009' }, document: { id: 'doc_r' } });
    renderTab();
    await userEvent.click(await screen.findByRole('button', { name: 'Submit random test' }));
    const file = new File(['%PDF-1.4'], 'random.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText('Test paper'), { target: { files: [file] } });
    await userEvent.click(screen.getByRole('button', { name: 'Submit test' }));
    await waitFor(() => expect(post).toHaveBeenCalled());
    const [path, body] = post.mock.calls[0] as [string, Record<string, unknown>];
    expect(path).toBe('/tests/random');
    expect(body).toMatchObject({ driverId: DRIVER, substance: 'drug', collectedOn: '2026-10-24', result: 'negative', fileName: 'random.pdf', contentType: 'application/pdf' });
    expect(typeof body.content).toBe('string');
  });
});
