import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { accidentsV2 as A } from '@neway/shared';
import { ToastProvider } from '@/design-system/components/Toast';
import { setClockForTests } from '@/lib/clock';

/**
 * Accident & Claims v2 — P3 web checks: the Financial impact strip and ledger draw the server's numbers (H3 at the
 * fixture clock), a viewer without repair costs sees a lock, and approving with fewer estimates than required asks for
 * the policy-exception reason (I3).
 */
const wo = vi.fn();
vi.mock('@tanstack/react-router', async (importOriginal) => ({ ...(await importOriginal<typeof import('@tanstack/react-router')>()), useNavigate: () => vi.fn() }));
vi.mock('./api', async (importOriginal) => {
  const real = await importOriginal<typeof import('./api')>();
  return {
    ...real,
    useVendors: () => ({ data: [{ id: 'v1', name: 'Prairie State Truck & Body' }] }),
    useCaseTasks: () => ({ data: [] }),
    accApi: { ...real.accApi, wo: (...args: unknown[]) => wo(...args) },
  };
});

const { FinancialImpact } = await import('./FinancialImpact');
const { EquipmentTab } = await import('./EquipmentTab');

const H3: A.FinancialsView = {
  lines: [
    { id: 'b1', group: 'actual', category: 'Towing', label: 'Lakeshore Towing & Recovery — Heavy tow', amountCents: 2_850_00, source: 'AP bill AP-90241' },
    { id: 'w1', group: 'estimate', category: 'Tractor repair', label: 'Tractor 118 repair — Prairie State Truck & Body, Joliet', amountCents: 38_450_00, source: 'Work order RO-2026-9131', note: 'Lowest of 2 estimates' },
    { id: 'e1', group: 'expected', category: 'Insurance payment', label: 'Harborline Insurance — Physical damage', amountCents: 33_450_00, source: 'Claim CLM-2026-0040 · Under review' },
    { id: 'c1', group: 'estimate', category: 'Deductible', label: 'Our deductible — Auto liability', amountCents: 2_500_00, source: 'Claim CLM-2026-0041 · Open' },
    { id: 'x1', group: 'exposure', category: 'Insurer reserve', label: 'Harborline reserve above our deductible', amountCents: 13_500_00, source: 'Claim CLM-2026-0041' },
  ],
  actualCents: 2_850_00,
  estimateCents: 40_950_00,
  recoveredCents: 0,
  expectedCents: 33_450_00,
  exposureCents: 13_500_00,
  netToDateCents: 2_850_00,
  projectedNetCents: 10_350_00,
  finalized: false,
  lostRevenue: { days: 16.84375, perDayCents: 630_00, amountCents: 10_612_00, fallback: false },
  restrictedClaimsExcluded: 0,
  byCategory: [
    { category: 'Towing', spentCents: 2_850_00, estimateCents: 0, recoveredCents: 0, expectedCents: 0 },
    { category: 'Tractor repair', spentCents: 0, estimateCents: 38_450_00, recoveredCents: 0, expectedCents: 0 },
    { category: 'Insurance payment', spentCents: 0, estimateCents: 0, recoveredCents: 0, expectedCents: 33_450_00 },
    { category: 'Deductible', spentCents: 0, estimateCents: 2_500_00, recoveredCents: 0, expectedCents: 0 },
  ],
};

const WO: A.WorkOrderView = {
  id: 'wo1',
  number: 'RO-2026-9131',
  unitKind: 'truck',
  unit: '118',
  shop: 'Prairie State Truck & Body, Joliet',
  status: 'Waiting for approval',
  title: 'Front-end collision repair',
  estimates: [
    { id: 'e1', vendor: 'Prairie State Truck & Body', amountCents: 38_450_00, receivedAt: '2026-10-08T15:00:00.000Z', selected: false },
    { id: 'e2', vendor: 'Joliet Collision', amountCents: 41_200_00, receivedAt: '2026-10-10T15:00:00.000Z', selected: false },
  ],
  estimatesRequired: 3,
  approvedAmountCents: null,
  approvedBy: null,
  policyExceptionReason: null,
  eta: null,
  invoiceNumber: null,
  invoiceTotalCents: null,
  bill: null,
  shopInAt: '2026-10-03T15:00:00.000Z',
  completedAt: null,
  updatedAt: '2026-10-10T15:00:00.000Z',
};

function detail(over: { financials?: A.FinancialsView | null; perms?: Partial<A.CaseDetailResponse['permissions']> } = {}): A.CaseDetailResponse {
  return {
    case: { id: 'acc16', number: 'ACC-2026-016', tz: 'America/Chicago', cargo: { status: 'no_damage' } },
    version: 3,
    redacted: [],
    display: { truck: { id: 't118', unit: '118' }, trailer: null, driver: { id: 'd2', name: 'Andre Lewis' }, load: null, owner: null, reportedBy: '', closedBy: null, voided: false },
    units: [{ id: 'u1', unitKind: 'truck', unitId: 't118', unit: '118', conditionAtScene: 'not_drivable', status: 'at_shop', damage: 'Front end', towCompany: 'Lakeshore Towing', towedTo: 'Joliet', storageRateCents: null, storageSince: null, returnedToServiceAt: null, version: 1 }],
    people: [],
    computed: {
      claims: [],
      downtime: { periods: [], truckMs: 0, trailerMs: 0, ongoing: true },
      money: { financials: over.financials === undefined ? H3 : over.financials, workOrders: [WO], unitStatus: [], apBills: [] },
    },
    permissions: { edit: true, editCargo: true, restricted: true, override: true, confirm: false, claimMoney: true, fleet: true, editUnits: true, bills: true, seeMoney: true, ...over.perms },
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
  wo.mockReset();
  setClockForTests('2026-10-19T17:00:00Z');
});

describe('Financial impact (P3)', () => {
  it('H3 draws Spent − Recovered = Net so far and Projected 10,350 from the server, every line with its source', () => {
    wrap(<FinancialImpact d={detail()} />);
    const strip = screen.getByText('Projected net cost').closest('#money-strip') as HTMLElement;
    expect(within(strip).getByText('$10,350')).toBeTruthy();
    expect(within(strip).getAllByText('$2,850').length).toBe(2);
    expect(screen.getByText('Work order RO-2026-9131')).toBeTruthy();
    expect(within(document.getElementById('ledger') as HTMLElement).getByText('−$33,450')).toBeTruthy();
    expect(screen.getByText(/16\.84 truck-days × \$630\/day/)).toBeTruthy();
  });

  it('shows a lock instead of money to a role that may not see repair costs', () => {
    wrap(<FinancialImpact d={detail({ financials: null, perms: { seeMoney: false } })} />);
    expect(screen.getByText('Repair costs are not shown to your role')).toBeTruthy();
    expect(screen.queryByText('$10,350')).toBeNull();
  });
});

describe('Equipment & cargo (P3)', () => {
  it('I3 approving with 2 of 3 estimates asks for the policy-exception reason before it sends', async () => {
    wo.mockResolvedValue({ id: 'wo1', updatedAt: '2026-10-19T17:00:00.000Z' });
    wrap(<EquipmentTab d={detail()} />);
    expect(screen.getByText('2 of 3 required')).toBeTruthy();
    await userEvent.click(screen.getByRole('button', { name: 'Approve estimate' }));
    const approve = screen.getByRole('button', { name: 'Approve' });
    expect((approve as HTMLButtonElement).disabled).toBe(true);
    await userEvent.type(screen.getByLabelText(/Policy-exception reason/), 'Third shop cannot quote for two weeks');
    await userEvent.click(approve);
    expect(wo).toHaveBeenCalledWith('wo1', 'approve', { updatedAt: WO.updatedAt, estimateId: 'e1', exceptionReason: 'Third shop cannot quote for two weeks' });
  });
});
