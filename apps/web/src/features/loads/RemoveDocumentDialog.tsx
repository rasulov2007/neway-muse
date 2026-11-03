import { useMutation, useQueryClient } from '@tanstack/react-query';
import { useState } from 'react';
import { removeLoadDocument, type Load } from '@/demo';
import { Button, Checkbox, FormField, Modal, Textarea, useToast } from '@/design-system';

/**
 * Delete a file filed by mistake (owner, 2026-11-02: a BOL went in as the POD and the load was
 * completed). The file is kept on the record as removed, with the reason; any charge that came
 * with it is dropped. A BOL or POD can also take back the step it made: the load returns to the
 * status before, and the Daily board with it.
 */
export function RemoveDocumentDialog({ load, doc, onClose }: { load: Load; doc: Load['documents'][number]; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const [reason, setReason] = useState('');
  const stepped = doc.type === 'pod' ? ['delivered'].includes(load.status) || load.status === 'in_transit' : doc.type === 'bol' ? ['loaded', 'in_transit'].includes(load.status) : false;
  const [revert, setRevert] = useState(stepped);
  const remove = useMutation({
    mutationFn: () => removeLoadDocument(load.id, doc.id, { reason: reason.trim(), revertStatus: stepped && revert }),
    onSuccess: async (next) => {
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ['load'] }),
        queryClient.invalidateQueries({ queryKey: ['loads'] }),
        queryClient.invalidateQueries({ queryKey: ['operations'] }),
        queryClient.invalidateQueries({ queryKey: ['dispatch'] }),
        queryClient.invalidateQueries({ queryKey: ['accounting'] }),
      ]);
      toast({
        tone: 'success',
        title: `${doc.title} deleted`,
        description: next.status !== load.status ? `${load.loadNumber} is back to ${next.status.replace(/_/g, ' ')}; the board follows.` : undefined,
      });
      onClose();
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not deleted', description: e instanceof Error ? e.message : 'Try again.' }),
  });
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open && !remove.isPending) onClose();
      }}
      title={`Delete ${doc.title}`}
      description={`${doc.fileName} comes off ${load.loadNumber}. It is kept in the history with your name and the reason.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={remove.isPending}>
            Cancel
          </Button>
          <Button variant="danger" loading={remove.isPending} disabled={reason.trim().length < 3} onClick={() => remove.mutate()}>
            Delete file
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <FormField label="Why" required description="For example: a BOL was filed as the POD.">
          <Textarea rows={2} aria-label="Why" value={reason} onChange={(e) => setReason(e.target.value)} autoFocus />
        </FormField>
        {stepped ? (
          <label className="flex items-start gap-2 text-sm text-ink">
            <Checkbox checked={revert} onCheckedChange={(v) => setRevert(v === true)} aria-label="Move the load back" />
            <span>
              Move the load back to where it was before this {doc.type === 'pod' ? 'POD' : 'BOL'} (now{' '}
              {load.status.replace(/_/g, ' ')}). The Daily board status follows.
            </span>
          </label>
        ) : null}
      </div>
    </Modal>
  );
}
