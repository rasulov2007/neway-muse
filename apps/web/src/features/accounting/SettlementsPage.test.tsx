import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { SettlementsPage } from './SettlementsPage';

/**
 * The settlements page reads as the week's four steps, in order, each saying whether it is done,
 * and shows the picked week's statements with their money in plain words.
 */
const open = () => renderPage(<SettlementsPage />, { routePath: '/accounting/settlements', path: '/accounting/settlements' });

describe('the settlements page', () => {
  it('lays the week out as four numbered steps, in order', async () => {
    open();
    const steps = await Promise.all(['step-check', 'step-create', 'step-approve', 'step-send'].map((id) => screen.findByTestId(id)));
    expect(steps.map((s) => within(s).getByRole('heading').textContent)).toEqual(['Check before paying', 'Create this week’s statements', 'Review and approve', 'Send and pay']);
  });

  it('has ONE week selector: ‹ week ⌄ › with This week, the window and payday as a caption under it', async () => {
    open();
    const picker = await screen.findByTestId('week-picker');
    expect(screen.getAllByTestId('week-picker')).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'Previous week' })).toHaveLength(1);
    expect(screen.queryByRole('combobox', { name: 'Past weeks' })).toBeNull();
    expect(within(picker).getByRole('combobox', { name: 'Week' })).toHaveTextContent(/Sep 28, 2026 – Oct 4, 2026 · open/);
    expect(await within(picker).findByTestId('week-label')).toHaveTextContent(/Sep 28, 2026 – Oct 4, 2026 · Payday Oct 8, 2026/);
    expect(within(picker).getByRole('button', { name: 'This week' })).toBeVisible();
  });

  it('steps to the previous and next week with the arrows', async () => {
    const user = userEvent.setup();
    open();
    const picker = await screen.findByTestId('week-picker');
    await within(picker).findByText(/Payday Oct 8, 2026/);
    await user.click(within(picker).getByRole('button', { name: 'Previous week' }));
    expect(await within(picker).findByText(/Payday Oct 1, 2026/)).toBeVisible();
    await user.click(within(picker).getByRole('button', { name: 'Next week' }));
    expect(await within(picker).findByText(/Payday Oct 8, 2026/)).toBeVisible();
  });

  it('says what to check in plain words, with a way to fix it', async () => {
    open();
    const check = await screen.findByTestId('step-check');
    expect(await within(check).findByText('No bank details — cannot be paid')).toBeVisible();
    expect(within(check).getByRole('button', { name: 'Fix pay setup' })).toBeVisible();
  });

  it('lists only the drivers paid this week, and counts the others', async () => {
    open();
    const check = await screen.findByTestId('step-check');
    await within(check).findByText('No bank details — cannot be paid');
    expect(within(check).queryByText('Not Paid This Week')).toBeNull();
    expect(within(check).getByText(/1 other driver not paid this week/)).toBeVisible();
  });

  it('filters the statements to those waiting for approval', async () => {
    const user = userEvent.setup();
    open();
    const table = await screen.findByTestId('statements-table');
    await user.click(screen.getByRole('button', { name: /Waiting for approval/ }));
    expect(within(table).queryByText('Approved · not paid')).toBeNull();
    expect(within(table).getByText('Draft · not approved')).toBeVisible();
  });

  it('lists the week’s statements with their status in words', async () => {
    open();
    const table = await screen.findByTestId('statements-table');
    expect(within(table).getByText('Draft · not approved')).toBeVisible();
    expect(within(table).getByText('Approved · not paid')).toBeVisible();
    expect(within(await screen.findByTestId('step-approve')).getByText('1 of 2 approved')).toBeVisible();
  });

  it('opens a statement in a drawer when its row is clicked', async () => {
    const user = userEvent.setup();
    open();
    await user.click(await screen.findByTestId('statement-ST-20260928-V_2001'));
    expect(await screen.findByTestId('statement-workspace')).toBeVisible();
  });

  it('never uses the old jargon', async () => {
    open();
    await screen.findByTestId('statements-table');
    expect(screen.queryByText(/Sum of signed net/)).toBeNull();
    expect(screen.queryByText(/Before generating/)).toBeNull();
  });
});
