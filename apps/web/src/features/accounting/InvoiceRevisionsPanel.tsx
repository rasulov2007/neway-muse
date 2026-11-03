import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Eye, FilePlus2, Lock, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { useMemo, useState } from 'react';
import { Alert, Badge, Button, Checkbox, FormField, Input, Modal, Select, Textarea, useToast } from '@/design-system';
import {
  addInternalNote,
  createRevision,
  discardRevision,
  editInternalNote,
  fetchInvoiceFamily,
  fetchSupplements,
  fetchRevisionOptions,
  getInvoiceFromServer,
  issueRevision,
  setInvoiceNote,
  type RevisionLineInput,
  type ServerInvoice,
} from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { formatDateTime, formatIsoDate, formatMoney } from '@/lib/format';
import { Link } from '@tanstack/react-router';
import { AddChargeAfterInvoicingDialog } from './AddChargeAfterInvoicingDialog';
import { AuthedFileLink } from './AuthedFileLink';
import { ReceiptPreview } from './ReceiptPreview';

/**
 * Versions, revisions and notes for one invoice family.
 *
 * A revision is drafted first - nothing posts - and shows the original total, the revised total
 * and the difference; issuing it posts only the difference and makes it current. Every version
 * keeps its own PDF, exactly as issued, and each can be previewed here.
 *
 * Two notes, never confused. The invoice note is printed on the invoice and travels in the RTS
 * package, so on an issued invoice it changes only by a revision. Internal notes are Accounting's
 * own, with author, time and every earlier wording, and are never printed or sent anywhere.
 */

const CHARGE_TYPES = [
  { value: 'linehaul', label: 'Linehaul' },
  { value: 'detention', label: 'Detention' },
  { value: 'layover', label: 'Layover' },
  { value: 'lumper', label: 'Lumper' },
  { value: 'tonu', label: 'TONU' },
  { value: 'fuel_surcharge', label: 'Fuel surcharge' },
  { value: 'other', label: 'Other' },
];

const cents = (n: number) => Math.round(n * 100);
const money = (c: number) => formatMoney(c / 100);
const signed = (c: number) => `${c >= 0 ? '+' : '-'}${money(Math.abs(c))}`;

export function InvoiceRevisionsPanel({ invoiceId }: { invoiceId: string }) {
  const account = useAccount();
  const canEdit = account?.permissions.includes('accounting.edit') ?? false;
  const queryClient = useQueryClient();
  const inv = useQuery({ queryKey: ['accounting', 'invoice', invoiceId], queryFn: () => getInvoiceFromServer(invoiceId) });
  const family = useQuery({ queryKey: ['accounting', 'invoice-family', invoiceId], queryFn: () => fetchInvoiceFamily(invoiceId), enabled: Boolean(inv.data) });
  const [creating, setCreating] = useState(false);
  const [issuing, setIssuing] = useState<ServerInvoice | null>(null);
  const [preview, setPreview] = useState<ServerInvoice | null>(null);
  const [adding, setAdding] = useState(false);
  const supps = useQuery({ queryKey: ['accounting', 'invoice-supplements', invoiceId], queryFn: () => fetchSupplements(invoiceId), enabled: Boolean(inv.data) });
  const refresh = async () => { await queryClient.invalidateQueries({ queryKey: ['accounting'] }); };

  const versions = family.data ?? [];
  const current = versions.find((v) => v.isCurrent) ?? inv.data ?? null;
  const draft = versions.find((v) => v.status === 'draft' && v.revisionOf);
  // Once RTS has the invoice it is not revised: extra charges go on a supplemental invoice.
  const sent = supps.data?.check.ok === true;
  const supplements = (supps.data?.supplements ?? []).filter((s) => s.id !== invoiceId);

  if (inv.isPending) return <p className="text-xs text-muted">Loading…</p>;
  if (!inv.data || !current) return null;

  return (
    <div className="flex flex-col gap-4" data-testid="invoice-revisions">
      <section className="rounded-xl border border-line bg-surface p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <p className="text-sm font-semibold text-ink">Versions</p>
            <p className="text-xs text-muted">Every version keeps its PDF exactly as it was issued. The original number is {current.family}.</p>
          </div>
          {canEdit && sent ? (
            <Button variant="primary" icon={<Plus />} onClick={() => setAdding(true)}>Add charge after invoicing</Button>
          ) : canEdit && current.status !== 'draft' && !draft && !supps.isPending ? (
            <Button variant="primary" icon={<FilePlus2 />} onClick={() => setCreating(true)}>Create revision</Button>
          ) : null}
        </div>

        {sent ? (
          <p className="mt-2 flex items-center gap-1 text-2xs text-muted"><Lock className="size-3" /> {supps.data?.check.ok ? supps.data.check.why : ''}: it stays exactly as sent. A layover, detention or lumper that came later is billed on a supplemental invoice.</p>
        ) : null}
        {current.supplementOf ? (
          <Alert tone="info" className="mt-3" title={`Supplemental invoice to ${current.supplementOf.invoiceNumber}`} description={`Charges billed after ${current.supplementOf.invoiceNumber} went to RTS: ${current.supplementOf.reason}. ${current.supplementOf.invoiceNumber} is unchanged.`} />
        ) : null}

        {current.priorSubmission ? (
          <Alert tone="info" className="mt-3" title={`RTS already has ${current.priorSubmission.invoiceNumber}`} description={`Recorded ${current.priorSubmission.status}${current.priorSubmission.reference ? ` · reference ${current.priorSubmission.reference}` : ''}${current.priorSubmission.fundedGross ? ` · funded ${formatMoney(current.priorSubmission.fundedGross)}` : ''}. This revision has to be submitted to RTS separately, and only the adjustment is new funding.`} />
        ) : null}

        <table className="mt-3 w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="py-2 pr-3 font-semibold">Number</th>
              <th className="py-2 pr-3 font-semibold">Status</th>
              <th className="py-2 pr-3 font-semibold">Issued</th>
              <th className="py-2 pr-3 font-semibold">Reason</th>
              <th className="py-2 pr-3 text-right font-semibold">Total</th>
              <th className="py-2 pr-3 text-right font-semibold">Change</th>
              <th className="py-2" />
            </tr>
          </thead>
          <tbody>
            {versions.filter((v) => v.status !== 'void' || v.revisionOf).map((v) => (
              <tr key={v.id} className="border-b border-line-soft last:border-0" data-testid={`version-${v.invoiceNumber}`}>
                <td className="py-2 pr-3 font-semibold text-ink">{v.invoiceNumber}{v.isCurrent ? <Badge tone="info" size="sm" className="ml-2">Current</Badge> : null}</td>
                <td className="py-2 pr-3"><Badge tone={v.status === 'draft' ? 'warning' : v.status === 'superseded' || v.status === 'void' ? 'neutral' : v.status === 'credit' ? 'warning' : 'success'} size="sm">{v.status === 'draft' ? 'Draft · nothing posted' : v.status.replace(/_/g, ' ')}</Badge></td>
                <td className="py-2 pr-3 text-secondary">{v.issuedOn ? formatIsoDate(v.issuedOn) : '—'}</td>
                <td className="py-2 pr-3 text-secondary">{v.revisionOf?.reason ?? (v.revision === 1 ? 'Original' : '—')}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(v.total)}</td>
                <td className="py-2 pr-3 text-right tabular-nums">{v.revisionOf ? signed(cents(v.revisionOf.adjustment)) : ''}</td>
                <td className="py-2 text-right">
                  <span className="inline-flex gap-1">
                    <Button variant="secondary" size="sm" icon={<Eye />} onClick={() => setPreview(v)}>Preview</Button>
                    <AuthedFileLink path={`/accounting/invoices/${v.id}/pdf`} fileName={`${v.invoiceNumber}.pdf`} className="inline-flex h-8 items-center rounded-lg border border-line px-2 text-xs font-semibold text-primary-text">PDF</AuthedFileLink>
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>

        {draft ? <DraftBanner draft={draft} current={versions.find((v) => v.id === draft.revisionOf?.invoiceId) ?? current} canEdit={canEdit} onIssue={() => setIssuing(draft)} onChanged={refresh} /> : null}

        {current.creditBalance ? (
          <Alert tone="warning" className="mt-3" title={`Credit of ${formatMoney(current.creditBalance)} owed to ${current.billToName}`} description="Payments received exceed the revised total. The credit is held on the invoice; nothing has been refunded. Apply it or refund it through Accounting." />
        ) : null}
      </section>

      {supplements.length > 0 ? (
        <section className="rounded-xl border border-line bg-surface p-4" data-testid="supplemental-invoices">
          <p className="text-sm font-semibold text-ink">Supplemental invoices</p>
          <p className="text-xs text-muted">Charges billed for this load after {current.supplementOf?.invoiceNumber ?? current.invoiceNumber} went to RTS. Each is its own invoice: issued, sent to RTS and funded on its own.</p>
          <table className="mt-3 w-full text-sm">
            <thead>
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="py-2 pr-3 font-semibold">Number</th>
                <th className="py-2 pr-3 font-semibold">Status</th>
                <th className="py-2 pr-3 font-semibold">Charges</th>
                <th className="py-2 pr-3 font-semibold">RTS</th>
                <th className="py-2 pr-3 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              {supplements.map((s) => (
                <tr key={s.id} className="border-b border-line-soft last:border-0" data-testid={`supplement-${s.invoiceNumber}`}>
                  <td className="py-2 pr-3 font-semibold"><Link to="/accounting/invoices/$invoiceId" params={{ invoiceId: s.id }} className="text-primary-text hover:underline">{s.invoiceNumber}</Link></td>
                  <td className="py-2 pr-3"><Badge tone={s.status === 'draft' ? 'warning' : s.status === 'void' ? 'neutral' : s.status === 'funded' || s.status === 'paid' ? 'success' : 'info'} size="sm">{s.status.replace(/_/g, ' ')}</Badge></td>
                  <td className="py-2 pr-3 text-secondary">{s.lines.map((l) => l.description).join(', ')}</td>
                  <td className="py-2 pr-3 text-secondary">{s.rtsBatch ? s.rtsBatch.batchNumber : '—'}{s.submission && s.submission.status !== 'prepared' ? ` · ${s.submission.status}` : ''}</td>
                  <td className="py-2 pr-3 text-right tabular-nums">{formatMoney(s.total)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      ) : null}

      <InvoiceNoteSection invoice={draft ?? current} canEdit={canEdit} onChanged={refresh} />
      <InternalNotesSection invoice={current} canEdit={canEdit} onChanged={refresh} />

      {adding ? <AddChargeAfterInvoicingDialog invoice={current} nextSequence={(supps.data?.supplements ?? []).reduce((m, s) => Math.max(m, s.supplementOf?.sequence ?? 0), 0) + 1} onClose={() => setAdding(false)} onDone={async () => { setAdding(false); await refresh(); }} /> : null}
      {creating ? <CreateRevisionDialog invoice={current} onClose={() => setCreating(false)} onCreated={async () => { setCreating(false); await refresh(); }} /> : null}
      {issuing ? <IssueRevisionDialog draft={issuing} previous={versions.find((v) => v.id === issuing.revisionOf?.invoiceId) ?? current} onClose={() => setIssuing(null)} onIssued={async () => { setIssuing(null); await refresh(); }} /> : null}
      {preview ? (
        <Modal open onOpenChange={(o) => (o ? undefined : setPreview(null))} size="lg" title={`${preview.invoiceNumber}${preview.status === 'draft' ? ' · draft' : ''}`} description={preview.issuedPdf ? `As issued ${formatDateTime(preview.issuedPdf.at)}` : preview.status === 'draft' ? 'Draft preview; not issued' : 'Rendered from the record'}>
          <ReceiptPreview key={preview.id} url={`/api/v1/accounting/invoices/${encodeURIComponent(preview.id)}/pdf`} fileName={`${preview.invoiceNumber}.pdf`} />
        </Modal>
      ) : null}
    </div>
  );
}

function DraftBanner({ draft, current, canEdit, onIssue, onChanged }: { draft: ServerInvoice; current: ServerInvoice; canEdit: boolean; onIssue: () => void; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const [discarding, setDiscarding] = useState(false);
  const [reason, setReason] = useState('');
  const discard = useMutation({
    mutationFn: () => discardRevision(draft.id, reason.trim()),
    onSuccess: async (r) => { if (!r.ok) { toast({ tone: 'danger', title: 'Not discarded', description: r.blocked }); return; } toast({ tone: 'success', title: `${draft.invoiceNumber} discarded`, description: 'Kept on record as void; the issued invoice is unchanged.' }); await onChanged(); },
  });
  const delta = cents(draft.total) - cents(current.total);
  return (
    <div className="mt-3 rounded-lg border border-warning-soft bg-warning-soft/40 p-3" data-testid="draft-revision">
      <p className="text-sm font-semibold text-ink">{draft.invoiceNumber} is a draft revision · nothing has been posted</p>
      <p className="text-xs text-secondary">{draft.revisionOf?.reason}</p>
      <dl className="mt-2 grid grid-cols-3 gap-2 text-sm">
        <div><dt className="text-xs text-muted">Original total ({current.invoiceNumber})</dt><dd className="font-semibold tabular-nums">{formatMoney(current.total)}</dd></div>
        <div><dt className="text-xs text-muted">Revised total</dt><dd className="font-semibold tabular-nums">{formatMoney(draft.total)}</dd></div>
        <div><dt className="text-xs text-muted">Difference</dt><dd className="font-semibold tabular-nums">{signed(delta)}</dd></div>
      </dl>
      {canEdit ? (
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" icon={<Send />} onClick={onIssue}>Issue revision</Button>
          {!discarding ? <Button variant="outline" icon={<Trash2 />} onClick={() => setDiscarding(true)}>Discard draft</Button> : (
            <span className="flex flex-1 items-center gap-2">
              <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why it is being discarded" aria-label="Discard reason" />
              <Button variant="secondary" size="sm" disabled={reason.trim().length < 3} loading={discard.isPending} onClick={() => discard.mutate()}>Discard</Button>
            </span>
          )}
        </div>
      ) : null}
    </div>
  );
}

function IssueRevisionDialog({ draft, previous, onClose, onIssued }: { draft: ServerInvoice; previous: ServerInvoice; onClose: () => void; onIssued: () => Promise<void> }) {
  const { toast } = useToast();
  const delta = cents(draft.total) - cents(previous.total);
  const paid = cents(previous.paid ?? 0);
  const after = cents(draft.total) - paid;
  const noteOnly = delta === 0 && JSON.stringify(draft.lines.map((l) => [l.chargeType, l.amount])) === JSON.stringify(previous.lines.map((l) => [l.chargeType, l.amount]));
  const issue = useMutation({
    mutationFn: () => issueRevision(draft.id, draft.updatedAt),
    onSuccess: async (r) => {
      if (!r.ok) { toast({ tone: 'danger', title: 'Not issued', description: r.blocked }); return; }
      toast({ tone: 'success', title: r.alreadyIssued ? `${draft.invoiceNumber} was already issued` : `${draft.invoiceNumber} issued`, description: r.alreadyIssued ? 'Nothing was posted twice.' : noteOnly ? 'Nothing posted: no charge changed.' : `${signed(delta)} posted.` });
      await onIssued();
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not issued', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} size="md" title={`Issue ${draft.invoiceNumber}`} description={`Replaces ${previous.invoiceNumber}. Only the difference posts; ${previous.invoiceNumber} is kept with its PDF, payments and history.`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" loading={issue.isPending} disabled={issue.isPending} onClick={() => issue.mutate()}>Issue revision</Button></>}>
      <dl className="grid grid-cols-2 gap-3 text-sm" data-testid="issue-revision-summary">
        <div><dt className="text-xs text-muted">Original total</dt><dd className="font-semibold tabular-nums">{formatMoney(previous.total)}</dd></div>
        <div><dt className="text-xs text-muted">Revised total</dt><dd className="font-semibold tabular-nums">{formatMoney(draft.total)}</dd></div>
        <div><dt className="text-xs text-muted">Accounting posts</dt><dd className="font-semibold tabular-nums">{noteOnly ? 'Nothing (note-only)' : signed(delta)}</dd></div>
        <div><dt className="text-xs text-muted">Payments received</dt><dd className="font-semibold tabular-nums">{money(paid)}</dd></div>
        <div className="col-span-2"><dt className="text-xs text-muted">After issuing</dt><dd className="font-semibold tabular-nums">{after >= 0 ? `${money(after)} outstanding` : `${money(-after)} credit owed to the customer (not refunded)`}</dd></div>
      </dl>
    </Modal>
  );
}

interface EditLine extends RevisionLineInput { key: string }

function CreateRevisionDialog({ invoice, onClose, onCreated }: { invoice: ServerInvoice; onClose: () => void; onCreated: () => Promise<void> }) {
  const { toast } = useToast();
  const options = useQuery({ queryKey: ['accounting', 'revision-options', invoice.id], queryFn: () => fetchRevisionOptions(invoice.id) });
  const [reason, setReason] = useState('');
  const [note, setNote] = useState(invoice.invoiceNote ?? '');
  const [lines, setLines] = useState<EditLine[]>(() => invoice.lines.map((l, i) => ({ key: `l${i}`, chargeType: l.chargeType, description: l.description, amount: l.amount, loadChargeId: (l as { loadChargeId?: string | null }).loadChargeId ?? null, supportingDocumentIds: ((l as { supportingDocuments?: Array<{ id: string }> }).supportingDocuments ?? []).map((d) => d.id) })));
  const total = lines.reduce((t, l) => t + cents(Number(l.amount) || 0), 0);
  const delta = total - cents(invoice.total);
  const linesChanged = JSON.stringify(lines.map((l) => [l.chargeType, cents(l.amount)])) !== JSON.stringify(invoice.lines.map((l) => [l.chargeType, cents(l.amount)]));
  const noteChanged = (note.trim() || null) !== (invoice.invoiceNote?.trim() || null);
  const used = useMemo(() => new Set(lines.map((l) => l.loadChargeId).filter(Boolean)), [lines]);
  const update = (key: string, patch: Partial<EditLine>) => setLines((ls) => ls.map((l) => (l.key === key ? { ...l, ...patch } : l)));
  const save = useMutation({
    mutationFn: () => createRevision(invoice.id, { reason: reason.trim(), lines: lines.map(({ key: _k, ...l }) => ({ ...l, amount: Number(l.amount) })), invoiceNote: note.trim() ? note : null, expectedUpdatedAt: invoice.updatedAt }),
    onSuccess: async (r) => {
      if (!r.ok) { toast({ tone: 'danger', title: 'Revision not created', description: r.blocked }); return; }
      toast({ tone: 'success', title: r.existing ? `${r.invoice.invoiceNumber} already drafted` : `${r.invoice.invoiceNumber} drafted`, description: 'Nothing has been posted. Issue it when it is right.' });
      await onCreated();
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Revision not created', description: e instanceof Error ? e.message : undefined }),
  });
  const ready = reason.trim().length >= 3 && lines.length > 0 && lines.every((l) => l.description.trim() && Number.isFinite(Number(l.amount))) && (linesChanged || noteChanged);

  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="xl"
      title={`Create revision of ${invoice.invoiceNumber}`}
      description={`Drafts ${invoice.family.replace(/^([A-Za-z]+)-/, `$1${invoice.revision + 1}-`)}. Nothing posts until you issue it; ${invoice.invoiceNumber} stays as issued.`}
      footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ready || save.isPending} loading={save.isPending} onClick={() => save.mutate()}>Create draft revision</Button></>}
    >
      <div className="flex flex-col gap-4">
        {invoice.submission && invoice.submission.status !== 'prepared' ? (
          <Alert tone="info" title={`RTS already has ${invoice.invoiceNumber} (${invoice.submission.status})`} description="The revision will need its own submission to RTS; only the adjustment is new funding. RTS has not confirmed how it takes revisions." />
        ) : null}
        <FormField label="Reason for the revision" description="Printed on the revised invoice."><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Detention approved by the broker after delivery" /></FormField>

        <div>
          <p className="text-sm font-semibold text-ink">Charges</p>
          <div className="mt-2 flex flex-col gap-2">
            {lines.map((l) => (
              <div key={l.key} className="grid grid-cols-[140px_minmax(0,1fr)_120px_auto] items-start gap-2 rounded-lg border border-line p-2" data-testid="revision-line">
                <Select aria-label="Charge type" value={l.chargeType} onValueChange={(v) => update(l.key, { chargeType: v })} options={CHARGE_TYPES} />
                <div className="flex flex-col gap-1">
                  <Input aria-label="Description" value={l.description} onChange={(e) => update(l.key, { description: e.target.value })} />
                  {(options.data?.documents ?? []).length ? (
                    <details className="text-xs">
                      <summary className="cursor-pointer text-muted">Supporting documents ({(l.supportingDocumentIds ?? []).length})</summary>
                      <div className="mt-1 flex flex-col gap-1">
                        {(options.data?.documents ?? []).map((d) => (
                          <label key={d.id} className="flex items-center gap-2">
                            <Checkbox checked={(l.supportingDocumentIds ?? []).includes(d.id)} onCheckedChange={(v) => update(l.key, { supportingDocumentIds: v === true ? [...(l.supportingDocumentIds ?? []), d.id] : (l.supportingDocumentIds ?? []).filter((x) => x !== d.id) })} aria-label={`Supporting ${d.fileName}`} />
                            <span>{d.fileName} <span className="text-muted">({d.type.replace(/_/g, ' ')})</span></span>
                          </label>
                        ))}
                      </div>
                    </details>
                  ) : null}
                </div>
                <Input prefix="$" aria-label="Amount" type="number" step="0.01" value={String(l.amount)} onChange={(e) => update(l.key, { amount: e.target.value as unknown as number })} />
                <Button variant="outline" size="sm" icon={<Trash2 />} aria-label="Remove charge" onClick={() => setLines((ls) => ls.filter((x) => x.key !== l.key))} />
              </div>
            ))}
          </div>
          <div className="mt-2 flex flex-wrap gap-2">
            {(options.data?.charges ?? []).filter((c) => !used.has(c.id)).map((c) => (
              <Button key={c.id} variant="secondary" size="sm" icon={<Plus />} onClick={() => setLines((ls) => [...ls, { key: `c${c.id}`, chargeType: c.chargeType, description: c.description, amount: c.amount, loadChargeId: c.id, supportingDocumentIds: [] }])}>
                Add approved {c.description} ({formatMoney(c.amount)})
              </Button>
            ))}
            <Button variant="outline" size="sm" icon={<Plus />} onClick={() => setLines((ls) => [...ls, { key: `n${ls.length}${Date.now()}`, chargeType: 'other', description: '', amount: 0, supportingDocumentIds: [] }])}>Add charge</Button>
          </div>
        </div>

        <FormField label="Invoice note" description="Visible on invoice PDF and customer/RTS package">
          <Textarea rows={3} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Invoice note (printed)" />
        </FormField>

        <dl className="grid grid-cols-3 gap-2 rounded-lg bg-surface-muted p-3 text-sm" data-testid="revision-summary">
          <div><dt className="text-xs text-muted">Original total</dt><dd className="font-semibold tabular-nums">{formatMoney(invoice.total)}</dd></div>
          <div><dt className="text-xs text-muted">Revised total</dt><dd className="font-semibold tabular-nums">{money(total)}</dd></div>
          <div><dt className="text-xs text-muted">Difference</dt><dd className="font-semibold tabular-nums">{signed(delta)}</dd></div>
        </dl>
        {!linesChanged && noteChanged ? <p className="text-xs text-muted">Note-only revision: the printed note changes; nothing will post.</p> : null}
        {!linesChanged && !noteChanged ? <p className="text-xs text-muted">Change a charge or the printed note to create a revision.</p> : null}
      </div>
    </Modal>
  );
}

function InvoiceNoteSection({ invoice, canEdit, onChanged }: { invoice: ServerInvoice; canEdit: boolean; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(invoice.invoiceNote ?? '');
  const save = useMutation({
    mutationFn: () => setInvoiceNote(invoice.id, text.trim() ? text : null, invoice.updatedAt),
    onSuccess: async (r) => { if (!r.ok) { toast({ tone: 'danger', title: 'Not saved', description: r.blocked }); return; } setEditing(false); await onChanged(); toast({ tone: 'success', title: 'Invoice note saved' }); },
  });
  const draft = invoice.status === 'draft';
  return (
    <section className="rounded-xl border border-line bg-surface p-4" data-testid="invoice-note">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">Invoice note</p>
          <p className="text-xs text-muted">Visible on invoice PDF and customer/RTS package</p>
        </div>
        {canEdit && draft && !editing ? <Button variant="secondary" size="sm" icon={<Pencil />} onClick={() => setEditing(true)}>Edit</Button> : null}
      </div>
      {editing ? (
        <div className="mt-2 flex flex-col gap-2">
          <Textarea rows={3} value={text} onChange={(e) => setText(e.target.value)} aria-label="Invoice note (printed)" />
          <div className="flex gap-2"><Button variant="primary" size="sm" loading={save.isPending} onClick={() => save.mutate()}>Save note</Button><Button variant="secondary" size="sm" onClick={() => setEditing(false)}>Cancel</Button></div>
        </div>
      ) : (
        <p className="mt-2 whitespace-pre-wrap text-sm text-ink">{invoice.invoiceNote?.trim() ? invoice.invoiceNote : <span className="text-muted">No note printed.</span>}</p>
      )}
      {!draft ? <p className="mt-2 flex items-center gap-1 text-2xs text-muted"><Lock className="size-3" /> {invoice.invoiceNumber} has been issued: the printed note changes by a revision (a note-only revision posts nothing).</p> : null}
    </section>
  );
}

function InternalNotesSection({ invoice, canEdit, onChanged }: { invoice: ServerInvoice; canEdit: boolean; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const [text, setText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const add = useMutation({ mutationFn: () => addInternalNote(invoice.id, text.trim()), onSuccess: async () => { setText(''); await onChanged(); toast({ tone: 'success', title: 'Internal note added' }); } });
  const edit = useMutation({ mutationFn: () => editInternalNote(invoice.id, editingId!, editText.trim()), onSuccess: async () => { setEditingId(null); await onChanged(); toast({ tone: 'success', title: 'Internal note updated', description: 'The earlier wording is kept.' }); } });
  const notes = invoice.internalNotes ?? [];
  return (
    <section className="rounded-xl border border-line bg-surface p-4" data-testid="internal-notes">
      <p className="text-sm font-semibold text-ink">Internal notes</p>
      <p className="text-xs text-muted">Internal only — not sent to customer or RTS</p>
      <ul className="mt-2 flex flex-col gap-2">
        {notes.length === 0 ? <li className="text-xs text-muted">No internal notes.</li> : null}
        {notes.map((n) => (
          <li key={n.id} className="rounded-lg bg-surface-muted p-2 text-sm">
            {editingId === n.id ? (
              <div className="flex flex-col gap-2">
                <Textarea rows={2} value={editText} onChange={(e) => setEditText(e.target.value)} aria-label="Edit internal note" />
                <div className="flex gap-2"><Button variant="primary" size="sm" loading={edit.isPending} disabled={!editText.trim()} onClick={() => edit.mutate()}>Save</Button><Button variant="secondary" size="sm" onClick={() => setEditingId(null)}>Cancel</Button></div>
              </div>
            ) : (
              <>
                <p className="whitespace-pre-wrap text-ink">{n.text}</p>
                <p className="mt-1 text-2xs text-muted">{n.by} · {formatDateTime(n.at)}{n.edits.length ? ` · edited ${n.edits.length}×` : ''}{canEdit ? <button type="button" className="ml-2 text-primary-text underline" onClick={() => { setEditingId(n.id); setEditText(n.text); }}>Edit</button> : null}</p>
                {n.edits.length ? (
                  <details className="mt-1 text-2xs text-muted"><summary className="cursor-pointer">Earlier wording</summary>{n.edits.map((e, i) => <p key={i}>{formatDateTime(e.at)} · {e.by}: {e.text}</p>)}</details>
                ) : null}
              </>
            )}
          </li>
        ))}
      </ul>
      {canEdit ? (
        <div className="mt-2 flex gap-2">
          <Textarea rows={2} value={text} onChange={(e) => setText(e.target.value)} aria-label="New internal note" placeholder="For Accounting only" />
          <Button variant="secondary" disabled={!text.trim() || add.isPending} loading={add.isPending} onClick={() => add.mutate()}>Add note</Button>
        </div>
      ) : null}
    </section>
  );
}
