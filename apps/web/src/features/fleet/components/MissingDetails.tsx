import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Trailer, Truck } from '@/demo';
import { updateTrailerDetails } from '@/demo/fleet-writes';
import { updateTruckRecord } from '@/demo/roster-api';
import { Button, DatePicker, FormField, Input, Modal, Select, useToast } from '@/design-system';
import { useInvalidateFleet } from '../useFleet';
import { MissingDetailPrompt } from './MissingDetailPrompt';

/**
 * What a unit is still missing, and the way to add it.
 *
 * A unit is created with only what identifies it (P1 #5); every later detail - the in-service
 * date PM scheduling runs from, the plate registration needs, the inspection date a trailer is
 * judged on - is asked for here, on the unit's own page, instead of blocking the create. Each
 * prompt opens one small dialog for exactly the fields that are absent.
 */
type Field = 'inServiceDate' | 'plate' | 'nextInspectionDate';

const TRUCK_OWNERSHIP = [
  { value: 'owned', label: 'Company-owned' },
  { value: 'leased', label: 'Leased' },
  { value: 'owner_operator', label: 'Owner-operator' },
  { value: 'vendor', label: 'Vendor truck' },
];
const TRAILER_OWNERSHIP = [
  { value: 'owned', label: 'Company-owned' },
  { value: 'leased', label: 'Leased' },
];

export function MissingDetails({
  truck,
  trailer,
  nextInspectionDate,
}: {
  truck?: Truck;
  trailer?: Trailer;
  /**
   * The trailer's effective next inspection date (its own field or its annual inspection
   * certificate, see `nextTrailerInspection`). When given, the prompt asks only if both are empty.
   */
  nextInspectionDate?: string | null;
}) {
  const [editing, setEditing] = useState<Field | null>(null);
  const prompts: { field: Field; message: string; actionLabel: string }[] = [];
  if (truck) {
    if (!truck.inServiceDate) {
      prompts.push({
        field: 'inServiceDate',
        message: 'Add the in-service date to start PM scheduling.',
        actionLabel: 'Add in-service date',
      });
    }
    if (!truck.plate || !truck.plateState) {
      prompts.push({
        field: 'plate',
        message: 'Add the plate to complete registration.',
        actionLabel: 'Add plate',
      });
    }
  }
  if (trailer) {
    const inspection =
      nextInspectionDate === undefined ? trailer.nextInspectionDate : nextInspectionDate;
    if (!inspection) {
      prompts.push({
        field: 'nextInspectionDate',
        message:
          'Add the next annual inspection date so the trailer can be dispatched and tracked.',
        actionLabel: 'Add inspection date',
      });
    }
    if (!trailer.plate || !trailer.plateState) {
      prompts.push({
        field: 'plate',
        message: 'Add the plate to complete registration.',
        actionLabel: 'Add plate',
      });
    }
  }
  if (prompts.length === 0) return null;
  return (
    <>
      <div className="flex flex-col gap-2">
        {prompts.map((prompt) => (
          <MissingDetailPrompt
            key={prompt.field}
            message={prompt.message}
            actionLabel={prompt.actionLabel}
            onAction={() => setEditing(prompt.field)}
          />
        ))}
      </div>
      {editing ? (
        <DetailsDialog
          field={editing}
          truck={truck}
          trailer={trailer}
          onClose={() => setEditing(null)}
        />
      ) : null}
    </>
  );
}

function DetailsDialog({
  field,
  truck,
  trailer,
  onClose,
}: {
  field: Field;
  truck?: Truck;
  trailer?: Trailer;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateFleet();
  const [date, setDate] = useState('');
  const [plate, setPlate] = useState(truck?.plate ?? trailer?.plate ?? '');
  const [plateState, setPlateState] = useState(truck?.plateState ?? trailer?.plateState ?? '');
  const [ownership, setOwnership] = useState<string>(
    truck?.ownership ?? trailer?.ownership ?? 'owned',
  );
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      if (field !== 'plate' && !date) throw new Error('Pick the date first.');
      if (field === 'plate' && (!plate.trim() || plateState.trim().length !== 2)) {
        throw new Error('Enter the plate and its two-letter state.');
      }
      if (truck) {
        await updateTruckRecord(truck.id, {
          ...(field === 'inServiceDate' ? { inServiceDate: date } : {}),
          ...(field === 'plate'
            ? { plate: plate.trim().toUpperCase(), plateState: plateState.trim().toUpperCase() }
            : {}),
          ownership: ownership as Truck['ownership'],
        });
      } else if (trailer) {
        await updateTrailerDetails(trailer.id, {
          ...(field === 'nextInspectionDate' ? { nextInspectionDate: date } : {}),
          ...(field === 'plate'
            ? { plate: plate.trim().toUpperCase(), plateState: plateState.trim().toUpperCase() }
            : {}),
          ownership: ownership as Trailer['ownership'],
        });
      }
    },
    onSuccess: async () => {
      await Promise.all([
        invalidate(),
        queryClient.invalidateQueries({ queryKey: ['trucks'] }),
        queryClient.invalidateQueries({ queryKey: ['trailers'] }),
      ]);
      toast({ tone: 'success', title: 'Details saved' });
      onClose();
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The details could not be saved'),
  });

  const title =
    field === 'inServiceDate'
      ? 'Add the in-service date'
      : field === 'nextInspectionDate'
        ? 'Add the next annual inspection date'
        : 'Add the plate';

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      size="sm"
      title={title}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {field === 'inServiceDate' ? (
          <FormField
            label="In service since"
            required
            description="The first PM is scheduled from this date."
          >
            <DatePicker value={date} onIsoChange={setDate} />
          </FormField>
        ) : null}
        {field === 'nextInspectionDate' ? (
          <FormField label="Next annual inspection" required>
            <DatePicker value={date} onIsoChange={setDate} />
          </FormField>
        ) : null}
        {field === 'plate' ? (
          <div className="grid grid-cols-[minmax(0,1fr)_6rem] gap-2">
            <FormField label="Plate" required>
              <Input
                value={plate}
                onChange={(e) => setPlate(e.target.value)}
                className="uppercase"
              />
            </FormField>
            <FormField label="State" required>
              <Input
                value={plateState}
                maxLength={2}
                onChange={(e) => setPlateState(e.target.value)}
                className="uppercase"
              />
            </FormField>
          </div>
        ) : null}
        <FormField
          label="Ownership"
          description="Who pays for this unit's repairs and carries its lease."
        >
          <Select
            options={truck ? TRUCK_OWNERSHIP : TRAILER_OWNERSHIP}
            value={ownership}
            onValueChange={setOwnership}
          />
        </FormField>
        {error ? (
          <p role="alert" className="text-sm text-danger-text">
            {error}
          </p>
        ) : null}
      </div>
    </Modal>
  );
}
