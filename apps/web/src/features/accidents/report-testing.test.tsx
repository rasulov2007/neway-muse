import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { accidentsV2 as A } from '@neway/shared';
import { ToastProvider } from '@/design-system/components/Toast';
import { ReportModal } from './ReportModal';

/** Owner, 2026-10-24: the quick report asks "Post-accident alcohol and drug test required?"; Yes asks for the
 *  submission, and a required test with nothing submitted needs a reason why it was not done. */
const get = vi.fn();
const post = vi.fn();
const upload = vi.fn();
let permissions: string[] = ['accidents.edit', 'accidents.restricted'];
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiGet: (...a: unknown[]) => get(...a),
  apiPost: (...a: unknown[]) => post(...a),
}));
vi.mock('@/lib/files', () => ({ uploadFile: (...a: unknown[]) => upload(...a) }));
vi.mock('@/features/auth/auth-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/features/auth/auth-context')>()),
  useAccount: () => ({ permissions }),
}));

const PICKERS: A.ReportPickers = {
  trucks: [{ id: 'trk_1', unit: '118', driverId: null, driverName: null, status: 'active', trailerId: null, loadId: null }],
  drivers: [],
  trailers: [],
  loads: [],
  people: [],
};

function renderModal() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <ReportModal onClose={() => undefined} onCreated={() => undefined} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

const byId = (id: string) => document.getElementById(id) as HTMLElement;
const answerYes = () => within(screen.getByRole('radiogroup', { name: 'Post-accident alcohol and drug test required?' })).getByRole('radio', { name: 'Yes' });

async function fillRequired() {
  await screen.findByRole('option', { name: /Truck 118/ });
  await userEvent.selectOptions(byId('r-truck'), 'trk_1');
  await userEvent.type(byId('r-city'), 'Lafayette');
  await userEvent.selectOptions(byId('r-state'), 'IN');
  await userEvent.type(byId('r-what'), 'Truck rear-ended a box truck in the work zone.');
}

describe('Report an accident — post-accident testing question', () => {
  beforeEach(() => {
    get.mockReset();
    post.mockReset();
    upload.mockReset();
    permissions = ['accidents.edit', 'accidents.restricted'];
    get.mockImplementation(async (path: string) => (String(path).endsWith('/pickers') ? PICKERS : { driverId: null, trailerId: null, loadId: null, source: null, note: null }));
    post.mockResolvedValue({ id: 'acc_1', number: 'ACC-001', stage: 'initial_response', version: 1, tasksCreated: 3, requestsCreated: 0 });
  });

  it('asks the question and will not submit without an answer', async () => {
    renderModal();
    expect(screen.getByRole('radiogroup', { name: 'Post-accident alcohol and drug test required?' })).toBeTruthy();
    await fillRequired();
    await userEvent.click(screen.getByRole('button', { name: 'Submit report' }));
    expect(await screen.findByText('Answer: Post-accident alcohol and drug test required?')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
  });

  it('Yes with nothing submitted needs a reason, and the reason is sent', async () => {
    renderModal();
    await fillRequired();
    await userEvent.click(answerYes());
    await userEvent.click(screen.getByRole('button', { name: 'Submit report' }));
    expect(await screen.findByText('The test is required but nothing is submitted — record why it was not done')).toBeTruthy();
    expect(post).not.toHaveBeenCalled();
    await userEvent.type(screen.getByLabelText(/Why was the test not done/), 'Driver taken to hospital, no collector within 32 hours');
    await userEvent.click(screen.getByRole('button', { name: 'Submit report' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    const body = post.mock.calls[0]![1] as A.ReportInput;
    expect(body.postAccidentTest).toEqual({ required: 'yes', fileId: null, notDoneReason: 'Driver taken to hospital, no collector within 32 hours' });
  });

  it('Yes with a submission sends the file and the results, no reason asked', async () => {
    upload.mockResolvedValue({ id: 'file_lab' });
    renderModal();
    await fillRequired();
    await userEvent.click(answerYes());
    const file = new File(['%PDF'], 'lab-result.pdf', { type: 'application/pdf' });
    fireEvent.change(screen.getByLabelText(/Test submission/), { target: { files: [file] } });
    expect(screen.queryByLabelText(/Why was the test not done/)).toBeNull();
    await userEvent.selectOptions(screen.getByLabelText('Alcohol result'), 'negative');
    await userEvent.selectOptions(screen.getByLabelText('Drug result'), 'pending');
    await userEvent.click(screen.getByRole('button', { name: 'Submit report' }));
    await waitFor(() => expect(post).toHaveBeenCalledTimes(1));
    expect((post.mock.calls[0]![1] as A.ReportInput).postAccidentTest).toEqual({ required: 'yes', fileId: 'file_lab', alcoholResult: 'negative', drugResult: 'pending', notDoneReason: null });
  });

  it('hides the restricted results without accidents.restricted', async () => {
    permissions = ['accidents.edit'];
    renderModal();
    await userEvent.click(answerYes());
    expect(screen.queryByLabelText('Alcohol result')).toBeNull();
    expect(screen.getByText(/Results are restricted/)).toBeTruthy();
  });
});
