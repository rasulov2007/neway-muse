import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { TruckHistoryTab } from './TruckHistoryTab';
import { demoData, type Accident, type Violation } from '@/demo';

/**
 * The list functions are mocked so the test owns the records and the paging: the rule under test
 * is that a unit shows its own history, all of it, and nothing of anybody else's.
 */
const mocks = vi.hoisted(() => ({
  listAccidents: vi.fn(),
  listViolations: vi.fn(),
}));

vi.mock('@/demo', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/demo')>()),
  listAccidents: (query: unknown) => mocks.listAccidents(query),
  listViolations: (query: unknown) => mocks.listViolations(query),
}));

/*
 * The fixtures are real records from the demo book with their identity changed: a hand-written
 * literal drifts from the type the moment Safety adds a field, and the shape is not what is under
 * test here.
 */
function must<T>(row: T | undefined, what: string): T {
  if (!row) throw new Error(`the demo book has no ${what}`);
  return row;
}
const ACCIDENT_TEMPLATE = must(demoData.accidents[0], 'accidents');
const VIOLATION_TEMPLATE = must(demoData.violations[0], 'violations');

function accident(id: string, truckId: string, over: Partial<Accident> = {}): Accident {
  // `Object.assign` rather than a spread: spreading a Partial makes every overridden field
  // optional, which is not what a record is.
  const base: Accident = {
    ...structuredClone(ACCIDENT_TEMPLATE),
    id,
    accidentNumber: `ACC-${id}`,
    truckId,
    unitNumber: '2701',
    at: '2026-05-04T14:00:00.000Z',
    description: 'Rear-ended at a light',
    location: { city: 'Joliet', state: 'IL', highway: 'I-80' },
    status: 'closed',
  };
  return Object.assign(base, over);
}

function violation(id: string, truckId: string, over: Partial<Violation> = {}): Violation {
  const base: Violation = {
    ...structuredClone(VIOLATION_TEMPLATE),
    id,
    violationNumber: `VIO-${id}`,
    truckId,
    unitNumber: '2701',
    onDate: '2026-06-11',
    code: '393.9-BL',
    description: 'Inoperative brake lamp',
    contested: false,
    resolvedAt: '2026-06-20T00:00:00.000Z',
  };
  return Object.assign(base, over);
}

/** Answers a paged list from a fixed set, filtered by `truckId` the way the store does. */
function pagedFrom<T extends { truckId: string | null }>(all: T[], pageSize = 200) {
  return async (query: { truckId?: string; page?: number; pageSize?: number }) => {
    const mine = all.filter((row) => !query.truckId || row.truckId === query.truckId);
    const size = query.pageSize ?? pageSize;
    const page = query.page ?? 1;
    return { data: mine.slice((page - 1) * size, page * size), total: mine.length };
  };
}

const ROUTE = { routePath: '/fleet/trucks/$truckId', path: '/fleet/trucks/trk_a' };

function render(truckId = 'trk_a') {
  return renderPage(<TruckHistoryTab truckId={truckId} unitNumber="2701" />, ROUTE);
}

describe('a unit’s safety history', () => {
  beforeEach(() => {
    mocks.listAccidents.mockReset();
    mocks.listViolations.mockReset();
  });

  it('shows this truck’s accidents and violations, closed ones included', async () => {
    mocks.listAccidents.mockImplementation(pagedFrom([accident('a1', 'trk_a')]));
    mocks.listViolations.mockImplementation(pagedFrom([violation('v1', 'trk_a')]));

    render();

    expect(await screen.findByText('ACC-a1')).toBeVisible();
    expect(screen.getByText('VIO-v1')).toBeVisible();
    // Both records are finished business and both are still here.
    expect(screen.getByText('Closed')).toBeVisible();
    expect(screen.getByText('Resolved')).toBeVisible();
    expect(screen.getByRole('link', { name: 'View accident' })).toHaveAttribute(
      'href',
      '/safety/accidents/a1',
    );
    expect(screen.getByRole('link', { name: 'View violation' })).toHaveAttribute(
      'href',
      '/safety/violations/v1',
    );
  });

  it('asks the store for this truck and never shows another truck’s records', async () => {
    mocks.listAccidents.mockImplementation(
      pagedFrom([accident('a1', 'trk_a'), accident('a2', 'trk_b')]),
    );
    mocks.listViolations.mockImplementation(
      pagedFrom([violation('v1', 'trk_a'), violation('v2', 'trk_b')]),
    );

    render('trk_a');

    expect(await screen.findByText('ACC-a1')).toBeVisible();
    expect(screen.queryByText('ACC-a2')).toBeNull();
    expect(screen.queryByText('VIO-v2')).toBeNull();
    // The filter is the truck's id, not its driver's.
    expect(mocks.listAccidents.mock.calls[0]?.[0]).toMatchObject({ truckId: 'trk_a' });
    expect(mocks.listViolations.mock.calls[0]?.[0]).toMatchObject({ truckId: 'trk_a' });
    for (const call of [...mocks.listAccidents.mock.calls, ...mocks.listViolations.mock.calls]) {
      expect(call[0]).not.toHaveProperty('driverId');
    }
  });

  it('keeps the history with the truck when the driver changes', async () => {
    // The same unit, two different drivers over its life. Both records belong to the unit.
    mocks.listAccidents.mockImplementation(
      pagedFrom([accident('a1', 'trk_a', { driverId: 'drv_old', driverName: 'Old Driver' })]),
    );
    mocks.listViolations.mockImplementation(
      pagedFrom([violation('v1', 'trk_a', { driverId: 'drv_new', driverName: 'New Driver' })]),
    );

    render('trk_a');

    expect(await screen.findByText('ACC-a1')).toBeVisible();
    expect(screen.getByText('VIO-v1')).toBeVisible();
  });

  it('drains every page rather than stopping at the first', async () => {
    const many = Array.from({ length: 250 }, (_, i) => accident(`a${i}`, 'trk_a'));
    mocks.listAccidents.mockImplementation(pagedFrom(many));
    mocks.listViolations.mockImplementation(pagedFrom([]));

    render();

    // The 201st record is on the second page; a single request would lose it.
    expect(await screen.findByText('ACC-a249')).toBeVisible();
    expect(mocks.listAccidents).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Accidents 250' })).toBeInTheDocument();
  });

  it('sorts newest first and filters by kind', async () => {
    const user = userEvent.setup();
    mocks.listAccidents.mockImplementation(
      pagedFrom([accident('old', 'trk_a', { at: '2025-01-02T00:00:00.000Z' })]),
    );
    mocks.listViolations.mockImplementation(
      pagedFrom([violation('new', 'trk_a', { onDate: '2026-08-01' })]),
    );

    render();

    const rows = await screen.findAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('VIO-new');
    expect(rows[1]).toHaveTextContent('ACC-old');

    await user.click(screen.getByRole('button', { name: 'Accidents 1' }));
    expect(screen.getByText('ACC-old')).toBeVisible();
    expect(screen.queryByText('VIO-new')).toBeNull();

    await user.click(screen.getByRole('button', { name: 'Violations 1' }));
    expect(screen.getByText('VIO-new')).toBeVisible();
    expect(screen.queryByText('ACC-old')).toBeNull();
  });

  it('picks up a record filed elsewhere in Safety', async () => {
    const all = [accident('a1', 'trk_a')];
    mocks.listAccidents.mockImplementation(pagedFrom(all));
    mocks.listViolations.mockImplementation(pagedFrom([]));

    const { queryClient } = render();
    expect(await screen.findByText('ACC-a1')).toBeVisible();

    // A new accident is recorded on another screen, which invalidates the safety key.
    all.push(accident('a2', 'trk_a'));
    await queryClient.invalidateQueries({ queryKey: ['safety'] });

    // This list is keyed beneath it, so it re-reads without knowing what happened.
    expect(await screen.findByText('ACC-a2')).toBeVisible();
  });

  it('carries links but never a photograph', async () => {
    mocks.listAccidents.mockImplementation(pagedFrom([accident('a1', 'trk_a')]));
    mocks.listViolations.mockImplementation(pagedFrom([]));

    const { container } = render();

    await screen.findByText('ACC-a1');
    expect(container.querySelectorAll('img')).toHaveLength(0);
    expect(screen.queryByRole('img')).toBeNull();
    expect(screen.getByRole('link', { name: 'View accident' })).toBeInTheDocument();
  });

  it('says so when a unit has no history, and offers a retry when the read fails', async () => {
    mocks.listAccidents.mockImplementation(pagedFrom([]));
    mocks.listViolations.mockImplementation(pagedFrom([]));
    const { unmount } = render();
    expect(await screen.findByText('Nothing recorded against unit 2701')).toBeVisible();
    unmount();

    mocks.listAccidents.mockRejectedValue(new Error('safety is unreachable'));
    mocks.listViolations.mockImplementation(pagedFrom([]));
    render();
    await waitFor(() =>
      expect(screen.getByText("Unable to load this unit's history")).toBeInTheDocument(),
    );
    expect(
      within(screen.getByRole('alert')).getByRole('button', { name: /try again/i }),
    ).toBeTruthy();
  });
});
