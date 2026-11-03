import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { InvoiceRevisionsPanel } from './InvoiceRevisionsPanel';

/**
 * Add charge after invoicing (owner, 2026-10-21): once RTS has the invoice it is not revised; a
 * layover that came later goes on a supplemental invoice. The write goes to the server.
 */
const mocks = vi.hoisted(() => ({ apiPost: vi.fn() }));
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiPost: (path: string, body: unknown) => mocks.apiPost(path, body),
}));

const open = (id: string) => renderPage(<InvoiceRevisionsPanel invoiceId={id} />, { routePath: '/', path: '/' });

describe('charges after the invoice went to RTS', () => {
  it('a sent invoice offers Add charge after invoicing instead of Create revision, and lists its supplements', async () => {
    open('inv_sent1');
    expect(await screen.findByRole('button', { name: 'Add charge after invoicing' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Create revision' })).toBeNull();
    expect(await screen.findByTestId('supplement-INV-10010-S1')).toBeVisible();
  });

  it('an invoice not yet sent keeps Create revision', async () => {
    open('inv_rev1');
    expect(await screen.findByRole('button', { name: 'Create revision' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Add charge after invoicing' })).toBeNull();
  });

  it('bills a layover on INV-…-S2 with the driver paid, and leaves the original as sent', async () => {
    mocks.apiPost.mockImplementation(async (path: string, body: { charges: Array<{ amount: number }> }) => ({ ok: true, existing: false, issueBlocked: null, invoice: { id: 'inv_s2', invoiceNumber: 'INV-10010-S2', status: 'issued', total: body.charges[0]!.amount, loadNumber: 'TEST-L-2', loadId: 'ld_2' }, path }));
    const user = userEvent.setup();
    open('inv_sent1');
    await user.click(await screen.findByRole('button', { name: 'Add charge after invoicing' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText(/stays exactly as it was sent/)).toBeVisible();
    expect(within(screen.getByTestId('supplement-summary')).getByText('INV-10010-S2')).toBeVisible();

    const save = within(dialog).getByRole('button', { name: 'Create supplemental invoice' });
    expect(save).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Amount'), '250');
    await user.type(within(dialog).getByLabelText('Why it came after invoicing'), 'Layover approved by the broker');
    await user.click(within(dialog).getByLabelText('Pay the driver'));
    await user.click(within(dialog).getByText(/Or use a document already on the load/));
    await user.click(within(dialog).getByLabelText('Use layover-receipt.jpg'));
    expect(within(screen.getByTestId('supplement-summary')).getByText('$250.00')).toBeVisible();
    await user.click(save);

    await waitFor(() => expect(mocks.apiPost).toHaveBeenCalled());
    const [path, body] = mocks.apiPost.mock.calls[0]! as [string, Record<string, unknown> & { charges: Array<Record<string, unknown>> }];
    expect(path).toBe('/accounting/invoices/inv_sent1/supplements');
    expect(body).toMatchObject({ reason: 'Layover approved by the broker', issueNow: true, expectedUpdatedAt: '2026-10-14T15:00:00Z' });
    expect(String(body['requestKey'])).toMatch(/^sup-/);
    expect(body.charges).toEqual([{ chargeType: 'layover', description: 'Layover', amount: 250, supportingDocumentIds: ['doc_lay'], newFiles: [], payableToDriver: true, driverPay: { mode: 'full', value: 100 } }]);
  });
});
