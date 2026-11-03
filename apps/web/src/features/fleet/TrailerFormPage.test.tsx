import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { TrailerFormPage } from './TrailerFormPage';
import { trailerFormSchema } from './TrailerFormSchema';

const WARNING =
  "Without a registration and a current annual inspection, this trailer will be created out of service and can't be dispatched";

/** The hidden file input of the dropzone with this title. */
function dropzoneInput(container: HTMLElement, title: string): HTMLInputElement {
  const heading = within(container).getByText(title);
  const zone = heading.closest('section');
  if (!zone) throw new Error(`No dropzone for ${title}`);
  const input = zone.querySelector('input[type="file"]');
  if (!input) throw new Error(`No file input for ${title}`);
  return input as HTMLInputElement;
}

function pdf(name: string): File {
  return new File(['%PDF-1.4'], name, { type: 'application/pdf' });
}

describe('TrailerFormPage documents', () => {
  it('warns before saving when the registration and inspection are missing, and still creates the trailer', async () => {
    const user = userEvent.setup();
    const { router } = renderPage(<TrailerFormPage />, {
      routePath: '/fleet/trailers/new',
      path: '/fleet/trailers/new',
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Add trailer' }),
    ).toBeInTheDocument();

    // The consequence is stated before anything is typed: nothing attached, nothing dispatchable.
    expect(screen.getByText(new RegExp(WARNING))).toBeVisible();

    await user.type(screen.getByLabelText(/Trailer number/), '5901');
    await user.type(screen.getByLabelText(/^VIN/), '1graa0623kj129901');
    await user.type(screen.getByLabelText(/^Model/), '4000D-X');
    await user.type(screen.getByLabelText(/^Year/), '2023');
    await user.click(screen.getByRole('combobox', { name: /Type/ }));
    await user.click(await screen.findByRole('option', { name: 'Dry van' }));

    // The warning never blocks the submit: the trailer is created, out of service or not.
    await user.click(screen.getByRole('button', { name: 'Add trailer' }));
    await waitFor(() => expect(router.state.location.href).toMatch(/^\/fleet\/trailers\/trl_/), {
      timeout: 5000,
    });
  }, 20_000);

  it('clears the warning once the registration and the annual inspection are attached', async () => {
    const user = userEvent.setup();
    const { container } = renderPage(<TrailerFormPage />, {
      routePath: '/fleet/trailers/new',
      path: '/fleet/trailers/new',
    });

    expect(
      await screen.findByRole('heading', { level: 1, name: 'Add trailer' }),
    ).toBeInTheDocument();
    expect(screen.getByText(new RegExp(WARNING))).toBeVisible();

    await user.upload(dropzoneInput(container, 'Trailer registration'), pdf('registration.pdf'));
    // One of the two on file is still a trailer that cannot be dispatched.
    expect(screen.getByText(new RegExp(WARNING))).toBeVisible();
    expect(screen.getByText(/Missing: Annual DOT inspection certificate/)).toBeVisible();

    await user.upload(
      dropzoneInput(container, 'Annual DOT inspection certificate'),
      pdf('inspection.pdf'),
    );
    await waitFor(() => expect(screen.queryByText(new RegExp(WARNING))).toBeNull());

    // The optional paperwork is offered, and its absence says nothing.
    expect(within(container).getByText('Insurance card')).toBeInTheDocument();
    expect(within(container).getByText('Lease agreement')).toBeInTheDocument();
    expect(within(container).getByText('Title')).toBeInTheDocument();
  }, 20_000);
});

describe('TrailerFormPage identity (owner, 2026-10-22)', () => {
  it('asks for model and year, never a make, and sends the model', async () => {
    const user = userEvent.setup();
    const posted: Record<string, unknown>[] = [];
    const serve = globalThis.fetch;
    globalThis.fetch = ((input: RequestInfo | URL, init?: RequestInit) => {
      const raw = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
      if ((init?.method ?? 'GET').toUpperCase() === 'POST' && /\/trailers$/.test(raw)) {
        posted.push(JSON.parse(String(init?.body ?? '{}')) as Record<string, unknown>);
      }
      return serve(input, init);
    }) as typeof fetch;
    try {
      const { container, router } = renderPage(<TrailerFormPage />, {
        routePath: '/fleet/trailers/new',
        path: '/fleet/trailers/new',
      });
      expect(
        await screen.findByRole('heading', { level: 1, name: 'Add trailer' }),
      ).toBeInTheDocument();

      // The Identity block: number, VIN, model and year. No make (owner, 2026-10-22).
      const identity = within(container).getByRole('heading', { name: 'Identity' }).closest('section');
      if (!identity) throw new Error('No Identity block');
      const labels = Array.from(identity.querySelectorAll('label')).map((label) =>
        (label.textContent ?? '').replace(/\*|required/gi, '').trim(),
      );
      expect(labels).toEqual(['Trailer number', 'VIN', 'Model', 'Year']);

      // Model is required, like the truck's.
      await user.click(screen.getByRole('button', { name: 'Add trailer' }));
      expect(await screen.findByText('Model is required')).toBeInTheDocument();
      expect(screen.queryByLabelText(/^Make/)).not.toBeInTheDocument();
      expect(posted).toHaveLength(0);

      await user.type(screen.getByLabelText(/Trailer number/), '5902');
      await user.type(screen.getByLabelText(/^VIN/), '1graa0623kj129902');
      await user.type(screen.getByLabelText(/^Model/), ' 4000D-X ');
      await user.type(screen.getByLabelText(/^Year/), '2026');
      await user.click(screen.getByRole('combobox', { name: /Type/ }));
      await user.click(await screen.findByRole('option', { name: 'Reefer' }));
      await user.click(screen.getByRole('button', { name: 'Add trailer' }));

      await waitFor(() => expect(router.state.location.href).toBe('/fleet/trailers/trl_5902'), {
        timeout: 5000,
      });
      expect(posted[0]).toMatchObject({ model: '4000D-X', year: 2026 });
      expect(posted[0]?.make ?? null).toBeNull();
    } finally {
      globalThis.fetch = serve;
    }
  }, 20_000);
});

describe('trailerFormSchema', () => {
  it('validates with the identity alone: number, VIN, model, year, type', () => {
    const result = trailerFormSchema.safeParse({
      unitNumber: '5219',
      vin: '1graa0623kj123457',
      year: '2022',
      model: '4000D-X',
      type: 'dry_van',
      lengthFt: '',
      plate: '',
      plateState: undefined,
      ownership: undefined,
      nextInspectionDate: undefined,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.vin).toBe('1GRAA0623KJ123457');
      expect(result.data.year).toBe(2022);
      // Blank stays absent, never a stand-in value.
      expect(result.data.lengthFt).toBeUndefined();
      expect(result.data.plate).toBeUndefined();
      expect(result.data.plateState).toBeUndefined();
      expect(result.data.ownership).toBeUndefined();
      expect(result.data.nextInspectionDate).toBeUndefined();
    }
  });

  it('keeps the optional details honest when they are given', () => {
    const result = trailerFormSchema.safeParse({
      unitNumber: '5220',
      vin: '1GRAA0623KJ123458',
      year: '2021',
      model: 'Everest',
      type: 'reefer',
      lengthFt: '53',
      plate: 'T5220',
      plateState: 'IL',
      ownership: 'leased',
      nextInspectionDate: new Date('2027-03-01'),
    });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.lengthFt).toBe(53);

    // A length that is given must be a real trailer length.
    expect(
      trailerFormSchema.safeParse({
        unitNumber: '5220',
        vin: '1GRAA0623KJ123458',
        year: '2021',
          model: 'Everest',
        type: 'reefer',
        lengthFt: '5',
        plate: '',
      }).success,
    ).toBe(false);
  });

  it('still rejects a trailer with no identity', () => {
    expect(
      trailerFormSchema.safeParse({
        unitNumber: '5221',
        vin: '1GRAA0623KJ123459',
        year: '2021',
          model: '',
        type: undefined,
        lengthFt: '',
        plate: '',
      }).success,
    ).toBe(false);
  });

  it('refuses a trailer without a model, with the truck form message', () => {
    const result = trailerFormSchema.safeParse({
      unitNumber: '5222',
      vin: '1GRAA0623KJ123450',
      year: '2024',
      model: '  ',
      type: 'dry_van',
      lengthFt: '',
      plate: '',
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.message)).toContain('Model is required');
  });
});
