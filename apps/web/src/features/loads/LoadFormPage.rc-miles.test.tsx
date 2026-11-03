import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { RateConfirmationExtract } from '@neway/shared';
import { renderPage } from '@/features/common/test-router';
import { demoData } from '@/demo';
import { apiGet } from '@/lib/api-client';
import { LoadForm } from './LoadFormPage';
import { readRateConfirmation } from './rc-reader';

/**
 * Loaded miles come from the RC when it prints them (owner, 2026-10-26): "Of course take it from
 * the RC." The straight-line estimate is the fallback, and a typed figure wins over both.
 */
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiGet: vi.fn(async (path?: string) => {
    throw new Error(`no api for ${path} in this test`);
  }),
}));

vi.mock('./rc-reader', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./rc-reader')>()),
  readRateConfirmation: vi.fn(),
}));

const PICKUP = demoData.facilities[0]!.address;
const DROP = demoData.facilities.find((f) => f.address.city !== PICKUP.city)!.address;

const extract = (miles: number | null): RateConfirmationExtract => ({
  brokerName: null,
  brokerMc: null,
  brokerLoadNumber: 'RC-1',
  totalRate: 2000,
  linehaulRate: null,
  commodity: null,
  weightLbs: null,
  equipment: null,
  hazmat: null,
  temperature: null,
  miles,
  stops: [
    { kind: 'pickup', facilityName: null, street: null, city: PICKUP.city, state: PICKUP.state, zip: null, date: null, time: null, endTime: null, reference: null },
    { kind: 'delivery', facilityName: null, street: null, city: DROP.city, state: DROP.state, zip: null, date: null, time: null, endTime: null, reference: null },
  ],
  notes: null,
  warnings: [],
});

async function booking() {
  const view = renderPage(<LoadForm onCancel={() => undefined} onBooked={() => undefined} />);
  await screen.findByRole('textbox', { name: 'PICKUP city' });
  return view;
}

async function typeRoute(user: ReturnType<typeof userEvent.setup>) {
  await user.type(screen.getByRole('textbox', { name: 'PICKUP city' }), PICKUP.city);
  await user.type(screen.getByRole('textbox', { name: 'PICKUP state' }), PICKUP.state);
  await user.type(screen.getByRole('textbox', { name: 'DELIVERY city' }), DROP.city);
  await user.type(screen.getByRole('textbox', { name: 'DELIVERY state' }), DROP.state);
}

async function uploadRc(user: ReturnType<typeof userEvent.setup>, miles: number | null) {
  vi.mocked(readRateConfirmation).mockResolvedValue({ extract: extract(miles) } as never);
  const input = document.querySelector('input[type="file"]') as HTMLInputElement;
  await user.upload(input, new File(['%PDF'], 'rc.pdf', { type: 'application/pdf' }));
  await waitFor(() => expect(readRateConfirmation).toHaveBeenCalled());
}

const loadedField = () => screen.getByRole('spinbutton', { name: /Loaded miles/ }) as HTMLInputElement;

describe('Add load: loaded miles from the RC', () => {
  beforeEach(() => {
    vi.mocked(readRateConfirmation).mockReset();
    vi.mocked(apiGet).mockClear();
  });

  it('fills the RC miles over the estimate, and the estimate does not overwrite them', async () => {
    const user = userEvent.setup();
    await booking();
    await typeRoute(user);
    // The estimate fills the empty box first...
    await waitFor(() => expect(Number(loadedField().value)).toBeGreaterThan(0));
    const estimate = Number(loadedField().value);
    expect(screen.getByTestId('loaded-miles-source')).toHaveTextContent('Estimated (straight line × 1.18)');
    // ...and the RC's own figure replaces it.
    await uploadRc(user, 3457);
    await waitFor(() => expect(loadedField()).toHaveValue(3457));
    expect(screen.getByTestId('loaded-miles-source')).toHaveTextContent('From the RC');
    // The estimate is still offered beside it, and taking it is the person's choice.
    expect(screen.getByRole('button', { name: `Use ${estimate} mi` })).toBeInTheDocument();
    // Clearing the box does not bring the estimate back by itself.
    await user.clear(loadedField());
    expect(loadedField()).toHaveValue(null);
  });

  it('falls back to the estimate when the RC prints no miles', async () => {
    const user = userEvent.setup();
    await booking();
    await uploadRc(user, null);
    // The RC filled the stops; the route estimate fills the miles.
    await waitFor(() => expect(Number(loadedField().value)).toBeGreaterThan(0));
    expect(screen.getByTestId('loaded-miles-source')).toHaveTextContent('Estimated (straight line × 1.18)');
  });

  it('keeps a figure the person typed over both the RC and the estimate', async () => {
    const user = userEvent.setup();
    await booking();
    await user.type(loadedField(), '999');
    await uploadRc(user, 3457);
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'PICKUP city' })).toHaveValue(PICKUP.city));
    expect(loadedField()).toHaveValue(999);
    expect(screen.queryByTestId('loaded-miles-source')).not.toBeInTheDocument();
  });
});
