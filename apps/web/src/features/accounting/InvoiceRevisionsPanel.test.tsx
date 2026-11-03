import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { InvoiceRevisionsPanel } from './InvoiceRevisionsPanel';

/** The revisions panel mounts, offers Create revision, and shows the difference before anything posts. */
const open = () => renderPage(<InvoiceRevisionsPanel invoiceId="inv_rev1" />, { routePath: '/', path: '/' });

describe('invoice revisions and notes', () => {
  it('lists the version and offers Create revision', async () => {
    open();
    expect(await screen.findByTestId('version-INV-10004')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Create revision' })).toBeEnabled();
  });

  it('labels the two notes for what they are', async () => {
    open();
    expect(await screen.findByText('Visible on invoice PDF and customer/RTS package')).toBeVisible();
    expect(screen.getByText('Internal only — not sent to customer or RTS')).toBeVisible();
    expect(screen.getByText('Broker called about detention')).toBeVisible();
  });

  it('shows original, revised and the difference before a draft is created', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByRole('button', { name: 'Create revision' }));
    await user.click(await screen.findByRole('button', { name: /Add approved Detention/ }));
    const summary = screen.getByTestId('revision-summary');
    expect(within(summary).getByText('$2,150.00')).toBeVisible();
    expect(within(summary).getByText('$2,300.00')).toBeVisible();
    expect(within(summary).getByText('+$150.00')).toBeVisible();
    // No reason yet: nothing can be created.
    expect(screen.getByRole('button', { name: 'Create draft revision' })).toBeDisabled();
    // The printed note says where it goes, inside the dialog itself.
    expect(within(screen.getByRole('dialog')).getByText('Visible on invoice PDF and customer/RTS package')).toBeVisible();
  });
});
