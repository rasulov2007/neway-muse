import { useMutation } from '@tanstack/react-query';
import { Undo2 } from 'lucide-react';
import { useState } from 'react';
import { Button, FormField, Input, Modal, useToast } from '@/design-system';
import { reopenStatement } from '@/demo';

/**
 * Reopening an approved statement (owner, 2026-10-21): approval is not final until the payment
 * is posted. One reason, one press; the server reverses the ledger entry and the charges the
 * approval wrote, and the statement is a draft again with every edit control back.
 */

export function ReopenStatementButton({ s, canEdit, onDone, size }: { s: { id: string; settlementNumber: string; status: string }; canEdit: boolean; onDone: () => Promise<unknown>; size?: 'sm' | 'md' }) {
  const [open, setOpen] = useState(false);
  if (!canEdit || s.status !== 'approved') return null;
  return (
    <>
      <Button variant="secondary" size={size} icon={<Undo2 />} onClick={() => setOpen(true)}>Reopen to edit</Button>
      {open ? <ReopenStatementDialog s={s} onClose={() => setOpen(false)} onDone={onDone} /> : null}
    </>
  );
}

export function ReopenStatementDialog({ s, onClose, onDone }: { s: { id: string; settlementNumber: string }; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const reopen = useMutation({
    mutationFn: () => reopenStatement(s.id, reason.trim()),
    onSuccess: async (r) => {
      if (!r.ok) { toast({ tone: 'danger', title: 'Not reopened', description: r.blocked }); return; }
      await onDone();
      toast({ tone: 'success', title: 'Reopened', description: `${s.settlementNumber} is a draft again. The ledger entry was reversed; approve it again when it is right.` });
      onClose();
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not reopened', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="sm"
      title={`Reopen ${s.settlementNumber}?`}
      description="The approval is undone: the ledger entry is reversed and the deductions it took are given back. The statement is a draft again until it is approved once more."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={reason.trim().length < 3} loading={reopen.isPending} onClick={() => reopen.mutate()}>Reopen</Button>
        </>
      }
    >
      <FormField label="Why (kept on record)" required>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Fuel from Tuesday was missing" aria-label="Reopen reason" />
      </FormField>
    </Modal>
  );
}
