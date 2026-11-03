import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { CreateEmployeeDialog } from './CreateEmployeeDialog';

/**
 * Create employee (owner, 2026-10-26): Shift time required, Title optional, and the pay type set
 * by the department and locked - Dispatch is Commission (KPI), every other department Fixed.
 */
const original = globalThis.fetch;
let posted: Record<string, unknown> | null = null;

beforeEach(() => {
  posted = null;
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const path = new URL(raw, 'http://localhost').pathname.replace(/^\/api\/v1/, '');
    const reply = (b: unknown, status = 200) =>
      new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
    if (path === '/employees' && init?.method === 'POST') {
      posted = JSON.parse(String(init.body)) as Record<string, unknown>;
      return reply({ id: 'emp_9', employeeNumber: 'EMP-9', name: 'Ann Lee', status: 'active', position: '' }, 201);
    }
    return reply({});
  }) as typeof fetch;
});
afterEach(() => {
  globalThis.fetch = original;
});

async function fillRequired(user: ReturnType<typeof userEvent.setup>) {
  await user.type(await screen.findByLabelText('Full name'), 'Ann Lee');
  const phone = screen.getByText('Primary phone').closest('div')!.querySelector('input')!;
  await user.type(phone, '6145550101');
  const email = screen.getByText('Email').closest('div')!.querySelector('input')!;
  await user.type(email, 'ann@example.com');
}

describe('Create employee', () => {
  it('requires a shift time and lets the title stay empty', async () => {
    const user = userEvent.setup();
    renderPage(<CreateEmployeeDialog open onOpenChange={() => undefined} />);
    await fillRequired(user);
    const create = screen.getByRole('button', { name: 'Create employee' });
    expect(create).toBeDisabled();
    expect(screen.getByLabelText('Title')).toHaveValue('');
    await user.type(screen.getByLabelText('Shift time'), '6 PM – 6 AM Eastern');
    expect(create).toBeEnabled();
    await user.click(create);
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toMatchObject({ position: '', shiftTime: '6 PM – 6 AM Eastern', department: 'dispatch', payType: 'commission' });
    // Personal fields go to their own columns, not the notes.
    expect(posted?.notes).toBeNull();
  });

  it('locks the pay type to the department: Dispatch is Commission (KPI), others Fixed', async () => {
    const user = userEvent.setup();
    renderPage(<CreateEmployeeDialog open onOpenChange={() => undefined} />);
    const pay = await screen.findByLabelText('Pay type');
    expect(pay).toHaveValue('Commission (KPI)');
    expect(pay).toBeDisabled();
    expect(screen.queryByRole('combobox', { name: 'Pay type' })).not.toBeInTheDocument();

    const department = screen.getByRole('combobox', { name: 'Department' });
    department.focus();
    await user.keyboard('{Enter}');
    await user.click(await screen.findByRole('option', { name: 'Safety' }));
    expect(screen.getByLabelText('Pay type')).toHaveValue('Fixed');
    expect(screen.getByLabelText('Pay type')).toBeDisabled();

    await fillRequired(user);
    await user.type(screen.getByLabelText('Shift time'), 'Day');
    await user.click(screen.getByRole('button', { name: 'Create employee' }));
    await waitFor(() => expect(posted).not.toBeNull());
    expect(posted).toMatchObject({ department: 'safety', payType: 'salary' });
  });

  it('the dispatcher preset is Dispatch on commission', async () => {
    renderPage(<CreateEmployeeDialog open preset="dispatcher" onOpenChange={() => undefined} />);
    expect(await screen.findByLabelText('Pay type')).toHaveValue('Commission (KPI)');
  });
});
