import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import type {
  AssignmentPhotoUpload,
  TruckAssignmentView,
  TruckDriverAssignment,
  UpdateAssignmentInput,
} from '@neway/shared';
import { Button, DatePicker, FormField, Modal, Textarea, useToast } from '@/design-system';
import { apiPatch } from '@/lib/api-client';
import { today as companyToday } from '@/lib/clock';
import { useAfterAssignmentChange } from '../../use-truck-assignment';
import { PhotoPicker, PhotoThumb } from './AssignmentPhotos';
import { assignedDateProblem, dropDateProblem } from './assignment-rules';
import {
  EquipmentChecklist,
  draftsFromEquipment,
  draftsToEquipment,
  returnDraftsFrom,
  type ItemDraft,
} from './EquipmentChecklist';

/**
 * Edit any assignment — the current one or an earlier driver's. Every field the record holds,
 * with the same date rules as when it was written. The version the card read is sent; a record
 * somebody else changed meanwhile comes back as a conflict, never overwritten.
 */
export function EditAssignmentDialog({
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
  const closed = assignment.endedOn !== null;
  const [assignedOn, setAssignedOn] = useState(assignment.assignedOn);
  const [endedOn, setEndedOn] = useState(assignment.endedOn ?? '');
  const [handed, setHanded] = useState<ItemDraft[]>(() => draftsFromEquipment(assignment.equipment));
  const [returned, setReturned] = useState<ItemDraft[]>(() =>
    returnDraftsFrom(assignment.equipment, assignment.returnedEquipment),
  );
  // An old drop with no returned list stays without one unless somebody fills it in.
  const [returnedTouched, setReturnedTouched] = useState(false);
  const [note, setNote] = useState(assignment.note ?? '');
  const [dropNote, setDropNote] = useState(assignment.dropNote ?? '');
  const [removed, setRemoved] = useState<string[]>([]);
  const [newPickup, setNewPickup] = useState<AssignmentPhotoUpload[]>([]);
  const [newDrop, setNewDrop] = useState<AssignmentPhotoUpload[]>([]);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const today = companyToday();
  const assignedProblem = assignedDateProblem(assignedOn, today);
  const dropProblem = closed ? dropDateProblem(endedOn, assignedOn, today) : null;

  const save = useMutation({
    mutationFn: () => {
      const body: UpdateAssignmentInput = {
        version: assignment.version,
        assignedOn,
        equipment: draftsToEquipment(handed, 'pickup'),
        note: note.trim() || null,
        ...(closed
          ? {
              endedOn,
              ...(assignment.returnedEquipment !== null || returnedTouched
                ? { returnedEquipment: draftsToEquipment(returned, 'drop') }
                : {}),
              dropNote: dropNote.trim() || null,
              addDropPhotoIds: newDrop.map((p) => p.fileId),
            }
          : {}),
        addPickupPhotoIds: newPickup.map((p) => p.fileId),
        removePhotoIds: removed,
      };
      return apiPatch<TruckAssignmentView>(`/trucks/${truckId}/assignment/${assignment.id}`, body);
    },
    onSuccess: async (next) => {
      await after(next);
      toast({ tone: 'success', title: `Assignment of ${assignment.driverName} saved` });
      onClose();
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The assignment could not be saved.'),
  });

  const keptPickup = assignment.pickupPhotos.filter((p) => !removed.includes(p.id));
  const keptDrop = assignment.dropPhotos.filter((p) => !removed.includes(p.id));

  return (
    <Modal
      open
      onOpenChange={(open) => !open && onClose()}
      size="lg"
      title={`Edit assignment · ${assignment.driverName}`}
      description={`Unit ${assignment.unitNumber}. Changes are kept in the audit log with who made them and when.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={save.isPending}
            disabled={Boolean(assignedProblem || dropProblem) || uploading}
            onClick={() => {
              setError(null);
              save.mutate();
            }}
          >
            Save changes
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
        <div className="grid gap-4 sm:grid-cols-2">
          <FormField
            label="Assigned date"
            required
            error={assignedProblem ?? undefined}
            description={
              assignment.assignedOnApproximate
                ? 'Approximate (reconstructed). Saving a date makes it exact.'
                : undefined
            }
          >
            <DatePicker
              aria-label="Assigned date"
              value={assignedOn}
              invalid={Boolean(assignedProblem)}
              onIsoChange={(iso) => setAssignedOn(iso ?? '')}
            />
          </FormField>
          {closed ? (
            <FormField label="Drop date" required error={dropProblem ?? undefined}>
              <DatePicker
                aria-label="Drop date"
                value={endedOn}
                invalid={Boolean(dropProblem)}
                onIsoChange={(iso) => setEndedOn(iso ?? '')}
              />
            </FormField>
          ) : null}
        </div>

        <FormField label="Handed over with the unit">
          <EquipmentChecklist mode="pickup" items={handed} onChange={setHanded} />
        </FormField>
        <FormField label="Pickup photos">
          <div className="flex flex-col gap-2">
            {keptPickup.length > 0 ? (
              <div className="flex flex-wrap gap-2">
                {keptPickup.map((p) => (
                  <PhotoThumb
                    key={p.id}
                    url={p.url}
                    fileName={p.fileName}
                    onRemove={() => setRemoved([...removed, p.id])}
                  />
                ))}
              </div>
            ) : null}
            <PhotoPicker
              truckId={truckId}
              label="Add pickup photos"
              value={newPickup}
              onChange={setNewPickup}
              onBusyChange={setUploading}
            />
          </div>
        </FormField>
        <FormField label="Note">
          <Textarea rows={2} aria-label="Note" value={note} onChange={(e) => setNote(e.target.value)} />
        </FormField>

        {closed ? (
          <>
            <FormField label="Returned with the unit">
              <EquipmentChecklist
                mode="drop"
                items={returned}
                onChange={(next) => {
                  setReturnedTouched(true);
                  setReturned(next);
                }}
              />
            </FormField>
            <FormField label="Drop photos">
              <div className="flex flex-col gap-2">
                {keptDrop.length > 0 ? (
                  <div className="flex flex-wrap gap-2">
                    {keptDrop.map((p) => (
                      <PhotoThumb
                        key={p.id}
                        url={p.url}
                        fileName={p.fileName}
                        onRemove={() => setRemoved([...removed, p.id])}
                      />
                    ))}
                  </div>
                ) : null}
                <PhotoPicker
                  truckId={truckId}
                  label="Add drop photos"
                  value={newDrop}
                  onChange={setNewDrop}
                  onBusyChange={setUploading}
                />
              </div>
            </FormField>
            <FormField label="Drop note">
              <Textarea
                rows={2}
                aria-label="Drop note"
                value={dropNote}
                onChange={(e) => setDropNote(e.target.value)}
              />
            </FormField>
          </>
        ) : null}
      </div>
    </Modal>
  );
}
