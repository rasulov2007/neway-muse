import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useParams } from '@tanstack/react-router';
import { Check, DollarSign, Download } from 'lucide-react';
import { useState } from 'react';
import { Alert, BackButton, Badge, Button, FormField, Input, Modal, PageHeader, Select, cn, useToast } from '@/design-system';
import { approveStatement, fetchStatement, markStatementPaid } from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { today } from '@/lib/clock';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { EnterOdometerButton } from './EnterOdometerDialog';
import { ReopenStatementButton } from './ReopenStatementDialog';
import { SendStatementEmailButton } from './StatementEmail';
import { useAuthedFile } from './useAuthedFile';
import { payWindowLabel } from './pay-window';
import { useInvalidateAccounting } from './useAccounting';

/**
 * One statement (§8, §9): every earning and deduction line with its basis, the debt and escrow
 * movement, the signed net and the cash payable - or, for a vendor, each truck's section and
 * the one payout. The PDF preview is the same document that is exported and emailed.
 */

const c = (cents: number) => formatMoney(cents / 100);

export function SettlementDetailRoute() {
  const { settlementId } = useParams({ from: '/accounting/settlements/$settlementId' });
  return <SettlementDetailPage settlementId={settlementId} />;
}

export function SettlementDetailPage({ settlementId }: { settlementId: string }) {
  const account = useAccount();
  const canEdit = account?.permissions.includes('accounting.edit') ?? false;
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const invalidate = useInvalidateAccounting();
  const query = useQuery({ queryKey: ['accounting', 'statement', settlementId], queryFn: () => fetchStatement(settlementId) });
  const [paying, setPaying] = useState(false);
  // Fetched with the session, shown from a blob: a draft previews and downloads like any other,
  // with its DRAFT watermark, without being approved or paid.
  const pdf = useAuthedFile(query.data ? `/accounting/settlements/${query.data.id}/pdf` : null, `${query.data?.settlementNumber ?? 'statement'}.pdf`);
  const refresh = () => Promise.all([queryClient.invalidateQueries({ queryKey: ['accounting'] }), invalidate()]);
  const approve = useMutation({
    mutationFn: () => approveStatement(settlementId),
    onSuccess: async (r) => {
      await refresh();
      toast({ tone: r.ok ? 'success' : 'danger', title: r.ok ? 'Approved' : 'Not approved', description: r.ok ? 'Recoveries, escrow and carry-forward recorded once; posted to the ledger. Record the payment to lock it; until then it can be reopened.' : r.blocked });
    },
  });
  if (query.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (query.isError) return <Alert tone="danger" title="Statement not found" description={query.error instanceof Error ? query.error.message : undefined} />;
  const s = query.data;
  const comp = s.computation;
  return (
    <div className="flex flex-col gap-4">
      <PageHeader
        back={<BackButton fallback="/accounting/settlements" />}
        title={`${s.partyName} — ${s.partyType === 'vendor' ? 'Vendor statement' : 'Statement'} ${s.settlementNumber}`}
        meta={<><Badge tone={s.status === 'paid' ? 'success' : s.status === 'approved' ? 'info' : s.status === 'review' ? 'warning' : 'neutral'}>{s.status === 'paid' ? 'Paid · locked' : s.status === 'approved' ? 'Approved' : s.status}</Badge><span className="text-xs text-muted">{payWindowLabel(s)} · payday {formatIsoDate(s.payDate)}{s.approvedAt ? ` · approved ${formatIsoDate(s.approvedAt.slice(0, 10))} by ${s.approvedBy}` : ''}</span></>}
        actions={
          <>
            <Button
              variant="secondary"
              icon={<Download />}
              disabled={!pdf.url}
              loading={pdf.loading}
              onClick={() => pdf.download()}
            >
              PDF
            </Button>
            {canEdit && (s.status === 'draft' || s.status === 'review') ? <Button variant="primary" icon={<Check />} disabled={s.exceptions.length > 0} loading={approve.isPending} onClick={() => approve.mutate()}>Approve</Button> : null}
            <SendStatementEmailButton s={s} canEdit={canEdit} size="md" />
            <ReopenStatementButton s={s} canEdit={canEdit} onDone={refresh} />
            {canEdit && s.status === 'approved' ? <Button variant="primary" icon={<DollarSign />} onClick={() => setPaying(true)}>Record payment</Button> : null}
          </>
        }
      />
      {s.exceptions.length > 0 ? (
        <Alert
          tone="warning"
          title="Exceptions block approval"
          description={
            <>
              <ul className="list-disc pl-4">{s.exceptions.map((e) => <li key={e}>{e}</li>)}</ul>
              <div className="mt-2"><EnterOdometerButton s={s} canEdit={canEdit} onDone={refresh} /></div>
            </>
          }
        />
      ) : null}
      {s.status === 'approved' ? <p className="text-xs text-muted">Approved. Record the payment to lock it; until then it can be reopened. Frozen at approval (version {s.versions.length}); the profile in force was effective {s.snapshot?.profileEffectiveFrom ? formatIsoDate(s.snapshot.profileEffectiveFrom) : '—'}.</p> : null}
      {s.status === 'paid' ? <p className="text-xs text-muted">Paid · locked. A correction goes on next week’s statement. Frozen at approval (version {s.versions.length}); the profile in force was effective {s.snapshot?.profileEffectiveFrom ? formatIsoDate(s.snapshot.profileEffectiveFrom) : '—'}.</p> : null}

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
        <div className="flex flex-col gap-4">
          {comp ? (
            <>
              <Section title="Earnings">
                <Rows head={['Load', 'Description', 'Basis', 'Amount']} rows={comp.earnings.map((e) => [e.loadNumber ? <Link key="l" to="/loads/$loadNumber" params={{ loadNumber: e.loadNumber }} className="text-primary-text">{e.loadNumber}</Link> : '', e.description, e.basis, c(e.cents)])} foot={['', 'Gross', '', c(comp.grossCents)]} />
                {comp.reimbursementsCents ? <p className="mt-1 text-right text-xs text-muted">Reimbursements {c(comp.reimbursementsCents)}</p> : null}
                {comp.excluded.length ? <p className="mt-2 text-xs text-warning-text">Excluded: {comp.excluded.map((x) => `${x.loadNumber} (${x.reason})`).join(' · ')}</p> : null}
                {(s.removedLoads ?? []).length ? <p className="mt-2 text-xs text-muted">Not on this statement: {(s.removedLoads ?? []).map((r) => `${r.loadNumber} (${r.reason}; taken off by ${r.by})`).join(' · ')}. Put back from the week’s Settlements page; otherwise each goes on the next statement.</p> : null}
              </Section>
              <Section title="Deductions">
                <Rows head={['Kind', 'Description', 'Basis', 'Amount']} rows={comp.deductions.map((d) => [d.kind.replace(/_/g, ' '), d.description, d.basis, `(${c(d.cents)})`])} foot={['', 'Deductions + escrow', '', `(${c(comp.deductionsCents + comp.escrowCents)})`]} />
              </Section>
              {comp.skipped?.length ? (
                <Section title="Skipped this week">
                  <Rows head={['Kind', 'Description', 'Why', 'Not taken']} rows={comp.skipped.map((k) => [k.kind, k.description, k.reason, c(k.cents)])} />
                </Section>
              ) : null}
              <Section title="Balances">
                <dl className="grid grid-cols-2 gap-1 text-sm">
                  <dt className="text-muted">Debt before this statement</dt><dd className="text-right">{comp.openingDebtCents === null ? 'unknown (not reconciled)' : c(comp.openingDebtCents)}</dd>
                  <dt className="text-muted">Closing debt</dt><dd className="text-right">{comp.closingDebtCents === null ? 'unknown (not reconciled)' : c(comp.closingDebtCents)}</dd>
                  <dt className="text-muted">Escrow balance after</dt><dd className="text-right">{comp.escrowBalanceAfterCents === null ? '—' : c(comp.escrowBalanceAfterCents)}</dd>
                  <dt className="font-semibold text-ink">Net (signed)</dt><dd className={cn('text-right font-semibold', comp.netCents < 0 && 'text-danger-text')}>{c(comp.netCents)}</dd>
                  <dt className="font-semibold text-ink">Cash payable</dt><dd className="text-right text-lg font-bold">{c(comp.payableCents)}</dd>
                  {comp.carryCents ? <><dt className="text-danger-text">Carried to next period</dt><dd className="text-right text-danger-text">{c(comp.carryCents)}</dd></> : null}
                </dl>
              </Section>
            </>
          ) : null}
          {s.vendor ? (
            <>
              {s.vendor.trucks.map((t) => (
                <Section key={t.truckId} title={`Truck #${t.unitNumber}`}>
                  <Rows head={['Load', 'Route', 'Gross', 'Rate', 'Vendor earnings']} rows={t.loads.map((l) => [<Link key="l" to="/loads/$loadNumber" params={{ loadNumber: l.loadNumber }} className="text-primary-text">{l.loadNumber}</Link>, l.route, c(l.grossCents), t.percentBps === null ? 'n/a' : `${t.percentBps / 100}%`, c(l.vendorEarningsCents)])} foot={['', 'Total truck earnings', c(t.grossCents), '', c(t.vendorEarningsCents)]} />
                  <dl className="mt-2 grid grid-cols-2 gap-1 text-sm">
                    <dt className="text-muted">Driver pay deducted</dt><dd className="text-right">({c(t.driverPayDeductedCents)})</dd>
                    <dt className="text-muted">Fuel</dt><dd className="text-right">({c(t.fuelCents)})</dd>
                    <dt className="text-muted">Tolls</dt><dd className="text-right">({c(t.tollsCents)})</dd>
                    {t.otherCents ? <><dt className="text-muted">Other</dt><dd className="text-right">({c(t.otherCents)})</dd></> : null}
                    <dt className="font-semibold text-ink">Net for Truck #{t.unitNumber}</dt><dd className="text-right font-semibold">{c(t.netCents)}</dd>
                  </dl>
                  {t.exceptions.map((e) => <p key={e} className="mt-1 text-xs text-warning-text">{e}</p>)}
                </Section>
              ))}
              <Section title="Payment summary">
                <dl className="grid grid-cols-2 gap-1 text-sm">
                  <dt className="text-muted">Vendor earnings (total)</dt><dd className="text-right">{c(s.vendor.totalEarningsCents)}</dd>
                  <dt className="text-muted">Deductions (total)</dt><dd className="text-right">({c(s.vendor.totalDeductionsCents)})</dd>
                  {s.vendor.vendorAdjustmentsCents ? <><dt className="text-muted">Vendor-level adjustments</dt><dd className="text-right">{c(s.vendor.vendorAdjustmentsCents)}</dd></> : null}
                  <dt className="font-semibold text-ink">Final vendor payout</dt><dd className="text-right text-lg font-bold">{c(s.vendor.payoutCents)}</dd>
                </dl>
              </Section>
            </>
          ) : null}
        </div>
        <div className="flex flex-col gap-4">
          <Section title="PDF preview">
            {/* The browser puts no Authorization header on an iframe, so the file is fetched with
                the session like every other request and shown from a blob this page owns. */}
            {pdf.error ? (
              <Alert
                tone="danger"
                title="The PDF could not be loaded"
                description={
                  <span className="flex flex-col items-start gap-2">
                    <span>{pdf.error}</span>
                    <Button variant="secondary" onClick={pdf.retry}>Retry</Button>
                  </span>
                }
              />
            ) : pdf.url ? (
              <iframe title="Statement PDF" src={pdf.url} className="h-[640px] w-full rounded-md border border-line bg-white" />
            ) : (
              <div className="flex h-[640px] w-full items-center justify-center rounded-md border border-line bg-surface-muted text-sm text-muted">Loading…</div>
            )}
            <p className="mt-1 text-2xs text-muted">{s.status === 'approved' || s.status === 'paid' ? 'The approved snapshot; the same file is exported and emailed.' : 'Draft: marked DRAFT on every page. A draft previews and downloads without being approved or paid.'}</p>
          </Section>
          {s.paidAt ? <Section title="Payment"><p className="text-sm">Paid {formatIsoDate(s.paidAt.slice(0, 10))} · {c(s.paidCents ?? s.payableCents)} · {s.paymentId}</p></Section> : null}
        </div>
      </div>
      {paying ? <PayDialog s={s} onClose={() => setPaying(false)} onDone={refresh} /> : null}
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-xl border border-line bg-surface p-4">
      <p className="mb-2 text-sm font-semibold text-ink">{title}</p>
      {children}
    </section>
  );
}

function Rows({ head, rows, foot }: { head: string[]; rows: React.ReactNode[][]; foot?: React.ReactNode[] }) {
  return (
    <table className="w-full text-sm">
      <thead className="text-left text-xs font-semibold uppercase tracking-wide text-muted"><tr>{head.map((h) => <th key={h} className="py-1 pr-2 last:text-right">{h}</th>)}</tr></thead>
      <tbody className="divide-y divide-line-soft">{rows.length === 0 ? <tr><td colSpan={head.length} className="py-2 text-xs text-muted">None.</td></tr> : rows.map((r, i) => <tr key={i}>{r.map((cell, j) => <td key={j} className={cn('py-1 pr-2', j === r.length - 1 && 'text-right tabular-nums')}>{cell}</td>)}</tr>)}</tbody>
      {foot ? <tfoot><tr className="font-semibold">{foot.map((f, j) => <td key={j} className={cn('py-1 pr-2', j === foot.length - 1 && 'text-right tabular-nums')}>{f}</td>)}</tr></tfoot> : null}
    </table>
  );
}

function PayDialog({ s, onClose, onDone }: { s: { id: string; settlementNumber: string; payableCents: number }; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { toast } = useToast();
  const [paidOn, setPaidOn] = useState(today());
  const [reference, setReference] = useState('');
  const [method, setMethod] = useState<'ach' | 'check' | 'wire' | 'cash'>('ach');
  const pay = useMutation({
    mutationFn: () => markStatementPaid(s.id, { paidOn, reference, method }),
    onSuccess: async (r) => {
      await onDone();
      toast({ tone: r.ok ? 'success' : 'danger', title: r.ok ? 'Payment recorded' : 'Not recorded', description: r.ok ? 'The liability is discharged in the ledger.' : r.blocked });
      if (r.ok) onClose();
    },
  });
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} size="sm" title={`Record payment · ${s.settlementNumber}`} description={`${c(s.payableCents)} payable. Approval or an email is not payment; this is the bank's evidence.`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!reference.trim()} loading={pay.isPending} onClick={() => pay.mutate()}>Record</Button></>}>
      <div className="flex flex-col gap-3">
        <FormField label="Paid on" required><Input type="date" value={paidOn} onChange={(e) => setPaidOn(e.target.value)} aria-label="Paid on" /></FormField>
        <FormField label="Method"><Select options={['ach', 'check', 'wire', 'cash'].map((m) => ({ value: m, label: m.toUpperCase() }))} value={method} onValueChange={(v) => setMethod(v as typeof method)} /></FormField>
        <FormField label="Bank / ADP reference" required><Input value={reference} onChange={(e) => setReference(e.target.value)} aria-label="Reference" /></FormField>
      </div>
    </Modal>
  );
}
