import { useMutation } from '@tanstack/react-query';
import { UserMinus } from 'lucide-react';
import { useState } from 'react';
import type {
  AssignmentPhotoUpload,
  EndAssignmentRequest,
  TruckAssignmentView,
  TruckDriverAssignment,
} from '@neway/shared';
import { Button, DatePicker, FormField, Modal, Textarea, useToast } from '@/design-system';
import { apiPost } from '@/lib/api-client';
import { today as companyToday } from '@/lib/clock';
import { formatIsoDate } from '@/lib/format';
import { useAfterAssignmentChange } from '../../use-truck-assignment';
import { PhotoPicker } from './AssignmentPhotos';
import { dropDateProblem } from './assignment-rules';
import {
  EquipmentChecklist,
  draftsToEquipment,
  returnDraftsFrom,
  type ItemDraft,
} from './EquipmentChecklist';

/** What a drop records, while it is being filled in. */
export interface DropDraft {
  endedOn: string;
  returned: ItemDraft[];
  photos: AssignmentPhotoUpload[];
  note: string;
}

export function newDropDraft(assignment: TruckDriverAssignment, endedOn = companyToday()): DropDraft {
  return {
    endedOn,
    returned: returnDraftsFrom(assignment.equipment, null),
    photos: [],
    note: '',
  };
}

/**
 * The drop of one driver: the date the unit came back, what came back with it (pre-filled from
 * what was handed over), photos and a note. Used by Unassign and by Change for the driver being
 * replaced.
 */
export function DropFields({
  truckId,
  assignment,
  draft,
  onChange,
  dateProblem,
  onBusyChange,
}: {
  truckId: string;
  assignment: TruckDriverAssignment;
  draft: DropDraft;
  onChange: (next: DropDraft) => void;
  dateProblem: string | null;
  onBusyChange?: (busy: boolean) => void;
}) {
  return (
    <div className="flex flex-col gap-4">
      <FormField
        label="Unassigned / drop date"
        required
        error={dateProblem ?? undefined}
        description={`${assignment.driverName} has had the unit since ${assignment.assignedOnApproximate ? 'about ' : ''}${formatIsoDate(assignment.assignedOn)}.`}
      >
        <DatePicker
          aria-label="Drop date"
          value={draft.endedOn}
          invalid={Boolean(dateProblem)}
          onIsoChange={(iso) => onChange({ ...draft, endedOn: iso ?? '' })}
        />
      </FormField>
      <FormField
        label="Returned with the unit"
        description="Pre-filled from what was handed over. Untick what did not come back; correct a serial if needed."
      >
        <EquipmentChecklist
          mode="drop"
          items={draft.returned}
          onChange={(returned) => onChange({ ...draft, returned })}
        />
      </FormField>
      <FormField label="Drop photos" description="The unit as it came back: outside, cab, dash, damage.">
        <PhotoPicker
          truckId={truckId}
          label="Add drop photos"
          value={draft.photos}
          onChange={(photos) => onChange({ ...draft, photos })}
          onBusyChange={onBusyChange}
        />
      </FormField>
      <FormField label="Drop note">
        <Textarea
          rows={2}
          aria-label="Drop note"
          value={draft.note}
          onChange={(e) => onChange({ ...draft, note: e.target.value })}
        />
      </FormField>
    </div>
  );
}

/**
 * Unassign: opens a modal, writes nothing until Unassign is pressed. The drop date defaults to the
 * company's today and may be moved back (never before the assigned date, never into the future).
 */
export function UnassignDialog({
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
  const [draft, setDraft] = useState<DropDraft>(() => newDropDraft(assignment));
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const today = companyToday();
  const problem = dropDateProblem(draft.endedOn, assignment.assignedOn, today);

  const end = useMutation({
    mutationFn: () => {
      const body: EndAssignmentRequest = {
        version: assignment.version,
        endedOn: draft.endedOn,
        returnedEquipment: draftsToEquipment(draft.returned, 'drop'),
        dropNote: draft.note.trim() || null,
        dropPhotoIds: draft.photos.map((p) => p.fileId),
      };
      return apiPost<TruckAssignmentView>(
        `/trucks/${truckId}/assignment/${assignment.id}/end`,
        body,
      );
    },
    onSuccess: async (next) => {
      await after(next);
      toast({
        tone: 'success',
        title: `${assignment.driverName} taken out of unit ${assignment.unitNumber}`,
        description: `Drop date ${formatIsoDate(draft.endedOn)}.`,
      });
      onClose();
    },
    onError: (e: unknown) => setError(e instanceof Error ? e.message : 'Could not unassign'),
  });

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="md"
      title={`Unassign ${assignment.driverName}`}
      description={`Unit ${assignment.unitNumber}. The assignment closes on the drop date and stays in the unit's history.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="danger"
            icon={<UserMinus />}
            loading={end.isPending}
            disabled={Boolean(problem) || uploading}
            onClick={() => {
              setError(null);
              end.mutate();
            }}
          >
            Unassign
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {error ? (
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        ) : null}
        <DropFields
          truckId={truckId}
          assignment={assignment}
          draft={draft}
          onChange={setDraft}
          dateProblem={problem}
          onBusyChange={setUploading}
        />
      </div>
    </Modal>
  );
}
