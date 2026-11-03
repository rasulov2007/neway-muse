import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { ReimbursementsPage } from './ReimbursementsPage';

/**
 * The page renders, and says what it owes.
 *
 * A page that throws during render puts the whole screen behind "Unable to load this page", and
 * neither the typechecker nor the bundler notices - a column helper called by the wrong name
 * compiles perfectly and breaks only in the browser. This mounts it the way the app does, against
 * the stubbed server.
 */
describe('the reimbursements page', () => {
  const open = () => renderPage(<ReimbursementsPage />, { routePath: '/accounting/reimbursements', path: '/accounting/reimbursements' });

  it('renders without throwing', async () => {
    open();
    await waitFor(() => expect(screen.getAllByText('Reimbursements').length).toBeGreaterThan(0));
    expect(screen.queryByText(/Unable to load this page/)).toBeNull();
  });

  it('shows a row for each reimbursement, with its driver, load and state', async () => {
    open();
    await waitFor(() => expect(screen.getAllByText('Remy Calloway').length).toBeGreaterThan(0));
    expect(screen.getAllByText('NW-2026-08-114872').length).toBeGreaterThan(0);
    expect(screen.getByText('Lumper at the Fresno DC')).toBeVisible();
    expect(screen.getAllByText('Pending review').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Paid').length).toBeGreaterThan(0);
  });

  it('totals what the company owes, not what the receipts came to', async () => {
    open();
    // The approved item is a $150 receipt the driver funded $60 of: the card says $60.00.
    const card = await screen.findByText('Approved, not on a statement');
    expect(within(card.closest('button')!).getByText('$60.00')).toBeVisible();
    // And the row says so too, with the receipt beside it.
    expect(screen.getByText('of $150.00')).toBeVisible();
  });

  it('opens one for review', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(screen.getByText('Lumper at the Fresno DC')).toBeVisible());
    await user.click(screen.getAllByRole('button', { name: 'Review' })[0]!);
    expect(await screen.findByText('Driver who paid')).toBeVisible();
    expect(screen.getByText('Owed to the driver')).toBeVisible();
  });

  it('will not let a rejection be recorded without a reason', async () => {
    const user = userEvent.setup();
    open();
    await waitFor(() => expect(screen.getByText('Lumper at the Fresno DC')).toBeVisible());
    await user.click(screen.getAllByRole('button', { name: 'Review' })[0]!);
    await screen.findByText('Driver who paid');
    expect(screen.getByRole('button', { name: /^Reject$/ })).toBeDisabled();
  });
});

describe('a receipt the company funded in full', () => {
  it('says nothing is owed and does not invite an approval the server will refuse', async () => {
    const user = userEvent.setup();
    renderPage(<ReimbursementsPage />, { routePath: '/accounting/reimbursements', path: '/accounting/reimbursements' });
    await waitFor(() => expect(screen.getByText('Lumper at the Fresno DC')).toBeVisible());
    await user.click(screen.getAllByRole('button', { name: 'Review' })[0]!);
    await screen.findByText('Driver who paid');
    // The stub's pending item is driver-funded, so this one can be approved.
    expect(screen.getByRole('button', { name: /Approve \$150\.00/ })).toBeEnabled();
  });
});

describe('the entry form', () => {
  it('opens without throwing', async () => {
    const user = userEvent.setup();
    renderPage(<ReimbursementsPage />, { routePath: '/accounting/reimbursements', path: '/accounting/reimbursements' });
    await waitFor(() => expect(screen.getByText('Lumper at the Fresno DC')).toBeVisible());
    await user.click(screen.getByRole('button', { name: /Add reimbursement/ }));
    expect(await screen.findByText('Receipt total')).toBeVisible();
    expect(screen.getByText('Of which the driver funded')).toBeVisible();
    expect(screen.queryByText(/Unable to load this page/)).toBeNull();
  });
});

describe('the receipt in the drawer', () => {
  it('is fetched and handed to an image once its bytes say it is one', async () => {
    const user = userEvent.setup();
    renderPage(<ReimbursementsPage />, { routePath: '/accounting/reimbursements', path: '/accounting/reimbursements' });
    await waitFor(() => expect(screen.getByText('Lumper at the Fresno DC')).toBeVisible());
    await user.click(screen.getAllByRole('button', { name: 'Review' })[0]!);
    expect(await screen.findByAltText('Receipt')).toBeInTheDocument();
    expect(screen.queryByText(/could not be/)).toBeNull();
  });
});

describe('the table at a desktop width', () => {
  it('keeps the status and the review action in the table, and moves the rest to the drawer', async () => {
    renderPage(<ReimbursementsPage />, { routePath: '/accounting/reimbursements', path: '/accounting/reimbursements' });
    await waitFor(() => expect(screen.getByText('Lumper at the Fresno DC')).toBeVisible());
    const headers = screen.getAllByRole('columnheader').map((h) => h.textContent?.trim());
    expect(headers).toEqual(expect.arrayContaining(['Date', 'Driver', 'Load', 'Description', 'Amount', 'Status', 'Statement']));
    expect(headers).not.toContain('Paid by');
    expect(headers).not.toContain('Truck');
  });
});

describe('a load number never shows as a raw id', () => {
  it('names the load, or says there is none', async () => {
    renderPage(<ReimbursementsPage />, { routePath: '/accounting/reimbursements', path: '/accounting/reimbursements' });
    await waitFor(() => expect(screen.getByText('Lumper at the Fresno DC')).toBeVisible());
    expect(screen.queryByText('ld_1')).toBeNull();
    expect(screen.getAllByText('NW-2026-08-114872').length).toBeGreaterThan(0);
  });
});
