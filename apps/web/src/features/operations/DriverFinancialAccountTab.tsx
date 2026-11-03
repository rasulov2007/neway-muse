import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CircleDollarSign, Clock, Landmark, Pencil, Plus, ShieldCheck, Trash2, TrendingUp, Wallet } from 'lucide-react';
import { useState } from 'react';
import { CONTRACT_LABEL, CONTRACT_TYPES, LEASE_SECURITY_DEPOSIT, type LeasePlan, RECURRING_CATEGORIES, RECURRING_LABEL, TX_TREATMENT, defaultSwitches, formatPercent, type DriverTx, type ProfileVersion, type RecurringDeduction } from '@neway/shared';
import { Alert, Badge, Button, Checkbox, FormField, Input, Modal, Select, Switch, Textarea, cn, useToast } from '@/design-system';
import { accountingFileUrl, addDriverAccountNote, addManualCharge, fetchDriverAccount, retryCompletion, saveRecurringDeduction, setDriverTransactionState, updateDriverProfile, type DriverAccount } from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { LeasePlanEditor } from './LeasePlanEditor';
import { EditAmountDialog, StopRecurringDialog, useIsAdmin, type ChangeTarget } from '@/features/accounting/DeductionChanges';
import { today } from '@/lib/clock';
import { formatIsoDate, formatMoney } from '@/lib/format';

/**
 * The driver's Financial Account (§7), inside the driver profile and linked from Accounting.
 *
 * Four balances, kept apart: debt, escrow, pending deductions, current payable. Below them the
 * account's transactions, the debt and escrow histories, the company's own costs (never owed
 * by the driver), the statements and an append-only history. Fleet reads; Accounting writes.
 */

const cents = (c: number | null | undefined) => (c === null || c === undefined ? 'Unknown' : formatMoney(c / 100));

function Tile({ label, value, hint, icon, tone }: { label: string; value: string; hint?: string; icon: React.ReactNode; tone: string }) {
  return (
    <div className="flex items-center justify-between rounded-xl border border-line bg-surface p-4">
      <div>
        <p className="text-xs text-muted">{label}</p>
        <p className="mt-1 text-2xl font-bold text-ink">{value}</p>
        {hint ? <p className="text-xs text-muted">{hint}</p> : null}
      </div>
      <span className={cn('flex size-10 items-center justify-center rounded-full', tone)}>{icon}</span>
    </div>
  );
}

const SUB_TABS = ['overview', 'earnings', 'transactions', 'debt', 'escrow', 'costs', 'history'] as const;
const SUB_LABEL: Record<(typeof SUB_TABS)[number], string> = { overview: 'Overview', earnings: 'Earnings', transactions: 'Transactions', debt: 'Debt', escrow: 'Escrow', costs: 'Company costs', history: 'History' };

/** The pay plan in words: the percent is a percent, the basis is named, never a bare number. */
export function planLabel(plan: ProfileVersion['loadedPlan'] | ProfileVersion['emptyPlan']): string {
  if (plan.kind === 'none') return 'none';
  if (plan.kind === 'per_mile') return `$${plan.rate}/mi`;
  if (plan.kind === 'percent_of_gross') return `${formatPercent(plan.rate)} of gross`;
  if (plan.kind === 'percent_of_linehaul') return `${formatPercent(plan.rate)} of linehaul`;
  return `$${plan.rate}/load`;
}

export function DriverFinancialAccountTab({ driverId }: { driverId: string }) {
  const account = useAccount();
  const canEdit = account?.permissions.includes('accounting.edit') ?? false;
  const queryClient = useQueryClient();
  const { toast } = useToast();
  const query = useQuery({ queryKey: ['accounting', 'driver-account', driverId], queryFn: () => fetchDriverAccount(driverId) });
  const [sub, setSub] = useState<(typeof SUB_TABS)[number]>('overview');
  const [charging, setCharging] = useState(false);
  const [editing, setEditing] = useState(false);
  const [recurring, setRecurring] = useState(false);
  // Edit (everyone with Accounting edit) and Delete (administrators) on a recurring deduction (owner, 2026-10-20).
  const [recChange, setRecChange] = useState<{ mode: 'edit' | 'stop'; target: ChangeTarget } | null>(null);
  const isAdmin = useIsAdmin();
  const [filter, setFilter] = useState<{ source: string; state: string; q: string }>({ source: '', state: '', q: '' });
  const refresh = () => queryClient.invalidateQueries({ queryKey: ['accounting', 'driver-account', driverId] });
  const txState = useMutation({
    mutationFn: (input: { id: string; state: 'approved' | 'disputed' | 'paused' | 'void'; reason: string }) => setDriverTransactionState(input.id, input.state, input.reason),
    onSuccess: async () => {
      await refresh();
      toast({ tone: 'success', title: 'Transaction updated' });
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Refused', description: e instanceof Error ? e.message : undefined }),
  });
  const note = useMutation({
    mutationFn: (body: string) => addDriverAccountNote(driverId, body),
    onSuccess: () => refresh(),
  });
  const [noteText, setNoteText] = useState('');
  const confirmRate = useMutation({
    mutationFn: (reading: 'percent' | 'multiplier') => {
      const a = query.data!;
      const cur = a.profile.current!;
      const rate = reading === 'percent' ? a.rate!.percent : a.rate!.percent * 100;
      return updateDriverProfile(driverId, { effectiveFrom: today(), contractType: cur.contractType, switches: cur.switches, loadedPlan: { kind: cur.loadedPlan.kind, rate }, emptyPlan: cur.emptyPlan, escrow: cur.escrow, lease: cur.lease ?? null, reason: `Rate confirmed as ${formatPercent(rate)} (roster figure ${a.rate!.percent})`, openingDebtCents: a.profile.record.openingDebtCents, openingDebtReconciled: a.profile.record.openingDebtReconciled, expectedVersion: a.profile.version, confirmRate: true });
    },
    onSuccess: async () => { await refresh(); await queryClient.invalidateQueries({ queryKey: ['accounting'] }); toast({ tone: 'success', title: 'Rate confirmed', description: 'Earnings are recalculated from this reading; earlier statements keep their terms.' }); },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not confirmed', description: e instanceof Error ? e.message : undefined }),
  });
  const retry = useMutation({ mutationFn: retryCompletion, onSuccess: async () => { await refresh(); toast({ tone: 'success', title: 'Load reprocessed' }); }, onError: (e: unknown) => toast({ tone: 'danger', title: 'Retry failed', description: e instanceof Error ? e.message : undefined }) });

  if (query.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (query.isError) return <Alert tone="danger" title="The financial account could not be loaded" description={query.error instanceof Error ? query.error.message : undefined} />;
  const a = query.data;
  const current = a.profile.current;
  const txs = a.transactions.filter((t) => (!filter.source || t.source === filter.source) && (!filter.state || t.state === filter.state) && (!filter.q || t.description.toLowerCase().includes(filter.q.toLowerCase()) || (t.loadId ?? '').includes(filter.q)));
  const debtUnknown = a.debt.closingCents === null;

  return (
    <div className="flex flex-col gap-4">
      {a.profile.defaulted ? <Alert tone="warning" title="No financial profile saved yet" description={`Showing the defaults for a ${current ? CONTRACT_LABEL[current.contractType].toLowerCase() : 'driver'} from the roster. Save the profile to confirm the switches, the pay plans and the escrow plan.`} actions={canEdit ? <Button variant="secondary" size="sm" onClick={() => setEditing(true)}>Set up profile</Button> : undefined} /> : null}
      {a.rate && a.rate.ambiguous && !a.rate.confirmed ? (
        <Alert tone="warning" title={`Pay rate needs confirmation: the roster says ${a.rate.percent}`} description={`Read as a percent that is ${a.rate.asPercent} of ${a.rate.basis === 'percent_of_linehaul' ? 'linehaul' : 'gross'}; read as a multiplier it is ${a.rate.asMultiplier}. Earnings are previewed at ${a.rate.asPercent} and cannot be finalised until somebody with Accounting rights confirms which one the contract means.`} actions={canEdit ? <span className="flex gap-2"><Button variant="secondary" size="sm" loading={confirmRate.isPending} onClick={() => confirmRate.mutate('percent')}>It is {a.rate.asPercent}</Button><Button variant="primary" size="sm" loading={confirmRate.isPending} onClick={() => confirmRate.mutate('multiplier')}>It is {a.rate.asMultiplier}</Button></span> : undefined} />
      ) : null}
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-5">
        <Tile label="Earned, not settled" value={a.earnedUnsettledCents === null ? 'Cannot calculate' : formatMoney(a.earnedUnsettledCents / 100)} hint={a.earnedUnsettledCents === null ? (a.earnedBlockers[0] ?? 'A load is missing a figure') : `${a.earnings.filter((e) => e.settlementStatus !== 'approved' && e.settlementStatus !== 'paid').length} completed load(s) awaiting a statement`} icon={<TrendingUp className="size-5 text-primary-text" />} tone="bg-primary-soft" />
        <Tile label="Outstanding debt" value={cents(a.debt.closingCents)} hint={debtUnknown ? 'Opening balance not reconciled' : `${formatMoney(a.debt.recoveredCents / 100)} recovered`} icon={<Wallet className="size-5 text-danger-text" />} tone="bg-danger-soft" />
        <Tile label="Escrow balance" value={a.escrow.balanceCents === null ? formatMoney(a.escrow.movementsCents / 100) : cents(a.escrow.balanceCents)} hint={a.escrow.balanceCents === null ? 'From recorded movements · opening balance not reconciled' : a.escrow.collectionEnabled ? `Target ${formatMoney(a.escrow.targetCents / 100)} · next ${formatMoney(a.escrow.nextDeductionCents / 100)}` : 'Collection off · balance still held'} icon={<ShieldCheck className="size-5 text-success-text" />} tone="bg-success-soft" />
        <Tile label="Pending deductions" value={formatMoney(a.pendingDeductionsCents / 100)} hint="Awaiting approval" icon={<Clock className="size-5 text-warning-text" />} tone="bg-warning-soft" />
        <Tile label="Approved, unpaid" value={formatMoney(a.approvedUnpaidCents / 100)} hint={`${a.draftCount > 0 ? `${a.draftCount} draft(s) ${formatMoney(a.draftNetCents / 100)} · ` : ''}paid to date ${formatMoney(a.paidToDateCents / 100)}`} icon={<CircleDollarSign className="size-5 text-info-text" />} tone="bg-info-soft" />
      </div>

      <div className="grid grid-cols-1 gap-4 xl:grid-cols-[260px_minmax(0,1fr)]">
        <div className="flex flex-col gap-4">
          <div className="rounded-xl border border-line bg-surface p-4">
            <div className="flex items-center justify-between">
              <p className="text-sm font-semibold text-ink">Expense responsibility</p>
              {canEdit ? <Button variant="link" size="sm" onClick={() => setEditing(true)}>Edit</Button> : null}
            </div>
            <p className="mt-1 text-xs text-muted">{current ? `${CONTRACT_LABEL[current.contractType]} · effective ${formatIsoDate(current.effectiveFrom)}` : 'No profile'}</p>
            <ul className="mt-3 flex flex-col gap-2 text-sm">
              {([['deductFuel', 'Deduct fuel', 'from driver settlements'], ['deductTolls', 'Deduct tolls', 'from driver settlements'], ['deductApprovedAdvances', 'Approved advances', 'repay from settlements'], ['recurringDeductions', 'Recurring deductions', 'weekly / monthly plans'], ['escrowEnabled', 'Escrow enabled', 'with automatic deductions']] as const).map(([k, l, d]) => (
                <li key={k} className="flex items-start gap-2">
                  <Checkbox checked={Boolean(current?.switches[k])} disabled aria-label={l} />
                  <span><span className="text-ink">{l}</span><span className="block text-xs text-muted">{d}</span></span>
                </li>
              ))}
            </ul>
            <p className="mt-3 text-xs text-muted">Loaded plan: {current ? planLabel(current.loadedPlan) : 'Loading…'}{a.rate?.confirmed ? ` (confirmed by ${a.rate.confirmedBy})` : a.rate?.ambiguous ? ' (unconfirmed)' : ''} · Empty plan: {current ? (current.emptyPlan.kind === 'none' ? 'no empty-mile pay' : planLabel(current.emptyPlan)) : 'Loading…'}</p>
            <p className="mt-1 text-2xs text-muted">Accounting can edit · Fleet can view</p>
          </div>
          <div className="rounded-xl border border-line bg-surface p-4">
            <p className="text-sm font-semibold text-ink">Payee</p>
            <p className="mt-1 text-xs text-muted">Bank details are held sealed and shown only as the last four digits, on the Settlements page under Payee.</p>
            <Link to="/accounting/settlements" className="mt-2 inline-block text-xs text-primary-text underline">Open settlements</Link>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-1.5">
            {SUB_TABS.map((t) => (
              <button key={t} type="button" aria-pressed={sub === t} onClick={() => setSub(t)} className={cn('h-7 rounded-full px-3 text-xs font-semibold ring-1', sub === t ? 'bg-primary-soft text-primary-text ring-primary/30' : 'bg-surface text-muted ring-line')}>{SUB_LABEL[t]}</button>
            ))}
            <span className="ml-auto flex gap-2">
              {canEdit ? <Button variant="primary" size="sm" icon={<Plus />} onClick={() => setCharging(true)}>Manual charge</Button> : null}
              {canEdit ? <Button variant="secondary" size="sm" onClick={() => setRecurring(true)}>Recurring deduction</Button> : null}
            </span>
          </div>

          {sub === 'overview' ? (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
              <div className="rounded-xl border border-line bg-surface p-4 text-sm">
                <p className="font-semibold text-ink">Debt history</p>
                <dl className="mt-2 grid grid-cols-2 gap-1 text-xs">
                  <dt className="text-muted">Opening balance</dt><dd className="text-right text-ink">{cents(a.debt.openingCents)}</dd>
                  <dt className="text-muted">New charges</dt><dd className="text-right text-ink">{formatMoney(a.debt.newChargesCents / 100)}</dd>
                  <dt className="text-muted">Recovered</dt><dd className="text-right text-success-text">({formatMoney(a.debt.recoveredCents / 100)})</dd>
                  <dt className="font-semibold text-danger-text">Outstanding debt</dt><dd className="text-right font-semibold text-danger-text">{cents(a.debt.closingCents)}</dd>
                </dl>
              </div>
              <div className="rounded-xl border border-line bg-surface p-4 text-sm">
                <p className="font-semibold text-ink">Escrow history</p>
                <dl className="mt-2 grid grid-cols-2 gap-1 text-xs">
                  <dt className="text-muted">Collection</dt><dd className="text-right text-ink">{a.escrow.collectionEnabled ? 'On' : 'Off'}</dd>
                  <dt className="text-muted">Target balance</dt><dd className="text-right text-ink">{formatMoney(a.escrow.targetCents / 100)}</dd>
                  <dt className="text-muted">Current balance</dt><dd className="text-right text-ink">{a.escrow.balanceCents === null ? `${formatMoney(a.escrow.movementsCents / 100)} (opening not reconciled)` : cents(a.escrow.balanceCents)}</dd>
                  <dt className="text-muted">Next deduction</dt><dd className="text-right text-ink">{a.escrow.collectionEnabled ? formatMoney(a.escrow.nextDeductionCents / 100) : 'None (collection off)'}</dd>
                  <dt className="text-muted">Deposits</dt><dd className="text-right text-ink">{formatMoney(a.escrow.depositsCents / 100)}</dd>
                  <dt className="text-muted">Refunds / offsets</dt><dd className="text-right text-ink">{formatMoney((a.escrow.refundsCents + a.escrow.offsetsCents) / 100)}</dd>
                </dl>
                {!a.escrow.collectionEnabled && (a.escrow.balanceCents ?? 0) > 0 ? <p className="mt-2 text-2xs text-muted">Collection is switched off on the profile; the balance already held stays the driver's.</p> : null}
              </div>
              <div className="rounded-xl border border-line bg-surface p-4 text-sm">
                <p className="font-semibold text-ink">Company costs</p>
                <p className="mt-1 text-xs text-muted">Not deducted from the driver. These are company expenses and do not reduce the payable.</p>
                <p className="mt-2 text-lg font-bold text-ink">{formatMoney(a.companyCosts.reduce((s, t) => s + t.amountCents, 0) / 100)}</p>
              </div>
              <p className="md:col-span-3 rounded-lg bg-info-soft px-3 py-2 text-xs text-info-text">Escrow and debt are separate balances. Funds in escrow are not applied to outstanding debt unless Accounting records an explicit offset.</p>
            </div>
          ) : null}

          {sub === 'earnings' ? (
            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              {a.earnings.length === 0 ? <p className="p-4 text-xs text-muted">No completed load has produced an earning for this driver yet. A load enters here when it is delivered or closed; if it was completed before the pipeline existed, Accounting runs the backfill from the overview.</p> : (
                <table className="w-full text-xs">
                  <thead><tr className="text-left text-muted"><th className="px-3 py-2">Load</th><th className="px-3 py-2">Completed</th><th className="px-3 py-2 text-right">Gross</th><th className="px-3 py-2 text-right">Linehaul</th><th className="px-3 py-2">Plan</th><th className="px-3 py-2 text-right">Earned</th><th className="px-3 py-2">Billing</th><th className="px-3 py-2">Statement</th><th className="px-3 py-2">State</th><th /></tr></thead>
                  <tbody className="divide-y divide-line-soft">
                    {a.earnings.map((e) => (
                      <tr key={e.loadId}>
                        <td className="px-3 py-2"><Link to="/loads/$loadNumber" params={{ loadNumber: e.loadNumber }} className="font-semibold text-primary-text">{e.loadNumber}</Link><span className="ml-1 text-muted">{e.loadStatus}</span></td>
                        <td className="px-3 py-2 text-secondary">{e.completedAt ? formatIsoDate(e.completedAt.slice(0, 10)) : '—'}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMoney(e.grossCents / 100)}</td>
                        <td className="px-3 py-2 text-right tabular-nums">{formatMoney(e.linehaulCents / 100)}</td>
                        <td className="px-3 py-2 text-secondary">{e.planKind ? planLabel({ kind: e.planKind as ProfileVersion['loadedPlan']['kind'], rate: e.planRate ?? 0 }) : 'No plan'}{e.planEffectiveFrom ? ` · from ${formatIsoDate(e.planEffectiveFrom)}` : ''}</td>
                        <td className="px-3 py-2 text-right tabular-nums font-semibold text-ink">{e.cents === null ? 'Cannot calculate' : formatMoney(e.cents / 100)}</td>
                        <td className="px-3 py-2"><Badge tone={e.invoiceQueue === 'ready_to_bill' || e.invoiceQueue === 'ready_to_submit' ? 'success' : e.invoiceQueue === null ? 'info' : 'warning'} size="sm">{e.invoiceQueue ? e.invoiceQueue.replace(/_/g, ' ') : e.invoiceStatus ?? 'invoiced'}</Badge></td>
                        <td className="px-3 py-2">{e.settlementId ? <Link to="/accounting/settlements/$settlementId" params={{ settlementId: e.settlementId }} className="text-primary-text underline">{e.settlementStatus}</Link> : <span className="text-muted">not on a statement</span>}</td>
                        <td className="px-3 py-2">{e.pipelineState === 'error' ? <span className="text-danger-text">{e.pipelineError}</span> : e.blockers.length > 0 ? <span className="text-warning-text" title={e.blockers.join('; ')}>{e.blockers[0]}</span> : <span className="text-success-text">Ready</span>}</td>
                        <td className="px-3 py-2 text-right">{canEdit ? <Button variant="link" size="sm" onClick={() => retry.mutate(e.loadId)}>Recalculate</Button> : null}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          ) : null}

          {sub === 'transactions' || sub === 'debt' || sub === 'costs' ? (
            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              {sub === 'transactions' ? (
                <div className="flex flex-wrap gap-2 border-b border-line-soft p-3">
                  <Input className="w-48" placeholder="Search description or load" value={filter.q} onChange={(e) => setFilter((f) => ({ ...f, q: e.target.value }))} aria-label="Search transactions" />
                  <Select className="w-40" options={[{ value: '', label: 'All sources' }, { value: 'import', label: 'Imports' }, { value: 'manual', label: 'Manual' }, { value: 'work_order', label: 'Repairs' }, { value: 'legacy_escrow', label: 'Legacy escrow' }, { value: 'settlement', label: 'Settlements' }]} value={filter.source} onValueChange={(v) => setFilter((f) => ({ ...f, source: v }))} aria-label="Source" />
                  <Select className="w-40" options={[{ value: '', label: 'All states' }, ...['pending', 'approved', 'applied', 'disputed', 'paused', 'void'].map((s) => ({ value: s, label: s }))]} value={filter.state} onValueChange={(v) => setFilter((f) => ({ ...f, state: v }))} aria-label="State" />
                </div>
              ) : null}
              <TxTable rows={sub === 'debt' ? a.debt.open : sub === 'costs' ? a.companyCosts : txs} canEdit={canEdit} onState={(id, state, reason) => txState.mutate({ id, state, reason })} showRecovered={sub === 'debt'} />
            </div>
          ) : null}

          {sub === 'escrow' ? (
            <div className="overflow-hidden rounded-xl border border-line bg-surface">
              <TxTable rows={a.transactions.filter((t) => TX_TREATMENT[t.kind] === 'escrow')} canEdit={canEdit} onState={(id, state, reason) => txState.mutate({ id, state, reason })} showRecovered={false} />
            </div>
          ) : null}

          {sub === 'history' ? (
            <div className="flex flex-col gap-3">
              <div className="rounded-xl border border-line bg-surface p-4">
                <p className="text-sm font-semibold text-ink">Statements &amp; payments</p>
                {a.statements.length === 0 ? <p className="mt-2 text-xs text-muted">No statements yet.</p> : (
                  <ul className="mt-2 divide-y divide-line-soft text-sm">
                    {a.statements.map((s) => (
                      <li key={s.id} className="flex items-center justify-between py-2">
                        <span><Link to="/accounting/settlements/$settlementId" params={{ settlementId: s.id }} className="font-semibold text-primary-text">{s.settlementNumber}</Link><span className="ml-2 text-xs text-muted">{formatIsoDate(s.periodStart)} – {formatIsoDate(s.periodEnd)}</span></span>
                        <span className="flex items-center gap-3 text-xs"><Badge tone={s.status === 'paid' ? 'success' : s.status === 'approved' ? 'info' : 'neutral'} size="sm">{s.status}</Badge><span className="tabular-nums text-ink">{formatMoney(s.payableCents / 100)}</span><a className="text-primary-text underline" href={accountingFileUrl(`settlements/${s.id}/pdf`)}>PDF</a></span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <div className="rounded-xl border border-line bg-surface p-4">
                <p className="text-sm font-semibold text-ink">Profile versions</p>
                <ul className="mt-2 text-xs text-secondary">
                  {a.profile.record.versions.length === 0 ? <li>None saved.</li> : a.profile.record.versions.map((v: ProfileVersion) => <li key={v.effectiveFrom}>{formatIsoDate(v.effectiveFrom)} · {CONTRACT_LABEL[v.contractType]} · fuel {v.switches.deductFuel ? 'deducted' : 'company'} · tolls {v.switches.deductTolls ? 'deducted' : 'company'} · escrow {v.switches.escrowEnabled ? 'on' : 'off'} · by {v.byName}{v.reason ? ` · ${v.reason}` : ''}</li>)}
                </ul>
              </div>
              <div className="rounded-xl border border-line bg-surface p-4">
                <p className="text-sm font-semibold text-ink">Notes</p>
                <ul className="mt-2 text-xs text-secondary">{a.history.map((n) => <li key={n.id}>{formatIsoDate(n.at.slice(0, 10))} · {n.byName}: {n.body}</li>)}</ul>
                {canEdit ? <div className="mt-2 flex gap-2"><Input value={noteText} onChange={(e) => setNoteText(e.target.value)} placeholder="Add a manual note" aria-label="Manual note" /><Button variant="secondary" size="sm" disabled={!noteText.trim()} onClick={() => { note.mutate(noteText.trim()); setNoteText(''); }}>Add</Button></div> : null}
              </div>
            </div>
          ) : null}

          {a.recurring.length > 0 ? (
            <div className="rounded-xl border border-line bg-surface p-4">
              <p className="text-sm font-semibold text-ink">Recurring deductions</p>
              <ul className="mt-2 divide-y divide-line-soft text-sm">
                {a.recurring.map((r: RecurringDeduction) => (
                  <li key={r.id} className="flex items-center justify-between py-2">
                    <span>{r.label || RECURRING_LABEL[r.category]}<span className="ml-2 text-xs text-muted">{r.cadence} · from {formatIsoDate(r.startsOn)}{r.endsOn ? ` to ${formatIsoDate(r.endsOn)}` : ''}{r.appliesWhenNoWork ? '' : ' · only when worked'}</span></span>
                    <span className="flex items-center gap-2 text-xs"><Badge tone={r.status === 'active' ? 'success' : 'neutral'} size="sm">{r.status}</Badge><span className="tabular-nums">{formatMoney(r.amountCents / 100)}</span>{r.totalCents !== null ? <span className="text-muted">{formatMoney(r.chargedCents / 100)} of {formatMoney(r.totalCents / 100)}</span> : null}{canEdit && r.status === 'active' ? <Button variant="outline" size="sm" icon={<Pencil />} onClick={() => setRecChange({ mode: 'edit', target: { kind: 'recurring', ref: r.id, driverId, description: r.label || RECURRING_LABEL[r.category], cents: r.amountCents, periodStart: null } })}>Edit</Button> : null}{canEdit && isAdmin && r.status === 'active' ? <Button variant="outline" size="sm" icon={<Trash2 />} aria-label={`Delete ${r.label || RECURRING_LABEL[r.category]}`} onClick={() => setRecChange({ mode: 'stop', target: { kind: 'recurring', ref: r.id, driverId, description: r.label || RECURRING_LABEL[r.category], cents: r.amountCents, periodStart: null } })} /> : null}</span>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>

      {charging ? <ManualChargeDialog driverId={driverId} driverName={a.name ?? driverId} onClose={() => setCharging(false)} onDone={refresh} /> : null}
      {editing ? <ProfileDialog account={a} onClose={() => setEditing(false)} onDone={refresh} /> : null}
      {recurring ? <RecurringDialog driverId={driverId} onClose={() => setRecurring(false)} onDone={refresh} /> : null}
      {recChange?.mode === 'edit' ? <EditAmountDialog target={recChange.target} onClose={() => setRecChange(null)} onDone={() => queryClient.invalidateQueries({ queryKey: ['accounting'] })} /> : null}
      {recChange?.mode === 'stop' ? <StopRecurringDialog target={recChange.target} onClose={() => setRecChange(null)} onDone={() => queryClient.invalidateQueries({ queryKey: ['accounting'] })} /> : null}
    </div>
  );
}

function TxTable({ rows, canEdit, onState, showRecovered }: { rows: DriverTx[]; canEdit: boolean; onState: (id: string, state: 'approved' | 'disputed' | 'paused' | 'void', reason: string) => void; showRecovered: boolean }) {
  if (rows.length === 0) return <p className="p-4 text-sm text-muted">Nothing here.</p>;
  return (
    <table className="w-full text-sm">
      <thead className="bg-surface-muted text-left text-xs font-semibold uppercase tracking-wide text-muted">
        <tr><th className="px-3 py-2">Date</th><th className="px-3 py-2">Type</th><th className="px-3 py-2">Source</th><th className="px-3 py-2">Description</th><th className="px-3 py-2 text-right">Amount</th>{showRecovered ? <th className="px-3 py-2 text-right">Recovered</th> : null}<th className="px-3 py-2">Treatment</th><th className="px-3 py-2">Status</th>{canEdit ? <th className="px-3 py-2" /> : null}</tr>
      </thead>
      <tbody className="divide-y divide-line-soft">
        {rows.map((t) => (
          <tr key={t.id}>
            <td className="px-3 py-2 whitespace-nowrap">{formatIsoDate(t.onDate)}</td>
            <td className="px-3 py-2">{t.kind.replace(/_/g, ' ')}</td>
            <td className="px-3 py-2 text-xs text-muted">{t.source}</td>
            <td className="px-3 py-2">{t.description}{t.reason ? <span className="block text-xs text-muted">{t.reason}</span> : null}</td>
            <td className="px-3 py-2 text-right tabular-nums">{formatMoney(t.amountCents / 100)}</td>
            {showRecovered ? <td className="px-3 py-2 text-right tabular-nums text-success-text">{formatMoney(t.recoveredCents / 100)}</td> : null}
            <td className="px-3 py-2 text-xs">{t.companyCost ? 'Company cost' : TX_TREATMENT[t.kind] === 'driver_charge' ? 'Driver charge' : TX_TREATMENT[t.kind] === 'escrow' ? 'Escrow' : TX_TREATMENT[t.kind] === 'credit' ? 'Credit to driver' : 'Recovery'}</td>
            <td className="px-3 py-2"><Badge tone={t.state === 'applied' ? 'info' : t.state === 'approved' ? 'success' : t.state === 'pending' ? 'warning' : t.state === 'disputed' || t.state === 'paused' ? 'danger' : 'neutral'} size="sm">{t.state}</Badge></td>
            {canEdit ? (
              <td className="px-3 py-2 text-xs">
                {t.state === 'pending' ? <Button variant="link" size="sm" onClick={() => onState(t.id, 'approved', 'Approved')}>Approve</Button> : null}
                {t.state === 'approved' && !t.companyCost ? <Button variant="link" size="sm" onClick={() => { const reason = window.prompt('Why is it disputed?') ?? ''; if (reason) onState(t.id, 'disputed', reason); }}>Dispute</Button> : null}
                {t.state === 'disputed' || t.state === 'paused' ? <Button variant="link" size="sm" onClick={() => onState(t.id, 'approved', 'Resumed')}>Resume</Button> : null}
              </td>
            ) : null}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function ManualChargeDialog({ driverId, driverName, onClose, onDone }: { driverId: string; driverName: string; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { toast } = useToast();
  const [kind, setKind] = useState<'manual_charge' | 'reimbursement' | 'adjustment' | 'advance' | 'escrow_refund' | 'escrow_offset' | 'escrow_deposit'>('manual_charge');
  const [amount, setAmount] = useState('');
  const [onDate, setOnDate] = useState(today());
  const [description, setDescription] = useState('');
  const [loadId, setLoadId] = useState('');
  const [reason, setReason] = useState('');
  const [approval, setApproval] = useState(false);
  const [installments, setInstallments] = useState('');
  const save = useMutation({
    mutationFn: () => addManualCharge(driverId, { kind, amountCents: Math.round(Number(amount) * 100), onDate, description, reason, loadId: loadId || undefined, approvalRequired: approval, installments: installments ? Number(installments) : undefined }),
    onSuccess: async () => {
      await onDone();
      toast({ tone: 'success', title: 'Recorded', description: approval ? 'Pending Accounting approval.' : 'Approved; it is taken on the next statement.' });
      onClose();
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Refused', description: e instanceof Error ? e.message : undefined }),
  });
  const ready = Number(amount) > 0 && description.trim().length >= 2 && reason.trim().length >= 3;
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} size="sm" title="Manual charge" description={`${driverName}. Late delivery and other charges are reviewed, never automatic.`} footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!ready || save.isPending} loading={save.isPending} onClick={() => save.mutate()}>{approval ? 'Send for approval' : 'Save'}</Button></>}>
      <div className="flex flex-col gap-3">
        <FormField label="Type" required><Select options={[{ value: 'manual_charge', label: 'Charge (driver owes)' }, { value: 'advance', label: 'Advance' }, { value: 'reimbursement', label: 'Reimbursement (credit)' }, { value: 'adjustment', label: 'Adjustment (credit)' }, { value: 'escrow_deposit', label: 'Escrow deposit' }, { value: 'escrow_refund', label: 'Escrow refund' }, { value: 'escrow_offset', label: 'Escrow offset against debt (authorised)' }]} value={kind} onValueChange={(v) => setKind(v as typeof kind)} /></FormField>
        <FormField label="Amount (USD)" required><Input prefix="$" type="number" step="0.01" min={0} value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" /></FormField>
        <FormField label="Date" required><Input type="date" value={onDate} onChange={(e) => setOnDate(e.target.value)} aria-label="Date" /></FormField>
        <FormField label="Description" required><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Late delivery · L-100004" aria-label="Description" /></FormField>
        <FormField label="Load reference (optional)"><Input value={loadId} onChange={(e) => setLoadId(e.target.value)} placeholder="ld_…" aria-label="Load reference" /></FormField>
        <FormField label="Reason" required><Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" /></FormField>
        <FormField label="Installments (optional)" description="Recover over this many settlements."><Input type="number" min={1} max={52} value={installments} onChange={(e) => setInstallments(e.target.value)} aria-label="Installments" /></FormField>
        <Checkbox checked={approval} onCheckedChange={(v) => setApproval(v === true)} label="Approval required — send to Accounting for approval" />
      </div>
    </Modal>
  );
}

/**
 * The one financial profile editor, preloaded from what is on record. With `review` it opens as
 * the driver's review task: the issues kept apart, the two readings of an ambiguous rate with
 * the earning each would give on the driver's actual completed loads, and a rate confirmation
 * that is ticked on purpose, never assumed.
 */
export function ProfileDialog({ account, onClose, onDone, review }: { account: DriverAccount; onClose: () => void; onDone: () => Promise<unknown>; review?: { issues: Array<{ kind: string; label: string; detail: string }> } }) {
  const { toast } = useToast();
  const cur = account.profile.current;
  const [confirmRate, setConfirmRate] = useState(false);
  const [contract, setContract] = useState<'CD' | 'LO' | 'OO'>(cur?.contractType ?? 'CD');
  const [switches, setSwitches] = useState(cur?.switches ?? defaultSwitches('CD'));
  const [loadedKind, setLoadedKind] = useState(cur?.loadedPlan.kind ?? 'none');
  const [loadedRate, setLoadedRate] = useState(String(cur?.loadedPlan.rate ?? ''));
  const [emptyKind, setEmptyKind] = useState(cur?.emptyPlan.kind ?? 'none');
  const [emptyRate, setEmptyRate] = useState(String(cur?.emptyPlan.rate ?? ''));
  const [effectiveFrom, setEffectiveFrom] = useState(today());
  const [escrowTarget, setEscrowTarget] = useState(String((cur?.escrow.targetCents ?? 250_000) / 100));
  const [escrowPer, setEscrowPer] = useState(String((cur?.escrow.perSettlementCents ?? 35_000) / 100));
  const [escrowOpening, setEscrowOpening] = useState(cur?.escrow.openingBalanceCents === null || cur?.escrow.openingBalanceCents === undefined ? '' : String(cur.escrow.openingBalanceCents / 100));
  const [escrowReconciled, setEscrowReconciled] = useState(cur?.escrow.openingReconciled ?? false);
  const [openingDebt, setOpeningDebt] = useState(account.profile.record.openingDebtCents === null ? '' : String(account.profile.record.openingDebtCents / 100));
  const [debtReconciled, setDebtReconciled] = useState(account.profile.record.openingDebtReconciled);
  const [reason, setReason] = useState('');
  const [lease, setLease] = useState<LeasePlan | null>(cur?.lease ?? null);
  const save = useMutation({
    mutationFn: () => updateDriverProfile(account.driverId, {
      effectiveFrom,
      contractType: contract,
      switches,
      loadedPlan: { kind: loadedKind, rate: Number(loadedRate) || 0 },
      emptyPlan: { kind: emptyKind, rate: Number(emptyRate) || 0 },
      escrow: { targetCents: Math.round(Number(escrowTarget) * 100), perSettlementCents: Math.round(Number(escrowPer) * 100), openingBalanceCents: escrowOpening === '' ? null : Math.round(Number(escrowOpening) * 100), openingReconciled: escrowReconciled },
      lease,
      reason: reason || undefined,
      openingDebtCents: openingDebt === '' ? null : Math.round(Number(openingDebt) * 100),
      openingDebtReconciled: debtReconciled,
      expectedVersion: account.profile.version,
      confirmRate: confirmRate || undefined,
    }),
    onSuccess: async () => {
      await onDone();
      toast({ tone: 'success', title: 'Profile saved', description: `Effective ${formatIsoDate(effectiveFrom)}; earlier statements keep their terms.` });
      onClose();
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not saved', description: e instanceof Error ? e.message : undefined }),
  });
  const percentKind = loadedKind === 'percent_of_gross' || loadedKind === 'percent_of_linehaul';
  const rateNum = Number(loadedRate) || 0;
  const ambiguous = percentKind && rateNum > 0 && rateNum < 1;
  const sample = account.earnings.filter((e) => e.settlementStatus !== 'approved' && e.settlementStatus !== 'paid').slice(0, 3);
  const basisCents = (e: (typeof sample)[number]) => (loadedKind === 'percent_of_linehaul' ? e.linehaulCents : e.grossCents);
  const planOptions = [{ value: 'none', label: 'None' }, { value: 'per_mile', label: 'Per mile ($)' }, { value: 'percent_of_linehaul', label: '% of linehaul' }, { value: 'percent_of_gross', label: '% of gross (linehaul + accessorials in the base)' }, { value: 'flat_per_load', label: 'Flat per load ($)' }];
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} size="md" title="Financial profile" description="Effective-dated. Changing it today never rewrites a statement already computed." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" loading={save.isPending} onClick={() => save.mutate()}>Save profile</Button></>}>
      <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
        {review ? (
          <div className="md:col-span-2 rounded-lg bg-surface-muted p-3">
            <p className="text-xs font-semibold text-ink">What needs a decision</p>
            <ul className="mt-1 flex flex-col gap-1 text-xs text-secondary">{review.issues.map((i) => <li key={i.kind}><span className="font-semibold text-ink">{i.label}:</span> {i.detail}</li>)}</ul>
            <p className="mt-2 text-2xs text-muted">Values below are what is on record. Change only what is wrong; each issue clears on its own.</p>
          </div>
        ) : null}
        {percentKind && rateNum > 0 ? (
          <div className="md:col-span-2 rounded-lg border border-line p-3">
            <p className="text-xs font-semibold text-ink">Rate reading{ambiguous ? ' — ambiguous, choose one' : ''}</p>
            <table className="mt-2 w-full text-xs">
              <thead className="text-left text-muted"><tr><th className="py-1">Reading</th><th className="py-1">Multiplier</th>{sample.map((e) => <th key={e.loadId} className="py-1 text-right">{e.loadNumber} ({formatMoney(basisCents(e) / 100)})</th>)}</tr></thead>
              <tbody>
                <tr><td className="py-1">{formatPercent(rateNum)} as entered</td><td className="py-1">× {(rateNum / 100).toFixed(4)}</td>{sample.map((e) => <td key={e.loadId} className="py-1 text-right tabular-nums">{formatMoney(Math.round(basisCents(e) * rateNum / 100) / 100)}</td>)}</tr>
                {ambiguous ? <tr><td className="py-1">{formatPercent(rateNum * 100)} if {rateNum} was a multiplier</td><td className="py-1">× {rateNum.toFixed(4)}</td>{sample.map((e) => <td key={e.loadId} className="py-1 text-right tabular-nums">{formatMoney(Math.round(basisCents(e) * rateNum) / 100)}</td>)}</tr> : null}
              </tbody>
            </table>
            {ambiguous ? <p className="mt-2 text-2xs text-warning-text">To confirm {formatPercent(rateNum * 100)}, enter {rateNum * 100} above. The saved figure is always a percent.</p> : null}
            <div className="mt-2"><Checkbox checked={confirmRate} onCheckedChange={(v) => setConfirmRate(v === true)} label={`Confirm this rate (${formatPercent(rateNum)} of ${loadedKind === 'percent_of_linehaul' ? 'linehaul' : 'gross'}) as reviewed`} /></div>
            {loadedKind === 'percent_of_linehaul' ? <p className="mt-1 text-2xs text-muted">Basis stays linehaul unless you change the plan to % of gross here, with a reason: a reviewed conversion, never a silent rewrite.</p> : null}
          </div>
        ) : null}
        <FormField label="Contract type" required><Select options={CONTRACT_TYPES.map((c) => ({ value: c, label: CONTRACT_LABEL[c] }))} value={contract} onValueChange={(v) => { const c = v as 'CD' | 'LO' | 'OO'; setContract(c); setSwitches(defaultSwitches(c)); }} /></FormField>
        <FormField label="Effective from" required><Input type="date" value={effectiveFrom} onChange={(e) => setEffectiveFrom(e.target.value)} aria-label="Effective from" /></FormField>
        <div className="md:col-span-2 flex flex-col gap-2 rounded-lg bg-surface-muted p-3">
          {([['deductFuel', 'Deduct fuel from settlements'], ['deductTolls', 'Deduct tolls from settlements'], ['deductApprovedAdvances', 'Recover approved advances'], ['recurringDeductions', 'Apply recurring deductions'], ['escrowEnabled', 'Escrow enabled']] as const).map(([k, l]) => (
            <Switch key={k} checked={switches[k]} onCheckedChange={(v) => setSwitches((s) => ({ ...s, [k]: v }))} label={l} />
          ))}
          <p className="text-2xs text-muted">Defaults: a company driver’s fuel and tolls are company costs; an owner’s are deducted. A contract exception is set here, on purpose.</p>
        </div>
        <FormField label="Loaded pay plan"><Select options={planOptions} value={loadedKind} onValueChange={(v) => setLoadedKind(v as typeof loadedKind)} /></FormField>
        <FormField label={loadedKind === 'percent_of_gross' || loadedKind === 'percent_of_linehaul' ? 'Loaded rate (percent: 30 means 30%)' : 'Loaded rate'} description={loadedKind === 'percent_of_gross' || loadedKind === 'percent_of_linehaul' ? `Reads as ${formatPercent(Number(loadedRate) || 0)}` : undefined}><Input type="number" step="0.01" value={loadedRate} onChange={(e) => setLoadedRate(e.target.value)} aria-label="Loaded rate" /></FormField>
        <FormField label="Empty pay plan" description="Blank means no empty-mile pay, never the loaded rate."><Select options={planOptions.filter((o) => o.value !== 'percent_of_gross' && o.value !== 'percent_of_linehaul')} value={emptyKind} onValueChange={(v) => setEmptyKind(v as typeof emptyKind)} /></FormField>
        <FormField label="Empty rate"><Input type="number" step="0.01" value={emptyRate} onChange={(e) => setEmptyRate(e.target.value)} aria-label="Empty rate" /></FormField>
        <LeasePlanEditor
          value={lease}
          onChange={(next) => {
            setLease(next);
            // A lease plan is paid the whole gross less its charges, with the $3,000 deposit.
            if (next && !lease) {
              setContract(next.kind === 'owner_truck' ? 'OO' : 'LO');
              setLoadedKind('percent_of_gross');
              setLoadedRate('100');
              setSwitches((sw) => ({ ...sw, recurringDeductions: true, escrowEnabled: true }));
              setEscrowTarget(String(LEASE_SECURITY_DEPOSIT.targetCents / 100));
              setEscrowPer(String(LEASE_SECURITY_DEPOSIT.perSettlementCents / 100));
            }
          }}
        />
        <FormField label="Escrow target ($)"><Input type="number" step="1" value={escrowTarget} onChange={(e) => setEscrowTarget(e.target.value)} aria-label="Escrow target" /></FormField>
        <FormField label="Escrow per settlement ($)"><Input type="number" step="1" value={escrowPer} onChange={(e) => setEscrowPer(e.target.value)} aria-label="Escrow per settlement" /></FormField>
        <FormField label="Escrow opening balance ($)" description="Blank = unknown (not zero). Tick reconciled once verified."><Input prefix="$" type="number" step="0.01" value={escrowOpening} onChange={(e) => setEscrowOpening(e.target.value)} aria-label="Escrow opening balance" /></FormField>
        <div className="flex items-end pb-2"><Checkbox checked={escrowReconciled} onCheckedChange={(v) => setEscrowReconciled(v === true)} label="Escrow opening reconciled" /></div>
        <FormField label="Opening debt ($)" description="Blank = unknown; an unknown opening keeps the closing unknown."><Input type="number" step="0.01" value={openingDebt} onChange={(e) => setOpeningDebt(e.target.value)} aria-label="Opening debt" /></FormField>
        <div className="flex items-end pb-2"><Checkbox checked={debtReconciled} onCheckedChange={(v) => setDebtReconciled(v === true)} label="Opening debt reconciled" /></div>
        <FormField label="Reason for the change" className="md:col-span-2"><Input value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Reason" /></FormField>
      </div>
    </Modal>
  );
}

function RecurringDialog({ driverId, onClose, onDone }: { driverId: string; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { toast } = useToast();
  const [category, setCategory] = useState<(typeof RECURRING_CATEGORIES)[number]>('insurance');
  const [label, setLabel] = useState('');
  const [cadence, setCadence] = useState<'weekly' | 'monthly'>('weekly');
  const [amount, setAmount] = useState('');
  const [startsOn, setStartsOn] = useState(today());
  const [endsOn, setEndsOn] = useState('');
  const [noWork, setNoWork] = useState(true);
  const [total, setTotal] = useState('');
  const save = useMutation({
    mutationFn: () => saveRecurringDeduction(driverId, { category, label: label || undefined, cadence, amountCents: Math.round(Number(amount) * 100), startsOn, endsOn: endsOn || null, appliesWhenNoWork: noWork, totalCents: total ? Math.round(Number(total) * 100) : null, status: 'active', overrides: [] }),
    onSuccess: async () => {
      await onDone();
      toast({ tone: 'success', title: 'Recurring deduction saved' });
      onClose();
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not saved', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <Modal open onOpenChange={(o) => (o ? undefined : onClose())} size="sm" title="Recurring deduction" description="Weekly or monthly; pauses and one-week overrides are recorded with a reason." footer={<><Button variant="secondary" onClick={onClose}>Cancel</Button><Button variant="primary" disabled={!(Number(amount) > 0) || save.isPending} loading={save.isPending} onClick={() => save.mutate()}>Save</Button></>}>
      <div className="flex flex-col gap-3">
        <FormField label="Category" required><Select options={RECURRING_CATEGORIES.map((c) => ({ value: c, label: RECURRING_LABEL[c] }))} value={category} onValueChange={(v) => setCategory(v as typeof category)} /></FormField>
        <FormField label="Label"><Input value={label} onChange={(e) => setLabel(e.target.value)} aria-label="Label" /></FormField>
        <FormField label="Cadence" required><Select options={[{ value: 'weekly', label: 'Weekly' }, { value: 'monthly', label: 'Monthly' }]} value={cadence} onValueChange={(v) => setCadence(v as 'weekly' | 'monthly')} /></FormField>
        <FormField label="Amount ($)" required><Input prefix="$" type="number" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label="Amount" /></FormField>
        <div className="grid grid-cols-2 gap-2"><FormField label="Starts"><Input type="date" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} aria-label="Starts" /></FormField><FormField label="Ends"><Input type="date" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} aria-label="Ends" /></FormField></div>
        <FormField label="Installment total ($)" description="Blank = open-ended."><Input prefix="$" type="number" step="0.01" value={total} onChange={(e) => setTotal(e.target.value)} aria-label="Total" /></FormField>
        <Checkbox checked={noWork} onCheckedChange={(v) => setNoWork(v === true)} label="Charge in weeks with no loads (LO/OO fixed charges)" />
        <p className="flex items-center gap-1 text-2xs text-muted"><Landmark className="size-3" /> The full deduction policy is not on file; each rule is configured here, not assumed.</p>
      </div>
    </Modal>
  );
}
