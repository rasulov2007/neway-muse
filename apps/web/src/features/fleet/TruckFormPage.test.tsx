import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { TruckFormPage } from './TruckFormPage';
import { firstServiceDate, truckFormSchema } from './TruckFormSchema';

vi.mock('@/demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/demo')>();
  return {
    ...actual,
    listDrivers: vi.fn(() =>
      Promise.resolve({
        data: actual.demoData.drivers.slice(0, 5),
        total: 5,
        page: 1,
        pageSize: 5,
      }),
    ),
  };
});

const TRUCK_WARNING =
  "Without a registration, a current annual inspection and proof of insurance, this truck will be created out of service and can't be dispatched";

/** The hidden file input of the dropzone with this title. */
function dropzoneInput(container: HTMLElement, title: string): HTMLInputElement {
  const zone = within(container).getByText(title).closest('section');
  const input = zone?.querySelector('input[type="file"]');
  if (!input) throw new Error(`No file input for ${title}`);
  return input as HTMLInputElement;
}

function pdf(name: string): File {
  return new File(['%PDF-1.4'], name, { type: 'application/pdf' });
}

describe('TruckFormPage', () => {
  it('validates the VIN inline', async () => {
    const user = userEvent.setup();
    renderPage(<TruckFormPage />, { routePath: '/fleet/trucks/new', path: '/fleet/trucks/new' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Add truck' })).toBeInTheDocument();
    expect(screen.getByText('Trailers are added under Fleet › Trailers.')).toBeInTheDocument();

    const vin = screen.getByLabelText(/^VIN/);
    await user.type(vin, '1FUJGLDR5LLAB12IO');
    await user.tab();
    expect(await screen.findByText('VIN must be 17 characters with no I, O or Q')).toBeVisible();
    expect(vin).toHaveAttribute('aria-invalid', 'true');

    await user.clear(vin);
    await user.type(vin, '1FUJGLDR5LLAB1234');
    await waitFor(() =>
      expect(screen.queryByText('VIN must be 17 characters with no I, O or Q')).toBeNull(),
    );
  });

  it('blocks submit with required errors, then submits and navigates', async () => {
    const user = userEvent.setup();
    const { router } = renderPage(<TruckFormPage />, {
      routePath: '/fleet/trucks/new',
      path: '/fleet/trucks/new',
    });

    await user.click(await screen.findByRole('button', { name: 'Create truck' }));
    expect(await screen.findByText('Unit number needs at least 2 characters')).toBeVisible();
    expect(screen.getAllByText('Select a make').length).toBeGreaterThan(0);
    // The in-service date, plate and terminal are not demanded: the unit exists before they are
    // known, and the unit's page asks for each when a feature needs it.
    expect(screen.queryByText('Pick the in-service date')).toBeNull();
    expect(screen.queryByText('Plate is required')).toBeNull();

    // Identity only: unit number, VIN, make, model, year. The optional fields keep their labels
    // (Plate, State, In service since) but are left empty.
    expect(screen.getByLabelText(/^Plate/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: /State/ })).toBeInTheDocument();
    expect(screen.getByLabelText(/In service since/)).toBeInTheDocument();

    await user.type(screen.getByLabelText(/Unit number/), '2790');
    await user.type(screen.getByLabelText(/^VIN/), '1fujgldr5llab1234');
    await user.type(screen.getByLabelText(/^Model/), 'Cascadia');
    await user.type(screen.getByLabelText(/^Year/), '2024');

    // Radix select: open, then choose.
    await user.click(screen.getByRole('combobox', { name: /Make/ }));
    await user.click(await screen.findByRole('option', { name: 'Freightliner' }));

    await user.click(screen.getByRole('button', { name: 'Create truck' }));
    // The unit is persisted, so the form lands on the new unit's own page rather than back on a
    // filtered list.
    await waitFor(() => expect(router.state.location.href).toMatch(/^\/fleet\/trucks\/trk_/), {
      timeout: 5000,
    });
  }, 15_000);

  it('schema uppercases the VIN and coerces numbers', () => {
    const result = truckFormSchema.safeParse({
      unitNumber: '2790',
      vin: '1fujgldr5llab1234',
      make: 'Volvo',
      model: 'VNL',
      year: '2022',
      plate: 'X1',
      plateState: 'TX',
      ownership: 'leased',
      status: 'available',
      driverId: null,
      homeLocation: 'Dallas, TX',
      inServiceDate: new Date('2022-03-01'),
      odometer: '120000',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vin).toBe('1FUJGLDR5LLAB1234');
      expect(result.data.year).toBe(2022);
      expect(result.data.odometer).toBe(120000);
    }
    expect(truckFormSchema.safeParse({ vin: 'ABC' }).success).toBe(false);
  });

  it('validates with the identity alone and leaves every other detail absent', () => {
    // A unit exists before its plate, terminal or in-service date are known. Blank text becomes
    // `undefined`, never an empty string, so the record carries no stand-in values.
    const result = truckFormSchema.safeParse({
      unitNumber: '2792',
      vin: '1fujgldr5llab1236',
      make: 'Kenworth',
      model: 'T680',
      year: '2023',
      plate: '',
      plateState: undefined,
      ownership: undefined,
      status: 'available',
      driverId: null,
      homeLocation: undefined,
      inServiceDate: undefined,
      odometer: '0',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.plate).toBeUndefined();
      expect(result.data.plateState).toBeUndefined();
      expect(result.data.ownership).toBeUndefined();
      expect(result.data.homeLocation).toBeUndefined();
      expect(result.data.inServiceDate).toBeUndefined();
    }
  });

  it('still rejects a unit with no identity', () => {
    expect(
      truckFormSchema.safeParse({
        unitNumber: '2792',
        vin: '1FUJGLDR5LLAB1236',
        make: 'Kenworth',
        model: '',
        year: '',
        plate: '',
        status: 'available',
        driverId: null,
        odometer: '0',
      }).success,
    ).toBe(false);
  });

  it('books the first PM from the in-service date, or from today when there is none', () => {
    const today = new Date(2026, 8, 17);
    expect(firstServiceDate(new Date(2026, 0, 1), today)).toBe('2026-06-30');
    // No in-service date: measured from the day the unit was added, 180 days on.
    expect(firstServiceDate(undefined, today)).toBe('2027-03-16');
  });

  it('warns about the missing paperwork before saving, and still creates the truck', async () => {
    const user = userEvent.setup();
    const { router, container } = renderPage(<TruckFormPage />, {
      routePath: '/fleet/trucks/new',
      path: '/fleet/trucks/new',
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'Add truck' })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(TRUCK_WARNING))).toBeVisible();

    await user.type(screen.getByLabelText(/Unit number/), '2795');
    await user.type(screen.getByLabelText(/^VIN/), '1fujgldr5llab1239');
    await user.type(screen.getByLabelText(/^Model/), 'Cascadia');
    await user.type(screen.getByLabelText(/^Year/), '2024');
    await user.click(screen.getByRole('combobox', { name: /Make/ }));
    await user.click(await screen.findByRole('option', { name: 'Freightliner' }));

    // Nothing attached, and the submit still goes through — the unit exists either way.
    expect(within(container).getByText(new RegExp(TRUCK_WARNING))).toBeVisible();
    await user.click(screen.getByRole('button', { name: 'Create truck' }));
    await waitFor(() => expect(router.state.location.href).toMatch(/^\/fleet\/trucks\/trk_/), {
      timeout: 5000,
    });
  }, 20_000);

  it('clears the warning once registration and inspection are attached', async () => {
    const user = userEvent.setup();
    const { container } = renderPage(<TruckFormPage />, {
      routePath: '/fleet/trucks/new',
      path: '/fleet/trucks/new',
    });

    expect(await screen.findByRole('heading', { level: 1, name: 'Add truck' })).toBeInTheDocument();
    expect(screen.getByText(new RegExp(TRUCK_WARNING))).toBeVisible();

    await user.upload(dropzoneInput(container, 'Vehicle registration'), pdf('registration.pdf'));
    await user.upload(dropzoneInput(container, 'DOT annual inspection'), pdf('inspection.pdf'));
    // The cab cards were retired 2026-09-22: registration and inspection are the required two.
    await waitFor(() => expect(screen.queryByText(new RegExp(TRUCK_WARNING))).toBeNull());
  }, 20_000);

  it('will not accept a status that claims the unit is already working', () => {
    // `active` and `driving` describe a unit on a load, and a unit cannot be on a load it has not
    // been dispatched.
    const base = {
      unitNumber: '2791',
      vin: '1FUJGLDR5LLAB1235',
      make: 'Volvo' as const,
      model: 'VNL',
      year: '2022',
      plate: 'X2',
      plateState: 'TX' as const,
      ownership: 'owned' as const,
      driverId: null,
      homeLocation: 'Dallas, TX' as const,
      inServiceDate: new Date('2022-03-01'),
      odometer: '0',
    };
    expect(truckFormSchema.safeParse({ ...base, status: 'active' }).success).toBe(false);
    expect(truckFormSchema.safeParse({ ...base, status: 'available' }).success).toBe(true);
  });
});
