import { useRef, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { HOME_ZONE, formatInstant, instantFromLocal, localParts, zoneAbbreviation } from '@neway/shared';
import { demoCurrentUser, getLoad, updateLoad, uploadLoadDocument, type Load } from '@/demo';
import { Alert, Button, FormField, Input, Modal, Select, Textarea, useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { apiPost } from '@/lib/api-client';
import { useEagerUpload } from '@/lib/files';
import { now as clockNow } from '@/lib/clock';
import { FileDropzone } from '@/features/fleet/components/FileDropzone';

const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
const UPLOAD_ACCEPT = 'application/pdf,image/png,image/jpeg,image/webp';

type EventKind = 'arrived' | 'loaded' | 'departed' | 'check_call' | 'eta_changed';

const EVENTS: { value: EventKind; label: string; hint: string }[] = [
  { value: 'arrived', label: 'Arrived at a stop', hint: 'The truck is on the property. A delivery becomes Unloading.' },
  { value: 'loaded', label: 'Loaded (BOL)', hint: 'The freight is on. The load becomes Loaded; it is In transit only when it leaves.' },
  { value: 'departed', label: 'Departed a stop', hint: 'The truck left. A pickup becomes In transit; the last delivery completes the load.' },
  { value: 'check_call', label: 'Check call', hint: 'The driver was heard from. Resets the update clock; nothing moves.' },
  { value: 'eta_changed', label: 'ETA changed', hint: 'A new ETA for the next stop, in your words. Nothing moves.' },
];

/**
 * Recording an event on a load (rules 1.4 and 1.5), from the load page.
 *
 * The person says what happened, at which stop, and when - in the stop's own clock, with the
 * Eastern time shown beside it. The status follows the event through the same server rules the
 * Daily Board uses; nothing here picks a status by hand.
 */
export function RecordEventDialog({
  load,
  open,
  onOpenChange,
  initial,
}: {
  load: Load;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** What the button that opened it was about, so the person only confirms. */
  initial?: { kind?: 'arrived' | 'loaded' | 'departed' | 'check_call' | 'eta_changed'; stopId?: string };
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const account = useAccount();
  const nowIso = clockNow().toISOString();

  const openStops = load.stops.filter((s) => s.status !== 'completed');
  const defaultStop = openStops[0] ?? load.stops.at(-1) ?? null;
  const [kind, setKind] = useState<EventKind>(
    initial?.kind ?? (defaultStop?.status === 'in_progress' ? (defaultStop.kind === 'pickup' ? 'loaded' : 'departed') : 'arrived'),
  );
  const [stopId, setStopId] = useState<string>(initial?.stopId ?? defaultStop?.id ?? '');
  const stop = load.stops.find((s) => s.id === stopId) ?? null;
  const zone = stop?.timezone || HOME_ZONE;
  // Prefilled with now in the stop's clock; the person corrects it to when it actually happened.
  const [clock] = useState(() => localParts(nowIso, zone) ?? { date: '', time: '' });
  const [date, setDate] = useState(clock.date);
  const [time, setTime] = useState(clock.time);
  const [etaDate, setEtaDate] = useState(clock.date);
  const [etaTime, setEtaTime] = useState(clock.time);
  const [location, setLocation] = useState('');
  const [pieces, setPieces] = useState(load.pieces ? String(load.pieces) : '');
  const [weight, setWeight] = useState(load.weightLbs ? String(load.weightLbs) : '');
  const [note, setNote] = useState('');
  const [bol, setBolFile] = useState<File | null>(null);
  const early = useEagerUpload();
  const setBol = (file: File | null) => {
    setBolFile(file);
    early.start(file);
  };
  const fileRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);

  const at = instantFromLocal(date, time, zone);
  const etaAt = instantFromLocal(etaDate, etaTime, zone);
  const eastern = at ? formatInstant(at, HOME_ZONE).text : null;
  const zoneName = (() => {
    try {
      return zoneAbbreviation(at ? new Date(at) : new Date(), zone);
    } catch {
      return zone;
    }
  })();

  // The arrival says where (owner, 2026-10-13): "Arrived at PU" at a pickup.
  const events = EVENTS.map((e) =>
    e.value === 'arrived' ? { ...e, label: stop?.kind === 'delivery' ? 'Arrived at delivery' : 'Arrived at PU' } : e,
  );

  const stopOptions = load.stops.map((s) => ({
    value: s.id,
    label: `${s.sequence}. ${s.kind === 'pickup' ? 'Pickup' : 'Delivery'} · ${s.facilityName || s.city}, ${s.state}${s.status === 'completed' ? ' (done)' : ''}`,
  }));

  const hasBol = load.documents.some((d) => d.type === 'bol' && d.status !== 'missing');
  // Leaving the pickup (Dispatched / Loaded → In transit) with no BOL on file asks for it here
  // (owner, 2026-10-13): the load never rolls without its bill of lading.
  // Every pickup's departure carries its own BOL - two pickups, two BOLs (owner, 2026-10-13).
  const departBolNeeded = kind === 'departed' && stop?.kind === 'pickup';
  // Leaving a delivery asks for its proof of delivery, every time (owner, 2026-10-13).
  const departPodNeeded = kind === 'departed' && stop?.kind === 'delivery';
  const needsStop = kind === 'arrived' || kind === 'loaded' || kind === 'departed';
  const ready =
    at !== null &&
    (!needsStop || stop !== null) &&
    (kind !== 'loaded' || stop?.kind === 'pickup') &&
    // Loaded is recorded with its BOL attached here, every time (owner, 2026-10-06).
    (kind !== 'loaded' || bol !== null) &&
    (!departBolNeeded || bol !== null) &&
    (!departPodNeeded || bol !== null) &&
    (kind !== 'eta_changed' || etaAt !== null);

  const record = useMutation({
    mutationFn: async () => {
      if (!at) throw new Error('Say when it happened.');
      const author = account?.name ?? demoCurrentUser.name;
      let expectedUpdatedAt = load.updatedAt;
      if (kind === 'loaded') {
        if (!stop || stop.kind !== 'pickup') throw new Error('Loaded belongs to a pickup.');
        if (bol) {
          if (bol.size > MAX_UPLOAD_BYTES) throw new Error('The BOL is over 10 MB.');
          const stored = await early.get(bol);
          const filed = await uploadLoadDocument({
            loadId: load.id,
            type: 'bol',
            fileName: bol.name,
            sizeBytes: bol.size,
            mimeType: bol.type,
            fileUrl: stored.url,
            fileId: stored.id,
            uploadedBy: author,
          });
          expectedUpdatedAt = filed.updatedAt;
        }
        // Loaded at the arrival on record when there is one - the freight went on while the
        // truck was on the dock - otherwise at the time typed here.
        const loadedAt = stop.arrivedAt ?? at;
        const confirmed = await apiPost<{ load: Load }>(`/loads/${load.id}/confirm`, { kind: 'mark_loaded', stopId: stop.id, at: loadedAt, expectedUpdatedAt });
        expectedUpdatedAt = confirmed.load.updatedAt;
        const piecesN = pieces.trim() === '' ? null : Number(pieces);
        const weightN = weight.trim() === '' ? null : Number(weight);
        const patch: { pieces?: number; weightLbs?: number } = {};
        if (piecesN !== null && Number.isFinite(piecesN) && piecesN !== load.pieces) patch.pieces = piecesN;
        if (weightN !== null && Number.isFinite(weightN) && weightN !== load.weightLbs) patch.weightLbs = weightN;
        if (Object.keys(patch).length > 0) await updateLoad({ loadId: load.id, ...patch });
        if (note.trim()) await apiPost(`/loads/${load.id}/notes`, { kind: 'internal', body: note.trim(), pinned: false, expectedUpdatedAt: (await getLoad(load.loadNumber))?.updatedAt ?? expectedUpdatedAt });
        return confirmed.load;
      }
      if (kind === 'arrived' || kind === 'departed') {
        if (!stop) throw new Error('Pick the stop.');
        if (departBolNeeded || departPodNeeded) {
          const word = departPodNeeded ? 'POD' : 'BOL';
          if (!bol) throw new Error(departPodNeeded ? 'Attach the POD before the truck leaves the delivery.' : 'Attach the BOL before the truck leaves the pickup.');
          if (bol.size > MAX_UPLOAD_BYTES) throw new Error(`The ${word} is over 10 MB.`);
          const stored = await early.get(bol);
          const filed = await uploadLoadDocument({
            loadId: load.id,
            type: departPodNeeded ? 'pod' : 'bol',
            fileName: bol.name,
            sizeBytes: bol.size,
            mimeType: bol.type,
            fileUrl: stored.url,
            fileId: stored.id,
            uploadedBy: author,
          });
          expectedUpdatedAt = filed.updatedAt;
        }
        const response = await apiPost<{ load: Load }>(`/loads/${load.id}/stop-event`, {
          stopId: stop.id,
          kind,
          at,
          zone,
          note: note.trim() || undefined,
          expectedUpdatedAt,
        });
        return response.load;
      }
      const response = await apiPost<{ load: Load }>(`/loads/${load.id}/check-call`, {
        kind,
        at,
        location: location.trim() || undefined,
        etaAt: kind === 'eta_changed' ? etaAt : undefined,
        stopId: stop?.id,
        note: note.trim() || undefined,
        expectedUpdatedAt,
      });
      return response.load;
    },
    onSuccess: async (updated) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['load'] }),
        queryClient.invalidateQueries({ queryKey: ['loads'] }),
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
        queryClient.invalidateQueries({ queryKey: ['dispatch-board'] }),
      ]);
      toast({
        tone: 'success',
        title: events.find((e) => e.value === kind)?.label ?? 'Recorded',
        description: `${updated.loadNumber} · now ${updated.status.replace(/_/g, ' ')}.`,
      });
      onOpenChange(false);
    },
    onError: (err: unknown) => setError(err instanceof Error ? err.message : 'The event could not be recorded.'),
  });

  const busy = record.isPending;

  return (
    <Modal
      open={open}
      onOpenChange={(next) => {
        if (busy) return;
        onOpenChange(next);
      }}
      size="md"
      title="Record an event"
      description={`${load.loadNumber} is ${load.status.replace(/_/g, ' ')}. Say what happened; the status follows.`}
      footer={
        <>
          <Button variant="secondary" disabled={busy} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!ready || busy} loading={busy} onClick={() => record.mutate()}>
            Record
          </Button>
        </>
      }
    >
      <input
        ref={fileRef}
        type="file"
        accept={UPLOAD_ACCEPT}
        className="hidden"
        aria-hidden
        tabIndex={-1}
        onChange={(e) => {
          setBol(e.target.files?.[0] ?? null);
          e.target.value = '';
        }}
      />
      <div className="flex flex-col gap-4">
        {error ? <Alert tone="danger" title={error} /> : null}
        <FormField label="What happened" required description={EVENTS.find((e) => e.value === kind)?.hint}>
          <Select options={events} value={kind} onValueChange={(v) => setKind(v as EventKind)} disabled={busy} />
        </FormField>
        <FormField label={needsStop ? 'Stop' : 'Next stop'} required={needsStop}>
          <Select options={stopOptions} value={stopId} onValueChange={setStopId} disabled={busy} placeholder="Pick the stop" />
        </FormField>
        {kind === 'loaded' && stop && stop.kind !== 'pickup' ? (
          <Alert tone="warning" title="Loaded belongs to a pickup" description="Pick the pickup the BOL is for." />
        ) : null}
        <div className="grid grid-cols-2 gap-3">
          <FormField label={`Date (${zoneName})`} required>
            <Input type="date" value={date} onChange={(e) => setDate(e.target.value)} disabled={busy} aria-label="Event date" />
          </FormField>
          <FormField label={`Time (${zoneName})`} required description={eastern ? `${eastern} Eastern` : undefined}>
            <Input type="time" value={time} onChange={(e) => setTime(e.target.value)} disabled={busy} aria-label="Event time" />
          </FormField>
        </div>
        {kind === 'loaded' ? (
          <>
            <div className="grid grid-cols-2 gap-3">
              <FormField label="Pieces">
                <Input type="number" min={0} value={pieces} onChange={(e) => setPieces(e.target.value)} disabled={busy} aria-label="Pieces" />
              </FormField>
              <FormField label="Weight (lbs)">
                <Input type="number" min={0} value={weight} onChange={(e) => setWeight(e.target.value)} disabled={busy} aria-label="Weight" />
              </FormField>
            </div>
            <BolDrop file={bol} onFile={setBol} disabled={busy} hint={hasBol ? 'A BOL is already on file; attach the one for this pickup.' : undefined} />
          </>
        ) : null}
        {departBolNeeded ? (
          <BolDrop file={bol} onFile={setBol} disabled={busy} hint={hasBol ? 'The BOL for this pickup: attach it to record the departure.' : 'No BOL is on file for this pickup yet: attach it to record the departure.'} testId="depart-bol" />
        ) : null}
        {departPodNeeded ? (
          <BolDrop pod file={bol} onFile={setBol} disabled={busy} hint="The proof of delivery for this stop: attach it to record the departure." testId="depart-pod" />
        ) : null}
        {kind === 'check_call' || kind === 'eta_changed' ? (
          <FormField label="Where the truck is">
            <Input value={location} onChange={(e) => setLocation(e.target.value)} disabled={busy} placeholder="I-80 near Des Moines, IA" aria-label="Location" />
          </FormField>
        ) : null}
        {kind === 'eta_changed' ? (
          <div className="grid grid-cols-2 gap-3">
            <FormField label={`New ETA date (${zoneName})`} required>
              <Input type="date" value={etaDate} onChange={(e) => setEtaDate(e.target.value)} disabled={busy} aria-label="ETA date" />
            </FormField>
            <FormField label={`New ETA time (${zoneName})`} required description={etaAt ? `${formatInstant(etaAt, HOME_ZONE).text} Eastern` : undefined}>
              <Input type="time" value={etaTime} onChange={(e) => setEtaTime(e.target.value)} disabled={busy} aria-label="ETA time" />
            </FormField>
          </div>
        ) : null}
        <FormField label="Note">
          <Textarea rows={2} value={note} onChange={(e) => setNote(e.target.value)} disabled={busy} aria-label="Note" />
        </FormField>
      </div>
    </Modal>
  );
}

/** The bill of lading as a drop zone with its file shown (owner, 2026-10-13: tidier than a bare button). */
function BolDrop({ file, onFile, disabled, hint, testId, pod = false }: { file: File | null; onFile: (file: File | null) => void; disabled: boolean; hint?: string; testId?: string; pod?: boolean }) {
  const word = pod ? 'POD' : 'BOL';
  return (
    <section aria-label={word} className="flex flex-col gap-2 rounded-[10px] border border-nw-border bg-nw-subtle p-3" data-testid={testId}>
      <h3 className="text-sm font-bold text-ink">
        {pod ? 'Proof of delivery (POD)' : 'Bill of lading (BOL)'} <span className="text-nw-urgent-text" aria-hidden>*</span>
      </h3>
      <FileDropzone
        title={word}
        subtitle={file ? `${file.name} · ${Math.max(1, Math.round(file.size / 1024))} KB · ready to attach` : `Drop the ${word} here or browse files · PDF or image (PDF, JPG, PNG)`}
        hint={hint ?? "Saved in this load's Documents when you record. Record stays off until it is attached."}
        actionLabel={file ? 'Change file' : 'Browse files'}
        accept={UPLOAD_ACCEPT}
        file={file}
        onFile={onFile}
        disabled={disabled}
      />
    </section>
  );
}
