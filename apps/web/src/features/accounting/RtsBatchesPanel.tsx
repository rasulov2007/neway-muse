import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { CircleCheck, Download, FileArchive, Info, Plus, Send, TriangleAlert, Upload, X } from 'lucide-react';
import { useRef, useState } from 'react';
import { RTS_DRAFT_REASON } from '@neway/shared';
import { Alert, Badge, Button, Checkbox, ConfirmDialog, Drawer, FormField, Input, Modal, Textarea, useToast } from '@/design-system';
import {
  cancelRtsBatch,
  createRtsBatch,
  fetchRtsBatch,
  fetchRtsBatches,
  fetchRtsCandidates,
  issueInvoice,
  recordRtsSubmission,
  sendRtsBatch,
  sendRtsTestPackets,
  type RtsBatch,
  type RtsCandidate,
} from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { API_BASE_URL } from '@/lib/api';
import { sessionToken } from '@/lib/session';
import { uploadFile } from '@/lib/files';
import { formatDateTime, formatIsoDate, formatMoney } from '@/lib/format';

/**
 * RTS batches: issued invoices gathered into one package for the factoring company.
 *
 * Not to be confused with Create invoice (a delivered load becomes a bill, in the Billing queue)
 * or a settlement batch (drivers are paid, under Settlements). "Send to RTS" uploads the batch
 * over FTPS (2026-10-19); a batch can still be exported and uploaded by hand. Exporting
 * marks nothing as sent. Recording the submission, with RTS's reference, a note of what was seen
 * or a file, is a separate step, and only that step marks the invoices submitted.
 */

const DOC_TAG: Record<string, string> = { rate_confirmation: 'RC', bol: 'BOL', pod: 'POD', tonu: 'TONU' };
/** A TONU packs its TONU confirmation, never a BOL or a POD (owner, 2026-10-15). */
const docTypesFor = (docs: ReadonlyArray<{ type: string }>): string[] => (docs.some((d) => d.type === 'tonu') ? ['rate_confirmation', 'tonu'] : ['rate_confirmation', 'bol', 'pod']);
const STATUS_WORD: Record<RtsBatch['status'], string> = { prepared: 'Prepared', exported: 'Exported · not sent', submitted: 'Submitted (recorded)', cancelled: 'Cancelled' };
const STATUS_TONE: Record<RtsBatch['status'], 'neutral' | 'warning' | 'success' | 'info'> = { prepared: 'neutral', exported: 'warning', submitted: 'success', cancelled: 'neutral' };
const money = (cents: number) => formatMoney(cents / 100);

/** POSTs for the package with the session, and hands the browser the zip. */
async function downloadPackage(batchId: string, kind: 'export' | 'ftp-export' = 'export'): Promise<string> {
  const token = sessionToken();
  const res = await fetch(`${API_BASE_URL}/accounting/rts/batches/${encodeURIComponent(batchId)}/${kind}`, { method: 'POST', headers: token ? { authorization: `Bearer ${token}` } : undefined });
  if (!res.ok) {
    const body = await res.json().catch(() => null);
    throw new Error(body?.detail ?? body?.message ?? `The package could not be prepared (${res.status}).`);
  }
  const name = res.headers.get('content-disposition')?.match(/filename="([^"]+)"/)?.[1] ?? 'RTS_package.zip';
  const url = URL.createObjectURL(await res.blob());
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
  return name;
}

export function RtsBatchesPanel() {
  const account = useAccount();
  const canEdit = account?.permissions.includes('accounting.edit') ?? false;
  const { toast } = useToast();
  const [testing, setTesting] = useState(false);
  // RTS's test folder (2026-10-20): three TEST packets and their CSV, no record made; the CSV is saved here too.
  const testPackets = useMutation({
    mutationFn: sendRtsTestPackets,
    onSuccess: (r) => {
      setTesting(false);
      const url = URL.createObjectURL(new Blob([r.csv], { type: 'text/csv' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = r.csvName;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
      toast({ tone: 'success', title: 'Test packets sent to RTS', description: `${r.uploaded.join(', ')} on ${r.host}. ${r.csvName} is downloaded for RTS.` });
    },
    onError: (e: unknown) => {
      setTesting(false);
      toast({ tone: 'danger', title: 'Test packets not sent', description: e instanceof Error ? e.message : undefined });
    },
  });
  const queryClient = useQueryClient();
  const batches = useQuery({ queryKey: ['accounting', 'rts-batches'], queryFn: fetchRtsBatches });
  const [creating, setCreating] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);
  const refresh = async () => {
    await queryClient.invalidateQueries({ queryKey: ['accounting'] });
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-start justify-between gap-3 rounded-xl border border-line bg-surface p-4">
        <span className="flex items-start gap-3">
          <span className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary-soft text-primary-text"><FileArchive className="size-4" /></span>
          <span className="text-sm">
            <span className="block font-semibold text-ink">RTS batches</span>
            <span className="block text-xs text-muted">Issued invoices, packaged for RTS with their RC, BOL and POD. Send to RTS uploads them over FTPS (set the RTS account in Settings › Integrations); RTS sends nothing back, so NeWay records what went and when.</span>
          </span>
        </span>
        {canEdit ? (
          <span className="flex flex-wrap gap-2">
            <Button variant="outline" icon={<Send />} loading={testPackets.isPending} onClick={() => setTesting(true)} data-testid="rts-test-packets">Send RTS test packets</Button>
            <Button variant="primary" icon={<Plus />} onClick={() => setCreating(true)}>Create RTS batch</Button>
          </span>
        ) : <span className="text-xs text-muted">Creating batches needs the Accounting edit permission.</span>}
        <ConfirmDialog
          open={testing}
          onOpenChange={(o) => { if (!o && !testPackets.isPending) setTesting(false); }}
          title="Send three test packets to RTS?"
          description="TEST-0001, TEST-0002 and TEST-0003 - each an invoice with the NOA stamp, RC, BOL and POD marked TEST - and their CSV go to the RTS test folder. Only a test account sends them. No load, invoice or batch is created; the CSV downloads here for RTS."
          confirmLabel="Send test packets"
          onConfirm={() => testPackets.mutateAsync().then(() => undefined)}
        />
      </div>

      <div className="overflow-x-auto rounded-xl border border-line bg-surface">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line text-left text-xs text-muted">
              <th className="px-3 py-2 font-semibold">Batch</th>
              <th className="px-3 py-2 font-semibold">Created</th>
              <th className="px-3 py-2 text-right font-semibold">Invoices</th>
              <th className="px-3 py-2 text-right font-semibold">Total</th>
              <th className="px-3 py-2 font-semibold">Status</th>
              <th className="px-3 py-2 font-semibold">Package</th>
              <th className="px-3 py-2 font-semibold">RTS reference</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody>
            {batches.isPending ? (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-xs text-muted">Loading…</td></tr>
            ) : (batches.data ?? []).length === 0 ? (
              <tr><td colSpan={8} className="px-3 py-6 text-center text-xs text-muted">No RTS batches yet. Create one from the issued invoices.</td></tr>
            ) : (
              (batches.data ?? []).map((b) => (
                <tr key={b.id} className="border-b border-line-soft last:border-0" data-testid={`rts-batch-${b.batchNumber}`}>
                  <td className="px-3 py-2 font-semibold text-ink">{b.batchNumber}</td>
                  <td className="px-3 py-2 text-secondary">{formatDateTime(b.createdAt)}<span className="block text-xs text-muted">{b.createdBy}</span></td>
                  <td className="px-3 py-2 text-right tabular-nums">{b.count}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{money(b.totalCents)}</td>
                  <td className="px-3 py-2"><Badge tone={STATUS_TONE[b.status]} size="sm">{STATUS_WORD[b.status]}</Badge></td>
                  <td className="px-3 py-2 text-xs text-secondary">{b.exports.length > 0 ? `${b.exports.length} export${b.exports.length === 1 ? '' : 's'} · last ${formatDateTime(b.exports.at(-1)!.at)}` : 'Not exported'}</td>
                  <td className="px-3 py-2 text-xs text-secondary">{b.submission?.reference ?? (b.submission ? 'evidence on file' : '—')}</td>
                  <td className="px-3 py-2 text-right"><Button variant="secondary" size="sm" onClick={() => setOpenId(b.id)}>Open</Button></td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>

      {creating ? <CreateBatchDialog onClose={() => setCreating(false)} onCreated={async (b) => { await refresh(); setCreating(false); setOpenId(b.id); }} /> : null}
      {openId ? <BatchDrawer id={openId} canEdit={canEdit} onClose={() => setOpenId(null)} onChanged={refresh} /> : null}
    </div>
  );
}

/** Select eligible issued invoices; every other invoice says why it cannot be selected. */
function CreateBatchDialog({ onClose, onCreated }: { onClose: () => void; onCreated: (b: RtsBatch) => Promise<void> }) {
  const { toast } = useToast();
  // Always fresh: what can be selected changes the moment another batch is created or exported.
  const candidates = useQuery({ queryKey: ['accounting', 'rts-candidates'], queryFn: fetchRtsCandidates, staleTime: 0, gcTime: 0, refetchOnMount: 'always' });
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [showIneligible, setShowIneligible] = useState(true);
  const rows = candidates.data ?? [];
  const eligible = rows.filter((r) => r.eligibility.eligible);
  // A draft with nothing else against it can go too: it is issued when the batch is created
  // (owner, 2026-10-28: select all = everything not yet sent to RTS).
  const selectable = rows.filter((r) => r.eligibility.eligible || draftReady(r));
  const [confirming, setConfirming] = useState(false);
  const chosen = rows.filter((r) => picked.has(r.invoiceId));
  const total = chosen.reduce((t, r) => t + r.totalCents, 0);
  const missing = chosen.filter((r) => !r.documents.some((d) => d.type === 'rate_confirmation' && d.stillCurrent) || !r.documents.some((d) => d.type === 'pod' && d.stillCurrent));
  const warnings = chosen.flatMap((r) => r.eligibility.warnings.map((w) => `${r.invoiceNumber}: ${w}`));
  const draftsChosen = chosen.filter(draftReady);
  const create = useMutation({
    mutationFn: async () => {
      const ids = chosen.filter((r) => !draftReady(r)).map((r) => r.invoiceId);
      const refused: string[] = [];
      for (const r of draftsChosen) {
        try {
          const out = await issueInvoice({ invoiceId: r.invoiceId });
          if (out.ok) ids.push(out.invoice.id);
          else refused.push(`${r.invoiceNumber}: ${out.blocked ?? 'refused'}`);
        } catch (e) {
          refused.push(`${r.invoiceNumber}: ${e instanceof Error ? e.message : 'refused'}`);
        }
      }
      if (ids.length === 0) throw new Error(refused.join(' · ') || 'Nothing to batch');
      const batch = await createRtsBatch(ids);
      if (refused.length) toast({ tone: 'warning', title: 'Some drafts were not issued', description: refused.join(' · ') });
      return batch;
    },
    onSuccess: async (b) => {
      toast({ tone: 'success', title: `${b.batchNumber} created`, description: `${b.count} invoice(s), ${money(b.totalCents)}. Nothing has been sent; export the package next.` });
      await onCreated(b);
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Batch not created', description: e instanceof Error ? e.message : undefined }),
  });
  const toggle = (id: string) => setPicked((p) => { const n = new Set(p); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const listed = showIneligible ? rows : eligible;

  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="xl"
      title="Create RTS batch"
      description="Select issued invoices to package for RTS. Only invoices that are issued, current, not already in a batch and carry their RC and POD can be selected."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={chosen.length === 0 || create.isPending} loading={create.isPending} onClick={() => (draftsChosen.length ? setConfirming(true) : create.mutate())}>
            Create RTS batch{chosen.length ? ` (${chosen.length})` : ''}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <div className="grid grid-cols-3 gap-2 rounded-lg bg-surface-muted p-3 text-sm" data-testid="rts-selection-summary">
          <span><span className="block text-xs text-muted">Invoices selected</span><span className="text-lg font-semibold tabular-nums text-ink">{chosen.length}</span></span>
          <span><span className="block text-xs text-muted">Total amount</span><span className="text-lg font-semibold tabular-nums text-ink">{money(total)}</span></span>
          <span><span className="block text-xs text-muted">Required documents</span><span className="text-sm font-semibold text-ink">{chosen.length === 0 ? '—' : missing.length === 0 ? 'RC and POD on every invoice' : `${missing.length} missing`}</span></span>
        </div>
        {warnings.length ? <Alert tone="warning" title="Worth checking before export" description={warnings.join(' · ')} /> : null}
        <label className="flex items-center gap-2 text-xs text-secondary">
          <Checkbox checked={showIneligible} onCheckedChange={(v) => setShowIneligible(v === true)} aria-label="Show invoices that cannot be selected" />
          Show invoices that cannot be selected, and why ({rows.length - eligible.length})
        </label>
        {candidates.isPending ? <p className="text-xs text-muted">Loading…</p> : null}
        <div className="max-h-[420px] overflow-y-auto rounded-lg border border-line">
          <table className="w-full text-sm">
            <thead className="sticky top-0 bg-surface">
              <tr className="border-b border-line text-left text-xs text-muted">
                <th className="w-10 px-3 py-2">
                  {/* Select all (owner, 2026-10-23): every invoice that can go in a batch. */}
                  {selectable.length > 0 ? (
                    <Checkbox
                      aria-label="Select all"
                      checked={selectable.every((r) => picked.has(r.invoiceId)) ? true : selectable.some((r) => picked.has(r.invoiceId)) ? 'indeterminate' : false}
                      onCheckedChange={() => setPicked((p) => (selectable.every((r) => p.has(r.invoiceId)) ? new Set() : new Set(selectable.map((r) => r.invoiceId))))}
                    />
                  ) : null}
                </th>
                <th className="px-3 py-2 font-semibold">Invoice</th>
                <th className="px-3 py-2 font-semibold">Load</th>
                <th className="px-3 py-2 font-semibold">Debtor</th>
                <th className="px-3 py-2 font-semibold">Documents</th>
                <th className="px-3 py-2 text-right font-semibold">Amount</th>
              </tr>
            </thead>
            <tbody>
              {listed.map((r) => (
                <CandidateRow key={r.invoiceId} r={r} picked={picked.has(r.invoiceId)} onToggle={() => toggle(r.invoiceId)} />
              ))}
              {listed.length === 0 && !candidates.isPending ? <tr><td colSpan={6} className="px-3 py-6 text-center text-xs text-muted">No issued invoices.</td></tr> : null}
            </tbody>
          </table>
        </div>
        <ConfirmDialog
          open={confirming}
          onOpenChange={(o) => { if (!o) setConfirming(false); }}
          title={`Issue ${draftsChosen.length} draft${draftsChosen.length === 1 ? '' : 's'} and create the batch?`}
          description={`${draftsChosen.map((r) => r.invoiceNumber).join(', ')} ${draftsChosen.length === 1 ? 'is' : 'are'} still a draft. ${draftsChosen.length === 1 ? 'It is' : 'They are'} issued first - posted to receivables and revenue - then put in the batch with the rest. Nothing is sent to RTS until you send the batch.`}
          confirmLabel="Issue and create batch"
          onConfirm={() => { setConfirming(false); create.mutate(); }}
        />
      </div>
    </Modal>
  );
}

/** A draft whose only reason is being a draft: issuing it makes it eligible. */
function draftReady(r: RtsCandidate): boolean {
  return r.status === 'draft' && r.eligibility.reasons.length === 1 && r.eligibility.reasons[0] === RTS_DRAFT_REASON;
}

function CandidateRow({ r, picked, onToggle }: { r: RtsCandidate; picked: boolean; onToggle: () => void }) {
  const draft = draftReady(r);
  const ok = r.eligibility.eligible || draft;
  return (
    <tr className={ok ? 'border-b border-line-soft' : 'border-b border-line-soft bg-surface-muted/60'} data-testid={`rts-candidate-${r.invoiceNumber}`} data-eligible={ok ? 'yes' : 'no'}>
      <td className="px-3 py-2 align-top">
        <Checkbox checked={picked} disabled={!ok} onCheckedChange={onToggle} aria-label={ok ? `Select ${r.invoiceNumber}` : `${r.invoiceNumber} cannot be selected`} />
      </td>
      <td className="px-3 py-2 align-top">
        <span className="block font-semibold text-ink">{r.invoiceNumber}</span>
        <span className="block text-xs text-muted">{r.status.replace(/_/g, ' ')}{r.issuedOn ? ` · issued ${formatIsoDate(r.issuedOn)}` : ''}</span>
        {draft ? (
          <span className="mt-1 flex items-start gap-1 text-xs text-muted" data-testid="rts-draft-note">
            <Info className="mt-0.5 size-3 shrink-0" /> Draft: issued when the batch is created.
          </span>
        ) : null}
        {!ok ? (
          <span className="mt-1 flex items-start gap-1 text-xs text-warning-text" data-testid="rts-ineligible-reason">
            <Info className="mt-0.5 size-3 shrink-0" /> {r.eligibility.reasons.join(' ')}
          </span>
        ) : null}
      </td>
      <td className="px-3 py-2 align-top text-secondary">{r.loadNumber}</td>
      <td className="px-3 py-2 align-top text-secondary">{r.debtor}</td>
      <td className="px-3 py-2 align-top">
        <span className="flex flex-wrap gap-1">
          {docTypesFor(r.documents).map((t) => {
            const d = r.documents.find((x) => x.type === t && x.stillCurrent);
            return <Badge key={t} tone={d ? 'success' : t === 'bol' ? 'neutral' : 'danger'} size="sm">{DOC_TAG[t]}{d ? '' : ' missing'}</Badge>;
          })}
        </span>
      </td>
      <td className="px-3 py-2 text-right align-top tabular-nums">{money(r.totalCents)}</td>
    </tr>
  );
}

/** One batch: review, export, record the submission, or cancel. Its history is kept. */
function BatchDrawer({ id, canEdit, onClose, onChanged }: { id: string; canEdit: boolean; onClose: () => void; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const query = useQuery({ queryKey: ['accounting', 'rts-batch', id], queryFn: () => fetchRtsBatch(id) });
  const [recording, setRecording] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const [sending, setSending] = useState(false);
  const b = query.data;
  // The exact files the FTPS upload sends, for a test upload by hand (RTS format, 2026-10-19).
  const ftpFiles = useMutation({
    mutationFn: () => downloadPackage(id, 'ftp-export'),
    onSuccess: async (name) => {
      await query.refetch();
      toast({ tone: 'success', title: 'RTS files downloaded', description: `${name}: one <invoice#>.pdf per invoice and the RTS CSV. Nothing was sent.` });
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Files not prepared', description: e instanceof Error ? e.message : undefined }),
  });
  const send = useMutation({
    mutationFn: () => sendRtsBatch(id, b!.version),
    onSuccess: async (after) => {
      setSending(false);
      await query.refetch();
      await onChanged();
      const test = after.ftpSends?.at(-1)?.test === true;
      toast({
        tone: 'success',
        title: test ? 'Sent to the RTS test folder' : 'Sent to RTS',
        description: test ? 'A test upload: nothing is marked submitted. Download RTS files to send RTS the CSV.' : 'Every PDF, then the CSV, is on the RTS server. The invoices are recorded as submitted.',
      });
    },
    onError: (e: unknown) => {
      setSending(false);
      toast({ tone: 'danger', title: 'Not sent to RTS', description: e instanceof Error ? e.message : undefined });
    },
  });
  const exportPkg = useMutation({
    mutationFn: () => downloadPackage(id),
    onSuccess: async (name) => {
      await query.refetch();
      await onChanged();
      toast({ tone: 'success', title: 'RTS package downloaded', description: `${name}. Nothing has been sent to RTS. Upload it there, then record the submission here.` });
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Package not exported', description: e instanceof Error ? e.message : undefined }),
  });

  return (
    <Drawer open onOpenChange={(o) => { if (!o) onClose(); }} size="lg" title={b ? `RTS batch ${b.batchNumber}` : 'RTS batch'} description={b ? `Created ${formatDateTime(b.createdAt)} by ${b.createdBy}` : undefined}>
      {!b ? <p className="text-xs text-muted">Loading…</p> : (
        <div className="flex flex-col gap-4 text-sm">
          <div className="grid grid-cols-3 gap-2 rounded-lg bg-surface-muted p-3" data-testid="rts-batch-summary">
            <span><span className="block text-xs text-muted">Invoices</span><span className="text-lg font-semibold tabular-nums text-ink">{b.count}</span></span>
            <span><span className="block text-xs text-muted">Total amount</span><span className="text-lg font-semibold tabular-nums text-ink">{money(b.totalCents)}</span></span>
            <span><span className="block text-xs text-muted">Status</span><Badge tone={STATUS_TONE[b.status]}>{STATUS_WORD[b.status]}</Badge></span>
          </div>

          {b.status === 'exported' ? <Alert tone="warning" title="Exported, not sent" description="A package exists. RTS has not been told anything by this system. Upload the package to RTS, then record the submission with their reference or what you saw." /> : null}
          {b.status === 'submitted' && b.submission ? (
            <Alert tone="success" title="Submission recorded" description={`${b.submission.by} recorded it as submitted on ${formatIsoDate(b.submission.submittedOn)}${b.submission.reference ? ` · RTS reference ${b.submission.reference}` : ''}${b.submission.evidence ? ` · ${b.submission.evidence}` : ''}${b.submission.evidenceFileId ? ' · evidence file on record' : ''}.`} />
          ) : null}
          {b.status === 'cancelled' && b.cancellation ? <Alert tone="info" title="Cancelled" description={`${b.cancellation.by}, ${formatDateTime(b.cancellation.at)}: ${b.cancellation.reason}. Its invoices can be batched again.`} /> : null}

          <div className="overflow-hidden rounded-lg border border-line">
            <table className="w-full text-sm">
              <thead><tr className="border-b border-line text-left text-xs text-muted"><th className="px-3 py-2 font-semibold">Invoice</th><th className="px-3 py-2 font-semibold">Load</th><th className="px-3 py-2 font-semibold">Documents</th><th className="px-3 py-2 text-right font-semibold">Amount</th></tr></thead>
              <tbody>
                {b.lines.map((l) => (
                  <tr key={l.invoiceId} className="border-b border-line-soft last:border-0">
                    <td className="px-3 py-2"><span className="font-semibold text-ink">{l.invoiceNumber}</span><span className="block text-xs text-muted">{l.debtor}</span></td>
                    <td className="px-3 py-2 text-secondary">{l.loadNumber}</td>
                    <td className="px-3 py-2">
                      <span className="flex flex-wrap gap-1">{docTypesFor(l.documents).map((t) => <Badge key={t} tone={l.documents.some((d) => d.type === t) ? 'success' : t === 'bol' ? 'neutral' : 'danger'} size="sm">{DOC_TAG[t]}</Badge>)}</span>
                      {l.warnings.length ? <span className="mt-1 flex items-start gap-1 text-2xs text-warning-text"><TriangleAlert className="mt-0.5 size-3 shrink-0" />{l.warnings.join(' ')}</span> : null}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">{money(l.totalCents)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {canEdit && b.status !== 'cancelled' ? (
            <div className="flex flex-wrap gap-2">
              {b.status !== 'submitted' ? <Button variant="primary" icon={<Send />} loading={send.isPending} disabled={send.isPending} onClick={() => setSending(true)} data-testid="rts-send">Send to RTS</Button> : null}
              <Button variant="secondary" icon={<Download />} loading={ftpFiles.isPending} disabled={ftpFiles.isPending} onClick={() => ftpFiles.mutate()}>Download RTS files</Button>
              <Button variant="outline" icon={<Download />} loading={exportPkg.isPending} disabled={exportPkg.isPending} onClick={() => exportPkg.mutate()}>Export review package</Button>
              {b.status !== 'submitted' ? <Button variant="secondary" icon={<Send />} disabled={b.exports.length === 0} title={b.exports.length === 0 ? 'Export the package first' : undefined} onClick={() => setRecording(true)}>Record manual submission</Button> : null}
              {b.status !== 'submitted' ? <Button variant="outline" icon={<X />} onClick={() => setCancelling(true)}>Cancel batch</Button> : null}
            </div>
          ) : null}
          {canEdit && b.status !== 'submitted' && b.status !== 'cancelled' && b.exports.length === 0 ? <p className="text-2xs text-muted">Record manual submission becomes available once the package has been exported.</p> : null}

          {b.ftpSends?.length ? (
            <div>
              <p className="text-xs font-semibold text-ink">Sent to RTS</p>
              <ul className="mt-1 flex flex-col gap-0.5 text-xs text-secondary">
                {b.ftpSends.map((s) => <li key={s.at}>{formatDateTime(s.at)} · {s.by} · {s.files} PDF(s) + {s.csvName} · {s.host} as {s.clientNumber}{s.test ? ' · TEST folder, nothing marked submitted' : ''}</li>)}
              </ul>
            </div>
          ) : null}
          <div>
            <p className="text-xs font-semibold text-ink">Package exports</p>
            {b.exports.length === 0 ? <p className="text-xs text-muted">None yet.</p> : (
              <ul className="mt-1 flex flex-col gap-0.5 text-xs text-secondary">
                {b.exports.map((e) => <li key={e.at}>{formatDateTime(e.at)} · {e.by} · {e.fileName} · {Math.round(e.bytes / 1024)} KB · sha256 {e.sha256.slice(0, 16)}…</li>)}
              </ul>
            )}
          </div>
          <div>
            <p className="text-xs font-semibold text-ink">History</p>
            <ul className="mt-1 flex flex-col gap-0.5 text-xs text-secondary">
              {b.history.map((h, i) => <li key={`${h.at}-${i}`}>{formatDateTime(h.at)} · {h.by} · {h.action.replace(/_/g, ' ')} · {h.detail}</li>)}
            </ul>
          </div>
          <p className="flex items-center gap-1 text-2xs text-muted"><CircleCheck className="size-3" /> Every invoice in this batch links back to it in its own history.</p>
        </div>
      )}
      {recording && b ? <RecordSubmissionDialog batch={b} onClose={() => setRecording(false)} onDone={async () => { setRecording(false); await query.refetch(); await onChanged(); }} /> : null}
      {b ? (
        <ConfirmDialog
          open={sending}
          onOpenChange={(o) => { if (!o && !send.isPending) setSending(false); }}
          title={`Send ${b.batchNumber} to RTS?`}
          description={`${b.count} invoice(s), ${money(b.totalCents)}. Each goes as <invoice#>.pdf with the NOA stamp, RC, BOL and POD, then the CSV - RTS takes the submission the moment the CSV lands, and sends nothing back. RTS takes one submission every 5 minutes.`}
          confirmLabel="Send to RTS"
          onConfirm={() => send.mutateAsync()}
        />
      ) : null}
      {cancelling && b ? <CancelDialog batch={b} onClose={() => setCancelling(false)} onDone={async () => { setCancelling(false); await query.refetch(); await onChanged(); }} /> : null}
    </Drawer>
  );
}

/** The person says how they know: RTS's reference, a note of what they saw, or a file. */
function RecordSubmissionDialog({ batch, onClose, onDone }: { batch: RtsBatch & { version: number }; onClose: () => void; onDone: () => Promise<void> }) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState('');
  const [evidence, setEvidence] = useState('');
  const [fileId, setFileId] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [on, setOn] = useState(new Date().toISOString().slice(0, 10));
  const [uploading, setUploading] = useState(false);
  const ready = Boolean(reference.trim() || evidence.trim() || fileId);
  const save = useMutation({
    mutationFn: () => recordRtsSubmission(batch.id, { reference: reference.trim() || null, evidence: evidence.trim() || null, evidenceFileId: fileId, submittedOn: on, expectedVersion: batch.version }),
    onSuccess: async () => { toast({ tone: 'success', title: `${batch.batchNumber} recorded as submitted`, description: `${batch.count} invoice(s) marked submitted with your evidence.` }); await onDone(); },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not recorded', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} size="md" title={`Record manual submission · ${batch.batchNumber}`} description="Only after you have uploaded the package to RTS yourself. Say how you know: RTS's reference, what you saw, or a screenshot or confirmation file." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ready || save.isPending} loading={save.isPending} onClick={() => save.mutate()}>Record submission</Button></>}>
      <div className="flex flex-col gap-3">
        <FormField label="RTS reference" description="The schedule or batch number RTS gave the upload."><Input value={reference} onChange={(e) => setReference(e.target.value)} placeholder="e.g. the RTS schedule number" /></FormField>
        <FormField label="What you saw" description="When RTS gave no reference."><Textarea rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} placeholder="Uploaded in the RTS portal; confirmation shown on screen" /></FormField>
        <FormField label="Evidence file" description="Optional: a screenshot or confirmation.">
          <div className="flex items-center gap-2">
            <input ref={fileRef} type="file" className="hidden" accept="image/*,.pdf" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; setUploading(true); try { const s = await uploadFile(f); setFileId(s.id); setFileName(f.name); } catch (err) { toast({ tone: 'danger', title: 'Upload failed', description: err instanceof Error ? err.message : undefined }); } finally { setUploading(false); } }} />
            <Button variant="secondary" size="sm" icon={<Upload />} loading={uploading} onClick={() => fileRef.current?.click()}>Attach</Button>
            <span className="text-xs text-muted">{fileName ?? 'None attached'}</span>
          </div>
        </FormField>
        <FormField label="Submitted on"><Input type="date" value={on} onChange={(e) => setOn(e.target.value)} /></FormField>
        {!ready ? <p className="text-2xs text-muted">A submission needs a reference, a note or a file.</p> : null}
      </div>
    </Modal>
  );
}

function CancelDialog({ batch, onClose, onDone }: { batch: RtsBatch & { version: number }; onClose: () => void; onDone: () => Promise<void> }) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const cancel = useMutation({
    mutationFn: () => cancelRtsBatch(batch.id, { reason: reason.trim(), expectedVersion: batch.version }),
    onSuccess: async () => { toast({ tone: 'success', title: `${batch.batchNumber} cancelled`, description: 'Its invoices can be batched again. The batch and its history are kept.' }); await onDone(); },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not cancelled', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} size="sm" title={`Cancel ${batch.batchNumber}`} description="Releases its invoices so they can be batched again. The batch and its history are kept." footer={<><Button variant="secondary" onClick={onClose}>Keep batch</Button><Button variant="primary" disabled={reason.trim().length < 3 || cancel.isPending} loading={cancel.isPending} onClick={() => cancel.mutate()}>Cancel batch</Button></>}>
      <FormField label="Reason"><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} /></FormField>
    </Modal>
  );
}
