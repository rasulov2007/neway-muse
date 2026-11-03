import { Gauge } from 'lucide-react';
import { useState } from 'react';
import type { PmBoardRow } from '@neway/shared';
import { Button, Input, Modal, Textarea, useToast } from '@/design-system';
import { nowIso } from '@/lib/clock';
import { formatDate, formatRelative } from '@/lib/format';
import { uploadFile } from '@/lib/files';
import { useAddReading } from './api';
import { Field } from './sheet-bits';

const n = (v: number) => v.toLocaleString('en-US');

/**
 * Get reading (§6.4): a manual odometer reading for a truck whose ELD is not reporting. It goes
 * through the engine's own endpoint, so the same conflict rules apply as to any other reading,
 * and a photo of the dash is asked for because a typed number is the weakest source there is.
 */
export function UpdateReadingDialog({ row, onClose }: { row: PmBoardRow; onClose: () => void }) {
  const { toast } = useToast();
  const add = useAddReading();
  const [odometer, setOdometer] = useState('');
  const [note, setNote] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const save = async () => {
    setError(null);
    const miles = Number(odometer);
    if (!odometer || !Number.isFinite(miles) || miles < 0) return setError('Enter the odometer');
    if (row.readingOdometer !== null && miles < row.readingOdometer)
      return setError(
        `That is below the last reading of ${n(row.readingOdometer)} mi. An odometer does not go backwards; if the ELD was swapped, say so in the note.`,
      );
    setBusy(true);
    let photoId: string | null = null;
    if (photo) {
      try {
        photoId = (await uploadFile(photo)).id;
      } catch (e) {
        setBusy(false);
        return setError(e instanceof Error ? e.message : 'Could not upload the photo');
      }
    }
    add.mutate(
      {
        unitId: row.unitId,
        readingAt: nowIso(),
        odometerMiles: Math.round(miles),
        source: 'manual',
        photoId,
        note: note.trim() || null,
      },
      {
        onSuccess: () => {
          toast({
            tone: 'success',
            title: `${row.unitNumber} · reading saved`,
            description: `${n(Math.round(miles))} mi, manual. The row recomputes from it.`,
          });
          onClose();
        },
        onError: (e) => setError(e instanceof Error ? e.message : 'Could not save the reading'),
        onSettled: () => setBusy(false),
      },
    );
  };

  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={`Update reading · ${row.unitNumber}`}
      description={
        row.readingAt && row.readingOdometer !== null
          ? `Last reading ${n(row.readingOdometer)} mi · ${row.readingSource === 'eld' ? 'ELD' : row.readingSource} · ${formatDate(row.readingAt)} (${formatRelative(row.readingAt)})`
          : 'No reading on record for this truck.'
      }
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            icon={<Gauge />}
            loading={busy || add.isPending}
            onClick={() => void save()}
          >
            Save reading
          </Button>
        </>
      }
    >
      <div className="grid gap-3">
        <Field label="Odometer now" required small="from the dash, not from memory">
          <Input
            type="number"
            inputMode="numeric"
            min={0}
            aria-label="Odometer"
            value={odometer}
            onChange={(e) => setOdometer(e.target.value)}
            suffix={<span className="text-nw-text-3">mi</span>}
            autoFocus
          />
        </Field>
        <Field label="Photo of the dash" small="asked for on every manual reading">
          <input
            type="file"
            accept="image/*"
            capture="environment"
            aria-label="Photo of the dash"
            onChange={(e) => setPhoto(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-nw-text-2 file:mr-3 file:rounded-lg file:border-0 file:bg-nw-subtle file:px-3 file:py-1.5 file:text-sm file:font-semibold file:text-nw-text"
          />
        </Field>
        <Field label="Note" optional>
          <Textarea
            rows={2}
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="Who read it, and why the ELD is not reporting"
          />
        </Field>
        {error ? <p className="text-sm text-nw-urgent-text">{error}</p> : null}
      </div>
    </Modal>
  );
}
