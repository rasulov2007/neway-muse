import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TruckAssignmentView, TruckDriverAssignment } from '@neway/shared';
import { renderPage } from '@/features/common/test-router';
import { TEST_ACCOUNT } from '@/test/roster-server';
import { apiGet, apiPost } from '@/lib/api-client';
import { setClockForTests } from '@/lib/clock';
import { invalidateRoster } from '@/demo/roster-api';
import { useAfterAssignmentChange } from '../use-truck-assignment';
import { AssignDriverPanel } from './AssignDriverPanel';
import { assignedDateProblem, dropDateProblem } from './assignment/assignment-rules';

vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiGet: vi.fn(),
  apiPost: vi.fn(),
  apiPatch: vi.fn(),
}));
vi.mock('@/demo/roster-api', async (importOriginal) => {
  const original = await importOriginal<typeof import('@/demo/roster-api')>();
  return { ...original, invalidateRoster: vi.fn(original.invalidateRoster) };
});

const TRUCK = 'trk_t1';

function assignment(over: Partial<TruckDriverAssignment> = {}): TruckDriverAssignment {
  return {
    id: 'tda_1',
    truckId: TRUCK,
    unitNumber: '101',
    driverId: 'drv_1',
    driverName: 'Ann Driver',
    driverNumber: 'D-1',
    assignedOn: '2026-10-01',
    endedOn: null,
    endReason: null,
    equipment: [
      { item: 'tablet', label: 'Tablet', detail: 'SN-1', handedOver: true },
      { item: 'keys', label: 'Keys', detail: null, handedOver: true },
    ],
    note: null,
    version: 3,
    createdByName: 'Ops',
    createdAt: '2026-10-01T14:00:00.000Z',
    updatedAt: '2026-10-01T14:00:00.000Z',
    assignedOnApproximate: false,
    source: 'truck_page',
    returnedEquipment: null,
    dropNote: null,
    endedByName: null,
    endedAt: null,
    editedByName: null,
    editedAt: null,
    pickupPhotos: [],
    dropPhotos: [],
    ...over,
  };
}

let view: TruckAssignmentView;

beforeEach(() => {
  setClockForTests('2026-10-08T15:00:00Z');
  view = {
    current: assignment(),
    history: [
      assignment({
        id: 'tda_0',
        driverId: 'drv_0',
        driverName: 'Old Driver',
        assignedOn: '2026-05-02',
        assignedOnApproximate: true,
        endedOn: '2026-09-30',
        endReason: 'Replaced by Ann Driver',
        returnedEquipment: [{ item: 'tablet', label: 'Tablet', detail: 'SN-0', handedOver: false }],
        dropNote: 'Scratched bumper',
        endedByName: 'Ops',
        editedByName: 'Sam Lead',
        editedAt: '2026-10-02T12:00:00.000Z',
        source: 'backfill',
      }),
    ],
  };
  vi.mocked(apiGet).mockImplementation(async (path: string) => {
    if (path === `/trucks/${TRUCK}/assignment`) return view as never;
    if (path === '/drivers') return { data: [] } as never;
    if (path === '/auth/me') return { ...TEST_ACCOUNT, signedIn: true } as never;
    throw new Error(`unexpected GET ${path}`);
  });
  vi.mocked(apiPost).mockReset();
});

afterEach(() => setClockForTests(null));

function render() {
  return renderPage(<AssignDriverPanel truckId={TRUCK} unitNumber="101" />);
}

describe('Unassign opens a modal and writes nothing until confirmed', () => {
  it('Cancel closes it without a call; Unassign sends the drop date and the returned list', async () => {
    const user = userEvent.setup();
    render();
    await user.click(await screen.findByRole('button', { name: 'Unassign' }));
    const dialog = await screen.findByRole('dialog', { name: /Unassign Ann Driver/ });
    expect(apiPost).not.toHaveBeenCalled();
    await user.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(apiPost).not.toHaveBeenCalled();

    vi.mocked(apiPost).mockResolvedValue({ current: null, history: [] } as never);
    await user.click(screen.getByRole('button', { name: 'Unassign' }));
    const again = await screen.findByRole('dialog', { name: /Unassign Ann Driver/ });
    // Pre-filled from what was handed over, ticked as returned.
    expect(within(again).getByDisplayValue('SN-1')).toBeVisible();
    await user.click(within(again).getByRole('button', { name: 'Unassign' }));
    await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
    const [path, body] = vi.mocked(apiPost).mock.calls[0]!;
    expect(path).toBe(`/trucks/${TRUCK}/assignment/tda_1/end`);
    expect(body).toMatchObject({
      version: 3,
      endedOn: '2026-10-08',
      returnedEquipment: [
        { item: 'tablet', label: 'Tablet', detail: 'SN-1', handedOver: true },
        { item: 'keys', label: 'Keys', detail: null, handedOver: true },
      ],
      dropPhotoIds: [],
    });
  });
});

describe('photos', () => {
  it('uploads a chosen picture at once and shows it in the Assign dialog', async () => {
    view = { current: null, history: [] };
    vi.mocked(apiPost).mockImplementation(async (path: string) => {
      if (path === `/trucks/${TRUCK}/assignment/photos`) {
        return { fileId: 'file_1', url: '/api/v1/files/file_1', fileName: 'cab.jpg', contentType: 'image/jpeg', sizeBytes: 3 } as never;
      }
      throw new Error(`unexpected POST ${path}`);
    });
    const user = userEvent.setup();
    render();
    await user.click((await screen.findAllByRole('button', { name: 'Assign driver' }))[0]!);
    const dialog = await screen.findByRole('dialog', { name: 'Assign driver' });
    const input = within(dialog).getByTestId('assignment-photo-input') as HTMLInputElement;
    expect(input.accept).toBe('image/*');
    expect(input.multiple).toBe(true);
    expect(input.hasAttribute('capture')).toBe(false);
    await user.upload(input, new File([new Uint8Array([0xff, 0xd8, 0xff])], 'cab.jpg', { type: 'image/jpeg' }));
    await waitFor(() =>
      expect(apiPost).toHaveBeenCalledWith(
        `/trucks/${TRUCK}/assignment/photos`,
        expect.objectContaining({ fileName: 'cab.jpg' }),
      ),
    );
    expect(await within(dialog).findByRole('button', { name: 'Open cab.jpg' })).toBeVisible();
  });
});

describe('Earlier drivers', () => {
  it('a row opens to everything the record holds, with "about" for a reconstructed start', async () => {
    const user = userEvent.setup();
    render();
    const row = await screen.findByRole('button', { name: /Old Driver/ });
    expect(row).toHaveTextContent('about');
    await user.click(row);
    const details = await screen.findByTestId('assignment-history-details');
    expect(details).toHaveTextContent('Scratched bumper');
    expect(details).toHaveTextContent('Not returned: Tablet');
    expect(details).toHaveTextContent('Edited by Sam Lead');
    expect(within(details).getByRole('button', { name: 'Edit' })).toBeVisible();
  });
});

describe('after an assignment write', () => {
  it('drops the cached roster and refreshes the fleet, drivers and dispatch boards', async () => {
    const queryClient = new QueryClient();
    const spy = vi.spyOn(queryClient, 'invalidateQueries');
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
    const { result } = renderHook(() => useAfterAssignmentChange(TRUCK), { wrapper });
    await act(() => result.current({ current: null, history: [] }));
    expect(invalidateRoster).toHaveBeenCalled();
    const keys = spy.mock.calls.map((c) => JSON.stringify(c[0]?.queryKey));
    for (const key of [['fleet'], ['trucks'], ['drivers'], ['dispatch-board']]) {
      expect(keys).toContain(JSON.stringify(key));
    }
    expect(queryClient.getQueryData(['fleet', 'assignment', TRUCK])).toEqual({ current: null, history: [] });
  });
});

describe('date rules', () => {
  it('assigned date: not empty, not in the future', () => {
    expect(assignedDateProblem('2026-10-08', '2026-10-08')).toBeNull();
    expect(assignedDateProblem('2026-10-09', '2026-10-08')).toMatch(/future/);
    expect(assignedDateProblem('', '2026-10-08')).toMatch(/Pick/);
  });
  it('drop date: not before the start, not in the future, not after the takeover', () => {
    expect(dropDateProblem('2026-10-01', '2026-10-01', '2026-10-08')).toBeNull();
    expect(dropDateProblem('2026-09-30', '2026-10-01', '2026-10-08')).toMatch(/before/);
    expect(dropDateProblem('2026-10-09', '2026-10-01', '2026-10-08')).toMatch(/future/);
    expect(dropDateProblem('2026-10-06', '2026-10-01', '2026-10-08', '2026-10-05')).toMatch(/new driver/);
  });
});
