import { screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { SendAllEmailDialog, StatementEmailBadge } from './StatementEmail';

/** The page never names a recipient: it sends the week id (and resend), the server does the rest. */
const mocks = vi.hoisted(() => ({ apiGet: vi.fn(), apiPost: vi.fn() }));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiGet: (path: string) => mocks.apiGet(path),
  apiPost: (path: string, body: unknown) => mocks.apiPost(path, body),
}));

const last = null;
const preview = {
  batchId: 'bat_1',
  running: false,
  ready: true,
  transport: 'resend',
  items: [
    { statementId: 's1', settlementNumber: 'ST-1', driverId: 'd1', driverName: 'Ann Able', recipient: 'a***@example.com', action: 'send', reason: null, last },
    { statementId: 's2', settlementNumber: 'ST-2', driverId: 'd2', driverName: 'Ben Bare', recipient: 'b***@example.com', action: 'send', reason: null, last },
    { statementId: 's3', settlementNumber: 'ST-3', driverId: 'd3', driverName: 'Cal Nomail', recipient: null, action: 'skip', reason: 'no_email', last },
    { statementId: 's4', settlementNumber: 'ST-4', driverId: 'd4', driverName: 'Dee Draft', recipient: 'd***@example.com', action: 'skip', reason: 'not_approved', last },
  ],
};

describe('Send all by email', () => {
  it('confirms with how many will be sent and who is skipped, sends only the week id, then shows the summary', async () => {
    mocks.apiGet.mockResolvedValue(preview);
    mocks.apiPost.mockResolvedValue({
      batchId: 'bat_1',
      sent: [{ statementId: 's1', settlementNumber: 'ST-1', driverId: 'd1', driverName: 'Ann Able', recipient: 'a***@example.com', status: 'sent', reason: null, error: null }],
      failed: [{ statementId: 's2', settlementNumber: 'ST-2', driverId: 'd2', driverName: 'Ben Bare', recipient: 'b***@example.com', status: 'failed', reason: null, error: 'Provider down' }],
      skipped_no_email: [{ statementId: 's3', settlementNumber: 'ST-3', driverId: 'd3', driverName: 'Cal Nomail', recipient: null, status: 'skipped', reason: 'no_email', error: null }],
      skipped: [{ statementId: 's4', settlementNumber: 'ST-4', driverId: 'd4', driverName: 'Dee Draft', recipient: null, status: 'skipped', reason: 'not_approved', error: null }],
    });
    renderPage(<SendAllEmailDialog batchId="bat_1" weekLabel="Company drivers · Oct 12 – Oct 19" onClose={() => undefined} />);
    expect(await screen.findByText(/2 statements will be emailed · 1 driver skipped \(no email\) · 1 skipped for other reasons/)).toBeInTheDocument();
    expect(screen.getByText(/Cal Nomail · ST-3 · No email on file/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Send 2' }));
    expect(mocks.apiPost).toHaveBeenCalledWith('/accounting/settlements/batches/bat_1/email', {});
    expect(await screen.findByTestId('email-summary')).toBeInTheDocument();
    expect(screen.getByText('1 sent')).toBeInTheDocument();
    expect(screen.getByText(/Ben Bare · ST-2 · Provider down/)).toBeInTheDocument();
    expect(screen.getByText(/Cal Nomail · ST-3/)).toBeInTheDocument();
  });

  it('a bounce reads "Email bounced — check address", never colour alone', async () => {
    renderPage(<StatementEmailBadge state={{ status: 'bounced', at: '2026-10-27T15:00:00.000Z', to: 'a***@example.com', error: 'Mailbox does not exist', bounced: true }} />);
    expect(await screen.findByText('Email bounced — check address')).toBeInTheDocument();
  });
});
