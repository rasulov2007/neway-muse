import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import type { Trailer } from '@/demo';
import { updateTrailerRecord } from '@/demo/roster-api';
import { Button, FormField, Input, Modal, useToast } from '@/design-system';
import { useInvalidateFleet } from '../useFleet';

/**
 * Model and year of a trailer already on the fleet (owner, 2026-10-22). No make: the owner took it off.
 *
 * Add trailer asks for both. Most trailers on record came from Ditat with none of them, so
 * here each may be left blank: a blank field is saved as "not set", never as a guess.
 */
export function EditTrailerIdentityDialog({
  trailer,
  onClose,
}: {
  trailer: Trailer;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateFleet();
  const [unitNumber, setUnitNumber] = useState(trailer.unitNumber);
  const [model, setModel] = useState(trailer.model ?? '');
  const [year, setYear] = useState(trailer.year ? String(trailer.year) : '');
  const [error, setError] = useState<string | null>(null);

  const save = useMutation({
    mutationFn: async () => {
      const yearText = year.trim();
      const yearValue = yearText === '' ? null : Number(yearText);
      if (yearValue !== null && (!Number.isInteger(yearValue) || yearValue < 1990 || yearValue > 2027)) {
        throw new Error('Year must be between 1990 and 2027.');
      }
      if (model.trim().length > 40) throw new Error('Model is too long');
      const number = unitNumber.trim();
      if (number.length < 2 || number.length > 20) throw new Error('Trailer number needs 2 to 20 characters.');
      await updateTrailerRecord(trailer.id, {
        model: model.trim() || null,
        year: yearValue,
        ...(number !== trailer.unitNumber ? { unitNumber: number } : {}),
      });
    },
    onSuccess: async () => {
      await Promise.all([
        invalidate(),
        queryClient.invalidateQueries({ queryKey: ['trailers'] }),
      ]);
      toast({ tone: 'success', title: `Trailer ${unitNumber.trim()} updated` });
      onClose();
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The trailer could not be saved'),
  });

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      size="sm"
      title={`Edit trailer ${trailer.unitNumber}`}
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
        <FormField label="Trailer number">
          <Input value={unitNumber} maxLength={20} onChange={(e) => setUnitNumber(e.target.value)} aria-label="Trailer number" />
        </FormField>
        <FormField label="Model">
          <Input
            value={model}
            maxLength={40}
            placeholder="4000D-X"
            onChange={(e) => setModel(e.target.value)}
          />
        </FormField>
        <FormField label="Year">
          <Input
            value={year}
            type="number"
            inputMode="numeric"
            placeholder="2026"
            onChange={(e) => setYear(e.target.value)}
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
