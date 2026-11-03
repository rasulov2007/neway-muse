import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConsentRequest } from '@neway/shared';
import { renderPage } from '@/features/common/test-router';
import { ConsentCenter } from './ConsentCenter';

function consent(overrides: Partial<ConsentRequest>): ConsentRequest {
  return {
    id: 'cns_1',
    driverId: 'drv_1',
    driverName: 'Ana Ruiz',
    purpose: 'mvr',
    requirementCode: 'mvr_review',
    subject: null,
    status: 'draft',
    requestedAt: '2026-09-01T10:00:00.000Z',
    requestedBy: 'Monica Alvarez',
    sentAt: null,
    viewedAt: null,
    signedAt: null,
    declinedAt: null,
    expiresAt: '2026-09-15T10:00:00.000Z',
    signerName: null,
    signerChannel: null,
    signedDocumentId: null,
    history: [
      { at: '2026-09-01T10:00:00.000Z', status: 'draft', actor: 'Monica Alvarez', note: null },
    ],
    ...overrides,
  };
}

const ROWS: ConsentRequest[] = [
  consent({}),
  consent({
    id: 'cns_2',
    driverName: 'Ben Cole',
    driverId: 'drv_2',
    purpose: 'psp',
    requirementCode: 'psp_review',
    status: 'sent',
    sentAt: '2026-09-02T10:00:00.000Z',
  }),
  consent({
    id: 'cns_3',
    driverName: 'Cy Dunn',
    driverId: 'drv_3',
    purpose: 'background_check',
    requirementCode: 'background_check',
    status: 'signed',
    sentAt: '2026-08-20T10:00:00.000Z',
    signedAt: '2026-08-21T14:00:00.000Z',
    signerName: 'Cy Dunn',
    signerChannel: 'driver_portal',
    signedDocumentId: 'doc_9',
  }),
];

const sendConsentRequest = vi.fn();
const respondToConsentRequest = vi.fn();

vi.mock('@/demo', () => ({
  listDrivers: vi.fn(() => Promise.resolve({ data: [], total: 0, page: 1, pageSize: 200 })),
}));

vi.mock('./compliance-api', () => ({
  listConsentRequests: vi.fn(() => Promise.resolve(ROWS)),
  createConsentRequest: vi.fn(),
  sendConsentRequest: (...args: unknown[]) => sendConsentRequest(...args),
  cancelConsentRequest: vi.fn(),
  respondToConsentRequest: (...args: unknown[]) => respondToConsentRequest(...args),
}));

describe('ConsentCenter', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendConsentRequest.mockResolvedValue({ ...ROWS[0], status: 'sent' });
    respondToConsentRequest.mockResolvedValue({ ...ROWS[1], status: 'signed' });
  });

  it('shows every request with its exact purpose and the requirement it unlocks', async () => {
    renderPage(<ConsentCenter />);
    // The card renders before its rows arrive, so wait on a row, not on the card.
    expect(await screen.findByText('MVR authorization')).toBeInTheDocument();
    const table = screen.getByTestId('consent-center');
    expect(within(table).getByText('unlocks mvr review')).toBeInTheDocument();
    expect(within(table).getByText('PSP authorization')).toBeInTheDocument();
    expect(within(table).getByText(/Cy Dunn · driver portal/)).toBeInTheDocument();
  });

  it('sends a draft as the current user', async () => {
    renderPage(<ConsentCenter />);
    const row = (await screen.findByText('Ana Ruiz')).closest('tr');
    await userEvent.click(within(row as HTMLElement).getByRole('button', { name: 'Send' }));
    await waitFor(() => expect(sendConsentRequest).toHaveBeenCalledWith('cns_1'));
  });

  it('keeps the simulated driver response clearly labelled as a demo stand-in', async () => {
    renderPage(<ConsentCenter />);
    const row = (await screen.findByText('Ben Cole')).closest('tr');
    await userEvent.click(
      within(row as HTMLElement).getByRole('button', { name: /Actions for Ben Cole/ }),
    );
    expect(await screen.findByText('Demo: driver responds')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('menuitem', { name: 'Driver signs' }));
    await waitFor(() =>
      expect(respondToConsentRequest).toHaveBeenCalledWith('cns_2', {
        outcome: 'signed',
        signerName: 'Ben Cole',
      }),
    );
  });

  it('has no driver-response menu for a request that is not awaiting a signature', async () => {
    renderPage(<ConsentCenter />);
    const row = (await screen.findByText('Cy Dunn')).closest('tr');
    await userEvent.click(
      within(row as HTMLElement).getByRole('button', { name: /Actions for Cy Dunn/ }),
    );
    expect(await screen.findByText('No actions available')).toBeInTheDocument();
    expect(screen.queryByText('Demo: driver responds')).not.toBeInTheDocument();
  });
});
