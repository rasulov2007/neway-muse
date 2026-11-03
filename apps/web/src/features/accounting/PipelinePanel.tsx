import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useState } from 'react';
import { Alert, Badge, Button, StatusSymbol, useToast } from '@/design-system';
import { fetchCompletionBackfill, fetchCompletions, fetchLegacyEscrow, importLegacyEscrow, retryCompletion, runCompletionBackfill, type CompletionRow, type LegacyEscrowReport } from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { formatIsoDate, formatMoney } from '@/lib/format';

/**
 * The completed-load pipeline, on the Accounting overview (corrective brief, section 3).
 *
 * Every completed load has one row here: what it produced for billing and for the drivers'
 * pay, or the error that stopped it. Nothing on this panel is a status somebody typed; a load
 * with no row is a load the pipeline missed, and the backfill says so before it writes.
 */
export function PipelinePanel() {
  const account = useAccount();
  const canEdit = account?.permissions.includes('accounting.edit') ?? false;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const rows = useQuery({ queryKey: ['accounting', 'completions'], queryFn: fetchCompletions, staleTime: 30_000 });
  const [dry, setDry] = useState<Awaited<ReturnType<typeof fetchCompletionBackfill>> | null>(null);
  const [escrow, setEscrow] = useState<LegacyEscrowReport | null>(null);
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['accounting'] });
  const dryRun = useMutation({ mutationFn: fetchCompletionBackfill, onSuccess: setDry, onError: (e: unknown) => toast({ tone: 'danger', title: 'Dry run failed', description: e instanceof Error ? e.message : undefined }) });
  const apply = useMutation({
    mutationFn: runCompletionBackfill,
    onSuccess: async (r) => { setDry(null); await refresh(); toast({ tone: 'success', title: 'Backfill applied', description: `${r.created} created, ${r.updated} updated, ${r.errors.length} errors.` }); },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Backfill failed', description: e instanceof Error ? e.message : undefined }),
  });
  const retry = useMutation({ mutationFn: retryCompletion, onSuccess: async () => { await refresh(); toast({ tone: 'success', title: 'Load reprocessed' }); }, onError: (e: unknown) => toast({ tone: 'danger', title: 'Retry failed', description: e instanceof Error ? e.message : undefined }) });
  const escrowDry = useMutation({ mutationFn: fetchLegacyEscrow, onSuccess: setEscrow, onError: (e: unknown) => toast({ tone: 'danger', title: 'Could not read the legacy escrow', description: e instanceof Error ? e.message : undefined }) });
  const escrowApply = useMutation({
    mutationFn: importLegacyEscrow,
    onSuccess: async (r) => { setEscrow(r); await refresh(); toast({ tone: 'success', title: 'Legacy escrow imported', description: `${r.imported} imported, ${r.alreadyImported} already there.` }); },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Import failed', description: e instanceof Error ? e.message : undefined }),
  });

  if (rows.isPending) return <div className="rounded-xl border border-line bg-surface p-4 text-sm text-muted">Loading…</div>;
  if (rows.isError) return <Alert tone="danger" title="The completed-load pipeline could not be read" description={rows.error instanceof Error ? rows.error.message : undefined} actions={<Button variant="secondary" size="sm" onClick={() => void rows.refetch()}>Retry</Button>} />;
  const list = rows.data;
  const errors = list.filter((c) => c.state === 'error');
  const blocked = list.filter((c) => c.state !== 'error' && (c.earnings.some((e) => e.blockers.length > 0) || c.invoiceCandidate.queue === 'needs_review' || c.invoiceCandidate.queue === 'needs_documents'));
  const earned = list.reduce((s, c) => s + c.earnings.reduce((x, e) => x + (e.cents ?? 0), 0), 0);
  const gross = list.reduce((s, c) => s + c.grossCents, 0);

  return (
    <div className="rounded-xl border border-line bg-surface p-4">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-ink">Completed-load pipeline</p>
          <p className="text-xs text-muted">One row per completed load: its invoice candidate and each driver's earning, or the error that stopped it. Figures here are candidates, not postings.</p>
        </div>
        {canEdit ? (
          <span className="flex flex-wrap gap-2">
            <Button variant="secondary" size="sm" loading={dryRun.isPending} onClick={() => dryRun.mutate()}>Backfill · dry run</Button>
            <Button variant="secondary" size="sm" loading={escrowDry.isPending} onClick={() => escrowDry.mutate()}>Legacy escrow · dry run</Button>
          </span>
        ) : null}
      </div>
      <div className="mt-3 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Figure label="Completed loads" value={String(list.length)} />
        <Figure label="Operational gross" value={formatMoney(gross / 100)} />
        <Figure label="Driver pay candidates" value={formatMoney(earned / 100)} hint={blocked.length > 0 ? `${blocked.length} with blockers` : undefined} />
        <Figure label="Errors" value={String(errors.length)} tone={errors.length > 0 ? 'danger' : undefined} />
      </div>

      {dry ? (
        <Alert className="mt-3" tone={dry.missing.length + dry.stale.length > 0 ? 'warning' : 'success'} title={`Dry run: ${dry.scanned} completed loads scanned, ${dry.missing.length} missing, ${dry.stale.length} stale, ${dry.errors.length} would error`} description={`${formatMoney(dry.totals.grossCents / 100)} gross, ${formatMoney(dry.totals.earnedCents / 100)} in earning candidates, ${dry.totals.blocked} earning(s) blocked. Nothing was written.`} actions={canEdit && dry.missing.length + dry.stale.length > 0 ? <Button variant="primary" size="sm" loading={apply.isPending} onClick={() => apply.mutate()}>Apply backfill</Button> : undefined} />
      ) : null}
      {escrow ? (
        <Alert className="mt-3" tone={escrow.movements.some((m) => m.state === 'new') ? 'warning' : 'success'} title={`Legacy escrow: ${escrow.found} movement(s) in the old browser store, ${escrow.alreadyImported} already in the account${escrow.dryRun ? ' (dry run)' : ''}`} description={escrow.movements.map((m) => `${formatIsoDate(m.date)} · ${m.driverId} · ${m.kind.replace('escrow_', '')} ${formatMoney(m.amountCents / 100)} · recorded by ${m.recordedBy} · ${m.state === 'new' ? 'would import' : 'already imported'}`).join(' | ') || 'Nothing to import.'} actions={canEdit && escrow.dryRun && escrow.movements.some((m) => m.state === 'new') ? <Button variant="primary" size="sm" loading={escrowApply.isPending} onClick={() => escrowApply.mutate()}>Import once</Button> : undefined} />
      ) : null}

      {list.length === 0 ? <p className="mt-3 text-xs text-muted">No completed load has reached the pipeline yet. Run the dry run to see what a backfill would produce.</p> : (
        <div className="mt-3 overflow-x-auto">
          <table className="w-full text-xs">
            <thead><tr className="text-left text-muted"><th className="py-1 pr-3">Load</th><th className="py-1 pr-3">Completed</th><th className="py-1 pr-3">Billing</th><th className="py-1 pr-3">Drivers</th><th className="py-1 pr-3 text-right">Gross</th><th className="py-1 pr-3 text-right">Pay</th><th className="py-1 pr-3">State</th><th /></tr></thead>
            <tbody className="divide-y divide-line-soft">
              {list.slice(0, 50).map((c) => <Row key={c.id} c={c} canEdit={canEdit} onRetry={() => retry.mutate(c.loadId)} />)}
            </tbody>
          </table>
          {list.length > 50 ? <p className="mt-2 text-2xs text-muted">Showing the latest 50 of {list.length}.</p> : null}
        </div>
      )}
    </div>
  );
}

function Row({ c, canEdit, onRetry }: { c: CompletionRow; canEdit: boolean; onRetry: () => void }) {
  const pay = c.earnings.some((e) => e.cents === null) ? null : c.earnings.reduce((s, e) => s + (e.cents ?? 0), 0);
  const blockers = c.earnings.flatMap((e) => e.blockers);
  return (
    <tr>
      <td className="py-1.5 pr-3"><Link to="/loads/$loadNumber" params={{ loadNumber: c.loadNumber }} className="font-semibold text-primary-text">{c.loadNumber}</Link></td>
      <td className="py-1.5 pr-3 text-secondary">{c.completedAt ? formatIsoDate(c.completedAt.slice(0, 10)) : '—'}</td>
      <td className="py-1.5 pr-3"><Badge tone={c.invoiceCandidate.queue === 'ready_to_bill' ? 'success' : c.invoiceCandidate.queue === 'ready_to_submit' || c.invoiceCandidate.queue === null ? 'info' : 'warning'} size="sm">{c.invoiceCandidate.queue ? c.invoiceCandidate.queue.replace(/_/g, ' ') : c.invoiceCandidate.invoiceStatus ?? 'invoiced'}</Badge></td>
      <td className="py-1.5 pr-3 text-secondary">{c.earnings.map((e) => e.recipientName ?? e.recipientId).join(' + ') || 'No driver'}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums text-ink">{formatMoney(c.grossCents / 100)}</td>
      <td className="py-1.5 pr-3 text-right tabular-nums text-ink">{pay === null ? 'Cannot calculate' : formatMoney(pay / 100)}</td>
      <td className="py-1.5 pr-3">
        {c.state === 'error' ? <span className="inline-flex items-center gap-1 text-danger-text"><StatusSymbol family="urgent" /> {c.error ?? 'Error'}</span> : blockers.length > 0 ? <span className="inline-flex items-center gap-1 text-warning-text" title={blockers.join('; ')}><StatusSymbol family="warning" /> {blockers[0]}</span> : <span className="inline-flex items-center gap-1 text-success-text"><StatusSymbol family="done" /> Processed</span>}
      </td>
      <td className="py-1.5 text-right">{canEdit ? <Button variant="link" size="sm" onClick={onRetry}>Retry</Button> : null}</td>
    </tr>
  );
}

function Figure({ label, value, hint, tone }: { label: string; value: string; hint?: string; tone?: 'danger' }) {
  return (
    <div className="rounded-lg bg-surface-muted p-3">
      <p className="text-xs text-muted">{label}</p>
      <p className={`mt-1 text-lg font-bold tabular-nums ${tone === 'danger' ? 'text-danger-text' : 'text-ink'}`}>{value}</p>
      {hint ? <p className="text-2xs text-warning-text">{hint}</p> : null}
    </div>
  );
}
