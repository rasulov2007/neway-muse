import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Plus } from 'lucide-react';
import { useState } from 'react';
import { Alert, Button, FormField, Modal, useToast } from '@/design-system';
import { updateDriverRecord } from '@/demo';
import { DispatcherSelect } from '@/features/people/DispatcherSelect';
import { ApiError } from '@/lib/api-client';

/**
 * The driver's dispatcher on their own page (owner, 2026-10-13): Add dispatcher when nobody is
 * assigned, Change when somebody is. Adding a driver no longer asks for one.
 */
export function DispatcherFact({ driverId, dispatcherId, dispatcherName }: { driverId: string; dispatcherId: string | null | undefined; dispatcherName: string | null | undefined }) {
  const [open, setOpen] = useState(false);
  const assigned = Boolean(dispatcherId) && dispatcherName !== 'Unassigned';
  return (
    <>
      {assigned ? (
        <span className="inline-flex flex-wrap items-center gap-2">
          {dispatcherName}
          <Button size="sm" variant="ghost" onClick={() => setOpen(true)} data-testid="change-dispatcher">
            Change
          </Button>
        </span>
      ) : (
        <Button size="sm" variant="outline" icon={<Plus />} onClick={() => setOpen(true)} data-testid="add-dispatcher">
          Add dispatcher
        </Button>
      )}
      {open ? <DispatcherDialog driverId={driverId} current={assigned ? (dispatcherId ?? null) : null} currentName={dispatcherName ?? null} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function DispatcherDialog({ driverId, current, currentName, onClose }: { driverId: string; current: string | null; currentName: string | null; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [value, setValue] = useState<string | null>(current);
  const save = useMutation({
    mutationFn: () => updateDriverRecord(driverId, { dispatcherId: value ?? '' }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
        queryClient.invalidateQueries({ queryKey: ['drivers'] }),
        queryClient.invalidateQueries({ queryKey: ['roster'] }),
      ]);
      toast({ tone: 'success', title: value ? 'Dispatcher saved' : 'Dispatcher removed' });
      onClose();
    },
  });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={current ? 'Change dispatcher' : 'Add dispatcher'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} disabled={value === current} onClick={() => save.mutate()} data-testid="save-dispatcher">
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {save.error ? <Alert tone="danger" title="Not saved" description={save.error instanceof ApiError ? save.error.message : 'Try again.'} /> : null}
        <FormField label="Dispatcher">
          <DispatcherSelect value={value} onValueChange={setValue} currentLabel={currentName} />
        </FormField>
      </div>
    </Modal>
  );
}
