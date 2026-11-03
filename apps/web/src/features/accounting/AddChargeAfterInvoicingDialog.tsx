import { useMutation, useQuery } from '@tanstack/react-query';
import { Paperclip, Plus, Trash2 } from 'lucide-react';
import { useRef, useState } from 'react';
import { LATE_CHARGE_LABEL, LATE_CHARGE_TYPES, supplementInvoiceNumber, type LateChargeType } from '@neway/shared';
import { Alert, Button, Checkbox, FormField, Input, Modal, Select, Textarea, useToast } from '@/design-system';
import { addChargeAfterInvoicing, fetchRevisionOptions, type AddChargeAfterInvoicingResult, type ServerInvoice } from '@/demo';
import { uploadFile } from '@/lib/files';
import { formatMoney } from '@/lib/format';

/**
 * Add charge after invoicing (owner, 2026-10-21).
 *
 * The invoice has gone to RTS, so it is not changed: a layover, detention or lumper that comes in
 * afterwards is billed on a supplemental invoice (INV-10004-S1) for the same load and broker
 * reference, with the proof attached, and sent to RTS in a batch of its own. When the driver gets
 * (part of) the charge, that is said here and it reaches their statement by the normal pay rules.
 */

interface ChargeRow {
  key: string;
  chargeType: LateChargeType;
  description: string;
  amount: string;
  supportingDocumentIds: string[];
  newFiles: Array<{ fileId: string; fileName: string }>;
  payableToDriver: boolean;
  payMode: 'full' | 'percent' | 'fixed';
  payValue: string;
}

const TYPE_OPTIONS = LATE_CHARGE_TYPES.map((t) => ({ value: t, label: LATE_CHARGE_LABEL[t] }));
const PAY_OPTIONS = [
  { value: 'full', label: 'The full amount' },
  { value: 'percent', label: 'A percentage' },
  { value: 'fixed', label: 'A fixed amount' },
];

const blank = (n: number): ChargeRow => ({ key: `c${n}${Date.now()}`, chargeType: 'layover', description: LATE_CHARGE_LABEL.layover, amount: '', supportingDocumentIds: [], newFiles: [], payableToDriver: false, payMode: 'full', payValue: '100' });
const amountOf = (s: string) => {
  const n = Number(s.replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
};
const newKey = () => `sup-${typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`}`;

export function AddChargeAfterInvoicingDialog({ invoice, nextSequence, onClose, onDone }: { invoice: ServerInvoice; nextSequence: number; onClose: () => void; onDone: (result: AddChargeAfterInvoicingResult) => void | Promise<void> }) {
  const { toast } = useToast();
  // One key per opening of the dialog: a double click or a retry gets the same supplemental invoice back.
  const [requestKey] = useState(newKey);
  const [rows, setRows] = useState<ChargeRow[]>(() => [blank(0)]);
  const [reason, setReason] = useState('');
  const [issueNow, setIssueNow] = useState(true);
  const [uploading, setUploading] = useState<string | null>(null);
  const options = useQuery({ queryKey: ['accounting', 'revision-options', invoice.id], queryFn: () => fetchRevisionOptions(invoice.id) });
  const update = (key: string, patch: Partial<ChargeRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));
  const number = supplementInvoiceNumber(invoice.family, nextSequence);
  const total = rows.reduce((t, r) => t + (amountOf(r.amount) > 0 ? amountOf(r.amount) : 0), 0);
  const ready = reason.trim().length >= 3 && rows.length > 0 && rows.every((r) => r.description.trim() && amountOf(r.amount) > 0 && (!r.payableToDriver || amountOf(r.payValue) >= 0)) && !uploading;

  const save = useMutation({
    mutationFn: () =>
      addChargeAfterInvoicing(invoice.id, {
        requestKey,
        reason: reason.trim(),
        charges: rows.map((r) => ({
          chargeType: r.chargeType,
          description: r.description.trim(),
          amount: Math.round(amountOf(r.amount) * 100) / 100,
          supportingDocumentIds: r.supportingDocumentIds,
          newFiles: r.newFiles,
          payableToDriver: r.payableToDriver,
          driverPay: r.payableToDriver ? { mode: r.payMode, value: r.payMode === 'full' ? 100 : amountOf(r.payValue) } : null,
        })),
        issueNow,
        expectedUpdatedAt: invoice.updatedAt,
      }),
    onSuccess: async (r) => {
      if (!r.ok) {
        toast({ tone: 'danger', title: 'Not created', description: r.blocked });
        return;
      }
      const issued = r.invoice.status !== 'draft';
      toast({
        tone: r.issueBlocked ? 'warning' : 'success',
        title: r.existing ? `${r.invoice.invoiceNumber} was already created` : `${r.invoice.invoiceNumber} ${issued ? 'issued' : 'drafted'}`,
        description: r.issueBlocked ? `Created as a draft, not issued: ${r.issueBlocked}` : `${formatMoney(r.invoice.total)} for ${r.invoice.loadNumber}. ${invoice.invoiceNumber} is unchanged. ${issued ? 'Send it to RTS from the Billing queue.' : 'Issue it, then send it to RTS from the Billing queue.'}`,
      });
      await onDone(r);
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not created', description: e instanceof Error ? e.message : undefined }),
  });

  return (
    <Modal
      open
      onOpenChange={(o) => (o || save.isPending ? undefined : onClose())}
      size="lg"
      title={`Add charge after invoicing · ${invoice.invoiceNumber}`}
      description={`${invoice.invoiceNumber} has gone to RTS and stays exactly as it was sent. The charge is billed on a new supplemental invoice, ${number}, for load ${invoice.loadNumber} and ${invoice.billToName}, and goes to RTS in its own batch.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose} disabled={save.isPending}>Cancel</Button>
          <Button variant="primary" disabled={!ready || save.isPending} loading={save.isPending} onClick={() => save.mutate()} data-testid="supplement-save">
            Create supplemental invoice
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4" data-testid="add-charge-after-invoicing">
        {rows.map((r, i) => (
          <div key={r.key} className="flex flex-col gap-3 rounded-lg border border-line p-3" data-testid="late-charge">
            <div className="grid gap-2 sm:grid-cols-[160px_minmax(0,1fr)_140px_auto] sm:items-end">
              <FormField label="Charge">
                <Select aria-label="Charge type" value={r.chargeType} options={TYPE_OPTIONS} onValueChange={(v) => update(r.key, { chargeType: v as LateChargeType, description: r.description === LATE_CHARGE_LABEL[r.chargeType] || !r.description ? LATE_CHARGE_LABEL[v as LateChargeType] : r.description })} />
              </FormField>
              <FormField label="Description" description="Printed on the invoice.">
                <Input aria-label="Description" value={r.description} onChange={(e) => update(r.key, { description: e.target.value })} />
              </FormField>
              <FormField label="Amount">
                <Input aria-label="Amount" prefix="$" inputMode="decimal" value={r.amount} onChange={(e) => update(r.key, { amount: e.target.value })} placeholder="0.00" />
              </FormField>
              {rows.length > 1 ? <Button variant="outline" size="sm" icon={<Trash2 />} aria-label={`Remove charge ${i + 1}`} onClick={() => setRows((rs) => rs.filter((x) => x.key !== r.key))} /> : <span />}
            </div>

            <ProofPicker
              row={r}
              documents={options.data?.documents ?? []}
              uploading={uploading === r.key}
              onUpload={async (file) => {
                setUploading(r.key);
                try {
                  const stored = await uploadFile(file);
                  update(r.key, { newFiles: [...r.newFiles, { fileId: stored.id, fileName: stored.fileName }] });
                } catch (e) {
                  toast({ tone: 'danger', title: 'Upload failed', description: e instanceof Error ? e.message : undefined });
                } finally {
                  setUploading(null);
                }
              }}
              onChange={(patch) => update(r.key, patch)}
            />

            <div className="flex flex-wrap items-end gap-3">
              <label className="flex items-center gap-2 text-sm text-ink">
                <Checkbox checked={r.payableToDriver} onCheckedChange={(v) => update(r.key, { payableToDriver: v === true })} aria-label="Pay the driver" />
                Pay the driver
              </label>
              {r.payableToDriver ? (
                <>
                  <FormField label="Driver gets">
                    <Select aria-label="Driver gets" value={r.payMode} options={PAY_OPTIONS} onValueChange={(v) => update(r.key, { payMode: v as ChargeRow['payMode'], payValue: v === 'percent' ? '100' : v === 'fixed' ? r.amount : '100' })} />
                  </FormField>
                  {r.payMode !== 'full' ? (
                    <FormField label={r.payMode === 'percent' ? 'Percent' : 'Driver amount'}>
                      <Input aria-label={r.payMode === 'percent' ? 'Driver percent' : 'Driver amount'} prefix={r.payMode === 'fixed' ? '$' : undefined} inputMode="decimal" value={r.payValue} onChange={(e) => update(r.key, { payValue: e.target.value })} />
                    </FormField>
                  ) : null}
                  <p className="text-xs text-muted">On the driver’s statement by the normal pay rules; if the load’s statement is already approved, on the next one.</p>
                </>
              ) : null}
            </div>
          </div>
        ))}
        <Button variant="outline" size="sm" icon={<Plus />} className="self-start" onClick={() => setRows((rs) => [...rs, blank(rs.length)])} disabled={rows.length >= 10}>
          Add another charge
        </Button>

        <FormField label="Why it came after invoicing" required description="Kept with the invoice and in the audit log.">
          <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Layover approved by the broker on 10/20" aria-label="Why it came after invoicing" />
        </FormField>

        <label className="flex items-center gap-2 text-sm text-ink">
          <Checkbox checked={issueNow} onCheckedChange={(v) => setIssueNow(v === true)} aria-label="Issue it now" />
          Issue it now (otherwise it waits as a draft in the Billing queue)
        </label>

        <dl className="grid grid-cols-3 gap-2 rounded-lg bg-surface-muted p-3 text-sm" data-testid="supplement-summary">
          <div><dt className="text-xs text-muted">{invoice.invoiceNumber} (unchanged)</dt><dd className="font-semibold tabular-nums">{formatMoney(invoice.total)}</dd></div>
          <div><dt className="text-xs text-muted">New invoice</dt><dd className="font-semibold">{number}</dd></div>
          <div><dt className="text-xs text-muted">Its total</dt><dd className="font-semibold tabular-nums">{formatMoney(total)}</dd></div>
        </dl>
        <Alert tone="info" title="What RTS receives" description={`${number}.pdf - the supplemental invoice with the NOA stamp, the proof you attach, and the RC, BOL and POD of the same load - and a CSV row with the same load reference.`} />
      </div>
    </Modal>
  );
}

function ProofPicker({ row, documents, uploading, onUpload, onChange }: { row: ChargeRow; documents: Array<{ id: string; type: string; fileName: string }>; uploading: boolean; onUpload: (f: File) => void; onChange: (patch: Partial<ChargeRow>) => void }) {
  const input = useRef<HTMLInputElement>(null);
  const backup = documents.filter((d) => !['rate_confirmation', 'bol', 'pod'].includes(d.type));
  return (
    <div className="flex flex-col gap-1 text-xs">
      <span className="font-semibold text-ink">Proof</span>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={input} type="file" accept="application/pdf,image/*" className="hidden" aria-label="Proof file" onChange={(e) => { const f = e.target.files?.[0]; if (f) onUpload(f); e.target.value = ''; }} />
        <Button variant="secondary" size="sm" icon={<Paperclip />} loading={uploading} onClick={() => input.current?.click()}>Attach proof</Button>
        {row.newFiles.map((f) => (
          <span key={f.fileId} className="inline-flex items-center gap-1 rounded-full bg-surface-muted px-2 py-0.5 text-secondary">
            {f.fileName}
            <button type="button" className="text-muted hover:text-ink" aria-label={`Remove ${f.fileName}`} onClick={() => onChange({ newFiles: row.newFiles.filter((x) => x.fileId !== f.fileId) })}>×</button>
          </span>
        ))}
        {row.newFiles.length === 0 ? <span className="text-muted">The layover receipt, detention sheet or broker approval.</span> : null}
      </div>
      {backup.length ? (
        <details>
          <summary className="cursor-pointer text-muted">Or use a document already on the load ({row.supportingDocumentIds.length})</summary>
          <div className="mt-1 flex flex-col gap-1">
            {backup.map((d) => (
              <label key={d.id} className="flex items-center gap-2">
                <Checkbox checked={row.supportingDocumentIds.includes(d.id)} onCheckedChange={(v) => onChange({ supportingDocumentIds: v === true ? [...row.supportingDocumentIds, d.id] : row.supportingDocumentIds.filter((x) => x !== d.id) })} aria-label={`Use ${d.fileName}`} />
                <span>{d.fileName} <span className="text-muted">({d.type.replace(/_/g, ' ')})</span></span>
              </label>
            ))}
          </div>
        </details>
      ) : null}
      <span className="text-muted">The RC, BOL and POD of the load go with it as backup.</span>
    </div>
  );
}
