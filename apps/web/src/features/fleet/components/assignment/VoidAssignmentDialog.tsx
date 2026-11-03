import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type { TruckAssignmentView, TruckDriverAssignment } from '@neway/shared';
import { Alert, Button, FormField, Modal, Textarea, useToast } from '@/design-system';
import { apiPost } from '@/lib/api-client';
import { formatIsoDate } from '@/lib/format';
import { useAfterAssignmentChange } from '../../use-truck-assignment';

/**
 * Voids a closed assignment entered by mistake or as a test (owner, 2026-10-08). Nothing is
 * deleted: the entry leaves the unit's history and the audit log keeps who, when and why.
 */
export function VoidAssignmentDialog({
  truckId,
  assignment,
  onClose,
}: {
  truckId: string;
  assignment: TruckDriverAssignment;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const after = useAfterAssignmentChange(truckId);
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);
  const tooShort = reason.trim().length < 3;

  const save = useMutation({
    mutationFn: () =>
      apiPost<TruckAssignmentView>(`/trucks/${truckId}/assignment/${assignment.id}/void`, {
        version: assignment.version,
        reason: reason.trim(),
      }),
    onSuccess: async (next) => {
      await after(next);
      toast({ tone: 'success', title: `Entry of ${assignment.driverName} voided` });
      onClose();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'The entry could not be voided.'),
  });

  const period = `${formatIsoDate(assignment.assignedOn)} – ${assignment.endedOn ? formatIsoDate(assignment.endedOn) : 'open'}`;

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="sm"
      title={`Void this entry · ${assignment.driverName}`}
      description={`Unit ${assignment.unitNumber}, ${period}. It leaves the unit's history; nothing is deleted and the audit log keeps who voided it, when and why.`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="danger" loading={save.isPending} disabled={tooShort} onClick={() => save.mutate()}>
            Void entry
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not voided">
            {error}
          </Alert>
        ) : null}
        <FormField label="Why" required description="For example: entered while testing, wrong driver or wrong unit.">
          <Textarea rows={2} aria-label="Why" value={reason} onChange={(e) => setReason(e.target.value)} />
        </FormField>
      </div>
    </Modal>
  );
}
