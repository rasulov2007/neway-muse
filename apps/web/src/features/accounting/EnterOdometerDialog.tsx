import { useMutation } from '@tanstack/react-query';
import { Gauge } from 'lucide-react';
import { useState } from 'react';
import { Button, FormField, Input, Modal, useToast } from '@/design-system';
import { enterStatementOdometer, type Statement } from '@/demo';
import { formatIsoDate } from '@/lib/format';

/**
 * The odometer typed in from a statement (owner, 2026-10-21).
 *
 * A lease driver's tractor lease tier and maintenance fee follow the truck's odometer. When the
 * ELD has no readings for the truck the statement says the fee cannot be figured; Accounting
 * enters what the odometer said at the start of the week (the day before it began) and at its
 * end, and the statement recomputes. Each figure is saved as a manual reading on the truck, so
 * the PM module sees it too; a figure below the last good reading is kept as a conflict and never
 * used, which the dialog says rather than hiding.
 */

/** True when the statement's warnings include the odometer problem the dialog answers. */
export function hasOdometerProblem(s: Pick<Statement, 'exceptions'>): boolean {
  return s.exceptions.some((e) => /odometer/i.test(e));
}

/** The button that opens the dialog, shown only where it can help: a draft with a truck. */
export function EnterOdometerButton({ s, canEdit, onDone }: { s: Statement; canEdit: boolean; onDone: () => Promise<unknown> }) {
  const [open, setOpen] = useState(false);
  const draft = s.status === 'draft' || s.status === 'review';
  if (!canEdit || !draft || !s.truckId || !hasOdometerProblem(s)) return null;
  return (
    <>
      <Button variant="secondary" size="sm" icon={<Gauge />} onClick={() => setOpen(true)}>Enter odometer</Button>
      {open ? <EnterOdometerDialog s={s} onClose={() => setOpen(false)} onDone={onDone} /> : null}
    </>
  );
}

const dayBefore = (day: string) => {
  const d = new Date(`${day}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
};

const miles = (raw: string): number | null => {
  const t = raw.replace(/[,\s]/g, '');
  if (!t) return null;
  const n = Number(t);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : null;
};

export function EnterOdometerDialog({ s, onClose, onDone }: { s: Statement; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { toast } = useToast();
  const [start, setStart] = useState('');
  const [end, setEnd] = useState('');
  const [note, setNote] = useState('');
  const startMiles = miles(start);
  const endMiles = miles(end);
  const startBad = start.trim() !== '' && startMiles === null;
  const endBad = end.trim() !== '' && endMiles === null;
  const order = startMiles !== null && endMiles !== null && endMiles < startMiles;
  const ready = !startBad && !endBad && !order && (startMiles !== null || endMiles !== null);
  const save = useMutation({
    mutationFn: () => enterStatementOdometer(s.id, { startMiles, endMiles, note: note.trim() || null }),
    onSuccess: async (r) => {
      await onDone();
      const conflicts = r.readings.filter((x) => x.status === 'conflict');
      if (conflicts.length) {
        toast({ tone: 'warning', title: 'Saved, but not usable', description: conflicts.every((x) => x.message) ? `${conflicts.map((x) => x.message).join('. ')}. Kept on record as a conflict and not used.` : `${conflicts.map((x) => `${x.end === 'start' ? 'Start' : 'End'} ${x.odometerMiles.toLocaleString('en-US')} mi`).join(' and ')} conflict${conflicts.length === 1 ? 's' : ''} with an earlier reading of the truck (${conflicts[0]!.conflictReason ?? 'below the last good reading'}). Kept on record as a conflict; the statement still cannot figure the fee.` });
      } else {
        toast({ tone: 'success', title: 'Odometer entered', description: hasOdometerProblem(r.statement) ? 'Saved as a manual reading. The statement still needs the other end of the week.' : 'Saved as manual readings on the truck. The lease charges are figured from them.' });
      }
      onClose();
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not saved', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="sm"
      title={`Enter odometer · unit ${s.unitNumber ?? '—'}`}
      description={`The truck has no ELD readings for this week. Type what the odometer said; one end is enough to start, both are needed for the maintenance fee.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready} loading={save.isPending} onClick={() => save.mutate()}>Save readings</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3" data-testid="enter-odometer">
        <FormField label={`Start of week · ${formatIsoDate(dayBefore(s.periodStart))}`} description="The reading on the day before the week began, in miles." error={startBad ? 'Miles, whole number.' : undefined}>
          <Input inputMode="numeric" value={start} onChange={(e) => setStart(e.target.value)} placeholder="120,000" aria-label="Odometer at the start of the week" />
        </FormField>
        <FormField label={`End of week · ${formatIsoDate(s.periodEnd)}`} description="The reading on the last day of the week, in miles." error={endBad ? 'Miles, whole number.' : order ? 'Cannot be below the start.' : undefined}>
          <Input inputMode="numeric" value={end} onChange={(e) => setEnd(e.target.value)} placeholder="122,000" aria-label="Odometer at the end of the week" />
        </FormField>
        <FormField label="Note (optional)" description="Where the figures came from, kept on the readings.">
          <Input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Driver’s photo of the dash, Sunday night" aria-label="Odometer note" />
        </FormField>
        <p className="text-2xs text-muted">Saved as manual readings on unit {s.unitNumber ?? s.truckId} at 23:59 Eastern of each day, under your name. A figure below an earlier reading is kept as a conflict and is not used.</p>
      </div>
    </Modal>
  );
}
