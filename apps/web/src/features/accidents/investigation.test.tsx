import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { accidentsV2 as A } from '@neway/shared';
import { ToastProvider } from '@/design-system/components/Toast';
import { setClockForTests } from '@/lib/clock';

/**
 * Accident & Claims v2 — P4 web checks: Submit is held back with the server's list of what is missing (J1), approval is
 * offered only to approvers (J2), CPDP is not offered on a non-recordable case (J5), legal liability is a lock for a
 * viewer without it (J7), a disciplinary review cannot be added without accidents.discipline (J8), evidence shows lock
 * cards and the legal-hold banner and disables removal (K4/K6).
 */
const investigation = vi.fn();
const evidence = vi.fn();
vi.mock('@tanstack/react-router', async (importOriginal) => ({ ...(await importOriginal<typeof import('@tanstack/react-router')>()), useNavigate: () => vi.fn() }));
vi.mock('./api', async (importOriginal) => {
  const real = await importOriginal<typeof import('./api')>();
  return {
    ...real,
    useCaseEvents: () => ({ data: [] }),
    useEvidence: (...args: unknown[]) => evidence(...args),
    accApi: { ...real.accApi, investigation: (...args: unknown[]) => investigation(...args) },
  };
});

const { InvestigationTab, PartiesPanel } = await import('./InvestigationTab');
const { EvidenceTab } = await import('./EvidenceTab');

const PERMS: A.CaseDetailResponse['permissions'] = { edit: true, editCargo: true, restricted: true, override: true, confirm: false, claimMoney: true, fleet: true, editUnits: true, bills: true, seeMoney: true, determine: true, legal: true, approve: true, discipline: true };

function detail(over: { status?: 'not_started' | 'in_progress' | 'in_review' | 'complete'; dot?: 'yes' | 'no' | 'pending'; perms?: Partial<A.CaseDetailResponse['permissions']>; redacted?: string[]; missing?: string[] } = {}): A.CaseDetailResponse {
  return {
    case: {
      id: 'acc16',
      number: 'ACC-2026-016',
      tz: 'America/Chicago',
      investigation: { status: over.status ?? 'in_progress', ownerId: 'p1', facts: [{ id: 'f1', text: 'ECM shows 62 mph', source: 'ECM', provenance: 'verified', by: 'Rachel Moore', at: '2026-10-15T15:00:00.000Z' }], questions: [], statements: [], checklist: [], factors: [{ id: 'fa1', category: 'Driver', label: 'Following distance', level: 'possible' }] },
      determinations: { fault: { value: 'not_determined' }, preventability: { value: 'not_determined' }, cpdp: { value: 'not_eligible' }, legal: { value: 'unknown' } },
      correctiveActions: [],
      witnesses: [],
      vehicles: [],
    },
    version: 7,
    redacted: over.redacted ?? [],
    display: { truck: null, trailer: null, driver: { id: 'd2', name: 'Andre Lewis' }, load: null, owner: null, reportedBy: '', closedBy: null, voided: false },
    units: [],
    people: [{ id: 'p1', name: 'Rachel Moore' }],
    computed: {
      dotRecordable: { value: over.dot ?? 'yes', reasons: [], missing: [] },
      expectedEvidence: [{ label: 'Police report', ok: false, why: 'Police responded' }],
      investigation: {
        vehicles: [{ id: 'v1', description: '2019 Honda Civic', ownerName: 'M. Diaz', driverName: null, insurer: 'Coastline Mutual', policyNo: null, plate: null, damage: 'Rear bumper', towed: 'yes' }],
        witnesses: [{ id: 'w1', name: 'Jo Clerk', contact: over.perms?.restricted === false ? null : '(555) 010-4242', note: 'Saw it' }],
        correctiveActions: [{ id: 'r1', number: 'REV-0091', kind: 'Disciplinary review', title: 'Restricted personnel action', restricted: true, locked: true, status: 'Open', assignee: null, dueAt: '2026-10-26T21:00:00.000Z', completedAt: null, evidence: null, driverId: 'd2', version: 1 }],
        questions: [{ id: 'q1', text: 'Was the work zone signed?', owner: { id: 'p1', name: 'Rachel Moore' }, answer: null, resolvedAt: null, resolvedBy: null }],
        reviewItems: [{ key: 'dashcam', label: 'Dashcam video', state: 'reviewed', note: null, restricted: false }],
        submitMissing: over.missing ?? ['Write a conclusion', 'Record driver fault', 'Record preventability'],
      },
    },
    permissions: { ...PERMS, ...over.perms },
  } as unknown as A.CaseDetailResponse;
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
  investigation.mockReset();
  evidence.mockReset();
  setClockForTests('2026-10-19T17:00:00Z');
});

describe('Investigation tab (P4)', () => {
  it('J1 Submit for approval is disabled and says what is missing (the server’s list)', () => {
    wrap(<InvestigationTab d={detail()} />);
    expect((screen.getByRole('button', { name: 'Submit for approval' }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText('To submit: Write a conclusion · Record driver fault · Record preventability.')).toBeTruthy();
    expect(screen.getByText('ECM shows 62 mph')).toBeTruthy();
    expect(screen.getByText('Was the work zone signed?')).toBeTruthy();
  });

  it('J2 an investigation in review offers Approve only to an approver', async () => {
    investigation.mockResolvedValue({ id: 'acc16', version: 8 });
    const { unmount } = wrap(<InvestigationTab d={detail({ status: 'in_review', perms: { approve: false } })} />);
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.getByText('Approval: Safety Manager or owner')).toBeTruthy();
    unmount();
    wrap(<InvestigationTab d={detail({ status: 'in_review' })} />);
    await userEvent.click(screen.getByRole('button', { name: 'Approve' }));
    expect(investigation).toHaveBeenCalledWith('acc16', 'approve', { version: 7, note: undefined, reason: undefined });
  });

  it('J5 CPDP is not offered on a case that is not DOT-recordable; on a recordable one the 21 crash types are listed', async () => {
    const { unmount } = wrap(<InvestigationTab d={detail({ dot: 'no' })} />);
    expect(screen.getByText('Only crashes that are DOT-reportable can be reviewed. Current: not recordable.')).toBeTruthy();
    expect(screen.queryByLabelText('CPDP status')).toBeNull();
    unmount();
    wrap(<InvestigationTab d={detail()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Show the 21 eligible crash types' }));
    expect(within(document.getElementById('cpdp-types') as HTMLElement).getAllByRole('listitem')).toHaveLength(21);
  });

  it('J7 legal liability is a lock for a viewer without it; J4 fault and preventability are separate selects', () => {
    wrap(<InvestigationTab d={detail({ redacted: ['determinations.legal'], perms: { legal: false } })} />);
    const legal = document.getElementById('det-legal') as HTMLElement;
    expect(within(legal).getByText('Restricted')).toBeTruthy();
    expect(within(legal).queryByRole('combobox')).toBeNull();
    expect(screen.getByLabelText('Driver fault (internal)')).toBeTruthy();
    expect(screen.getByLabelText('Preventability (company standard)')).toBeTruthy();
  });

  it('J8 a restricted disciplinary review shows as a lock card; without accidents.discipline the dialog will not add one', async () => {
    wrap(<InvestigationTab d={detail({ perms: { discipline: false } })} />);
    expect(screen.getByText('Restricted personnel action')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Add action' }));
    await userEvent.selectOptions(screen.getByLabelText('Type'), 'Disciplinary review');
    await userEvent.type(screen.getByLabelText('What exactly'), 'Written warning');
    expect(screen.getByText('Disciplinary reviews are recorded by the Safety Manager and the owner')).toBeTruthy();
    expect((screen.getByRole('button', { name: 'Add' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('witness contacts are shown only when the server sent them', () => {
    const { unmount } = wrap(<PartiesPanel d={detail()} />);
    expect(screen.getByText(/\(555\) 010-4242/)).toBeTruthy();
    unmount();
    wrap(<PartiesPanel d={detail({ perms: { restricted: false } })} />);
    expect(screen.queryByText(/010-4242/)).toBeNull();
    expect(screen.getByText('restricted')).toBeTruthy();
  });
});

describe('Evidence tab (P4)', () => {
  const ITEMS: A.EvidenceListResponse = {
    items: [
      { id: 'e1', category: 'Damage photo', restricted: false, locked: false, name: 'front.jpg', description: null, kind: 'photo', uploadedBy: 'Rachel Moore', uploadedAt: '2026-10-08T15:00:00.000Z', sizeKb: 812, version: 2, versions: [{ v: 2, at: '2026-10-09T15:00:00.000Z', by: 'Rachel Moore', note: 'Cropped', fileId: 'f2', fileName: 'front.jpg', sha256: 'a'.repeat(64), sizeBytes: 812_000 }, { v: 1, at: '2026-10-08T15:00:00.000Z', by: 'Rachel Moore', note: null, fileId: 'f1', fileName: 'front.jpg', sha256: 'b'.repeat(64), sizeBytes: 900_000 }], removed: null, fileId: 'f2' },
      { id: 'e2', category: 'Legal (restricted)', restricted: true, locked: true, name: null, description: null, kind: 'pdf', uploadedBy: null, uploadedAt: '2026-10-12T15:00:00.000Z', sizeKb: null, version: 1, versions: null, removed: null, fileId: null },
    ],
    counts: {},
    legalHold: { since: '2026-10-12T15:00:00.000Z', by: 'Rachel Moore', reason: 'Attorney representation' },
  };

  it('K6 / K4 lock card for a restricted document, version badge, legal-hold banner, removal disabled under the hold', async () => {
    evidence.mockReturnValue({ data: ITEMS, isLoading: false, error: null });
    wrap(<EvidenceTab d={detail({ perms: { restricted: false } })} />);
    expect(screen.getByText('Restricted document')).toBeTruthy();
    expect(screen.getByText('v2')).toBeTruthy();
    expect(screen.getByText(/Legal hold since .*Attorney representation\. Nothing on this case can be removed\./)).toBeTruthy();
    await userEvent.click(screen.getByText('front.jpg'));
    const drawer = document.getElementById('evidence-drawer') as HTMLElement;
    expect(within(drawer).getByText('Cropped')).toBeTruthy();
    expect(within(drawer).getByText(`SHA-256 ${'a'.repeat(64)}`)).toBeTruthy();
    expect((within(drawer).getByRole('button', { name: 'Remove from case' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('shows Loading… before the list arrives, never an empty state', () => {
    evidence.mockReturnValue({ data: undefined, isLoading: true, error: null });
    wrap(<EvidenceTab d={detail()} />);
    expect(screen.getByText('Loading…')).toBeTruthy();
    expect(screen.queryByText('Nothing in this category')).toBeNull();
  });
});
