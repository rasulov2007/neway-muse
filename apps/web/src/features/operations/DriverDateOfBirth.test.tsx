import { render as rtlRender, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { ToastProvider } from '@/design-system/components/Toast';
import { setClockForTests } from '@/lib/clock';
import type { Driver } from '@/demo';
import { DriverForm } from './DriverFormPage';
import { driverFormSchema } from './DriverFormSchema';

/** Date of birth on Add driver and on the profile's contact edit (owner, 2026-10-25). */

const mocks = vi.hoisted(() => ({
  createDriver: vi.fn(),
  updateDriverRecord: vi.fn(),
  readCardText: vi.fn(),
}));

vi.mock('@/demo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/demo')>()),
  createDriver: (input: unknown) => mocks.createDriver(input),
  updateDriverRecord: (id: string, patch: unknown) => mocks.updateDriverRecord(id, patch),
}));
vi.mock('@/features/safety/compliance-api', () => ({
  uploadComplianceDocument: vi.fn(async () => ({ document: { id: 'doc_1', title: 'CDL' } })),
}));
vi.mock('./credential-ocr', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./credential-ocr')>()),
  readCardText: (file: File) => mocks.readCardText(file),
}));

const { EditDriverDialog, canSeeDateOfBirth } = await import('./EditDriverDialog');

const CDL_TEXT = `
ILLINOIS
4d DLN W123-4567-8901
1 WILSON
2 JAMES
4a ISS 05/14/2025   4b EXP 05/14/2029
9 CLASS A
`;

const base = {
  firstName: 'James',
  lastName: 'Wilson',
  phone: '+1 312 555 0142',
  secondaryPhone: '',
  secondaryPhoneLabel: '' as const,
  email: 'james@example.com',
  driverType: 'company' as const,
  cdlState: 'IL',
  cdlClass: 'A' as const,
  cdlEndorsements: [],
  cdlExpiresOn: '2029-05-14',
  hireDate: '2026-10-25',
  homeCity: 'Chicago',
  homeState: 'IL',
  dispatcherId: '',
  payKind: 'per_mile' as const,
  payRate: 0.6,
  preferredLanguage: 'en' as const,
};

describe('date of birth', () => {
  beforeAll(() => setClockForTests('2026-10-25T12:00:00-04:00'));
  afterAll(() => setClockForTests(null));
  beforeEach(() => {
    mocks.createDriver.mockReset();
    mocks.updateDriverRecord.mockReset();
    mocks.readCardText.mockReset();
    mocks.readCardText.mockResolvedValue(CDL_TEXT);
    mocks.createDriver.mockResolvedValue({ id: 'drv_new', name: 'James Wilson', driverNumber: 'D-2101' });
  });

  it('the form schema takes it as optional and refuses the future and under 18 against the Eastern today', () => {
    expect(driverFormSchema.safeParse(base).success).toBe(true);
    expect(driverFormSchema.safeParse({ ...base, dateOfBirth: '' }).success).toBe(true);
    expect(driverFormSchema.safeParse({ ...base, dateOfBirth: '2008-10-25' }).success).toBe(true);
    const young = driverFormSchema.safeParse({ ...base, dateOfBirth: '2008-10-26' });
    expect(young.success).toBe(false);
    expect(young.error?.issues.find((i) => i.path[0] === 'dateOfBirth')?.message).toBe('A driver must be at least 18 years old');
    const future = driverFormSchema.safeParse({ ...base, dateOfBirth: '2026-10-26' });
    expect(future.error?.issues.find((i) => i.path[0] === 'dateOfBirth')?.message).toBe('Date of birth cannot be in the future');
  });

  it('Add driver shows an optional Date of birth and sends it as YYYY-MM-DD', async () => {
    const user = userEvent.setup();
    renderPage(<DriverForm onCancel={() => {}} onCreated={() => {}} />, { routePath: '/drivers/new', path: '/drivers/new' });

    const dob = (await screen.findByLabelText('Date of birth')) as HTMLInputElement;
    expect(screen.getByText('Optional. The driver must be 18 or older.')).toBeTruthy();

    const cdl = screen.getByLabelText('CDL — front of the card');
    const input = cdl.querySelector('input[type="file"]') as HTMLInputElement;
    await user.upload(input, new File([new Uint8Array([137, 80, 78, 71])], 'cdl.png', { type: 'image/png' }));
    await waitFor(() => expect(within(cdl).getByText('cdl.png')).toBeVisible());

    await user.type(screen.getByLabelText(/^Phone/), '+1 312 555 0142');
    await user.type(screen.getByLabelText(/^Email/), 'james@example.com');
    await user.type(screen.getByLabelText(/^Home city/), 'Chicago');
    const states = screen.getAllByLabelText(/^State/) as HTMLInputElement[];
    await user.type(states[states.length - 1]!, 'IL');
    await user.type(dob, '04/12/1987');
    await user.tab();
    await waitFor(() => expect(dob.value).toBe('Apr 12, 1987'));
    expect(screen.getByText('39 years old.')).toBeTruthy();

    await user.click(screen.getByRole('button', { name: 'Add driver' }));
    await waitFor(() => expect(mocks.createDriver).toHaveBeenCalled());
    expect(mocks.createDriver.mock.calls[0]![0]).toMatchObject({ dateOfBirth: '1987-04-12' });
  });

  it('the profile contact edit shows the recorded date and saves a change with the version read', async () => {
    const user = userEvent.setup();
    mocks.updateDriverRecord.mockResolvedValue({});
    const driver = {
      id: 'drv_42',
      name: 'Ali Karimov',
      driverNumber: 'D-042',
      phone: '+1 312 555 0142',
      secondaryPhone: null,
      email: 'ali@example.com',
      homeCity: 'Chicago',
      homeState: 'IL',
      preferredLanguage: 'en',
      cdlClass: 'A',
      cdlState: 'IL',
      cdlExpiresOn: '2029-05-14',
      medicalCardExpiresOn: '2027-01-01',
      cdlEndorsements: [],
      dateOfBirth: '1987-04-12',
      updatedAt: '2026-10-25T15:00:00.000Z',
    } as unknown as Driver;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rtlRender(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <EditDriverDialog driver={driver} section="contact" onClose={() => {}} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    const dob = screen.getByLabelText('Date of birth') as HTMLInputElement;
    expect(dob.value).toBe('Apr 12, 1987');
    expect(screen.getByText('39 years old.')).toBeTruthy();

    // Under 18 is refused before anything is sent.
    await user.clear(dob);
    await user.type(dob, '01/01/2015');
    await user.tab();
    expect(await screen.findByText('A driver must be at least 18 years old')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    expect(mocks.updateDriverRecord).not.toHaveBeenCalled();

    await user.clear(dob);
    await user.type(dob, '05/13/1988');
    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mocks.updateDriverRecord).toHaveBeenCalled());
    const [id, patch] = mocks.updateDriverRecord.mock.calls[0] as [string, Record<string, unknown>];
    expect(id).toBe('drv_42');
    expect(patch).toMatchObject({ dateOfBirth: '1988-05-13', expectedUpdatedAt: '2026-10-25T15:00:00.000Z' });
  });

  it('enters a date of birth that was never recorded, typed as MM/DD/YYYY (owner, 2026-10-26)', async () => {
    const user = userEvent.setup();
    mocks.updateDriverRecord.mockResolvedValue({});
    const driver = {
      id: 'drv_43',
      name: 'Bek Aliyev',
      driverNumber: 'D-043',
      phone: '+1 312 555 0143',
      secondaryPhone: null,
      email: 'bek@example.com',
      homeCity: 'Chicago',
      homeState: 'IL',
      preferredLanguage: 'en',
      cdlClass: 'A',
      cdlState: 'IL',
      cdlExpiresOn: '2029-05-14',
      medicalCardExpiresOn: '2027-01-01',
      cdlEndorsements: [],
      dateOfBirth: null,
      updatedAt: '2026-10-25T15:00:00.000Z',
    } as unknown as Driver;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rtlRender(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <EditDriverDialog driver={driver} section="contact" onClose={() => {}} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    const dob = screen.getByLabelText('Date of birth') as HTMLInputElement;
    expect(dob.value).toBe('');
    expect(dob.placeholder).toBe('MM/DD/YYYY');
    await user.type(dob, '12/31/1979');
    await user.tab();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mocks.updateDriverRecord).toHaveBeenCalled());
    // The calendar day as typed, never shifted by a zone.
    expect(mocks.updateDriverRecord.mock.calls[0]![1]).toMatchObject({ dateOfBirth: '1979-12-31' });
  });

  it('a role that may not see the date of birth is told so, and the save leaves it alone', async () => {
    const user = userEvent.setup();
    mocks.updateDriverRecord.mockResolvedValue({});
    const driver = {
      id: 'drv_44',
      name: 'Kim Lee',
      driverNumber: 'D-044',
      phone: '+1 312 555 0144',
      secondaryPhone: null,
      email: 'kim@example.com',
      homeCity: 'Chicago',
      homeState: 'IL',
      preferredLanguage: 'en',
      cdlClass: 'A',
      cdlState: 'IL',
      cdlExpiresOn: '2029-05-14',
      medicalCardExpiresOn: '2027-01-01',
      cdlEndorsements: [],
      dateOfBirth: null,
      updatedAt: '2026-10-25T15:00:00.000Z',
    } as unknown as Driver;
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    rtlRender(
      <QueryClientProvider client={client}>
        <ToastProvider>
          <EditDriverDialog driver={driver} section="contact" canEditBirth={false} onClose={() => {}} />
        </ToastProvider>
      </QueryClientProvider>,
    );
    const dob = screen.getByLabelText('Date of birth') as HTMLInputElement;
    expect(dob.disabled).toBe(true);
    expect(screen.getByText('Only Safety, the HR manager and administrators can see or change it.')).toBeTruthy();
    await user.click(screen.getByRole('button', { name: 'Save changes' }));
    await waitFor(() => expect(mocks.updateDriverRecord).toHaveBeenCalled());
    expect(mocks.updateDriverRecord.mock.calls[0]![1]).not.toHaveProperty('dateOfBirth');
  });

  it('canSeeDateOfBirth reads the same codes the API masks by', () => {
    expect(canSeeDateOfBirth(['drivers.view_contact', 'drivers.view_licence'])).toBe(false);
    expect(canSeeDateOfBirth(['compliance_sensitive.view'])).toBe(true);
    expect(canSeeDateOfBirth(['recruiting.manage'])).toBe(true);
    expect(canSeeDateOfBirth(['safety_testing.view'])).toBe(true);
  });
});
