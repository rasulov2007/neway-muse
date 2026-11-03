import { useRef, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { FileText, Pencil, Trash2, Upload } from 'lucide-react';
import {
  Alert,
  Button,
  Card,
  ConfirmDialog,
  FormField,
  IconButton,
  Input,
  Modal,
  useToast,
} from '@/design-system';
import {
  attachWorkOrderInvoice,
  demoCurrentUser,
  removeWorkOrderInvoice,
  updateWorkOrderInvoice,
  type RepairOrder,
} from '@/demo';
import { formatDateTime, formatMoney, parseMoney } from '@/lib/format';
import { DocumentViewer } from '@/features/documents';
import { uploadFile } from '@/lib/files';
import { FileDropzone } from './FileDropzone';
import { useInvalidateFleet } from '../useFleet';

/**
 * The shop's paperwork, on the work order it belongs to.
 *
 * Every work order has this section, because every work order eventually has an invoice. A
 * completed order without one is not finished business: it is money the carrier has been charged
 * and cannot yet prove, so the section says so plainly instead of showing an empty list.
 *
 * The amount on the invoice becomes the order's cost. What was typed when the order was written up
 * was an estimate, and an estimate that quietly outlives the invoice is how a maintenance budget
 * stops meaning anything.
 */
export function WorkOrderInvoices({ order }: { order: RepairOrder }) {
  const [adding, setAdding] = useState(false);
  // Which invoice the viewer is showing, by id: the list is re-read after every write, so holding
  // the row itself would show the copy from before a correction.
  const [viewing, setViewing] = useState<string | null>(null);
  const invoices = order.invoices ?? [];
  const shown = invoices.find((i) => i.id === viewing) ?? null;
  const awaiting = order.status === 'completed' && invoices.length === 0;

  return (
    <div className="flex flex-col gap-4">
      {awaiting ? (
        <Alert
          tone="warning"
          title="This work is completed and its invoice has not arrived"
          description={`Until the shop's invoice is attached, ${formatMoney(order.total)} on this order is the estimate rather than what was charged. Chase ${order.vendorName || 'the shop'} for it.`}
        />
      ) : null}

      <Card className="p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-md font-bold text-ink">Invoices and receipts</h3>
            <p className="text-xs text-muted">
              {invoices.length === 0
                ? 'Nothing attached yet. Attaching the invoice completes this work order.'
                : `${invoices.length} file${invoices.length === 1 ? '' : 's'} on this order.`}
            </p>
          </div>
          <Button size="sm" icon={<Upload />} onClick={() => setAdding(true)}>
            Add an invoice
          </Button>
        </div>

        {invoices.length > 0 ? (
          <ul className="mt-3 divide-y divide-line-soft">
            {invoices.map((invoice) => (
              <li key={invoice.id} className="flex items-center gap-3 py-2.5">
                <FileText aria-hidden className="size-4 shrink-0 text-muted" />
                <span className="min-w-0 flex-1">
                  {/*
                   * Opened in the app's own viewer, never an anchor: the file store wants the
                   * session token, and Chrome refuses a top-level `data:` URL outright — either
                   * way the link that looked fine did nothing at all.
                   */}
                  <button
                    type="button"
                    onClick={() => setViewing(invoice.id)}
                    className="block max-w-full truncate text-left text-sm font-medium text-primary-text hover:underline"
                  >
                    {invoice.fileName}
                  </button>
                  <span className="block text-xs text-muted">
                    {(invoice.sizeBytes / 1024).toFixed(0)} KB · {invoice.uploadedBy} ·{' '}
                    {formatDateTime(invoice.uploadedAt)}
                  </span>
                </span>
                <span className="tabular shrink-0 text-sm font-medium text-ink">
                  {invoice.amount === null ? (
                    <span className="text-muted">No amount</span>
                  ) : (
                    formatMoney(invoice.amount)
                  )}
                </span>
                <InvoiceActions order={order} invoice={invoice} />
              </li>
            ))}
          </ul>
        ) : null}
      </Card>

      {adding ? <AttachDialog order={order} onClose={() => setAdding(false)} /> : null}
      {shown ? (
        <InvoiceViewer order={order} invoice={shown} onClose={() => setViewing(null)} />
      ) : null}
    </div>
  );
}

/**
 * One invoice, in the viewer every document in this product opens in.
 *
 * Replace is an attach followed by a remove, because that is what the writes are: there is no
 * `replaceWorkOrderInvoice`. Attaching first matters — removing the last invoice from a completed
 * order puts it back in the shop, and a replacement should never make the order flicker backwards.
 */
function InvoiceViewer({
  order,
  invoice,
  onClose,
}: {
  order: RepairOrder;
  invoice: NonNullable<RepairOrder['invoices']>[number];
  onClose: () => void;
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();
  const fileRef = useRef<HTMLInputElement>(null);

  const replace = useMutation({
    mutationFn: async (file: File) => {
      const stored = await uploadFile(file);
      await attachWorkOrderInvoice({
        orderId: order.id,
        fileName: file.name,
        sizeBytes: file.size,
        mimeType: file.type || 'application/octet-stream',
        fileUrl: stored.url,
        fileId: stored.id,
        uploadedBy: demoCurrentUser.name,
        amount: invoice.amount,
      });
      return removeWorkOrderInvoice({ orderId: order.id, invoiceId: invoice.id });
    },
    onSuccess: async () => {
      await invalidate();
      toast({ tone: 'success', title: `${invoice.fileName} replaced` });
      onClose();
    },
    onError: (error: unknown) =>
      toast({
        tone: 'danger',
        title: 'Not replaced',
        description: error instanceof Error ? error.message : undefined,
      }),
  });

  const remove = useMutation({
    mutationFn: () => removeWorkOrderInvoice({ orderId: order.id, invoiceId: invoice.id }),
    onSuccess: async (saved) => {
      await invalidate();
      toast({
        tone: 'warning',
        title: `${invoice.fileName} removed`,
        description:
          saved.status === 'in_shop'
            ? `${saved.roNumber} is back in the shop until an invoice is attached.`
            : `${saved.roNumber} keeps its other paperwork.`,
      });
      onClose();
    },
    onError: (error: unknown) =>
      toast({
        tone: 'danger',
        title: 'Not removed',
        description: error instanceof Error ? error.message : undefined,
      }),
  });

  return (
    <>
      <input
        ref={fileRef}
        type="file"
        accept="application/pdf,image/png,image/jpeg,image/webp"
        className="hidden"
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) replace.mutate(file);
          event.target.value = '';
        }}
      />
      <DocumentViewer
        source={{ kind: 'file', file: invoice }}
        title={invoice.fileName}
        subtitle={`${order.roNumber} · ${invoice.uploadedBy} · ${formatDateTime(invoice.uploadedAt)}`}
        contentType={invoice.mimeType}
        fileName={invoice.fileName}
        onClose={onClose}
        onReplace={() => fileRef.current?.click()}
        replaceLabel={replace.isPending ? 'Replacing…' : 'Replace'}
        onDelete={() => remove.mutate()}
        deleting={remove.isPending}
        deleteTitle={`Remove ${invoice.fileName}?`}
        deleteDescription={
          (order.invoices ?? []).length === 1 && order.status === 'completed'
            ? 'This is the only invoice on the order, so the order goes back to in shop until another is attached.'
            : 'The file is taken off this order. The others stay.'
        }
        deleteConfirmLabel="Remove invoice"
      />
    </>
  );
}

/**
 * Correcting or removing an invoice somebody attached in a hurry.
 *
 * The amount is what goes wrong — a figure read off the wrong line — and it becomes the order's
 * cost, so it has to be correctable. Removing is for the invoice attached to the wrong order;
 * taking the last one off a completed order puts it back in the shop, because completed work is
 * work that has been invoiced.
 */
function InvoiceActions({
  order,
  invoice,
}: {
  order: RepairOrder;
  invoice: NonNullable<RepairOrder['invoices']>[number];
}) {
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();
  const [editing, setEditing] = useState(false);
  const [removing, setRemoving] = useState(false);
  const [amount, setAmount] = useState(invoice.amount === null ? '' : String(invoice.amount));

  const save = useMutation({
    mutationFn: () =>
      updateWorkOrderInvoice({
        orderId: order.id,
        invoiceId: invoice.id,
        amount: parseMoney(amount),
      }),
    onSuccess: async (saved) => {
      await invalidate();
      toast({
        tone: 'success',
        title: `${invoice.fileName} corrected`,
        description: `${saved.roNumber} now costs ${formatMoney(saved.total)}.`,
      });
      setEditing(false);
    },
    onError: (error: unknown) =>
      toast({
        tone: 'danger',
        title: 'Not changed',
        description: error instanceof Error ? error.message : undefined,
      }),
  });

  const remove = useMutation({
    mutationFn: () => removeWorkOrderInvoice({ orderId: order.id, invoiceId: invoice.id }),
    onSuccess: async (saved) => {
      await invalidate();
      toast({
        tone: 'warning',
        title: `${invoice.fileName} removed`,
        description:
          saved.status === 'in_shop'
            ? `${saved.roNumber} is back in the shop until an invoice is attached.`
            : `${saved.roNumber} keeps its other paperwork.`,
      });
      setRemoving(false);
    },
    onError: (error: unknown) =>
      toast({
        tone: 'danger',
        title: 'Not removed',
        description: error instanceof Error ? error.message : undefined,
      }),
  });

  return (
    <span className="flex shrink-0 items-center gap-1">
      <IconButton
        label={`Correct the amount on ${invoice.fileName}`}
        variant="ghost"
        size="sm"
        onClick={() => setEditing(true)}
      >
        <Pencil />
      </IconButton>
      <IconButton
        label={`Remove ${invoice.fileName}`}
        variant="ghost"
        size="sm"
        onClick={() => setRemoving(true)}
      >
        <Trash2 />
      </IconButton>

      <Modal
        open={editing}
        onOpenChange={(next) => !next && setEditing(false)}
        size="sm"
        title="Correct the amount"
        description={`${invoice.fileName} on ${order.roNumber}. The amount here is what the order costs.`}
        footer={
          <>
            <Button variant="secondary" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button loading={save.isPending} onClick={() => save.mutate()}>
              Save amount
            </Button>
          </>
        }
      >
        <FormField
          label="Amount invoiced"
          description="Leave blank if the paperwork carries no total."
        >
          <Input
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="$5,503.00"
          />
        </FormField>
      </Modal>

      <ConfirmDialog
        open={removing}
        onOpenChange={setRemoving}
        tone="danger"
        title={`Remove ${invoice.fileName}?`}
        description={
          (order.invoices ?? []).length === 1 && order.status === 'completed'
            ? 'This is the only invoice on the order, so the order goes back to in shop until another is attached.'
            : 'The file is taken off this order. The others stay.'
        }
        confirmLabel="Remove invoice"
        cancelLabel="Keep it"
        onConfirm={() => remove.mutate()}
      />
    </span>
  );
}

function AttachDialog({ order, onClose }: { order: RepairOrder; onClose: () => void }) {
  const { toast } = useToast();
  const invalidate = useInvalidateFleet();
  const [file, setFile] = useState<File | null>(null);
  const [amount, setAmount] = useState(order.total > 0 ? String(order.total) : '');
  const [error, setError] = useState<string | null>(null);

  const attach = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error('Choose the invoice file first');
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
      });
    },
    onSuccess: async (saved) => {
      await invalidate();
      toast({
        tone: 'success',
        title: `Invoice attached to ${saved.roNumber}`,
        description:
          parseMoney(amount) === null
            ? 'No amount was entered, so the order keeps its estimate.'
            : `The order now costs ${formatMoney(parseMoney(amount) as number)}, from the invoice.`,
      });
      onClose();
    },
    onError: (err: unknown) =>
      setError(err instanceof Error ? err.message : 'The invoice could not be attached'),
  });

  return (
    <Modal
      open
      onOpenChange={(next) => !next && onClose()}
      size="sm"
      title={`Attach an invoice to ${order.roNumber}`}
      description="What the shop charged. The amount on the invoice replaces the estimate."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            loading={attach.isPending}
            onClick={() => {
              setError(null);
              attach.mutate();
            }}
          >
            Attach
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {error ? (
          <Alert tone="danger" title="Not attached">
            {error}
          </Alert>
        ) : null}
        <FileDropzone
          title="Invoice"
          subtitle="PDF or an image of the paperwork"
          hint="The amount below replaces the estimate on this order."
          actionLabel="Add invoice"
          file={file}
          onFile={setFile}
        />
        <FormField
          label="Amount invoiced"
          description="Leave blank if the paperwork carries no total; the estimate then stands."
        >
          <Input
            inputMode="decimal"
            value={amount}
            onChange={(event) => setAmount(event.target.value)}
            placeholder="$5,503.00"
          />
        </FormField>
      </div>
    </Modal>
  );
}
