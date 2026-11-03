import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { accidentsV2 as A } from '@neway/shared';
import { ToastProvider } from '@/design-system/components/Toast';
import { setClockForTests } from '@/lib/clock';

/**
 * Accident & Claims v2 — P2 web checks (ACCEPTANCE G1, G2, G6 in the UI): one claim per picked coverage with blank
 * amounts left unknown (never 0), the duplicate warning, and a restricted claim drawn with a lock instead of money.
 */
const create = vi.fn();
const navigate = vi.fn();

vi.mock('@tanstack/react-router', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tanstack/react-router')>()),
  useNavigate: () => navigate,
  useSearch: () => ({}),
}));

const ROW = (over: Partial<A.ClaimRow>): A.ClaimRow => ({
  id: 'clm_1',
  number: 'CLM-2026-0040',
  type: 'physical_damage',
  status: 'Under review',
  open: true,
  title: 'Tractor 118 front-end damage',
  openedAt: '2026-10-03T14:00:00.000Z',
  accident: { id: 'acc_16', number: 'ACC-2026-016', stage: 'investigation' },
  standaloneKind: null,
  insurer: 'Harborline Insurance',
  insurerClaimNo: 'HL-PD-1',
  owner: { id: 'u1', name: 'Nilufar Karimova' },
  restricted: false,
  isTest: false,
  claimant: null,
  claimedCents: 38_450_00,
  reserveCents: null,
  paidOrReceivedCents: 0,
  nextFollowUp: null,
  lastUpdateAt: '2026-10-15T14:00:00.000Z',
  staleDays: null,
  needsFollowUp: false,
  redacted: [],
  ...over,
});

vi.mock('./claims-api', async (importOriginal) => {
  const real = await importOriginal<typeof import('./claims-api')>();
  return {
    ...real,
    useClaims: () => ({
      isLoading: false,
      data: {
        items: [
          ROW({}),
          ROW({ id: 'clm_44', number: 'CLM-2026-0044', type: 'auto_liability', restricted: true, claimedCents: null, reserveCents: null, paidOrReceivedCents: null, redacted: ['reserveCents'], accident: { id: 'acc_18', number: 'ACC-2026-018', stage: 'investigation' } }),
        ],
        total: 2,
        counts: { needs_follow_up: 3, open: 8, money_to_us: 4, settled: 13, all: 21 },
        insurers: ['Harborline Insurance'],
      },
    }),
    useClaimsSummary: () => ({
      data: {
        open: { value: 8, fromAccidents: 6, standalone: 2 },
        stillToRecoverCents: 38_750_00,
        ourShareCents: 15_000_00,
        insurerReservesCents: 111_040_00,
        recoveredYear: { year: 2026, cents: 67_340_00 },
        needsFollowUp: { value: 3, noUpdate: 3, followUpsOverdue: 0 },
        noUpdateDays: 7,
        restrictedExcluded: 1,
      },
    }),
    claimsApi: { ...real.claimsApi, create: (...args: unknown[]) => create(...args) },
  };
});

vi.mock('./api', async (importOriginal) => {
  const real = await importOriginal<typeof import('./api')>();
  return {
    ...real,
    useCan: (code: string) => code !== 'accidents.claim_money',
    useBoard: () => ({ data: { items: [], total: 0, page: 1, pageSize: 200, draftsCount: 0, range: { key: '12m', from: '', to: '' } } }),
    useCase: () => ({
      data: {
        case: { id: 'acc_16', number: 'ACC-2026-016', occurredAt: '2026-10-02T20:45:00.000Z', tz: 'America/Chicago', injuries: { status: 'yes' } },
        display: { truck: { id: 't', unit: '118' } },
        computed: { claims: [{ id: 'clm_1', number: 'CLM-2026-0040', type: 'physical_damage', status: 'Under review' }] },
      },
    }),
    usePickers: () => ({ data: { loads: [], people: [] } }),
  };
});

const { ClaimsBoardPage } = await import('./ClaimsBoardPage');
const { NewClaimDialog } = await import('./NewClaimDialog');

function wrap(ui: ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>{ui}</ToastProvider>
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  create.mockReset();
  setClockForTests('2026-10-19T17:00:00Z');
});

describe('Claims board (P2)', () => {
  it('shows the server KPIs, chip counts, and a lock instead of money on a restricted claim (G6)', () => {
    wrap(<ClaimsBoardPage />);
    expect(screen.getByText('$111K')).toBeTruthy();
    expect(screen.getByText(/excludes 1 restricted claim/)).toBeTruthy();
    expect(screen.getByRole('tab', { name: /Open\s*8/ })).toBeTruthy();
    const restricted = screen.getByText('CLM-2026-0044').closest('tr') as HTMLElement;
    expect(within(restricted).getAllByLabelText('Restricted').length).toBeGreaterThanOrEqual(3);
    expect(within(restricted).queryByText(/\$/)).toBeNull();
    const pd = screen.getByText('CLM-2026-0040').closest('tr') as HTMLElement;
    expect(within(pd).getByText('$38,450')).toBeTruthy();
  });
});

describe('New claim dialog (P2)', () => {
  it('G1 opens one claim per coverage; blank amounts are not sent (unknown, never 0)', async () => {
    create.mockResolvedValue({ created: [{ id: 'a', number: 'CLM-1', type: 'physical_damage', restricted: false }, { id: 'b', number: 'CLM-2', type: 'cargo', restricted: false }], accidentId: 'acc_16' });
    const onClose = vi.fn();
    wrap(<NewClaimDialog accidentId="acc_16" onClose={onClose} />);
    expect(screen.getByText(/Already linked: CLM-2026-0040/)).toBeTruthy();
    await userEvent.click(screen.getByLabelText(/Cargo/, { selector: 'input' }));
    await userEvent.click(screen.getByLabelText(/Recovery/, { selector: 'input' }));
    await userEvent.click(screen.getByRole('button', { name: 'Open 2 claims' }));
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    const [body, key] = create.mock.calls[0] as [A.CreateClaimsInput, string];
    expect(body).toEqual({ accidentId: 'acc_16', lines: [{ type: 'cargo' }, { type: 'recovery' }] });
    expect(key).toBeTruthy();
    await waitFor(() => expect(onClose).toHaveBeenCalled());
  });

  it('G2 warns that an open claim of the same coverage exists; auto liability on an injury accident shows as restricted (G10)', async () => {
    wrap(<NewClaimDialog accidentId="acc_16" onClose={() => undefined} />);
    expect(screen.getAllByText(/an open claim of this type already exists/).length).toBe(1);
    // Auto liability (injuries on the accident) and workers' comp both open restricted.
    expect(screen.getAllByText(/opened restricted \(bodily injury\)/, { selector: 'span' })).toHaveLength(2);
    // Without accidents.claim_money the amount fields are read-only.
    await userEvent.click(screen.getByLabelText(/Cargo/, { selector: 'input' }));
    expect((document.getElementById('claimed-cargo') as HTMLInputElement).disabled).toBe(true);
  });
});
