import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderPage } from '@/features/common/test-router';
import { setClockForTests } from '@/lib/clock';
import { LoadDetailPage } from './LoadDetailPage';

/**
 * The status tests read the load back after changing it, so the mocked store holds one mutable
 * copy rather than handing out a fresh clone of the seed each time. Nothing here writes the real
 * workspace: the persistence scheduler is mocked too.
 */
const mocks = vi.hoisted(() => ({
  updateLoad: vi.fn(),
  uploadLoadDocument: vi.fn(),
  cancelLoad: vi.fn(),
  addLoadNote: vi.fn(),
  pinLoadNote: vi.fn(),
  fetchLeadStatus: vi.fn(async () => ({ isLead: false })),
  apiPost: vi.fn(),
  state: { load: null as import('@/demo').Load | null },
}));
const {
  cancelLoad,
  addLoadNote,
  pinLoadNote,
  fetchLeadStatus,
  apiPost,
  state,
} = mocks;

// The event dialog speaks to the server directly; the server is the mock's word here.
vi.mock('@/lib/api-client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/api-client')>()),
  apiPost: (path: string, body: unknown) => mocks.apiPost(path, body),
}));

// The bytes go to the file store before the record is written; the store is not under test.
vi.mock('@/lib/files', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/files')>()),
  uploadFile: vi.fn(async (file: File) => ({
    id: 'file_test',
    url: '/api/v1/files/file_test',
    fileName: file.name,
    contentType: file.type,
    sizeBytes: file.size,
  })),
}));

vi.mock('@/demo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/demo')>();
  const hero = actual.demoData.loads.find((l) => l.loadNumber === actual.HERO_LOAD_NUMBER);
  const truck = actual.demoData.trucks.find((t) => t.id === hero?.truckId);
  const driver = actual.demoData.drivers.find((d) => d.id === hero?.driverId);
  mocks.state.load = structuredClone(hero) ?? null;
  return {
    ...actual,
    getLoad: vi.fn((idOrNumber: string) =>
      Promise.resolve(
        idOrNumber === actual.HERO_LOAD_NUMBER && mocks.state.load
          ? structuredClone(mocks.state.load)
          : null,
      ),
    ),
    getTruck: vi.fn(() => Promise.resolve(truck ? structuredClone(truck) : null)),
    getDriver: vi.fn(() => Promise.resolve(driver ? structuredClone(driver) : null)),
    updateLoad: (input: import('@/demo').UpdateLoadInput) => mocks.updateLoad(input),
    uploadLoadDocument: (input: import('@/demo').UploadLoadDocumentInput) =>
      mocks.uploadLoadDocument(input),
    // The per-record writes go to the server; here they are the mock's word.
    cancelLoad: (id: string, input: unknown) => mocks.cancelLoad(id, input),
    addLoadNote: (id: string, input: unknown) => mocks.addLoadNote(id, input),
    pinLoadNote: (id: string, noteId: string, pinned: boolean) =>
      mocks.pinLoadNote(id, noteId, pinned),
    fetchLeadStatus: () => mocks.fetchLeadStatus(),
  };
});

const ROUTE = { routePath: '/loads/$loadNumber' };

describe('LoadDetailPage', () => {
  it('renders the header, summary and stepper for the hero load', async () => {
    renderPage(<LoadDetailPage loadNumber="L-100245" />, { ...ROUTE, path: '/loads/L-100245' });

    expect(await screen.findByRole('heading', { level: 1, name: 'Load L-100245' })).toBeVisible();
    expect((await screen.findAllByText('In transit')).length).toBeGreaterThan(0);
    expect(screen.getByRole('button', { name: 'Record an event' })).toBeInTheDocument();

    const stops = await screen.findByRole('list', { name: 'Stops' });
    expect(stops).toHaveTextContent('Midwest Steel Partners – Chicago Plant');
    expect(stops).toHaveTextContent('Sunbelt Building Supply – Dallas DC');
    // The journey across the top narrates the load.
    expect(screen.getAllByText('Dispatched').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Delivered').length).toBeGreaterThan(0);

    // People and equipment links the truck to the fleet table.
    expect(await screen.findByRole('link', { name: 'Unit 2785' })).toHaveAttribute(
      'href',
      '/fleet/trucks?unit=2785',
    );
    expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true');
  });

  it('switches tabs and syncs the ?tab search param', async () => {
    const user = userEvent.setup();
    const { router } = renderPage(<LoadDetailPage loadNumber="L-100245" />, {
      ...ROUTE,
      path: '/loads/L-100245?tab=financial',
    });

    expect(await screen.findByRole('tab', { name: 'Financial' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(screen.getByText('Gross profit')).toBeInTheDocument();
    expect(screen.getByText('$1,050.00')).toBeInTheDocument();
    expect(screen.getAllByText('$2,500.00').length).toBeGreaterThan(0);

    await user.click(screen.getByRole('tab', { name: 'Notes' }));
    expect(await screen.findByRole('heading', { name: 'Add note' })).toBeInTheDocument();
    await waitFor(() => expect(router.state.location.search).toEqual({ tab: 'notes' }));
  });

  it('says how long ago the load was updated on the server clock, never "in N days" (P0.3)', async () => {
    const updatedAt = Date.parse(state.load!.updatedAt);
    setClockForTests(new Date(updatedAt + 3 * 60 * 60 * 1000));
    try {
      renderPage(<LoadDetailPage loadNumber="L-100245" />, { ...ROUTE, path: '/loads/L-100245' });
      await screen.findByRole('heading', { level: 1, name: 'Load L-100245' });
      expect(await screen.findByText('Updated 3 h ago')).toBeInTheDocument();
      expect(screen.queryByText(/^Updated in /)).not.toBeInTheDocument();
    } finally {
      setClockForTests(null);
    }
  });

  it('shows a designed empty state for an unknown load', async () => {
    renderPage(<LoadDetailPage loadNumber="L-000000" />, { ...ROUTE, path: '/loads/L-000000' });
    expect(await screen.findByText('Load not found')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to loads' })).toHaveAttribute('href', '/loads');
  });

  /**
   * Recording an event (rules 1.4 and 1.5).
   *
   * The dialog says what happened and when; the status follows through the server's rules. The
   * server is the mock's word here: what matters is what the screen sends and what it does with
   * the answer.
   */
  describe('record an event', () => {
    const pristine = () => structuredClone(state.load!);
    let seed: import('@/demo').Load;

    beforeEach(() => {
      seed ??= pristine();
      state.load = structuredClone(seed);
      apiPost.mockReset();
    });

    /** Opens the load page and the event dialog. */
    async function openDialog(user: ReturnType<typeof userEvent.setup>) {
      renderPage(<LoadDetailPage loadNumber="L-100245" />, { ...ROUTE, path: '/loads/L-100245' });
      await screen.findByRole('heading', { level: 1, name: 'Load L-100245' });
      await user.click(await screen.findByRole('button', { name: 'Record an event' }));
      return screen.findByRole('dialog');
    }

    /** Picks an option in the n-th combobox of the dialog. */
    async function choose(user: ReturnType<typeof userEvent.setup>, index: number, label: RegExp | string) {
      const dialog = screen.getByRole('dialog');
      await user.click(within(dialog).getAllByRole('combobox')[index]!);
      await user.click(await screen.findByRole('option', { name: label }));
    }

    it('records an arrival at the stop, in the stop\'s own clock, and the page shows what the server now holds', async () => {
      const user = userEvent.setup();
      const stop = seed.stops.find((s) => s.status !== 'completed')!;
      apiPost.mockImplementation(async (path: string, body: Record<string, unknown>) => {
        expect(path).toBe(`/loads/${seed.id}/stop-event`);
        const load = state.load!;
        load.status = 'at_delivery';
        load.updatedAt = new Date(Date.parse(load.updatedAt) + 1_000).toISOString();
        load.stops = load.stops.map((s) => (s.id === body.stopId ? { ...s, status: 'in_progress', arrivedAt: String(body.at) } : s));
        return { load: structuredClone(load) };
      });

      const dialog = await openDialog(user);
      await choose(user, 0, /^Arrived at (PU|delivery)$/);
      // The default stop is the next open one; the time is typed in that stop's zone.
      expect(within(dialog).getAllByRole('combobox')[1]).toHaveTextContent(stop.facilityName || stop.city);
      await user.click(within(dialog).getByRole('button', { name: 'Record' }));

      await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
      const body = apiPost.mock.calls[0]?.[1] as Record<string, unknown>;
      expect(body).toMatchObject({ stopId: stop.id, kind: 'arrived', zone: stop.timezone, expectedUpdatedAt: seed.updatedAt });
      expect(typeof body.at).toBe('string');

      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      await waitFor(() => expect(screen.getAllByText('At delivery').length).toBeGreaterThan(0));
    });

    it('keeps the dialog and shows what the server said when the write is refused', async () => {
      const user = userEvent.setup();
      apiPost.mockRejectedValue(new Error('L-100245 changed since you opened it. Reload the load and try again.'));

      const dialog = await openDialog(user);
      await choose(user, 0, /^Arrived at (PU|delivery)$/);
      await user.click(within(dialog).getByRole('button', { name: 'Record' }));

      await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
      expect(await within(screen.getByRole('dialog')).findByRole('alert')).toHaveTextContent('changed since you opened it');
      expect(state.load!.status).toBe('in_transit');
    });

    it('makes one write however many times Record is pressed', async () => {
      const user = userEvent.setup();
      let release: () => void = () => {};
      apiPost.mockImplementation(() => new Promise((resolve) => { release = () => resolve({ load: structuredClone(state.load!) }); }));

      const dialog = await openDialog(user);
      await choose(user, 0, /^Arrived at (PU|delivery)$/);
      const submit = within(dialog).getByRole('button', { name: 'Record' });
      await user.click(submit);
      await user.click(submit);
      await user.click(submit);

      expect(apiPost).toHaveBeenCalledTimes(1);
      release();
    });

    it('a check call goes to the check-call route with where the truck is, and moves nothing', async () => {
      const user = userEvent.setup();
      apiPost.mockImplementation(async () => ({ load: structuredClone(state.load!) }));

      const dialog = await openDialog(user);
      await choose(user, 0, 'Check call');
      await user.type(within(dialog).getByLabelText('Location'), 'I-80 near Des Moines, IA');
      await user.click(within(dialog).getByRole('button', { name: 'Record' }));

      await waitFor(() => expect(apiPost).toHaveBeenCalledTimes(1));
      expect(apiPost.mock.calls[0]?.[0]).toBe(`/loads/${seed.id}/check-call`);
      expect(apiPost.mock.calls[0]?.[1]).toMatchObject({ kind: 'check_call', location: 'I-80 near Des Moines, IA' });
      // Nothing in the dialog picks a status by hand.
      expect(screen.queryByRole('option', { name: 'At delivery' })).not.toBeInTheDocument();
    });

    it('Loaded belongs to a pickup: with a delivery chosen it cannot be recorded', async () => {
      const user = userEvent.setup();
      const delivery = seed.stops.find((s) => s.kind === 'delivery')!;

      const dialog = await openDialog(user);
      await choose(user, 0, 'Loaded (BOL)');
      await choose(user, 1, new RegExp(delivery.facilityName || delivery.city));
      expect(within(dialog).getByText('Loaded belongs to a pickup')).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Record' })).toBeDisabled();
      expect(apiPost).not.toHaveBeenCalled();
    });
  });

  describe('cancel (P0.1)', () => {
    const pristine = () => structuredClone(state.load!);
    let seed: import('@/demo').Load;

    beforeEach(() => {
      seed ??= pristine();
      state.load = structuredClone(seed);
      cancelLoad.mockReset();
      fetchLeadStatus.mockReset();
      fetchLeadStatus.mockImplementation(async () => ({ isLead: false }));
    });

    async function open(user: ReturnType<typeof userEvent.setup>) {
      renderPage(<LoadDetailPage loadNumber="L-100245" />, { ...ROUTE, path: '/loads/L-100245' });
      await screen.findByRole('heading', { level: 1, name: 'Load L-100245' });
      await user.click(await screen.findByRole('button', { name: 'More actions' }));
    }

    it('is not offered at all once the load is past the pickup; flagging still is', async () => {
      const user = userEvent.setup();
      state.load!.status = 'in_transit';
      await open(user);
      expect(await screen.findByRole('menuitem', { name: 'Flag load' })).toBeInTheDocument();
      expect(screen.queryByRole('menuitem', { name: /Cancel load/ })).not.toBeInTheDocument();
    });

    it('tells a dispatcher to ask a lead once the driver is dispatched, and sends nothing', async () => {
      const user = userEvent.setup();
      state.load!.status = 'dispatched';
      await open(user);
      await user.click(await screen.findByRole('menuitem', { name: 'Cancel load (lead only)' }));
      const dialog = await screen.findByRole('dialog');
      expect(
        within(dialog).getByText(/Only a dispatch lead can cancel it now/),
      ).toBeInTheDocument();
      expect(within(dialog).getByRole('button', { name: 'Cancel load' })).toBeDisabled();
      expect(cancelLoad).not.toHaveBeenCalled();
    });

    it('a lead cancels a dispatched load as a TONU with the fee, the reason and who asked', async () => {
      const user = userEvent.setup();
      state.load!.status = 'dispatched';
      fetchLeadStatus.mockImplementation(async () => ({ isLead: true }));
      cancelLoad.mockImplementation(async (_id: string, input: { outcome: string }) => {
        const load = state.load!;
        load.status = input.outcome as import('@/demo').Load['status'];
        load.driverId = null;
        load.driverName = null;
        load.updatedAt = new Date(Date.parse(load.updatedAt) + 1_000).toISOString();
        return structuredClone(load);
      });
      await open(user);
      await user.click(await screen.findByRole('menuitem', { name: 'Cancel load' }));
      const dialog = await screen.findByRole('dialog');
      await user.click(within(dialog).getByRole('radio', { name: /TONU/ }));
      await user.type(within(dialog).getByLabelText(/TONU fee/), '250');
      await user.type(within(dialog).getByLabelText(/Requested by/), 'TQL');
      await user.type(within(dialog).getByLabelText(/Approved by/), 'Dana at the broker');
      await user.type(within(dialog).getByLabelText(/Reason/), 'Shipper not ready');
      await user.click(within(dialog).getByRole('button', { name: 'Mark TONU' }));

      await waitFor(() => expect(cancelLoad).toHaveBeenCalledTimes(1));
      expect(cancelLoad).toHaveBeenCalledWith(seed.id, {
        approval: expect.objectContaining({ by: 'Dana at the broker', method: 'email' }),
        outcome: 'tonu',
        reason: 'Shipper not ready',
        requestedBy: 'TQL',
        fee: 250,
      });
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      expect((await screen.findAllByText('TONU')).length).toBeGreaterThan(0);
    });

    it('a cancel needs a reason and who asked; the TONU fee may be zero but not blank', async () => {
      const user = userEvent.setup();
      state.load!.status = 'assigned';
      await open(user);
      await user.click(await screen.findByRole('menuitem', { name: 'Cancel load' }));
      const dialog = await screen.findByRole('dialog');
      const submit = () => within(dialog).getByRole('button', { name: /Cancel load|Mark TONU/ });
      expect(submit()).toBeDisabled();
      await user.type(within(dialog).getByLabelText(/Requested by/), 'Us');
      await user.type(within(dialog).getByLabelText(/Approved by/), 'Dana at the broker');
      await user.type(within(dialog).getByLabelText(/Reason/), 'Booked twice');
      expect(submit()).toBeEnabled();
      await user.click(within(dialog).getByRole('radio', { name: /TONU/ }));
      expect(submit()).toBeDisabled();
      await user.type(within(dialog).getByLabelText(/TONU fee/), '0');
      expect(submit()).toBeEnabled();
    });

    it('keeps the dialog and shows what the server said when the write is refused', async () => {
      const user = userEvent.setup();
      state.load!.status = 'assigned';
      cancelLoad.mockRejectedValue(
        new Error('L-100245 changed since you opened it. Reload the load and try again.'),
      );
      await open(user);
      await user.click(await screen.findByRole('menuitem', { name: 'Cancel load' }));
      const dialog = await screen.findByRole('dialog');
      await user.type(within(dialog).getByLabelText(/Requested by/), 'Us');
      await user.type(within(dialog).getByLabelText(/Approved by/), 'Dana at the broker');
      await user.type(within(dialog).getByLabelText(/Reason/), 'Booked twice');
      await user.click(within(dialog).getByRole('button', { name: 'Cancel load' }));
      expect(await within(dialog).findByRole('alert')).toHaveTextContent(
        /changed since you opened it/,
      );
      expect(screen.getByRole('dialog')).toBeInTheDocument();
    });
  });

  describe('notes (P0.1)', () => {
    const pristine = () => structuredClone(state.load!);
    let seed: import('@/demo').Load;

    beforeEach(() => {
      seed ??= pristine();
      state.load = structuredClone(seed);
      addLoadNote.mockReset();
      pinLoadNote.mockReset();
    });

    it('posts the note through the server as the signed-in person, pinned when asked, and shows it once it lands', async () => {
      const user = userEvent.setup();
      addLoadNote.mockImplementation(
        async (_id: string, input: { body: string; pinned: boolean; kind: string }) => {
          const load = state.load!;
          load.notes.push({
            id: 'note_server_1',
            kind: 'internal',
            body: input.body,
            authorName: 'Signed-in Person',
            // Now, not a fixed day: the demo's pinned note is dated relative to today and would
            // otherwise outrank this one once the calendar passed the fixture.
            at: new Date().toISOString(),
            pinned: input.pinned,
          });
          load.updatedAt = '2026-09-18T14:00:00.000Z';
          return structuredClone(load);
        },
      );
      renderPage(<LoadDetailPage loadNumber="L-100245" />, {
        ...ROUTE,
        path: '/loads/L-100245?tab=notes',
      });
      await screen.findByRole('heading', { name: 'Add note' });
      const before = state.load!.notes.length;
      await user.type(screen.getByLabelText('Note'), 'Shipper opens at 7');
      await user.click(screen.getByRole('checkbox', { name: /Pin to the top/ }));
      const form = screen.getByLabelText('Note').closest('form')!;
      await user.click(within(form).getByRole('button', { name: 'Add note' }));

      await waitFor(() => expect(addLoadNote).toHaveBeenCalledTimes(1));
      expect(addLoadNote).toHaveBeenCalledWith(seed.id, {
        kind: 'internal',
        body: 'Shipper opens at 7',
        pinned: true,
      });
      const list = await screen.findByRole('list', { name: 'Notes' });
      await waitFor(() => expect(within(list).getAllByRole('listitem')).toHaveLength(before + 1));
      // Pinned first: the new note is at the top, by the person the server named.
      const first = within(list).getAllByRole('listitem')[0]!;
      expect(first).toHaveTextContent('Signed-in Person');
      expect(first).toHaveTextContent('Shipper opens at 7');
      expect(first).toHaveTextContent('Pinned');
      expect(screen.getByLabelText('Note')).toHaveValue('');
    });

    it('unpins through the server, never locally', async () => {
      const user = userEvent.setup();
      const target = state.load!.notes[0]!;
      target.pinned = true;
      pinLoadNote.mockImplementation(async (_id: string, noteId: string, pinned: boolean) => {
        const note = state.load!.notes.find((n) => n.id === noteId)!;
        note.pinned = pinned;
        return structuredClone(state.load!);
      });
      renderPage(<LoadDetailPage loadNumber="L-100245" />, {
        ...ROUTE,
        path: '/loads/L-100245?tab=notes',
      });
      const list = await screen.findByRole('list', { name: 'Notes' });
      await user.click(
        within(list).getByRole('button', { name: `Unpin note by ${target.authorName}` }),
      );
      await waitFor(() => expect(pinLoadNote).toHaveBeenCalledWith(seed.id, target.id, false));
      await waitFor(() =>
        expect(
          within(list).queryByRole('button', { name: `Unpin note by ${target.authorName}` }),
        ).not.toBeInTheDocument(),
      );
    });
  });
});

describe('a load with a POD per delivery', () => {
  // The owner's case: a two-stop load, both PODs filed and on the timeline, one on Documents.
  it('lists every POD, not only the first one filed', async () => {
    const before = structuredClone(state.load!);
    const delivery = state.load!.stops.find((st) => st.kind === 'delivery')!;
    const pod = (id: string, fileName: string, at: string, stopId?: string) => ({
      id, type: 'pod' as const, title: 'pod', fileName, sizeBytes: 684_000, uploadedAt: at, uploadedBy: 'System Administrator',
      status: 'pending' as const, fileUrl: `/api/v1/files/${id}`, ...(stopId ? { stopId } : {}),
    });
    state.load!.documents = [
      ...state.load!.documents.filter((d) => d.type !== 'pod'),
      pod('doc_pod_1', 'CamScanner 9-28-26 13.55.pdf', '2026-09-29T11:59:00Z', delivery.id),
      pod('doc_pod_2', 'photo_2026-09-28_18-10-56.jpg', '2026-09-29T12:01:00Z'),
    ] as typeof state.load.documents;
    try {
      renderPage(<LoadDetailPage loadNumber="L-100245" />, { ...ROUTE, path: '/loads/L-100245?tab=documents' });
      expect(await screen.findByText(/CamScanner 9-28-26 13\.55\.pdf/)).toBeInTheDocument();
      expect(screen.getByText(/photo_2026-09-28_18-10-56\.jpg/)).toBeInTheDocument();
      // The one filed against a stop says which stop; the other says which of the two it is.
      expect(screen.getByText(`pod · ${delivery.facilityName?.trim() || `${delivery.city}, ${delivery.state}`}`)).toBeInTheDocument();
      expect(screen.getByText('pod · 2 of 2')).toBeInTheDocument();
    } finally {
      state.load = before;
    }
  });
});
