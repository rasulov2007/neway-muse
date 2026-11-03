import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { st1PayFactsWrites } from '@/test/roster-server';
import { StatementWorkspace } from './StatementWorkspace';

/**
 * A driver statement finished in one place: every line listed, deductions and reimbursements
 * added from here while it is a draft, approval right beside them - and nothing to add once it
 * is approved.
 */
const open = (id: 'st_1' | 'st_2') =>
  renderPage(<StatementWorkspace statementId={id} canEdit refreshWeek={vi.fn(async () => {})} onChanged={vi.fn(async () => {})} />, { routePath: '/', path: '/' });

describe('the statement workspace', () => {
  it('lists what was earned and what is taken off, line by line', async () => {
    open('st_1');
    const ws = await screen.findByTestId('statement-workspace');
    expect(within(ws).getByText('L-100006')).toBeVisible();
    expect(within(ws).getByText('Cracked mirror')).toBeVisible();
    expect(within(ws).getAllByText('−$361.00').length).toBe(2); // the line and the section total
  });

  it('on a draft, offers Add deduction, Add reimbursement, Remove and Approve', async () => {
    open('st_1');
    await screen.findByTestId('statement-workspace');
    expect(screen.getByRole('button', { name: 'Add deduction' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add reimbursement' })).toBeEnabled();
    expect(await screen.findByRole('button', { name: 'Remove Cracked mirror' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Approve this statement' })).toBeEnabled();
  });

  it('asks for an amount and a reason before a deduction can be added', async () => {
    const user = userEvent.setup();
    open('st_1');
    await user.click(await screen.findByRole('button', { name: 'Add deduction' }));
    const form = screen.getByTestId('add-deduction');
    expect(within(form).getByRole('button', { name: /Add .*deduction/ })).toBeDisabled();
    await user.type(within(form).getByLabelText('Deduction amount'), '150');
    await user.type(within(form).getByLabelText('Deduction reason'), 'Agreed with the driver');
    expect(within(form).getByRole('button', { name: 'Add $150.00 deduction' })).toBeEnabled();
  });

  it('shows the real pay week, Monday noon to Monday noon Eastern', async () => {
    open('st_1');
    expect(await screen.findByTestId('pay-window')).toHaveTextContent('Pay week Mon Sep 28, 12:00 PM – Mon Oct 5, 12:00 PM ET');
  });

  it('a load taken off is listed under “Not on this statement” and Put back returns it in one click', async () => {
    const user = userEvent.setup();
    open('st_1');
    await screen.findByTestId('statement-workspace');
    expect(screen.getByText('Not on this statement')).toBeVisible();
    expect(screen.getByText('L-100009')).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Put back L-100009' }));
    expect(await screen.findByText('Put back on this statement')).toBeVisible();
    expect(screen.queryByText('Not on this statement')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Put back L-100009' })).toBeNull();
  });

  it('Take off asks why, then the load is listed to be put back', async () => {
    const user = userEvent.setup();
    open('st_1');
    await user.click(await screen.findByRole('button', { name: 'Take L-100006 off this statement' }));
    const form = screen.getByTestId('take-off-load');
    const go = within(form).getByRole('button', { name: 'Take off this statement' });
    expect(go).toBeDisabled();
    await user.type(within(form).getByLabelText('Reason the load comes off'), 'POD not received yet');
    await user.click(go);
    expect(await screen.findByRole('button', { name: 'Put back L-100006' })).toBeEnabled();
  });

  it('an approved statement has nothing to add and nothing to approve, but can be reopened', async () => {
    open('st_2');
    await screen.findByTestId('statement-workspace');
    expect(screen.getByText('Approved')).toBeVisible();
    expect(screen.getByText('Approved. Record the payment to lock it; until then it can be reopened.')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Add deduction' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Approve this statement' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Reopen to edit' })).toBeEnabled();
  });

  it('Reopen to edit asks for a reason, then the statement is a draft with its edit controls back', async () => {
    const user = userEvent.setup();
    open('st_2');
    await user.click(await screen.findByRole('button', { name: 'Reopen to edit' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByRole('button', { name: 'Reopen' })).toBeDisabled();
    await user.type(within(dialog).getByLabelText('Reopen reason'), 'Fuel from Tuesday was missing');
    await user.click(within(dialog).getByRole('button', { name: 'Reopen' }));
    expect(await screen.findByRole('button', { name: 'Approve this statement' })).toBeEnabled();
    expect(screen.getByRole('button', { name: 'Add deduction' })).toBeEnabled();
    expect(screen.getByText('Draft · can still change')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Reopen to edit' })).toBeNull();
  });
});

describe('Real and For driver on the statement (owner, 2026-10-23)', () => {
  it('shows each load by REF and L-number with Real beside For driver', async () => {
    open('st_1');
    const ws = await screen.findByTestId('statement-workspace');
    expect(within(ws).getByText('REF 123456 / L-100006')).toBeVisible();
    expect(within(ws).getByText('$3,000.00')).toBeVisible();
    expect(within(ws).getByText('$2,500.00')).toBeVisible();
    expect(within(ws).getByText('$150.00')).toBeVisible();
  });

  it('Accounting edits For driver and the REF right there; the write carries the load version', async () => {
    const user = userEvent.setup();
    open('st_1');
    await user.click(await screen.findByRole('button', { name: 'Edit For driver and REF of L-100006' }));
    const form = screen.getByTestId('pay-facts-editor');
    const rate = within(form).getByLabelText('Linehaul For driver');
    await user.clear(rate);
    await user.type(rate, '2000');
    const ref = within(form).getByLabelText('REF number');
    await user.clear(ref);
    await user.type(ref, '654321');
    await user.click(within(form).getByRole('button', { name: 'Save' }));
    expect(await screen.findByText('REF 654321 / L-100006')).toBeVisible();
    expect(screen.getByText('$2,000.00')).toBeVisible();
    expect(st1PayFactsWrites.at(-1)).toMatchObject({ expectedUpdatedAt: '2026-10-04T15:00:00.000Z', driverRate: 2000, brokerReference: '654321', charges: [{ chargeId: 'det', driverAmount: 150 }] });
  });

  it('an approved statement shows the figures without an edit', async () => {
    open('st_2');
    await screen.findByTestId('statement-workspace');
    expect(screen.getByText('REF 123456 / L-100006')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Edit For driver and REF of L-100006' })).toBeNull();
  });
});
