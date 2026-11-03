import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ExternalLink, Upload, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState } from 'react';
import { boardLoadLabel, type DailyBoardRow } from '@neway/shared';
import { Button, StatusSymbol, cn, useToast } from '@/design-system';
import { apiGet, apiPost } from '@/lib/api-client';
import { uploadFile } from '@/lib/files';
import { formatIsoDate } from '@/lib/format';

/**
 * Finishing the work a board status implies, without leaving the board.
 *
 * Four of the fourteen board words are statements about freight: DISPATCHED, ENROUTE, UNLOADING
 * and the READY that follows a delivery. Each one needs something from the person before it is
 * true - a time in the receiver's clock, the POD - and each one, once saved, moves the load and
 * the board together in one server call. The other ten words are the board's own business and
 * never reach this panel.
 *
 * Two rules it keeps without being told twice: cancelling changes nothing anywhere, and a failed
 * save leaves both the load and the row exactly as they were, with what was typed still on
 * screen.
 */

type LoadRecord = {
  id: string;
  loadNumber: string;
  /** The broker's reference, shown before the load number on the boards. */
  brokerReference?: string | null;
  status: string;
  updatedAt: string;
  stops: {
    id: string;
    kind: 'pickup' | 'delivery';
    sequence: number;
    facilityName: string;
    city: string;
    state: string;
    timezone: string;
    status: string;
    arrivedAt: string | null;
    departedAt: string | null;
    loadedAt?: string | null;
    appointmentStartAt: string;
    appointmentEndAt: string;
  }[];
  documents: { id: string; type: string; status: string; review?: string; fileName: string; uploadedAt: string }[];
};

export interface PendingStatus {
  row: DailyBoardRow;
  status: string;
  /** The load this word is about: the one being run, or the one being dispatched. */
  load: DailyBoardRow['primaryLoad'];
}

/** The paper each step of the company's own sequence asks for. */
type Paper = 'rate_confirmation' | 'bol' | 'pod';

const PAPER_LABEL: Record<Paper, string> = {
  rate_confirmation: 'Rate confirmation',
  bol: 'Bill of lading',
  pod: 'Proof of delivery',
};

/**
 * Whether that paper is already on file.
 *
 * The POD is asked per stop, because a two-delivery load is signed for twice; a POD filed before
 * stops carried an id still counts for a load with one delivery. The RC and the BOL are the
 * load's, not a stop's.
 */
function onFile(load: LoadRecord, paper: Paper, stopId: string | null): boolean {
  return load.documents.some((d) => {
    if (d.type !== paper) return false;
    if (d.status === 'missing' || d.fileName.trim() === '') return false;
    if (paper !== 'pod' || !stopId) return true;
    const own = (d as { stopId?: string | null }).stopId;
    if (own) return own === stopId;
    // A POD with no stop on it belongs to the delivery, as long as there is only one.
    return load.stops.filter((x) => x.kind === 'delivery').length === 1;
  });
}

/**
 * What the chosen board word asks the load to do - the sequence this company runs:
 *
 * READY → DISPATCHED (rate confirmation) → ENROUTE (bill of lading) → UNLOADING (the truck has
 * arrived and is unloading) → ENROUTE again for the next stop, or READY when that was the last
 * one. A paper already on file is never asked for twice.
 *
 * **The POD is asked for on the way OUT of UNLOADING, not into it.** A proof of delivery is proof
 * the freight was handed over; while the truck is still on the dock there is nothing to prove yet,
 * and asking then either stops a dispatcher who is only recording an arrival or trains them to
 * upload whatever is nearest. So: UNLOADING records the arrival and asks for no paper, and the
 * POD is required at the move that ends that stop — ENROUTE when another delivery follows, READY
 * when it does not.
 */
export function planFor(status: string, load: LoadRecord | null) {
  if (!load) return null;
  const pickups = load.stops.filter((s) => s.kind === 'pickup');
  const deliveries = load.stops.filter((s) => s.kind === 'delivery');
  const openDeliveries = deliveries.filter((s) => s.status !== 'completed');
  /** The stop the truck is standing on right now: the one UNLOADING opened. */
  const unloadingNow = openDeliveries.find((s) => s.status === 'in_progress') ?? null;

  if (status === 'DISPATCHED') {
    /*
     * DISPATCHED says two different things on this board: the truck is running to the shipper,
     * or it is already sitting on it. The load tells them apart - `dispatched` against
     * `at_pickup` - and the ETA column reads the difference: a time while they are running, the
     * words AT PU once they are there.
     */
    return {
      kind: 'status' as const,
      title: 'Dispatch this load',
      stop: null,
      paper: 'rate_confirmation' as Paper,
      timeLabel: null,
      asksWhere: true,
    };
  }

  if (status === 'ENROUTE') {
    const pickup = pickups.find((s) => s.status !== 'completed') ?? null;
    if (pickup) {
      /*
       * Two things happen here and they are kept apart (rule 1.5): the BOL makes the load Loaded,
       * at the time the truck was on the dock; the departure makes it In transit, at the time it
       * rolled. A load already Loaded needs no paper - only the departure.
       */
      return {
        kind: 'departed' as const,
        title: 'Left the shipper',
        stop: pickup,
        paper: pickup.loadedAt ? null : ('bol' as Paper),
        confirm: pickup.loadedAt ? null : ('mark_loaded' as const),
        timeLabel: 'Departed',
        asksWhere: false,
      };
    }
    /*
     * Rolling off a delivery: this is the move that finishes the stop the truck was unloading at,
     * so it is where the POD is asked for. Only a stop actually in progress qualifies — ENROUTE
     * between two deliveries the truck has not reached yet finishes nothing.
     */
    if (unloadingNow) {
      const toGo = openDeliveries.length - 1;
      return {
        kind: 'departed' as const,
        title: toGo > 0 ? `Finish this stop, ${toGo} to go` : 'Finish the delivery',
        stop: unloadingNow,
        paper: 'pod' as Paper,
        // The POD's confirmation completes this stop at the arrival on record - never the upload.
        confirm: 'mark_delivered' as const,
        timeLabel: 'Checked out',
        asksWhere: false,
      };
    }
    // The freight is already on and no stop is open: ENROUTE means running, and the load has
    // nothing left to record.
    return null;
  }

  if (status === 'UNLOADING') {
    // Arriving at the next delivery. No paper: nothing has been delivered yet.
    const stop = openDeliveries.find((s) => s.status !== 'in_progress') ?? null;
    if (!stop) return null;
    const left = openDeliveries.length;
    return {
      kind: 'arrived' as const,
      title: left > 1 ? `On the dock, ${left} deliveries to go` : 'On the dock',
      stop,
      paper: null,
      timeLabel: 'Checked in',
      asksWhere: false,
    };
  }

  if (status === 'READY') {
    /*
     * The truck is empty, which means the last delivery is done. If one is still open the POD is
     * asked for here — including when the driver never said UNLOADING, because the paperwork is
     * owed either way and this is the last moment to ask for it.
     */
    const stop = unloadingNow ?? openDeliveries[0] ?? null;
    if (!stop) return null;
    return {
      kind: 'departed' as const,
      title: 'Finish the delivery',
      stop,
      paper: 'pod' as Paper,
      confirm: 'mark_delivered' as const,
      timeLabel: 'Checked out',
      asksWhere: false,
    };
  }

  return null;
}

/** `2026-09-24T18:42` in the stop's zone, for the two inputs. */
function localParts(iso: string, zone: string): { date: string; time: string } {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: zone,
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', hour12: false,
    });
    const parts = Object.fromEntries(fmt.formatToParts(new Date(iso)).map((p) => [p.type, p.value]));
    return { date: `${parts.year}-${parts.month}-${parts.day}`, time: `${parts.hour}:${parts.minute}` };
  } catch {
    return { date: '', time: '' };
  }
}

/** The instant a local date and time mean in that zone. */
function instantFrom(date: string, time: string, zone: string): string | null {
  if (!date || !time) return null;
  const guess = new Date(`${date}T${time}:00Z`).getTime();
  if (Number.isNaN(guess)) return null;
  // Two passes: the offset at the guessed instant, then the corrected one.
  let ms = guess;
  for (let i = 0; i < 2; i += 1) {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    });
    const p = Object.fromEntries(fmt.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
    const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour) % 24, Number(p.minute), Number(p.second));
    ms += guess - asUtc;
  }
  return new Date(ms).toISOString();
}

export function StatusActionPanel({
  pending,
  onCancel,
  onPlainStatus,
  onDone,
}: {
  pending: PendingStatus;
  onCancel: () => void;
  /** The board word needs nothing from the load: write the cell the way the board always did. */
  onPlainStatus: (row: DailyBoardRow, status: string) => void;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const loadRef = pending.load ?? pending.row.primaryLoad;

  /*
   * Always the load as it stands, never a cached copy.
   *
   * The panel decides which stop is next and whether the POD is still wanted; a copy from before
   * the last save would ask for the wrong stop. It refetches on every open and shows nothing
   * until the answer is in.
   */
  const load = useQuery({
    queryKey: ['load', loadRef?.id],
    queryFn: () => apiGet<LoadRecord>(`/loads/${loadRef!.id}`),
    enabled: Boolean(loadRef),
    staleTime: 0,
    gcTime: 0,
    refetchOnMount: 'always',
  });
  const reading = load.isPending || load.isFetching;

  const plan = useMemo(() => planFor(pending.status, load.data ?? null), [pending.status, load.data]);
  const stop = plan?.kind === 'status' ? null : (plan?.stop ?? null);
  const zone = stop?.timezone ?? '';
  const now = useMemo(() => new Date().toISOString(), []);
  const initial = useMemo(() => (zone ? localParts(now, zone) : { date: '', time: '' }), [now, zone]);

  /*
   * The default time arrives with the load, not with the first render: the stop's zone is not
   * known until the record is read, and a time typed against the wrong zone is the one mistake
   * this panel exists to prevent. `touched` keeps a person's own typing from being overwritten.
   */
  const [date, setDate] = useState('');
  const [time, setTime] = useState('');
  const [touched, setTouched] = useState(false);
  useEffect(() => {
    if (touched || !zone) return;
    setDate(initial.date);
    setTime(initial.time);
  }, [initial.date, initial.time, touched, zone]);
  const [note, setNote] = useState('');
  /** Where the truck is: running to the shipper, or standing on it. */
  const [where, setWhere] = useState<'going' | 'at'>('going');
  const [file, setFile] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const paper = plan?.paper ?? null;
  const paperOnFile = load.data && paper ? onFile(load.data, paper, stop?.id ?? null) : false;
  const paperNeeded = Boolean(paper) && !paperOnFile;

  const save = useMutation({
    mutationFn: async () => {
      const record = load.data;
      if (!record || !plan) throw new Error('That load could not be read.');

      /*
       * The POD first. If the upload fails the load has not moved and the panel stays open with
       * the times still typed - only the file is retried.
       */
      let expectedUpdatedAt = record.updatedAt;
      if (paperNeeded && paper) {
        if (!file) throw new Error(`The ${PAPER_LABEL[paper].toLowerCase()} is needed for this step.`);
        const stored = await uploadFile(file);
        const filed = await apiPost<{ load: { updatedAt: string } }>(`/loads/${record.id}/documents`, {
          type: paper,
          stopId: paper === 'pod' ? (stop?.id ?? null) : null,
          fileName: file.name,
          sizeBytes: file.size,
          mimeType: file.type || 'application/pdf',
          fileUrl: stored.url,
          fileId: stored.id,
          expectedUpdatedAt,
        });
        // The load moved when the paper was filed; what follows carries that version, not the
        // one the panel opened with.
        expectedUpdatedAt = filed.load.updatedAt;
      }

      /*
       * What the paper proves, confirmed as its own write through the server's rules: a BOL makes
       * the load Loaded at the pickup's recorded arrival (the time typed here is the departure, a
       * separate thing); a POD completes this delivery at its recorded arrival, and a non-final
       * one sends the load back in transit. Neither ever uses the upload time.
       */
      const confirm = 'confirm' in plan ? plan.confirm : null;
      if (confirm && stop) {
        const at =
          confirm === 'mark_loaded'
            ? (stop.arrivedAt ?? instantFrom(date, time, zone) ?? new Date().toISOString())
            : (stop.arrivedAt ?? instantFrom(date, time, zone) ?? new Date().toISOString());
        const confirmed = await apiPost<{ load: { updatedAt: string; stops: { id: string; status: string }[] } }>(
          `/loads/${record.id}/confirm`,
          { kind: confirm, stopId: stop.id, at, boardStatus: pending.status, expectedUpdatedAt },
        );
        expectedUpdatedAt = confirmed.load.updatedAt;
        // A confirmed POD has completed the stop and moved the board word with it; there is no
        // departure left to record. A confirmed BOL still has the departure to come, below.
        if (confirm === 'mark_delivered') return confirmed;
      }

      if (plan.kind === 'status') {
        /*
         * The load walks the steps its own rules allow: assigned → dispatched → at pickup. A
         * load already standing where the person says it is needs no write at all, and one that
         * is further along is never dragged backwards from here - that is a correction, and a
         * correction takes a lead.
         */
        const order = ['booked', 'assigned', 'dispatched', 'at_pickup'];
        const target = where === 'at' ? 'at_pickup' : 'dispatched';
        const from = order.indexOf(record.status);
        const to = order.indexOf(target);
        if (from === -1 || to === -1 || to <= from) {
          /*
           * The load is already where the person says it is - or further along, which is a
           * correction and not this panel's business. The board word is the whole change, and it
           * goes through the board's own write.
           */
          onPlainStatus(pending.row, pending.status);
          return null;
        }
        let last: unknown = null;
        for (const step of order.slice(from + 1, to + 1)) {
          const res = await apiPost<{ load: { updatedAt: string } }>(`/loads/${record.id}/status`, {
            status: step,
            boardStatus: pending.status,
            expectedUpdatedAt,
            bypassPaperwork: false,
            note: step === target ? note.trim() || undefined : undefined,
          });
          expectedUpdatedAt = res.load.updatedAt;
          last = res;
        }
        return last;
      }

      if (!stop) throw new Error('That stop is no longer on the load.');
      if (!zone) throw new Error('This stop has no time zone. Add the city and state on the load first.');
      const at = instantFrom(date, time, zone);
      if (!at) throw new Error('Give the date and the time.');
      return apiPost(`/loads/${record.id}/stop-event`, {
        stopId: stop.id,
        kind: plan.kind,
        at,
        zone,
        note: note.trim() || undefined,
        boardStatus: pending.status,
        expectedUpdatedAt,
      });
    },
    onSuccess: async () => {
      toast({ tone: 'success', title: 'Saved', description: 'The load and the board moved together.' });
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['dispatch-board'] }),
        queryClient.invalidateQueries({ queryKey: ['load'] }),
        queryClient.invalidateQueries({ queryKey: ['loads'] }),
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
      ]);
      onDone();
    },
    onError: (e: unknown) => {
      // Nothing is closed and nothing is cleared: the person fixes one thing and saves again.
      setError(e instanceof Error ? e.message : 'That did not save. Nothing was changed.');
    },
  });

  const title = plan?.title ?? `Set ${pending.status}`;

  return (
    <aside
      aria-label="Finish this status"
      className="flex w-[340px] shrink-0 flex-col border-l-2 border-nw-border-strong bg-nw-panel"
    >
      <header className="flex items-start justify-between gap-2 border-b border-nw-border px-4 py-3">
        <div className="min-w-0">
          <h2 className="text-[13.5px] font-extrabold text-nw-text">{title}</h2>
          <p className="truncate text-[11.5px] text-nw-text-3">
            {pending.row.driverName}
            {loadRef ? (
              <>
                {' · '}
                <Link to="/loads/$loadNumber" params={{ loadNumber: loadRef.loadNumber }} className="font-semibold text-(--bd-blue) hover:underline">
                  {boardLoadLabel(loadRef)}
                </Link>
              </>
            ) : null}
          </p>
          {stop ? (
            <p className="truncate text-[11.5px] text-nw-text-3">
              {stop.facilityName || `${stop.city}, ${stop.state}`} · stop{' '}
              {(load.data?.stops.findIndex((s) => s.id === stop.id) ?? 0) + 1} of {load.data?.stops.length}
            </p>
          ) : null}
        </div>
        <button type="button" aria-label="Close" onClick={onCancel} className="grid size-6 place-items-center rounded text-nw-text-3 hover:bg-nw-hover">
          <X className="size-4" aria-hidden />
        </button>
      </header>

      <div className="flex flex-1 flex-col gap-3 overflow-auto px-4 py-3">
        {!loadRef ? (
          <>
            <p className="text-[12.5px] text-nw-text-2">
              {pending.row.driverName} has no live load, so this word is the board's own. Nothing in Loads changes.
            </p>
            <Button onClick={() => onPlainStatus(pending.row, pending.status)}>Set {pending.status}</Button>
          </>
        ) : reading ? (
          <p className="text-[12.5px] text-nw-text-3">Reading the load…</p>
        ) : load.isError ? (
          <p className="text-[12.5px] text-nw-urgent-text">That load could not be read. Nothing has been changed.</p>
        ) : !plan ? (
          <>
            <p className="text-[12.5px] text-nw-text-2">
              {pending.status === 'READY'
                ? `${loadRef.loadNumber} needs nothing here: READY says the truck is empty and free.`
                : `${loadRef.loadNumber} has nothing left to record at this step - the freight is already on.`}
            </p>
            <Button onClick={() => onPlainStatus(pending.row, pending.status)}>Set {pending.status}</Button>
          </>
        ) : (
          <>
            {plan.kind !== 'status' && stop ? (
              <>
                <div>
                  <label className="mb-1 block text-[11px] font-bold tracking-[.02em] text-nw-text-3 uppercase">
                    {plan.timeLabel} <span className="text-nw-urgent-text">*</span>
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <input
                      type="date"
                      value={date}
                      onChange={(e) => { setTouched(true); setDate(e.target.value); }}
                      className="h-8 rounded-md border border-nw-border-strong bg-nw-panel px-2 text-[12.5px] text-nw-text"
                    />
                    <input
                      type="time"
                      value={time}
                      onChange={(e) => { setTouched(true); setTime(e.target.value); }}
                      className="h-8 rounded-md border border-nw-border-strong bg-nw-panel px-2 text-[12.5px] text-nw-text"
                    />
                  </div>
                  <p className="mt-1 text-[11px] text-nw-text-3">
                    {zone ? (
                      <>
                        {zone.replace('America/', '')} — the stop's own clock, not yours.
                        {stop.arrivedAt ? ` Arrived ${formatIsoDate(stop.arrivedAt)}.` : ''}
                      </>
                    ) : (
                      <span className="font-semibold text-nw-urgent-text">
                        This stop has no time zone. Add its city and state on the load first.
                      </span>
                    )}
                  </p>
                </div>

                {paper ? (
                  paperOnFile ? (
                    <p className="flex items-center gap-1.5 rounded-md bg-nw-done-bg px-2.5 py-1.5 text-[11.5px] font-semibold text-nw-done-text">
                      <StatusSymbol family="done" size={12} className="text-nw-done-icon" />
                      {PAPER_LABEL[paper]} already on file — not asked for again.
                    </p>
                  ) : (
                    <div>
                      <label className="mb-1 block text-[11px] font-bold tracking-[.02em] text-nw-text-3 uppercase">
                        {PAPER_LABEL[paper]} <span className="text-nw-urgent-text">*</span>
                      </label>
                      <input
                        ref={fileInput}
                        type="file"
                        accept="application/pdf,image/*"
                        className="hidden"
                        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                      />
                      <button
                        type="button"
                        onClick={() => fileInput.current?.click()}
                        className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-nw-border-strong px-3 py-3 text-[12px] text-nw-text-2 hover:bg-nw-hover"
                      >
                        <Upload className="size-3.5" aria-hidden />
                        {file ? file.name : `Drop the ${PAPER_LABEL[paper].toLowerCase()} or browse`}
                      </button>
                    </div>
                  )
                ) : null}
              </>
            ) : (
              <>
                <p className="text-[12.5px] text-nw-text-2">
                  {loadRef.loadNumber}: {loadRef.origin} → {loadRef.destination}.
                </p>
                {plan.asksWhere ? (
                  <div>
                    <label className="mb-1 block text-[11px] font-bold tracking-[.02em] text-nw-text-3 uppercase">
                      Where is the truck? <span className="text-nw-urgent-text">*</span>
                    </label>
                    <div role="radiogroup" aria-label="Where is the truck" className="flex gap-2">
                      <button
                        type="button"
                        role="radio"
                        aria-checked={where === 'going'}
                        onClick={() => setWhere('going')}
                        className={cn(
                          'h-8 flex-1 rounded-md border px-2 text-[12px] font-bold',
                          where === 'going'
                            ? 'border-nw-accent bg-nw-accent-tint text-nw-accent-ink'
                            : 'border-nw-border bg-nw-panel text-nw-text-2 hover:bg-nw-hover',
                        )}
                      >
                        Going to PU
                      </button>
                      <button
                        type="button"
                        role="radio"
                        aria-checked={where === 'at'}
                        onClick={() => setWhere('at')}
                        className={cn(
                          'h-8 flex-1 rounded-md border px-2 text-[12px] font-bold',
                          where === 'at'
                            ? 'border-nw-accent bg-nw-accent-tint text-nw-accent-ink'
                            : 'border-nw-border bg-nw-panel text-nw-text-2 hover:bg-nw-hover',
                        )}
                      >
                        AT PU
                      </button>
                    </div>
                    <p className="mt-1 text-[11px] text-nw-text-3">
                      {where === 'at'
                        ? 'The ETA column reads AT PU while the truck is on the shipper.'
                        : 'The ETA column keeps the pickup appointment time.'}
                    </p>
                  </div>
                ) : null}
                {paper ? (
                  paperOnFile ? (
                    <p className="flex items-center gap-1.5 rounded-md bg-nw-done-bg px-2.5 py-1.5 text-[11.5px] font-semibold text-nw-done-text">
                      <StatusSymbol family="done" size={12} className="text-nw-done-icon" />
                      {PAPER_LABEL[paper]} already on file — not asked for again.
                    </p>
                  ) : (
                    <div>
                      <label className="mb-1 block text-[11px] font-bold tracking-[.02em] text-nw-text-3 uppercase">
                        {PAPER_LABEL[paper]} <span className="text-nw-urgent-text">*</span>
                      </label>
                      <input
                        ref={fileInput}
                        type="file"
                        accept="application/pdf,image/*"
                        className="hidden"
                        onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                      />
                      <button
                        type="button"
                        onClick={() => fileInput.current?.click()}
                        className="flex w-full items-center justify-center gap-2 rounded-md border border-dashed border-nw-border-strong px-3 py-3 text-[12px] text-nw-text-2 hover:bg-nw-hover"
                      >
                        <Upload className="size-3.5" aria-hidden />
                        {file ? file.name : `Drop the ${PAPER_LABEL[paper].toLowerCase()} or browse`}
                      </button>
                    </div>
                  )
                ) : null}
              </>
            )}

            <div>
              <label className="mb-1 block text-[11px] font-bold tracking-[.02em] text-nw-text-3 uppercase">Note</label>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="A line for the next shift…"
                className="h-8 w-full rounded-md border border-nw-border-strong bg-nw-panel px-2 text-[12.5px] text-nw-text"
              />
            </div>

            {error ? (
              <p className="rounded-md bg-nw-urgent-bg px-2.5 py-2 text-[11.5px] font-semibold text-nw-urgent-text">{error}</p>
            ) : null}

            <p className="text-[11px] text-nw-text-3">
              On save: the stop, the load and {pending.row.driverName.split(' ')[0]}'s board row move together. Cancel
              changes nothing.
            </p>
          </>
        )}
      </div>

      <footer className="flex items-center gap-2 border-t border-nw-border px-4 py-3">
        <Button variant="secondary" className="flex-1" onClick={onCancel} disabled={save.isPending}>
          Cancel
        </Button>
        {loadRef && plan ? (
          <Button
            className="flex-1"
            loading={save.isPending}
            disabled={reading || save.isPending || (plan.kind !== 'status' && (!date || !time || !zone)) || (paperNeeded && !file)}
            onClick={() => {
              setError(null);
              save.mutate();
            }}
          >
            Save
          </Button>
        ) : null}
      </footer>

      {loadRef ? (
        <Link
          to="/loads/$loadNumber"
          params={{ loadNumber: loadRef.loadNumber }}
          className={cn('flex items-center justify-center gap-1.5 border-t border-nw-border px-4 py-2 text-[11.5px] font-semibold text-nw-text-2 hover:bg-nw-hover')}
        >
          Open the full load <ExternalLink className="size-3" aria-hidden />
        </Link>
      ) : null}
    </aside>
  );
}
