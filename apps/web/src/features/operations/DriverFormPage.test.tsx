import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { DriverForm } from './DriverFormPage';

/**
 * Adding a driver files two cards.
 *
 * The rule under test is that neither is optional: a qualification file opened on two typed dates
 * with no evidence behind them is the one somebody chases months later, when the driver is already
 * running loads. Recognition itself is stubbed — reading pixels is tested on its own text
 * fixtures in `credential-ocr.test.ts`; what matters here is what the form does with the result.
 */
const mocks = vi.hoisted(() => ({
  createDriver: vi.fn(),
  readCardText: vi.fn(),
}));

vi.mock('@/demo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/demo')>()),
  createDriver: (input: unknown) => mocks.createDriver(input),
}));

vi.mock('./credential-ocr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./credential-ocr')>()),
  readCardText: (file: File) => mocks.readCardText(file),
}));

const CDL_TEXT = `
ILLINOIS
4d DLN W123-4567-8901
1 WILSON
2 JAMES
3 DOB 03/12/1984
4a ISS 05/14/2025   4b EXP 05/14/2029
9 CLASS A   9a END H N
`;

const ROUTE = { routePath: '/drivers/new', path: '/drivers/new' };

function render() {
  return renderPage(<DriverForm onCancel={() => {}} onCreated={() => {}} />, ROUTE);
}

/** A photo, as the browser hands one to the form. */
function photo(name: string) {
  return new File([new Uint8Array([137, 80, 78, 71])], name, { type: 'image/png' });
}

function fileInput(section: HTMLElement): HTMLInputElement {
  const input = section.querySelector('input[type="file"]');
  expect(input).toBeTruthy();
  return input as HTMLInputElement;
}

describe('adding a driver', () => {
  beforeEach(() => {
    mocks.createDriver.mockReset();
    mocks.readCardText.mockReset();
    mocks.readCardText.mockResolvedValue(CDL_TEXT);
    mocks.createDriver.mockResolvedValue({
      id: 'drv_new',
      name: 'James Wilson',
      driverNumber: 'D-2101',
    });
  });

  it('asks only for the CDL: the DOT medical card and the photograph come from Recruiting (owner, 2026-10-12)', async () => {
    const user = userEvent.setup();
    render();

    const cdl = await screen.findByLabelText('CDL — front of the card');
    expect(screen.queryByLabelText('DOT medical certificate')).toBeNull();
    expect(screen.queryByLabelText('Driver photograph')).toBeNull();
    expect(screen.queryByText('Medical certificate expires')).toBeNull();
    expect(screen.getByRole('button', { name: 'Add driver' })).toBeDisabled();

    await user.upload(fileInput(cdl), photo('cdl-front.png'));
    await waitFor(() => expect(within(cdl).getByText('cdl-front.png')).toBeVisible());
    await waitFor(() => expect(screen.getByRole('button', { name: 'Add driver' })).toBeEnabled());
  });

  it('fills the licence fields from the card and leaves them editable', async () => {
    const user = userEvent.setup();
    render();

    const cdl = await screen.findByLabelText('CDL — front of the card');
    await user.upload(fileInput(cdl), photo('cdl-front.png'));
    await waitFor(() => expect(within(cdl).getByText('cdl-front.png')).toBeVisible());

    const expiry = screen.getAllByLabelText(/CDL expires/)[0] as HTMLInputElement;
    await waitFor(() => expect(expiry.value).toBe('May 14, 2029'));
    expect((screen.getAllByLabelText(/^State/)[0] as HTMLInputElement).value).toBe('IL');
    expect(within(cdl).getByText(/Read from the card/i)).toBeVisible();

    // Offered, not imposed: the person can change any of it before saving.
    await user.clear(expiry);
    await user.type(expiry, '2031-01-31');
    expect(expiry.value).toBe('2031-01-31');
  });

  it('keeps a PDF on file even though it cannot be read', async () => {
    const user = userEvent.setup();
    render();

    const back = await screen.findByLabelText('CDL — back of the card');
    const pdf = new File([new Uint8Array([37, 80, 68, 70])], 'card.pdf', {
      type: 'application/pdf',
    });
    await user.upload(fileInput(back), pdf);

    await waitFor(() => expect(within(back).getByText('card.pdf')).toBeVisible());
    expect(within(back).getByText(/cannot be read automatically/i)).toBeVisible();
    expect(mocks.readCardText).not.toHaveBeenCalled();
  });

  it('refuses a file the store will not keep', async () => {
    render();

    const cdl = await screen.findByLabelText('CDL — front of the card');
    const doc = new File(['x'], 'licence.docx', {
      type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    });
    // The picker filters by accept; a drop does not, which is the case being tested.
    const input = fileInput(cdl);
    Object.defineProperty(input, 'files', { value: [doc], configurable: true });
    fireEvent.change(input);

    expect(await within(cdl).findByRole('alert')).toHaveTextContent('JPG, a PNG or a PDF');
    expect(screen.getByRole('button', { name: 'Add driver' })).toBeDisabled();
  });

  it('files the card even when the reader fails, and says the dates need typing', async () => {
    const user = userEvent.setup();
    mocks.readCardText.mockRejectedValue(new Error('engine unavailable'));
    render();

    const cdl = await screen.findByLabelText('CDL — front of the card');
    await user.upload(fileInput(cdl), photo('cdl-front.png'));

    await waitFor(() => expect(within(cdl).getByText('cdl-front.png')).toBeVisible());
    expect(within(cdl).getByText(/could not be read/i)).toBeVisible();
    expect((screen.getAllByLabelText(/CDL expires/)[0] as HTMLInputElement).value).toBe('');
  });
});
