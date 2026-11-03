import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { accidentsV2 as A } from '@neway/shared';
import { ToastProvider } from '@/design-system/components/Toast';
import { AccidentSettingsDialog } from './AccidentSettingsDialog';

/** Go-live §17 item 8: the Accidents settings dialog reads and saves the carrier's own values; read-only without the right. */
const get = vi.fn();
const put = vi.fn();
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiGet: (...a: unknown[]) => get(...a),
  apiPut: (...a: unknown[]) => put(...a),
}));

const SETTINGS = (over: Partial<A.AccidentSettingsResponse> = {}): A.AccidentSettingsResponse => ({
  version: '2026-10-22T12:00:00.000Z',
  deptAssignees: { Safety: { id: 'u1', name: 'Gina Safety' }, Fleet: null, Dispatch: null, Claims: null, Accounting: null, Management: null, 'Driver Relations': null },
  insurers: { physical_damage: 'Prairie Mutual', auto_liability: '', cargo: '', recovery: '', workers_comp: '' },
  deductibles: { physicalDamageDeductibleCents: 500_000, autoLiabilityDeductibleCents: 250_000, cargoDeductibleCents: 250_000 },
  fallbackDailyContributionCents: 64_000,
  people: [
    { id: 'u1', name: 'Gina Safety' },
    { id: 'u2', name: 'Clara Claims' },
  ],
  canEdit: true,
  updatedBy: 'Gina Safety',
  ...over,
});

function renderDialog() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <ToastProvider>
        <AccidentSettingsDialog onClose={() => undefined} />
      </ToastProvider>
    </QueryClientProvider>,
  );
}

describe('Accidents settings dialog', () => {
  beforeEach(() => {
    get.mockReset();
    put.mockReset();
  });

  it('shows the saved values and the $640 fallback, and saves the changes with the version it read', async () => {
    get.mockResolvedValue(SETTINGS());
    put.mockResolvedValue(SETTINGS());
    renderDialog();
    await screen.findByText('Default assignee per department');
    expect((screen.getByLabelText('Physical damage', { selector: 'input#insurer-physical_damage' }) as HTMLInputElement).value).toBe('Prairie Mutual');
    expect(screen.getByText('$640')).toBeTruthy();
    await userEvent.selectOptions(screen.getByLabelText('Claims'), 'u2');
    const pd = screen.getByLabelText('Physical damage', { selector: 'input#deductible-physicalDamageDeductibleCents' });
    await userEvent.clear(pd);
    await userEvent.type(pd, '7500');
    await userEvent.click(screen.getByRole('button', { name: 'Save settings' }));
    await waitFor(() => expect(put).toHaveBeenCalled());
    const [, body] = put.mock.calls[0] as [string, A.AccidentSettingsInput];
    expect(body.version).toBe('2026-10-22T12:00:00.000Z');
    expect(body.deptAssignees).toMatchObject({ Safety: 'u1', Claims: 'u2', Fleet: null });
    expect(body.deductibles).toEqual({ physicalDamageDeductibleCents: 750_000, autoLiabilityDeductibleCents: 250_000, cargoDeductibleCents: 250_000 });
    expect(body.insurers?.physical_damage).toBe('Prairie Mutual');
  });

  it('is read-only for an account that may not change it', async () => {
    get.mockResolvedValue(SETTINGS({ canEdit: false }));
    renderDialog();
    await screen.findByText('Only Safety Managers and the owner change these.');
    expect(screen.queryByRole('button', { name: 'Save settings' })).toBeNull();
    expect((screen.getByLabelText('Claims') as HTMLSelectElement).disabled).toBe(true);
  });
});
