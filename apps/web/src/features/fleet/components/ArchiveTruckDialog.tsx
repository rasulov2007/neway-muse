import { useState } from 'react';
import { ConfirmDialog, FormField, Textarea, useToast } from '@/design-system';
import { archiveTruckRecord, restoreTruckRecord } from '@/demo';
import { useInvalidateFleet } from '../useFleet';

/**
 * Archive a truck, or restore one (owner, 2026-10-05).
 *
 * Archived = hidden, kept, reversible, audited: the unit leaves every list, picker, board and count
 * of the current fleet; its old loads, repairs, fuel and settlements keep its number. Archiving asks
 * for a reason, which goes into the audit line with who and when. The truck's `updatedAt` as this
 * page read it is the version check, so a unit somebody else changed meanwhile is refused.
 */
export function ArchiveTruckDialog({
  mode,
  truckId,
  unitNumber,
  updatedAt,
  onClose,
}: {
  /** Null when closed. */
  mode: 'archive' | 'restore' | null;
  truckId: string;
  unitNumber: string;
  updatedAt: string | undefined;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const close = () => {
    setReason('');
    setError(null);
    onClose();
  };

  const confirm = async () => {
    if (!updatedAt) {
      setError('This page is out of date. Reload it and try again.');
      throw new Error('stale');
    }
    if (mode === 'archive' && reason.trim().length < 3) {
      setError('Say why the truck is archived');
      throw new Error('reason');
    }
    try {
      if (mode === 'archive') {
        await archiveTruckRecord(truckId, reason.trim(), updatedAt);
      } else {
        await restoreTruckRecord(truckId, updatedAt, reason.trim() || undefined);
      }
      await invalidate();
      toast({
        tone: 'success',
        title:
          mode === 'archive'
            ? `Unit ${unitNumber} is archived`
            : `Unit ${unitNumber} is back in the fleet as available`,
      });
      close();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : 'The change was refused.';
      setError(message);
      throw cause;
    }
  };

  return (
    <ConfirmDialog
      open={mode !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      tone={mode === 'archive' ? 'danger' : 'default'}
      title={mode === 'archive' ? `Archive unit ${unitNumber}?` : `Restore unit ${unitNumber}?`}
      description={
        mode === 'archive'
          ? 'The unit leaves every truck list, picker, board and count. Its past loads, repairs, fuel and settlements keep its number. You can restore it later.'
          : 'The unit comes back to the fleet as available and shows on every list again.'
      }
      confirmLabel={mode === 'archive' ? 'Archive truck' : 'Restore truck'}
      onConfirm={confirm}
    >
      <FormField
        label={mode === 'archive' ? 'Reason' : 'Reason (optional)'}
        required={mode === 'archive'}
        error={error ?? undefined}
      >
        <Textarea
          rows={3}
          value={reason}
          onChange={(event) => {
            setReason(event.target.value);
            if (error) setError(null);
          }}
          placeholder={
            mode === 'archive' ? 'Why the unit is leaving the fleet' : 'Why it is coming back'
          }
        />
      </FormField>
    </ConfirmDialog>
  );
}
