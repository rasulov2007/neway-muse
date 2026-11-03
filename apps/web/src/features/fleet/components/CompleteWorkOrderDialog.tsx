import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import {
  attachWorkOrderInvoice,
  completeWorkOrderWithoutInvoice,
  demoCurrentUser,
  type NoInvoiceReason,
  type RepairOrder,
} from '@/demo';
import { Button, DatePicker, FormField, Input, Modal, Select, useToast } from '@/design-system';
import { formatMoney } from '@/lib/format';
import { uploadFile } from '@/lib/files';
import { useInvalidateFleet } from '../useFleet';
import { FileDropzone } from './FileDropzone';

/**
 * Completing a work order asks for the invoice - and is itself the way forward.
 *
 * A completed repair should have paperwork, so the old refusal ("a document must be attached")
 * was right about the rule and wrong about the path: it left the person with nothing to do.
 * This dialog is the path. Attach the invoice with its number, date and amount and the order
 * completes; or complete without one for a stated reason (warranty work, the internal shop, an
 * invoice still to come), which flags the order as awaiting its invoice rather than hiding that.
 */
const REASONS: { value: NoInvoiceReason; label: string }[] = [
  { value: 'invoice_to_follow', label: 'Invoice to follow' },
  { value: 'warranty', label: 'Warranty work' },
  { value: 'internal_shop', label: 'Internal shop' },
];

function parseMoney(value: string): number | null {
  const n = Number(value.replace(/[^0-9.]/g, ''));
  return value.trim() === '' || Number.isNaN(n) ? null : n;
}

export function CompleteWorkOrderDialog({
  order,
  invoiceOptional = false,
  onClose,
}: {
  order: RepairOrder;
  /** A lease operator's truck (owner, 2026-11-03): the invoice may be attached, never required. */
  invoiceOptional?: boolean;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();
  const [file, setFile] = useState<File | null>(null);
  const [invoiceNumber, setInvoiceNumber] = useState('');
  const [invoiceDate, setInvoiceDate] = useState('');
  const [amount, setAmount] = useState(order.total > 0 ? String(order.total) : '');
  const [withoutInvoice, setWithoutInvoice] = useState(false);
  const [reason, setReason] = useState<NoInvoiceReason>('invoice_to_follow');
  const [note, setNote] = useState('');
  const [error, setError] = useState<string | null>(null);

  const attach = useMutation({
    mutationFn: async () => {
      if (!file) {
        if (!invoiceOptional) throw new Error('Attach the invoice file first, or complete without one below.');
        return completeWorkOrderWithoutInvoice({
          orderId: order.id,
          reason: 'lease_operator',
          note: 'Lease operator truck: invoice optional',
          completedBy: demoCurrentUser.name,
        });
      }
      const stored = await uploadFile(file);
      return attachWorkOrderInvoice({
        orderId: order.id,
        fileName: file.name,
        sizeBytes: file.size,
        mimeType: file.type || 'application/octet-stream',
        fileUrl: stored.url,
        fileId: stored.id,
        uploadedBy: demoCurrentUser.name,
        amount: parseMoney(amount),
        invoiceNumber: invoiceNumber.trim() || null,
        invoiceDate: invoiceDate || null,
      });
    },
    onSuccess: async (saved) => {
      await invalidate();
      const money = parseMoney(amount);
      toast({
        tone: 'success',
        title: `${saved.roNumber} completed`,
        description: !file
          ? 'Lease operator truck: completed without an invoice.'
          : money === null
            ? 'The invoice is on file; the order keeps its estimate as the cost.'
            : `The invoice is on file; the order cost ${formatMoney(money)}.`,
      });
      onClose();
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The work order could not be completed'),
  });

  const complete = useMutation({
    mutationFn: async () => {
      if (note.trim().length < 3) throw new Error('Say briefly why there is no invoice.');
      return completeWorkOrderWithoutInvoice({
        orderId: order.id,
        reason,
        note: note.trim(),
        completedBy: demoCurrentUser.name,
      });
    },
    onSuccess: async (saved) => {
      await invalidate();
      toast({
        tone: 'warning',
        title: `${saved.roNumber} completed without an invoice`,
        description: 'It is flagged as awaiting the invoice until one is attached.',
      });
      onClose();
    },
    onError: (e: unknown) =>
      setError(e instanceof Error ? e.message : 'The work order could not be completed'),
  });

  const busy = attach.isPending || complete.isPending;

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      size="md"
      title={invoiceOptional ? 'Complete this work order' : 'Attach the invoice to complete this work order'}
      description={`${order.roNumber} · ${order.summary}`}
      footer={
        withoutInvoice ? (
          <>
            <Button variant="ghost" onClick={() => setWithoutInvoice(false)} disabled={busy}>
              Back to the invoice
            </Button>
            <Button
              variant="primary"
              loading={complete.isPending}
              onClick={() => complete.mutate()}
            >
              Complete without invoice
            </Button>
          </>
        ) : (
          <>
            <Button variant="ghost" onClick={onClose} disabled={busy}>
              Cancel
            </Button>
            {invoiceOptional ? null : (
              <Button variant="secondary" onClick={() => setWithoutInvoice(true)} disabled={busy}>
                Complete without invoice
              </Button>
            )}
            <Button variant="primary" loading={attach.isPending} onClick={() => attach.mutate()}>
              {invoiceOptional && !file ? 'Complete' : 'Attach and complete'}
            </Button>
          </>
        )
      }
    >
      {withoutInvoice ? (
        <div className="flex flex-col gap-3">
          <FormField label="Why is there no invoice?" required>
            <Select
              options={REASONS}
              value={reason}
              onValueChange={(next) => setReason(next as NoInvoiceReason)}
            />
          </FormField>
          <FormField
            label="Note"
            required
            description="One line for whoever reconciles the shop bills later."
          >
            <Input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder={
                reason === 'warranty'
                  ? 'Covered under the Cummins warranty claim'
                  : reason === 'internal_shop'
                    ? 'Done in our own bay, parts from stock'
                    : 'Shop will send the invoice by Friday'
              }
            />
          </FormField>
          {error ? (
            <p role="alert" className="text-sm text-danger-text">
              {error}
            </p>
          ) : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <FileDropzone
            title="Drop the invoice or browse"
            subtitle="PDF or a photo of the paper invoice"
            hint="Attaching it completes the order and records what the work cost."
            actionLabel="Choose file"
            file={file}
            onFile={setFile}
            disabled={busy}
          />
          <div className="grid gap-3 sm:grid-cols-3">
            <FormField label="Invoice number">
              <Input
                value={invoiceNumber}
                onChange={(e) => setInvoiceNumber(e.target.value)}
                placeholder="INV-10482"
              />
            </FormField>
            <FormField label="Invoice date">
              <DatePicker value={invoiceDate} onIsoChange={setInvoiceDate} />
            </FormField>
            <FormField label="Amount" description="Replaces the estimate.">
              <Input
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                inputMode="decimal"
                prefix="$"
                placeholder="0.00"
              />
            </FormField>
          </div>
          {error ? (
            <p role="alert" className="text-sm text-danger-text">
              {error}
            </p>
          ) : null}
        </div>
      )}
    </Modal>
  );
}
