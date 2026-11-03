import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleCheck, CircleX, Clock, DollarSign, ExternalLink, FileText, Receipt, Search, TriangleAlert } from 'lucide-react';
import { useMemo, useState } from 'react';
import { invoiceLinesFor, type BillableLoad, type BillingQueue } from '@neway/shared';
import { Alert, Badge, Button, Checkbox, ConfirmDialog, Drawer, FormField, Input, KpiCard, Modal, Select, Textarea, cn, useToast } from '@/design-system';
import {
  createInvoicesFromLoads,
  decideDraftCharge,
  createRtsBatch,
  fetchRtsBatch,
  sendRtsBatch,
  fetchBillingQueue,
  issueInvoice,
  markSubmission,
  resolveBillingException,
  reviseInvoice,
  type BillingQueueRow,
  type ServerInvoice,
} from '@/demo';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { useFileObjectUrl } from '@/lib/files';
import { AuthedFileLink } from './AuthedFileLink';
import { useInvalidateAccounting } from './useAccounting';
import { BillingDocuments } from './BillingDocuments';
import { ReceiptPreview } from './ReceiptPreview';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet } from '@/lib/api-client';

/**
 * The billing queue (§3, §4), laid out as the owner's reference: four tiles, six tabs derived
 * from the loads' actual condition, the loads with their documents and validation, a side
 * panel for the selected load (the RC check side by side, the exception to resolve), and the
 * invoice's revisions once it exists. Nothing here stores a status: every word is derived.
 */

type Pill = 'all' | 'ready_to_bill' | 'needs_documents' | 'needs_review' | 'invoiced';
const PILLS: Array<[Pill, string]> = [['all', 'All'], ['ready_to_bill', 'Ready'], ['needs_documents', 'Needs documents'], ['needs_review', 'Reference review'], ['invoiced', 'Invoiced']];
const INVOICED: BillingQueue[] = ['ready_to_submit', 'submission_issues', 'revisions'];
function inPill(r: BillingQueueRow, pill: Pill): boolean {
  if (pill === 'all') return true;
  if (pill === 'invoiced') return r.verdict.queue !== null && INVOICED.includes(r.verdict.queue);
  return r.verdict.queue === pill;
}

function docState(row: BillingQueueRow, type: 'rate_confirmation' | 'pod'): { ok: boolean; label: string } {
  // Current files only, and every one of them: a reviewed old POD must not read as "reviewed"
  // while its replacement - the file that counts - has not been looked at.
  const docs = row.load.documents.filter((d) => d.type === type && d.status !== 'missing' && !(d as { supersededBy?: string | null }).supersededBy);
  if (docs.length === 0) return { ok: false, label: `${type === 'pod' ? 'POD' : 'RC'} missing` };
  if (docs.some((d) => d.review === 'rejected')) return { ok: false, label: `${type === 'pod' ? 'POD' : 'RC'} rejected` };
  const reviewed = docs.every((d) => d.review === 'reviewed' || d.review === 'verified');
  if (type === 'rate_confirmation' && row.verdict.rc.state === 'mismatch') return { ok: false, label: 'RC mismatch' };
  return { ok: reviewed, label: reviewed ? `${type === 'pod' ? 'POD' : 'RC'} ${docs.some((d) => d.review === 'verified') ? 'verified' : 'reviewed'}` : `${type === 'pod' ? 'POD' : 'RC'} not reviewed` };
}

function gross(row: BillingQueueRow): number {
  if (row.invoice) return row.invoice.total;
  // The lines the invoice would carry - a TONU is its fee, not the linehaul (owner, 2026-10-15).
  return invoiceLinesFor(row.load as unknown as BillableLoad).reduce((s, l) => s + l.amount, 0);
}

export function BillingQueuePanel() {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAccounting();
  const query = useQuery({ queryKey: ['accounting', 'billing-queue'], queryFn: fetchBillingQueue, refetchInterval: 60_000 });
  const [tab, setTab] = useState<Pill>('all');
  const [q, setQ] = useState('');
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [focus, setFocus] = useState<string | null>(null);
  const rows = useMemo(() => (query.data?.rows ?? []).filter((r) => inPill(r, tab) && (!q.trim() || [r.load.loadNumber, r.load.brokerReference ?? '', r.load.customerName, r.load.brokerName ?? ''].some((v) => v.toLowerCase().includes(q.trim().toLowerCase())))), [query.data, tab, q]);
  /*
   * A load sent off on its invoice leaves the queue; a search still finds it (owner, 2026-10-30):
   * the invoices whose load #, broker ref or invoice # match, beside the queue's own rows.
   */
  const needle = q.trim().toLowerCase();
  const invoiced = useQuery({ queryKey: ['accounting', 'receivables', 'queue-search'], queryFn: () => apiGet<ServerInvoice[]>('/accounting/receivables'), enabled: needle.length > 0, staleTime: 60_000 });
  const invoicedMatches = useMemo(() => {
    if (!needle) return [];
    const shown = new Set(rows.map((r) => r.load.id));
    return (invoiced.data ?? []).filter((i) => !shown.has(i.loadId) && [i.invoiceNumber, i.loadNumber, i.rc?.loadReference ?? '', i.rc?.rcReference ?? '', i.billToName].some((v) => v.toLowerCase().includes(needle))).slice(0, 20);
  }, [invoiced.data, needle, rows]);
  // The rows that carry a checkbox: ready to bill, or an invoice still draft or issued.
  const selectableIds = rows.filter((r) => (r.verdict.queue === 'ready_to_bill' && !r.invoice) || r.invoice?.status === 'draft' || r.invoice?.status === 'issued').map((r) => r.load.id);
  const focused = (query.data?.rows ?? []).find((r) => r.load.id === focus) ?? null;
  const selectedRows = (query.data?.rows ?? []).filter((r) => selected.has(r.load.id));
  const selectedTotal = selectedRows.reduce((s, r) => s + gross(r), 0);
  // What the selection can do next, by where each load stands.
  const toCreate = selectedRows.filter((r) => !r.invoice && r.verdict.queue === 'ready_to_bill');
  const toIssue = selectedRows.filter((r) => r.invoice?.status === 'draft');
  const toRts = selectedRows.filter((r) => r.invoice?.status === 'issued');
  const [rtsAsk, setRtsAsk] = useState<null | { issueFirst: boolean }>(null);
  const refresh = async () => {
    await Promise.all([queryClient.invalidateQueries({ queryKey: ['accounting', 'billing-queue'] }), invalidate(), queryClient.invalidateQueries({ queryKey: ['loads'] }), queryClient.invalidateQueries({ queryKey: ['load'] })]);
  };

  const create = useMutation({
    mutationFn: (ids: string[]) => createInvoicesFromLoads(ids),
    onSuccess: async (r) => {
      await refresh();
      setSelected(new Set());
      toast({ tone: r.created.length > 0 ? 'success' : 'warning', title: `${r.created.length} invoice${r.created.length === 1 ? '' : 's'} drafted`, description: r.skipped.length > 0 ? r.skipped.map((s) => s.reason).join(' · ') : 'Drafts are on the Invoices tab; issue them to post.' });
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Could not create invoices', description: e instanceof Error ? e.message : undefined }),
  });
  const issue = useMutation({
    mutationFn: (id: string) => issueInvoice({ invoiceId: id }),
    onSuccess: async (r) => {
      await refresh();
      toast({ tone: r.ok ? 'success' : 'danger', title: r.ok ? `${r.invoice.invoiceNumber} issued` : 'Refused', description: r.ok ? 'Posted to receivables and revenue.' : r.blocked });
    },
  });
  /** Issues every selected draft, one after another; a refusal is reported and the rest go on. */
  const issueAll = async (rowsToIssue: BillingQueueRow[]): Promise<{ issued: string[]; refused: string[] }> => {
    const issued: string[] = [];
    const refused: string[] = [];
    for (const r of rowsToIssue) {
      try {
        const out = await issueInvoice({ invoiceId: r.invoice!.id });
        if (out.ok) issued.push(out.invoice.id);
        else refused.push(`${r.invoice!.invoiceNumber}: ${out.blocked ?? 'refused'}`);
      } catch (e) {
        refused.push(`${r.invoice!.invoiceNumber}: ${e instanceof Error ? e.message : 'refused'}`);
      }
    }
    return { issued, refused };
  };
  const bulkIssue = useMutation({
    mutationFn: () => issueAll(toIssue),
    onSuccess: async ({ issued, refused }) => {
      await refresh();
      toast({ tone: refused.length ? 'warning' : 'success', title: `${issued.length} invoice${issued.length === 1 ? '' : 's'} issued`, description: refused.length ? refused.join(' · ') : 'Select them and press Send to RTS when ready.' });
    },
  });
  /** One RTS batch for the selected issued invoices (drafts issued first when asked), then sent. */
  const sendToRts = useMutation({
    mutationFn: async (issueFirst: boolean) => {
      let refused: string[] = [];
      let ids = toRts.map((r) => r.invoice!.id);
      if (issueFirst && toIssue.length) {
        const out = await issueAll(toIssue);
        refused = out.refused;
        ids = [...ids, ...out.issued];
      }
      if (ids.length === 0) throw new Error(refused.join(' · ') || 'Nothing issued to send.');
      const batch = await createRtsBatch(ids);
      try {
        const { version } = await fetchRtsBatch(batch.id);
        const sent = await sendRtsBatch(batch.id, version);
        return { batch: sent, refused, sentOk: true as const, error: null as string | null };
      } catch (e) {
        return { batch, refused, sentOk: false as const, error: e instanceof Error ? e.message : 'Not sent' };
      }
    },
    onSuccess: async ({ batch, refused, sentOk, error }) => {
      setRtsAsk(null);
      setSelected(new Set());
      await refresh();
      const test = batch.ftpSends?.at(-1)?.test === true;
      toast({
        tone: sentOk && !refused.length ? 'success' : 'warning',
        title: sentOk ? `${batch.batchNumber} sent to RTS${test ? ' (test folder)' : ''}` : `${batch.batchNumber} prepared, not sent`,
        description: [sentOk ? `${batch.count} invoice${batch.count === 1 ? '' : 's'} with RC, BOL and POD.${test ? ' A test upload marks nothing submitted.' : ''}` : `${error} Open the RTS batches tab to send it or download the files.`, ...refused].join(' · '),
      });
    },
    onError: (e: unknown) => {
      setRtsAsk(null);
      void refresh();
      toast({ tone: 'danger', title: 'Not sent to RTS', description: e instanceof Error ? e.message : undefined });
    },
  });
  const submission = useMutation({
    mutationFn: (input: { id: string; status: 'submitted' | 'accepted' | 'rejected'; reference?: string; issues?: string[]; evidence?: string }) => markSubmission(input.id, input),
    onSuccess: async (r) => {
      await refresh();
      toast({ tone: r.ok ? 'success' : 'danger', title: r.ok ? `Submission ${r.invoice.submission?.status}` : 'Refused', description: r.ok ? undefined : r.blocked });
    },
  });

  const counts = query.data?.counts;
  const totals = query.data?.totals;

  return (
    <div className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <KpiCard label="Ready to bill" value={counts ? counts.ready_to_bill : '…'} hint={totals ? formatMoney(totals.ready_to_bill) : undefined} icon={<FileText />} iconTile variant="feature" onClick={() => setTab('ready_to_bill')} />
        <KpiCard label="Needs review" value={counts ? counts.needs_review + counts.needs_documents : '…'} hint={counts ? `${counts.needs_documents} missing documents` : undefined} icon={<Clock />} iconTile variant="feature" onClick={() => setTab('needs_review')} />
        <KpiCard label="Selected total" value={formatMoney(selectedTotal)} hint={`${selected.size} load${selected.size === 1 ? '' : 's'} selected`} icon={<DollarSign />} iconTile variant="feature" />
      </div>

      <div className="flex flex-wrap items-center gap-1.5">
        {PILLS.map(([key, label]) => {
          const n = (query.data?.rows ?? []).filter((r) => inPill(r, key)).length;
          return (
            <button key={key} type="button" aria-pressed={tab === key} onClick={() => setTab(key)} className={cn('inline-flex h-8 items-center gap-1.5 rounded-full px-3 text-xs font-semibold ring-1', tab === key ? 'bg-primary-soft text-primary-text ring-primary/30' : 'bg-surface text-muted ring-line hover:text-ink')}>
              {label} <span className="tabular-nums">({query.data ? n : '…'})</span>
            </button>
          );
        })}
        <span className="ml-auto w-56 max-w-full">{/* One border: the field draws its own (owner, 2026-10-15). */}<Input prefix={<Search className="size-3.5 text-muted" />} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search loads…" aria-label="Search loads" /></span>
      </div>

      <div className="overflow-hidden rounded-xl border border-line bg-surface">
          {query.isPending ? (
            <p className="p-6 text-sm text-muted">Loading…</p>
          ) : query.isError ? (
            <Alert tone="danger" title="The billing queue could not be loaded" description={query.error instanceof Error ? query.error.message : undefined} className="m-4" />
          ) : rows.length === 0 ? (
            <p className="p-6 text-sm text-muted">Nothing in the queue{q ? ` for “${q}”` : ''}. A load enters the queue when it is delivered or closed.</p>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted">
                <tr>
                  <th className="w-8 px-3 py-2">
                    {/* Select all (owner, 2026-10-23): every row on screen that has a checkbox. */}
                    {selectableIds.length > 0 ? (
                      <Checkbox
                        aria-label="Select all"
                        checked={selectableIds.every((id) => selected.has(id)) ? true : selectableIds.some((id) => selected.has(id)) ? 'indeterminate' : false}
                        onCheckedChange={() => setSelected((prev) => (selectableIds.every((id) => prev.has(id)) ? new Set([...prev].filter((id) => !selectableIds.includes(id))) : new Set([...prev, ...selectableIds])))}
                      />
                    ) : null}
                  </th>
                  <th className="px-3 py-2">Load</th>
                  <th className="px-3 py-2">Broker ref</th>
                  <th className="px-3 py-2">Customer</th>
                  <th className="px-3 py-2">RC file</th>
                  <th className="px-3 py-2">Reference match</th>
                  <th className="px-3 py-2">POD</th>
                  <th className="px-3 py-2 text-right">Gross</th>
                  <th className="px-3 py-2">Billing status</th>
                  <th className="px-3 py-2" />
                </tr>
              </thead>
              <tbody className="divide-y divide-line-soft">
                {rows.map((r) => {
                  const rcFile = r.load.documents.some((d) => d.type === 'rate_confirmation' && d.status !== 'missing');
                  const pod = docState(r, 'pod');
                  const ready = r.verdict.queue === 'ready_to_bill' && !r.invoice;
                  return (
                    <tr key={r.load.id} className={cn('cursor-pointer hover:bg-surface-hover', focus === r.load.id && 'bg-primary-soft/40')} onClick={() => setFocus(r.load.id)}>
                      <td className="px-3 py-2" onClick={(e) => e.stopPropagation()}>
                        {ready || r.invoice?.status === 'draft' || r.invoice?.status === 'issued' ? (
                          <Checkbox aria-label={`Select ${r.load.loadNumber}`} checked={selected.has(r.load.id)} onCheckedChange={(v) => setSelected((prev) => { const next = new Set(prev); if (v === true) next.add(r.load.id); else next.delete(r.load.id); return next; })} />
                        ) : null}
                      </td>
                      <td className="px-3 py-2 font-semibold text-primary-text">{r.load.loadNumber}</td>
                      <td className="px-3 py-2">{r.load.brokerReference ?? '—'}</td>
                      <td className="px-3 py-2">{r.load.brokerName ?? r.load.customerName}</td>
                      <td className="px-3 py-2 text-xs">
                        {/* Three separate checks, never folded into one word: the file is present, the reference matches, the POD is reviewed. */}
                        <span className={cn('flex items-center gap-1', rcFile ? 'text-success-text' : 'text-danger-text')}>{rcFile ? <FileText className="size-3.5" /> : <CircleX className="size-3.5" />} {rcFile ? 'File present' : 'Missing'}</span>
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {r.verdict.rc.state === 'match' ? <span className="flex items-center gap-1 text-success-text"><CircleCheck className="size-3.5" /> Match</span> : r.verdict.rc.state === 'missing' ? <span className="text-muted">No RC</span> : r.verdict.rc.state === 'unreadable' ? <span className="flex items-center gap-1 text-danger-text"><TriangleAlert className="size-3.5" /> Unread</span> : <span className="flex items-center gap-1 text-danger-text"><TriangleAlert className="size-3.5" /> {r.verdict.rc.state === 'mismatch' ? 'Mismatch' : r.verdict.rc.state === 'duplicate' ? 'Reused file' : 'No load ref'}</span>}
                      </td>
                      <td className="px-3 py-2 text-xs">
                        {!r.verdict.tonu ? <span className={cn('flex items-center gap-1', pod.ok ? 'text-success-text' : 'text-danger-text')}>{pod.ok ? <CircleCheck className="size-3.5" /> : <CircleX className="size-3.5" />} {pod.ok ? 'Reviewed' : pod.label.replace(/^POD /, '')}</span> : <span className="text-muted">TONU · evidence</span>}
                      </td>
                      <td className="px-3 py-2 text-right tabular-nums">{formatMoney(gross(r))}</td>
                      <td className="px-3 py-2">
                        {r.invoice ? <Badge tone="info" size="sm">{r.invoice.invoiceNumber}</Badge> : r.verdict.queue === 'ready_to_bill' ? <Badge tone="success" size="sm">Ready to bill</Badge> : r.verdict.queue === 'needs_documents' ? <Badge tone="danger" size="sm">Needs documents</Badge> : <Badge tone="warning" size="sm" title={r.verdict.conditions[0]?.message}>Needs review</Badge>}
                      </td>
                      <td className="px-3 py-2 text-right" onClick={(e) => e.stopPropagation()}><Button variant="secondary" size="sm" onClick={() => setFocus(r.load.id)}>Review</Button></td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
          {invoicedMatches.length > 0 ? (
            <div className="border-t border-line p-3" data-testid="queue-search-invoiced">
              <p className="mb-2 text-xs font-semibold uppercase tracking-wide text-muted">Already invoiced</p>
              <ul className="divide-y divide-line text-sm">
                {invoicedMatches.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center gap-x-4 gap-y-1 py-2">
                    <Link to="/accounting/invoices/$invoiceId" params={{ invoiceId: i.id }} className="font-semibold text-primary-text hover:underline">{i.invoiceNumber}</Link>
                    <span className="text-ink">{i.loadNumber}</span>
                    <span className="text-muted">Ref {i.rc?.loadReference ?? '—'}</span>
                    <span className="text-muted">{i.billToName}</span>
                    <Badge tone={i.status === 'paid' ? 'success' : 'neutral'} size="sm">{i.status.replace(/_/g, ' ')}</Badge>
                    <span className="ml-auto font-semibold tabular-nums">{formatMoney(i.total)}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          {selected.size > 0 ? (
            <div className="fixed inset-x-4 bottom-4 z-30 mx-auto flex max-w-4xl flex-wrap items-center justify-between gap-3 rounded-xl border border-line bg-surface px-4 py-3 shadow-menu lg:left-[calc(var(--shell-sidebar-width)+1rem)]">
              <span className="text-sm font-semibold text-ink">{selected.size} load{selected.size === 1 ? '' : 's'} selected · {formatMoney(selectedTotal)}</span>
              <span className="flex gap-2">
                <Button variant="link" size="sm" onClick={() => setSelected(new Set())}>Clear selection</Button>
                {toCreate.length ? <Button variant={toIssue.length || toRts.length ? "secondary" : "primary"} size="sm" icon={<Receipt />} loading={create.isPending} onClick={() => create.mutate(toCreate.map((r) => r.load.id))}>Create invoice ({toCreate.length})</Button> : null}
                {toIssue.length ? <Button variant="secondary" size="sm" loading={bulkIssue.isPending} disabled={sendToRts.isPending} onClick={() => bulkIssue.mutate()}>Issue ({toIssue.length})</Button> : null}
                {toRts.length ? <Button variant="primary" size="sm" disabled={bulkIssue.isPending} loading={sendToRts.isPending && rtsAsk?.issueFirst === false} onClick={() => setRtsAsk({ issueFirst: false })}>Send to RTS ({toRts.length})</Button> : null}
                {toIssue.length ? <Button variant="primary" size="sm" disabled={bulkIssue.isPending} loading={sendToRts.isPending && rtsAsk?.issueFirst === true} onClick={() => setRtsAsk({ issueFirst: true })}>Issue &amp; send to RTS ({toIssue.length + toRts.length})</Button> : null}
              </span>
            </div>
          ) : null}
      </div>
      {/* Room under the table for the floating selection bar, so the last loads stay clear (owner, 2026-10-30). */}
      {selected.size > 0 ? <div aria-hidden className="h-16" /> : null}
      {rtsAsk ? (
        <ConfirmDialog
          open
          onOpenChange={(o) => (o ? undefined : setRtsAsk(null))}
          title={`Send ${(rtsAsk.issueFirst ? toIssue.length : 0) + toRts.length} invoice${(rtsAsk.issueFirst ? toIssue.length : 0) + toRts.length === 1 ? '' : 's'} to RTS?`}
          description={`${rtsAsk.issueFirst && toIssue.length ? `${toIssue.length} draft${toIssue.length === 1 ? ' is' : 's are'} issued first. ` : ''}One RTS batch is made and every PDF (invoice with NOA, RC, BOL, POD) and the CSV are uploaded. Total ${formatMoney([...toRts, ...(rtsAsk.issueFirst ? toIssue : [])].reduce((s, r) => s + gross(r), 0))}.`}
          confirmLabel="Send to RTS"
          onConfirm={() => sendToRts.mutateAsync(rtsAsk.issueFirst).catch(() => undefined)}
        />
      ) : null}
      {focused ? <LoadPanel row={focused} onIssue={(id) => issue.mutate(id)} onSubmission={(input) => submission.mutate(input)} onChanged={refresh} onClose={() => setFocus(null)} onCreate={(id) => create.mutate([id])} creating={create.isPending} /> : null}
    </div>
  );
}

/**
 * Drafted accessorials (a detention the clock wrote), each accepted onto the bill or dropped
 * (owner, 2026-10-30) - until then the load waits in Reference review.
 */
function DraftCharges({ row, onChanged }: { row: BillingQueueRow; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const drafts = row.load.charges.filter((c) => c.status === 'draft');
  const decide = useMutation({
    mutationFn: (input: { chargeId: string; decision: 'accepted' | 'dropped' }) => decideDraftCharge(row.load.id, input.chargeId, input.decision),
    onSuccess: async (_load, input) => {
      await onChanged();
      toast({ tone: 'success', title: input.decision === 'accepted' ? 'Charge accepted' : 'Charge dropped', description: input.decision === 'accepted' ? 'It goes on the invoice.' : 'It stays on the load, marked dropped; nothing is billed.' });
    },
    onError: (error) => toast({ tone: 'danger', title: 'Not saved', description: error instanceof Error ? error.message : undefined }),
  });
  if (drafts.length === 0) return null;
  return (
    <section className="rounded-lg border border-line p-3" data-testid="draft-charges">
      <p className="text-xs font-semibold text-ink">Accessorial drafts to decide</p>
      <ul className="mt-2 flex flex-col gap-2">
        {drafts.map((c) => (
          <li key={c.id} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="min-w-0 flex-1 text-secondary">{c.description}</span>
            <span className="font-semibold tabular-nums text-ink">{formatMoney(c.amount)}</span>
            <Button size="sm" variant="secondary" loading={decide.isPending && decide.variables?.chargeId === c.id && decide.variables.decision === 'dropped'} disabled={decide.isPending} onClick={() => decide.mutate({ chargeId: c.id, decision: 'dropped' })}>Drop</Button>
            <Button size="sm" variant="primary" loading={decide.isPending && decide.variables?.chargeId === c.id && decide.variables.decision === 'accepted'} disabled={decide.isPending} onClick={() => decide.mutate({ chargeId: c.id, decision: 'accepted' })}>Accept</Button>
          </li>
        ))}
      </ul>
    </section>
  );
}

function LoadPanel({ row, onIssue, onSubmission, onChanged, onClose, onCreate, creating }: { row: BillingQueueRow; onIssue: (id: string) => void; onSubmission: (input: { id: string; status: 'submitted' | 'accepted' | 'rejected'; reference?: string; issues?: string[]; evidence?: string }) => void; onChanged: () => Promise<void>; onClose: () => void; onCreate: (id: string) => void; creating: boolean }) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [revising, setRevising] = useState(false);
  const [rejecting, setRejecting] = useState(false);
  const [recording, setRecording] = useState<'submitted' | 'accepted' | null>(null);
  const rc = row.verdict.rc;
  const rcDoc = row.load.documents.find((d) => d.id === rc.documentId) ?? null;
  const previewUrl = useFileObjectUrl(rcDoc?.fileUrl ? { fileUrl: rcDoc.fileUrl, mimeType: rcDoc.mimeType ?? undefined, fileName: rcDoc.fileName } : null);
  const resolve = useMutation({
    mutationFn: () => resolveBillingException(row.load.id, { kind: rc.state === 'mismatch' ? 'rc_mismatch' : rc.state === 'duplicate' ? 'rc_duplicate' : rc.state === 'no_reference_on_load' ? 'rc_no_reference' : 'rc_unreadable', reason, rcReference: rc.rcReference ?? undefined }),
    onSuccess: async () => {
      setReason('');
      await onChanged();
      toast({ tone: 'success', title: 'Exception resolved', description: 'Recorded with your name and reason.' });
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Could not resolve', description: e instanceof Error ? e.message : undefined }),
  });
  const account = useAccount();
  const canReview = account?.permissions.includes('accounting.edit') ?? false;
  const blocking = rc.state !== 'match' && rc.state !== 'missing' && row.verdict.conditions.some((c) => c.code.startsWith('rc_'));
  const ready = row.verdict.queue === 'ready_to_bill' && !row.invoice;
  return (
    <Drawer open onOpenChange={(o) => { if (!o) onClose(); }} size="lg" title={`Review load ${row.load.loadNumber}`} description={`${row.load.driverName ?? 'No driver'}${row.load.truckUnit ? ` · Unit ${row.load.truckUnit}` : ''}${row.load.deliveredAt ? ` · delivered ${formatIsoDate(row.load.deliveredAt.slice(0, 10))}` : ''}`} footer={<><Button variant="primary" icon={<Receipt />} disabled={!ready || creating} loading={creating} title={ready ? undefined : row.invoice ? 'Already invoiced' : 'Complete the checks first'} onClick={() => onCreate(row.load.id)}>Create invoice</Button><Button variant="secondary" onClick={onClose}>Cancel</Button></>}>
      <div className="flex flex-col gap-4">
        <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-y-1.5 rounded-lg bg-surface-muted p-3 text-sm">
          <dt className="text-muted">Load</dt><dd className="font-semibold text-ink">{row.load.loadNumber}</dd>
          <dt className="text-muted">Broker reference</dt><dd className="font-semibold text-ink">{rc.loadReference ?? '—'}</dd>
          <dt className="text-muted">Customer</dt><dd className="text-ink">{row.load.brokerName ?? row.load.customerName}</dd>
          <dt className="text-muted">Gross amount</dt><dd className="font-semibold tabular-nums text-ink">{formatMoney(gross(row))}</dd>
        </dl>
        <div className="flex flex-wrap gap-3 text-xs">
          <Link to="/loads/$loadNumber" params={{ loadNumber: row.load.loadNumber }} className="inline-flex items-center gap-1 text-primary-text underline"><ExternalLink className="size-3" /> View load</Link>
          <Link to="/loads/$loadNumber" params={{ loadNumber: row.load.loadNumber }} search={{ tab: 'documents' }} className="inline-flex items-center gap-1 text-primary-text underline"><FileText className="size-3" /> Review documents</Link>
          {row.invoice ? <Link to="/accounting/invoices/$invoiceId" params={{ invoiceId: row.invoice.id }} className="inline-flex items-center gap-1 text-primary-text underline"><Receipt className="size-3" /> View invoice</Link> : null}
          {row.invoice ? <AuthedFileLink path={`/accounting/invoices/${row.invoice.id}/pdf`} fileName={`${row.invoice.invoiceNumber ?? row.invoice.id}.pdf`} className="inline-flex items-center gap-1 text-primary-text underline">PDF</AuthedFileLink> : null}
        </div>

        <BillingDocuments row={row} canReview={canReview} onChanged={onChanged} />

        <DraftCharges row={row} onChanged={onChanged} />

        {row.verdict.conditions.length > 0 ? (
          <div className="rounded-lg border border-line p-3" data-testid="billing-blockers">
            <p className="text-xs font-semibold text-ink">Still blocking the invoice</p>
            <ul className="mt-1 flex flex-col gap-1 text-xs text-secondary">
              {row.verdict.conditions.map((c) => (
                <li key={`${c.code}-${c.message}`} className="flex items-start gap-2"><TriangleAlert className="mt-0.5 size-3 shrink-0 text-warning-text" /> {c.message}</li>
              ))}
            </ul>
          </div>
        ) : !row.invoice ? (
          <Alert tone="success" title="All good · ready to bill" description="The documents are on file. RTS checks them and the reference; press Create invoice." />
        ) : null}

        <section className="flex flex-col gap-2">
          <p className="text-sm font-semibold text-ink">Rate confirmation (RC) reference</p>
          <div className="nw-paper overflow-hidden rounded-lg border border-line" data-theme="light">
            {!rcDoc ? <p className="p-6 text-center text-xs text-muted">No rate confirmation on file</p> : !rcDoc.fileUrl ? <p className="p-6 text-center text-xs text-muted">{rcDoc.fileName ?? rcDoc.id} · no file bytes on record</p> : <ReceiptPreview key={rcDoc.id} fileId={decodeURIComponent(rcDoc.fileUrl.split('/files/')[1] ?? '')} fileName={rcDoc.fileName ?? 'rate-confirmation.pdf'} />}
          </div>
          {rcDoc ? <div className="flex items-center justify-between text-xs"><span className="inline-flex items-center gap-1 text-secondary"><FileText className="size-3.5" /> {rcDoc.fileName ?? rcDoc.id}</span>{previewUrl ? <a href={previewUrl} target="_blank" rel="noreferrer" className="inline-flex items-center gap-1 rounded-lg border border-line px-2 py-1 text-primary-text"><ExternalLink className="size-3" /> Open full document</a> : null}</div> : null}
        </section>

        {/* No reference reading or comparison: RTS checks the reference (owner, 2026-10-16). */}

        {blocking ? (
          <FormField label="Resolve as Accounting" description="Only Accounting can clear this, with a reason kept on the load. This clears the reference exception only; document checks stay their own.">
            <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Resolution reason" />
            <Button className="mt-2" variant="primary" size="sm" disabled={reason.trim().length < 3 || resolve.isPending} loading={resolve.isPending} onClick={() => resolve.mutate()}>Resolve exception</Button>
          </FormField>
        ) : null}
      {row.invoice ? (
        <div className="flex flex-col gap-3 rounded-lg border border-line p-3">
          <div className="flex items-center justify-between">
            <p className="text-sm font-semibold text-ink">Invoice {row.invoice.invoiceNumber}</p>
            <Badge tone={row.invoice.status === 'draft' ? 'neutral' : row.invoice.status === 'paid' || row.invoice.status === 'funded' ? 'success' : 'info'} size="sm">{row.invoice.status.replace(/_/g, ' ')}</Badge>
          </div>
          {row.parentInvoice ? (
            <Alert tone="info" title={`Supplemental to ${row.parentInvoice.invoiceNumber}`} description={`${row.parentInvoice.invoiceNumber} went to RTS and is unchanged. This invoice bills what came after${row.invoice.supplementOf?.reason ? `: ${row.invoice.supplementOf.reason}` : ''}. Issue it and press Send to RTS like any invoice.`} />
          ) : null}
          <dl className="grid grid-cols-2 gap-2 text-xs">
            <dt className="text-muted">Bill to</dt><dd className="text-ink">{row.invoice.billToName}</dd>
            <dt className="text-muted">Issued</dt><dd className="text-ink">{row.invoice.issuedOn ? formatIsoDate(row.invoice.issuedOn) : '—'}</dd>
            <dt className="text-muted">Total</dt><dd className="text-ink">{formatMoney(row.invoice.total)}</dd>
            <dt className="text-muted">Balance</dt><dd className="text-ink">{formatMoney(row.invoice.balance)}</dd>
            <dt className="text-muted">RTS</dt><dd className="text-ink">{row.invoice.submission ? `${row.invoice.submission.status}${row.invoice.submission.reference ? ` · ${row.invoice.submission.reference}` : ''}` : 'not prepared'}</dd>
            {(row.supplements ?? []).length > 0 ? (
              <>
                <dt className="text-muted">Supplemental</dt>
                <dd className="text-ink">{(row.supplements ?? []).map((s) => `${s.invoiceNumber} (${s.status.replace(/_/g, ' ')}, ${formatMoney(s.total)})`).join(' · ')}</dd>
              </>
            ) : null}
          </dl>
          {row.invoice.revisions.length > 0 ? (
            <div>
              <p className="eyebrow">Revision history</p>
              <ul className="mt-1 text-xs text-secondary">
                <li>Original · {formatIsoDate(row.invoice.createdAt.slice(0, 10))} · {formatMoney(row.invoice.revisions[0]!.total - row.invoice.revisions[0]!.delta)}</li>
                {row.invoice.revisions.map((r) => (
                  <li key={r.invoiceId}>R{r.revision} · {formatIsoDate(r.at.slice(0, 10))} · {r.reason} · {r.delta >= 0 ? '+' : ''}{formatMoney(r.delta)} → {formatMoney(r.total)}</li>
                ))}
              </ul>
            </div>
          ) : null}
          <div className="flex flex-wrap gap-2">
            {row.invoice.status === 'draft' ? <Button variant="primary" size="sm" onClick={() => onIssue(row.invoice!.id)}>Issue invoice</Button> : null}
            {/* A submission is a claim about RTS, so it carries RTS's reference or what was seen -
                never a reference this screen made up. Batches are recorded under RTS batches. */}
            {row.invoice.status === 'issued' && row.invoice.submission?.status === 'prepared' ? <Button variant="secondary" size="sm" onClick={() => setRecording('submitted')}>Record manual submission…</Button> : null}
            {row.invoice.submission?.status === 'submitted' ? <Button variant="secondary" size="sm" onClick={() => setRecording('accepted')}>RTS accepted…</Button> : null}
            {row.invoice.submission?.status === 'submitted' ? <Button variant="outline" size="sm" onClick={() => setRejecting(true)}>RTS rejected…</Button> : null}
            {/* Revisions are drafted, reviewed and issued on the invoice itself - one place, one workflow. */}
            {row.invoice.status !== 'draft' && row.invoice.status !== 'void' ? <Link to="/accounting/invoices/$invoiceId" params={{ invoiceId: row.invoice.id }} className="inline-flex h-8 items-center rounded-lg border border-line px-3 text-xs font-semibold text-primary-text">Revise on the invoice page</Link> : null}
          </div>
          <p className="text-2xs text-muted">RTS is not connected: submission is by export and marked here from RTS’s answer. Existing payments stay linked through every revision.</p>
        </div>
      ) : null}
      {revising && row.invoice ? <ReviseDialog invoice={row.invoice} onClose={() => setRevising(false)} onChanged={onChanged} /> : null}
      {recording && row.invoice ? <EvidenceDialog status={recording} invoiceNumber={row.invoice.invoiceNumber} onClose={() => setRecording(null)} onSubmit={(ev) => { onSubmission({ id: row.invoice!.id, status: recording, ...ev }); setRecording(null); }} /> : null}
      {rejecting && row.invoice ? <RejectDialog onClose={() => setRejecting(false)} onSubmit={(issues) => { onSubmission({ id: row.invoice!.id, status: 'rejected', issues }); setRejecting(false); }} /> : null}
      </div>
    </Drawer>
  );
}

function ReviseDialog({ invoice, onClose, onChanged }: { invoice: ServerInvoice; onClose: () => void; onChanged: () => Promise<void> }) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const [lines, setLines] = useState(invoice.lines.map((l) => ({ chargeType: l.chargeType, description: l.description, amount: String(l.amount) })));
  const revise = useMutation({
    mutationFn: () => reviseInvoice(invoice.id, { reason, lines: lines.map((l) => ({ chargeType: l.chargeType, description: l.description, amount: Number(l.amount) || 0 })), expectedUpdatedAt: invoice.updatedAt }),
    onSuccess: async (r) => {
      if (!r.ok) {
        toast({ tone: 'danger', title: 'Refused', description: r.blocked });
        return;
      }
      await onChanged();
      toast({ tone: 'success', title: `${r.invoice.invoiceNumber} created`, description: `Delta ${formatMoney(r.invoice.revisions.at(-1)?.delta ?? 0)} posted; the original and its payments are kept.` });
      onClose();
    },
  });
  const total = lines.reduce((s, l) => s + (Number(l.amount) || 0), 0);
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} size="md" title={`Revise ${invoice.invoiceNumber}`} description={`Creates ${invoice.family}-R${invoice.revision + 1}. The original stays; only the difference posts.`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={reason.trim().length < 3 || revise.isPending} loading={revise.isPending} onClick={() => revise.mutate()}>Create revision</Button></>}>
      <div className="flex flex-col gap-3">
        {lines.map((l, i) => (
          <div key={i} className="grid grid-cols-[minmax(0,1fr)_120px_100px_auto] items-end gap-2">
            <FormField label={i === 0 ? 'Description' : undefined}><Input value={l.description} onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, description: e.target.value } : x)))} aria-label="Description" /></FormField>
            <FormField label={i === 0 ? 'Type' : undefined}>
              <Select options={['linehaul', 'detention', 'layover', 'lumper', 'fuel_surcharge', 'stop_charge', 'tonu', 'other'].map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))} value={l.chargeType} onValueChange={(v) => setLines((p) => p.map((x, j) => (j === i ? { ...x, chargeType: v } : x)))} />
            </FormField>
            <FormField label={i === 0 ? 'Amount' : undefined}><Input prefix="$" type="number" step="0.01" value={l.amount} onChange={(e) => setLines((p) => p.map((x, j) => (j === i ? { ...x, amount: e.target.value } : x)))} aria-label="Amount" /></FormField>
            <Button variant="link" size="sm" onClick={() => setLines((p) => p.filter((_, j) => j !== i))}>Remove</Button>
          </div>
        ))}
        <Button variant="outline" size="sm" onClick={() => setLines((p) => [...p, { chargeType: 'detention', description: 'Detention', amount: '' }])}>Add line</Button>
        <p className="text-sm text-ink">New total {formatMoney(total)} · was {formatMoney(invoice.total)} · delta {formatMoney(total - invoice.total)}</p>
        <FormField label="Reason" required><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Revision reason" /></FormField>
      </div>
    </Modal>
  );
}

function RejectDialog({ onClose, onSubmit }: { onClose: () => void; onSubmit: (issues: string[]) => void }) {
  const [text, setText] = useState('');
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} size="sm" title="RTS rejected the submission" description="What RTS said, one issue per line. The invoice moves to Submission issues." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={text.trim().length === 0} onClick={() => onSubmit(text.split('\n').map((s) => s.trim()).filter(Boolean))}>Record</Button></>}>
      <Textarea rows={4} value={text} onChange={(e) => setText(e.target.value)} aria-label="Rejection issues" />
    </Modal>
  );
}

/** What RTS said about one invoice, with how the person knows: a reference, or a note of what they saw. */
function EvidenceDialog({ status, invoiceNumber, onClose, onSubmit }: { status: 'submitted' | 'accepted'; invoiceNumber: string; onClose: () => void; onSubmit: (input: { reference?: string; evidence?: string }) => void }) {
  const [reference, setReference] = useState('');
  const [evidence, setEvidence] = useState('');
  const ready = Boolean(reference.trim() || evidence.trim());
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} size="sm" title={status === 'submitted' ? `Record manual submission · ${invoiceNumber}` : `Record RTS acceptance · ${invoiceNumber}`} description="RTS is not connected, so this records what you saw. Give RTS's reference, or describe what you saw." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ready} onClick={() => onSubmit({ reference: reference.trim() || undefined, evidence: evidence.trim() || undefined })}>Record</Button></>}>
      <div className="flex flex-col gap-3">
        <FormField label="RTS reference"><Input value={reference} onChange={(e) => setReference(e.target.value)} /></FormField>
        <FormField label="What you saw"><Textarea rows={2} value={evidence} onChange={(e) => setEvidence(e.target.value)} /></FormField>
      </div>
    </Modal>
  );
}
