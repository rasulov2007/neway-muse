import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { ReceivablesPage } from './ReceivablesPage';

/** Overdue lives in one place: the Overdue figure opens how much is late and for how long. */
describe('receivables overdue', () => {
  it('has no aging strip at the foot of the page', async () => {
    renderPage(<ReceivablesPage />, { routePath: '/', path: '/' });
    await screen.findByText('Outstanding invoices');
    expect(screen.queryByText('Outstanding by due date')).toBeNull();
    expect(screen.queryByTestId('overdue-breakdown')).toBeNull();
  });

  it('clicking Overdue shows the amount late, by how many days, and the oldest', async () => {
    const user = userEvent.setup();
    renderPage(<ReceivablesPage />, { routePath: '/', path: '/' });
    await user.click(await screen.findByText('Overdue'));
    const panel = await screen.findByTestId('overdue-breakdown');
    expect(within(panel).getByText(/^Overdue: \$/)).toBeVisible();
    for (const band of ['All overdue', '1–30 days', '31–60 days', '61–90 days', '90+ days']) {
      expect(within(panel).getByText(band)).toBeVisible();
    }
    expect(within(panel).getByText(/Oldest:|Nothing is past its due date\./)).toBeVisible();
  });
});
