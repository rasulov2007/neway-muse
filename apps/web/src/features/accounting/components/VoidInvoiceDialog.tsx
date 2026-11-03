import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Alert, Button, FormField, Modal, Textarea, useToast } from '@/design-system';
import { voidInvoice, type Invoice } from '@/demo';
import { formatMoney } from '@/lib/format';
import { useInvalidateAccounting } from '../useAccounting';

/**
 * Voids an invoice.
 *
 * A void writes a reversing journal entry; it never deletes the original. A set of books that can
 * lose a row cannot be audited, so the invoice stays on file with its reversal beside it and the
 * reason attached to both.
 */
export function VoidInvoiceDialog({
  open,
  onOpenChange,
  invoice,
  onDone,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  invoice: Invoice;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateAccounting();
  const [reason, setReason] = useState('');
  const [error, setError] = useState<string | null>(null);

  const run = useMutation({
    mutationFn: () => voidInvoice({ invoiceId: invoice.id, reason }),
    onSuccess: async (result) => {
      if (!result.ok) {
        setError(result.blocked ?? 'The invoice could not be voided.');
        return;
      }
      await invalidate();
      toast({
        tone: 'success',
        title: `${invoice.invoiceNumber} voided`,
        description: 'A reversing entry was posted; the original stays on the books.',
      });
      onDone();
    },
  });

  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title={`Void ${invoice.invoiceNumber}?`}
      description={`${formatMoney(invoice.total)} billed to ${invoice.billToName}.`}
      footer={
        <>
          <Button variant="secondary" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            loading={run.isPending}
            disabled={!reason.trim()}
            onClick={() => {
              setError(null);
              run.mutate();
            }}
          >
            Void invoice
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
        <Alert
          tone="info"
          title="Nothing is deleted"
          description="Voiding posts a reversing entry: the revenue and the receivable are backed out, and both the original and the reversal stay on the books for the audit trail."
        />
        <FormField label="Reason" required description="Recorded on the reversing entry.">
          <Textarea
            rows={3}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            placeholder="Billed to the wrong party; re-issuing to the broker."
          />
        </FormField>
      </div>
    </Modal>
  );
}
