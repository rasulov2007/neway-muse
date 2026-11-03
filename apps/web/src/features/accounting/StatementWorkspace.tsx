import { useMutation, useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { ArrowRightFromLine, Check, Minus, Pencil, Plus, SkipForward, Trash2, Undo2, Upload } from 'lucide-react';
import { useRef, useState } from 'react';
import { REIMBURSEMENT_CATEGORIES, REIMBURSEMENT_CATEGORY_LABEL, loadRefLabel, type LoadPayFacts, type ReimbursementCategory } from '@neway/shared';
import { Alert, Badge, Button, FormField, Input, Select, cn, useToast } from '@/design-system';
import {
  addManualCharge,
  approveStatement,
  createReimbursement,
  fetchDriverAccount,
  fetchStatement,
  putBackStatementLoad,
  removeStatementLoad,
  reviewReimbursement,
  setDriverTransactionState,
  setStatementLoadPayFacts,
  type Statement,
} from '@/demo';
import { ApiError } from '@/lib/api-client';
import { uploadFile } from '@/lib/files';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { AuthedFileLink } from './AuthedFileLink';
import { payWindowLabel } from './pay-window';
import { EditAmountDialog, SkipWeekDialog, StopRecurringDialog, useIsAdmin, type ChangeTarget } from './DeductionChanges';
import { EnterOdometerButton } from './EnterOdometerDialog';
import { ReopenStatementButton } from './ReopenStatementDialog';

/**
 * One driver statement, finished in one place.
 *
 * Everything the statement pays and takes off is listed line by line as it stands - each load's
 * pay, each reimbursement, fuel, tolls, advances, recurring deductions, repayments and escrow - so
 * nothing has to be looked up elsewhere. While the statement is still a draft, Accounting can add
 * a deduction or a reimbursement here, remove a deduction added by mistake, and approve.
 *
 * Adding goes through the same records the driver's Financial tab uses - a charge on the driver's
 * account, a reimbursement - and the week's draft statements are then updated, exactly as the
 * Update draft statements button does, so the table and its totals stay in step. Nothing here
 * calculates pay; every figure comes back from the server.
 */

const c = (cents: number) => formatMoney(cents / 100);

const DEDUCTION_KINDS = [
  { value: 'Fuel', label: 'Fuel' },
  { value: 'Damage', label: 'Damage' },
  { value: 'Fine or ticket', label: 'Fine or ticket' },
  { value: 'Equipment', label: 'Equipment' },
  { value: 'Uniform', label: 'Uniform' },
  { value: 'Other', label: 'Other' },
];

const DEDUCTION_WORD: Record<string, string> = {
  fuel: 'Fuel',
  tolls: 'Tolls',
  advance: 'Advance',
  manual_charge: 'Charge',
  recurring: 'Recurring',
  debt_recovery: 'Repayment',
  escrow: 'Escrow',
  carry_forward: 'Carried forward',
};

export function StatementWorkspace({ statementId, canEdit, refreshWeek, onChanged }: { statementId: string; canEdit: boolean; refreshWeek: () => Promise<unknown>; onChanged: () => Promise<unknown> }) {
  const { toast } = useToast();
  const st = useQuery({ queryKey: ['accounting', 'statement', statementId], queryFn: () => fetchStatement(statementId) });
  const s = st.data;
  const account = useQuery({ queryKey: ['accounting', 'driver-account', s?.partyId], queryFn: () => fetchDriverAccount(s!.partyId), enabled: Boolean(s && s.partyType === 'driver') });
  const [adding, setAdding] = useState<'deduction' | 'reimbursement' | null>(null);
  // Skip this week, put back, edit or delete a lease charge / recurring deduction (owner, 2026-10-20).
  const [change, setChange] = useState<{ mode: 'skip' | 'undo' | 'edit' | 'stop'; target: ChangeTarget } | null>(null);
  const isAdmin = useIsAdmin();

  /** After any change: update the week's drafts, then read this statement again. */
  const settle = async () => {
    await refreshWeek();
    await st.refetch();
    await account.refetch();
    await onChanged();
  };

  const approve = useMutation({
    mutationFn: () => approveStatement(statementId),
    onSuccess: async (r) => {
      if (!r.ok) { toast({ tone: 'danger', title: 'Not approved', description: r.blocked }); return; }
      await st.refetch();
      await onChanged();
      toast({ tone: 'success', title: 'Approved', description: 'Record the payment to lock it; until then it can be reopened.' });
    },
  });
  const remove = useMutation({
    mutationFn: (txId: string) => setDriverTransactionState(txId, 'void', `Removed from statement ${s?.settlementNumber} before approval`),
    onSuccess: async () => { await settle(); toast({ tone: 'success', title: 'Deduction removed', description: 'Kept on the driver’s account as void, with the reason.' }); },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not removed', description: e instanceof Error ? e.message : undefined }),
  });
  // A load taken off this week (owner, 2026-10-21): listed under "Not on this statement" with a
  // one-click Put back; otherwise the server puts it on the driver's next statement.
  const [takingOff, setTakingOff] = useState<{ loadId: string; loadNumber: string } | null>(null);
  /** Read again without regenerating the week: a regenerate is what these two writes already did. */
  const reread = async () => {
    await st.refetch();
    await onChanged();
  };
  const putBack = useMutation({
    mutationFn: (loadId: string) => putBackStatementLoad(statementId, loadId),
    onSuccess: async (r) => {
      if (!r.ok) { toast({ tone: 'danger', title: 'Not put back', description: r.blocked }); return; }
      await reread();
      toast({ tone: 'success', title: 'Put back on this statement' });
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not put back', description: e instanceof Error ? e.message : undefined }),
  });

  if (st.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (!s || !s.computation) return <p className="text-sm text-muted">This statement has not been calculated.</p>;
  const comp = s.computation;
  const draft = s.status === 'draft' || s.status === 'review';
  const editable = canEdit && draft;
  const txs = account.data?.transactions ?? [];
  // A deduction can be removed here only if it was added by hand and nothing has been taken yet.
  const removable = (txId: string | null) => {
    if (!txId) return false;
    const tx = txs.find((t) => t.id === txId);
    return Boolean(tx && tx.source === 'manual' && tx.state === 'approved' && tx.recoveredCents === 0);
  };
  const loadLines = comp.earnings.filter((e) => e.kind !== 'reimbursement');
  const reimbLines = comp.earnings.filter((e) => e.kind === 'reimbursement');
  const takenOff = comp.deductions.filter((d) => d.cents !== 0);
  const skippedLines = comp.skipped ?? [];
  const targetOf = (kind: 'lease' | 'recurring', ref: string, description: string, cents: number): ChangeTarget => ({ kind, ref, driverId: s.partyId, description: description.replace(/ \(.*\)$/, ''), cents, periodStart: s.periodStart });
  const lineActions = (d: (typeof takenOff)[number]) => {
    if (!editable || !d.ref || (d.kind !== 'lease' && d.kind !== 'recurring')) return null;
    const t = targetOf(d.kind, d.ref, d.description, d.cents);
    return (
      <span className="flex gap-1">
        <Button variant="outline" size="sm" icon={<SkipForward />} onClick={() => setChange({ mode: 'skip', target: t })}>Skip this week</Button>
        <Button variant="outline" size="sm" icon={<Pencil />} aria-label={`Edit ${t.description}`} onClick={() => setChange({ mode: 'edit', target: t })}>Edit</Button>
        {d.kind === 'recurring' && isAdmin ? <Button variant="outline" size="sm" icon={<Trash2 />} aria-label={`Delete ${t.description}`} onClick={() => setChange({ mode: 'stop', target: t })} /> : null}
      </span>
    );
  };

  return (
    <div className="flex flex-col gap-4 text-sm" data-testid="statement-workspace">
      <div className="flex items-start justify-between gap-3 rounded-xl bg-surface-muted p-3">
        <div>
          <p className="text-xs text-muted">To pay out</p>
          <p className="text-2xl font-bold tabular-nums text-ink">{c(s.payableCents)}</p>
          {s.carryCents > 0 ? <p className="text-xs text-danger-text">{c(s.carryCents)} still owed — carried to next week</p> : null}
          <p className="mt-1 text-2xs text-muted" data-testid="pay-window">Pay week {payWindowLabel(s)}</p>
        </div>
        <Badge tone={s.status === 'paid' ? 'success' : s.status === 'approved' ? 'info' : 'neutral'}>{s.status === 'paid' ? 'Paid · locked' : s.status === 'approved' ? 'Approved' : 'Draft · can still change'}</Badge>
      </div>

      {/* ---------------------------------------------------------------- earned */}
      <Section title="Earned" total={c(comp.grossCents)}>
        {loadLines.length === 0 ? <Empty text="No loads this week." /> : loadLines.map((e, i) => (
          <Line
            key={`e${i}`}
            left={<>{e.loadNumber ? <span className="font-medium text-ink">{loadRefLabel(e.brokerReference, e.loadNumber)}</span> : null}<span className="block text-2xs text-muted">{[e.route, e.rateLabel, e.description].filter(Boolean).join(' · ')}</span></>}
            amount={c(e.cents)}
            // One action per load, on its first line.
            action={editable && e.loadId && e.loadNumber && (s.loadIds ?? []).includes(e.loadId) && loadLines.findIndex((x) => x.loadId === e.loadId) === i ? <Button variant="outline" size="sm" icon={<ArrowRightFromLine />} aria-label={`Take ${e.loadNumber} off this statement`} onClick={() => setTakingOff({ loadId: e.loadId!, loadNumber: e.loadNumber! })}>Take off</Button> : undefined}
          />
        ))}
        {takingOff ? <TakeOffLoad s={s} load={takingOff} onCancel={() => setTakingOff(null)} onDone={async () => { setTakingOff(null); await reread(); }} /> : null}
      </Section>

      {/* ---------------------------------------------------------------- real vs for driver */}
      {/* What the broker pays beside what the driver is paid on, per load (owner, 2026-10-23). */}
      {(comp.loadFacts ?? []).length > 0 ? (
        <Section title="Real and For driver" total={`${(comp.loadFacts ?? []).length} load${(comp.loadFacts ?? []).length === 1 ? '' : 's'}`}>
          {(comp.loadFacts ?? []).map((f) => (
            <PayFactsLine key={f.loadId} s={s} facts={f} editable={editable && (s.loadIds ?? []).includes(f.loadId)} onDone={reread} />
          ))}
        </Section>
      ) : null}

      {/* ---------------------------------------------------------------- loads taken off */}
      {(s.removedLoads ?? []).length > 0 ? (
        <Section title="Not on this statement" total={`${(s.removedLoads ?? []).length} load${(s.removedLoads ?? []).length === 1 ? '' : 's'}`}>
          {(s.removedLoads ?? []).map((r) => (
            <Line
              key={r.loadId}
              left={<><span className="font-medium text-ink">{r.loadNumber}</span><span className="block text-2xs text-muted">Taken off by {r.by} · {formatIsoDate(r.at.slice(0, 10))} · {r.reason}. Goes on the next statement unless put back.</span></>}
              amount=""
              action={editable ? <Button variant="outline" size="sm" icon={<Undo2 />} aria-label={`Put back ${r.loadNumber}`} loading={putBack.isPending && putBack.variables === r.loadId} onClick={() => putBack.mutate(r.loadId)}>Put back</Button> : null}
            />
          ))}
        </Section>
      ) : null}

      {/* ---------------------------------------------------------------- reimbursements */}
      <Section title="Reimbursements (added to pay)" total={`+${c(comp.reimbursementsCents)}`} action={editable ? <Button variant="secondary" size="sm" icon={<Plus />} onClick={() => setAdding('reimbursement')}>Add reimbursement</Button> : null}>
        {reimbLines.length === 0 ? <Empty text="None this week. Approved reimbursements appear here by themselves." /> : reimbLines.map((e, i) => (
          <Line key={`r${i}`} left={<><span className="text-ink">{e.description}</span><span className="block text-2xs text-muted">{[e.loadNumber, e.deliveredOn ? formatIsoDate(e.deliveredOn) : null].filter(Boolean).join(' · ')}</span></>} amount={`+${c(e.cents)}`} />
        ))}
        {adding === 'reimbursement' ? <AddReimbursement s={s} onCancel={() => setAdding(null)} onDone={async () => { setAdding(null); await settle(); }} /> : null}
      </Section>

      {/* ---------------------------------------------------------------- taken off */}
      <Section title="Taken off (deductions)" total={`−${c(comp.deductionsCents + comp.escrowCents)}`} action={editable ? <Button variant="secondary" size="sm" icon={<Minus />} onClick={() => setAdding('deduction')}>Add deduction</Button> : null}>
        {takenOff.length === 0 ? <Empty text="Nothing taken off this week." /> : takenOff.map((d, i) => (
          <Line
            key={`d${i}`}
            // "Recovery ·" repeats the Repayment label shown underneath, so the line says only what it was for.
            left={<><span className="text-ink">{d.description.replace(/^Recovery · /, '')}</span><span className="block text-2xs text-muted">{[DEDUCTION_WORD[d.kind] ?? d.kind, d.onDate ? formatIsoDate(d.onDate) : null].filter(Boolean).join(' · ')}</span></>}
            amount={`−${c(d.cents)}`}
            action={editable && removable(d.txId) ? <Button variant="outline" size="sm" icon={<Trash2 />} aria-label={`Remove ${d.description.replace(/^Recovery · /, '')}`} loading={remove.isPending && remove.variables === d.txId} onClick={() => remove.mutate(d.txId!)} /> : lineActions(d)}
          />
        ))}
        {adding === 'deduction' ? <AddDeduction s={s} onCancel={() => setAdding(null)} onDone={async () => { setAdding(null); await settle(); }} /> : null}
      </Section>

      {/* ---------------------------------------------------------------- skipped this week */}
      {skippedLines.length > 0 ? (
        <Section title="Skipped this week" total={`${c(sumSkipped(skippedLines))} not taken`}>
          {skippedLines.map((k) => (
            <Line
              key={`${k.kind}-${k.ref}`}
              left={<><span className="text-ink">{k.description}</span><span className="block text-2xs text-muted">{k.kind === 'lease' ? 'Lease' : 'Recurring'} · skipped: {k.reason}</span></>}
              amount={c(k.cents)}
              action={editable ? <Button variant="outline" size="sm" icon={<Undo2 />} onClick={() => setChange({ mode: 'undo', target: targetOf(k.kind, k.ref, k.description, k.cents) })}>Put back</Button> : null}
            />
          ))}
        </Section>
      ) : null}
      {/* Said on the statement, not hidden (owner, 2026-10-22): e.g. no truck in the week, so no lease charge. */}
      {(comp.notes ?? []).length > 0 ? (
        <Alert tone="info" title="Note" description={<ul className="text-xs" data-testid="statement-notes">{(comp.notes ?? []).map((n) => <li key={n}>{n}</li>)}</ul>} />
      ) : null}
      {change?.mode === 'skip' || change?.mode === 'undo' ? <SkipWeekDialog target={change.target} undo={change.mode === 'undo'} onClose={() => setChange(null)} onDone={settle} /> : null}
      {change?.mode === 'edit' ? <EditAmountDialog target={change.target} onClose={() => setChange(null)} onDone={settle} /> : null}
      {change?.mode === 'stop' ? <StopRecurringDialog target={change.target} onClose={() => setChange(null)} onDone={settle} /> : null}

      {/* ---------------------------------------------------------------- bottom line */}
      <dl className="grid grid-cols-[minmax(0,1fr)_auto] gap-y-1 border-t border-line pt-3">
        <dt className="text-muted">Owed by the driver before → after this week</dt><dd className="text-right tabular-nums">{comp.openingDebtCents === null ? 'not confirmed' : c(comp.openingDebtCents)} → {comp.closingDebtCents === null ? 'not confirmed' : c(comp.closingDebtCents)}</dd>
        <dt className="font-semibold text-ink">To pay out</dt><dd className="text-right text-lg font-bold tabular-nums text-ink">{c(s.payableCents)}</dd>
      </dl>
      {s.exceptions.length ? (
        <Alert
          tone="warning"
          title="Check before approving"
          description={
            <>
              <ul className="text-xs">{s.exceptions.map((e) => <li key={e}>• {e}</li>)}</ul>
              {/* No ELD readings for the truck: the odometer is typed in here and the statement recomputes. */}
              <div className="mt-2"><EnterOdometerButton s={s} canEdit={canEdit} onDone={settle} /></div>
            </>
          }
        />
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        {editable ? <Button variant="primary" icon={<Check />} loading={approve.isPending} onClick={() => approve.mutate()}>Approve this statement</Button> : null}
        <ReopenStatementButton s={s} canEdit={canEdit} onDone={settle} />
        <Link to="/accounting/settlements/$settlementId" params={{ settlementId: s.id }} className="text-xs text-primary-text underline">Open full statement</Link>
        <AuthedFileLink path={`/accounting/settlements/${s.id}/pdf`} fileName={`${s.settlementNumber}.pdf`} className="text-xs text-primary-text underline">PDF</AuthedFileLink>
        <Link to="/drivers/$driverId" params={{ driverId: s.partyId }} search={{ tab: 'financial' }} className="text-xs text-primary-text underline">Driver’s financial account</Link>
      </div>
      {s.status === 'approved' ? <p className="text-2xs text-muted">Approved. Record the payment to lock it; until then it can be reopened.</p> : !draft ? <p className="text-2xs text-muted">Paid · locked. A correction goes on next week’s statement.</p> : editable ? <p className="text-2xs text-muted">Approving freezes the statement; it can be reopened until the payment is recorded.</p> : null}
    </div>
  );
}

function sumSkipped(rows: ReadonlyArray<{ cents: number }>): number {
  return rows.reduce((t, r) => t + r.cents, 0);
}

function Section({ title, total, action, children }: { title: string; total: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section>
      <div className="flex items-center justify-between gap-2 border-b border-line-soft pb-1">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</p>
        <span className="flex items-center gap-2">{action}<span className="font-semibold tabular-nums text-ink">{total}</span></span>
      </div>
      <ul className="flex flex-col">{children}</ul>
    </section>
  );
}

function Line({ left, amount, action }: { left: React.ReactNode; amount: string; action?: React.ReactNode }) {
  return (
    <li className="flex items-start justify-between gap-3 border-b border-line-soft py-1.5 last:border-0">
      <span className="min-w-0">{left}</span>
      <span className="flex shrink-0 items-center gap-2"><span className="tabular-nums">{amount}</span>{action}</span>
    </li>
  );
}

function Empty({ text }: { text: string }) {
  return <li className="py-1.5 text-xs text-muted">{text}</li>;
}

const dollarsOf = (cents: number) => (cents / 100).toFixed(2);
/** A typed amount, or null for blank ("the same as real"). */
const typed = (text: string): number | null => (text.trim() === '' ? null : Number(text));

/**
 * One load's Real and For driver money, and its REF, corrected right here (owner, 2026-10-23).
 *
 * The statement pays on For driver; the invoice to the broker keeps the Real figures and is not
 * touched. Saving writes the load - checked against the copy this statement read, so a load
 * somebody changed meanwhile is a conflict, never overwritten - and the draft recomputes. Only
 * while the statement is a draft: approved or paid statements show the figures read-only.
 */
function PayFactsLine({ s, facts, editable, onDone }: { s: Statement; facts: LoadPayFacts; editable: boolean; onDone: () => Promise<void> }) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [rate, setRate] = useState('');
  const [amounts, setAmounts] = useState<Record<string, string>>({});
  const [ref, setRef] = useState('');
  const start = () => {
    setRate(dollarsOf(facts.linehaulCents));
    setAmounts(Object.fromEntries(facts.accessorials.map((a) => [a.id, dollarsOf(a.amountCents)])));
    setRef(facts.brokerReference ?? '');
    setOpen(true);
  };
  const numbers = [rate, ...Object.values(amounts)].map(typed);
  const valid = numbers.every((n) => n === null || (Number.isFinite(n) && n >= 0)) && ref.trim().length > 0;
  const save = useMutation({
    mutationFn: () =>
      setStatementLoadPayFacts(s.id, facts.loadId, {
        expectedUpdatedAt: facts.loadUpdatedAt ?? '',
        driverRate: typed(rate),
        charges: facts.accessorials.map((a) => ({ chargeId: a.id, driverAmount: typed(amounts[a.id] ?? '') })),
        ...(ref.trim() !== (facts.brokerReference ?? '') ? { brokerReference: ref.trim() } : {}),
      }),
    onSuccess: async () => {
      setOpen(false);
      await onDone();
      toast({ tone: 'success', title: `${facts.loadNumber} updated`, description: 'The statement pays on the For driver figures. The invoice keeps the real ones.' });
    },
    onError: (e: unknown) =>
      toast({
        tone: 'danger',
        title: 'Not saved',
        description: e instanceof ApiError && e.status === 409 ? `${facts.loadNumber} changed since this statement was read. Close and open the statement again.` : e instanceof Error ? e.message : undefined,
      }),
  });
  const pair = (label: string, real: number, driver: number) => (
    <span className="block text-2xs text-muted">
      {label}: Real <span className="tabular-nums">{c(real)}</span> · For driver <span className={cn('tabular-nums', driver !== real ? 'font-semibold text-ink' : undefined)}>{c(driver)}</span>
    </span>
  );
  return (
    <>
      <Line
        left={
          <>
            <span className="font-medium text-ink">{loadRefLabel(facts.brokerReference, facts.loadNumber)}</span>
            {pair('Linehaul', facts.realLinehaulCents, facts.linehaulCents)}
            {facts.accessorials.map((a) => <span key={a.id}>{pair(a.description || a.type, a.realAmountCents, a.amountCents)}</span>)}
          </>
        }
        amount=""
        action={editable && !open ? <Button variant="outline" size="sm" icon={<Pencil />} aria-label={`Edit For driver and REF of ${facts.loadNumber}`} onClick={start}>Edit</Button> : undefined}
      />
      {open ? (
        <li className="mt-2 flex flex-col gap-2 rounded-lg border border-line bg-surface-muted p-3" data-testid="pay-facts-editor">
          {/* REF and For driver on one row, the real price under it; no reason asked (owner, 2026-10-23). */}
          <div className="grid grid-cols-2 items-end gap-2">
            <FormField label="REF number"><Input value={ref} onChange={(e) => setRef(e.target.value)} aria-label="REF number" /></FormField>
            <FormField label="For driver"><Input prefix="$" type="number" min="0" step="0.01" value={rate} onChange={(e) => setRate(e.target.value)} aria-label="Linehaul For driver" /></FormField>
          </div>
          <p className="text-xs text-muted">Real price: <span className="font-semibold tabular-nums text-ink">{c(facts.realLinehaulCents)}</span></p>
          {facts.accessorials.map((a) => (
            <div key={a.id} className="grid grid-cols-2 items-end gap-2">
              <FormField label={`${a.description || a.type} for driver`}>
                <Input prefix="$" type="number" min="0" step="0.01" value={amounts[a.id] ?? ''} onChange={(e) => setAmounts((m) => ({ ...m, [a.id]: e.target.value }))} aria-label={`${a.description || a.type} For driver`} />
              </FormField>
              <p className="pb-2 text-xs text-muted">Real price: <span className="font-semibold tabular-nums text-ink">{c(a.realAmountCents)}</span></p>
            </div>
          ))}
          <div className="flex gap-2">
            <Button variant="primary" size="sm" disabled={!valid || save.isPending} loading={save.isPending} onClick={() => save.mutate()}>Save</Button>
            <Button variant="secondary" size="sm" onClick={() => setOpen(false)}>Cancel</Button>
          </div>
        </li>
      ) : null}
    </>
  );
}

/**
 * Takes one load off this week's statement, with the reason (kept on record). The load is then
 * listed under "Not on this statement" with Put back; if nobody puts it back it goes on the
 * driver's next statement by itself - it is never lost and never paid twice.
 */
function TakeOffLoad({ s, load, onCancel, onDone }: { s: Statement; load: { loadId: string; loadNumber: string }; onCancel: () => void; onDone: () => Promise<void> }) {
  const { toast } = useToast();
  const [why, setWhy] = useState('');
  const save = useMutation({
    mutationFn: () => removeStatementLoad(s.id, load.loadId, why.trim()),
    onSuccess: async (r) => {
      if (!r.ok) { toast({ tone: 'danger', title: 'Not taken off', description: r.blocked }); return; }
      await onDone();
      toast({ tone: 'success', title: `${load.loadNumber} taken off`, description: r.carriedTo ? `It is on ${r.carriedTo} now. Put back returns it here.` : 'It goes on the driver’s next statement. Put back returns it here.' });
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not taken off', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <li className="mt-2 flex flex-col gap-2 rounded-lg border border-line bg-surface-muted p-3" data-testid="take-off-load">
      <FormField label={`Why ${load.loadNumber} comes off this week`} description="Kept on record. The load goes on next week’s statement unless it is put back."><Input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="POD not received yet" aria-label="Reason the load comes off" /></FormField>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={why.trim().length < 3 || save.isPending} loading={save.isPending} onClick={() => save.mutate()}>Take off this statement</Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
    </li>
  );
}

/**
 * A charge on the driver's account, dated in this week, so this statement takes it whole - the
 * net may go below zero and the rest is carried to next week (owner, 2026-10-29). Spreading it
 * over several weeks takes an equal part each week.
 */
function AddDeduction({ s, onCancel, onDone }: { s: Statement; onCancel: () => void; onDone: () => Promise<void> }) {
  const { toast } = useToast();
  const [what, setWhat] = useState('Damage');
  const [detail, setDetail] = useState('');
  const [amount, setAmount] = useState('');
  const [weeks, setWeeks] = useState('1');
  const [why, setWhy] = useState('');
  const cents = Math.round((Number(amount) || 0) * 100);
  const n = Math.max(1, Math.min(52, Math.round(Number(weeks) || 1)));
  const ready = cents > 0 && why.trim().length >= 3 && (what !== 'Other' || detail.trim().length >= 2);
  const save = useMutation({
    mutationFn: () => addManualCharge(s.partyId, { kind: 'manual_charge', amountCents: cents, onDate: s.periodEnd, description: `${what}${detail.trim() ? ` — ${detail.trim()}` : ''}`, reason: why.trim(), approvalRequired: false, installments: n > 1 ? n : undefined }),
    onSuccess: async () => { await onDone(); toast({ tone: 'success', title: 'Deduction added', description: n > 1 ? `${c(Math.ceil(cents / n))} a week for ${n} weeks.` : 'Taken from this week’s pay as far as it allows; any rest stays owed.' }); },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not added', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <li className="mt-2 flex flex-col gap-2 rounded-lg border border-line bg-surface-muted p-3" data-testid="add-deduction">
      <div className="grid grid-cols-2 gap-2">
        <FormField label="What for"><Select value={what} onValueChange={setWhat} options={DEDUCTION_KINDS} aria-label="What for" /></FormField>
        <FormField label="Amount"><Input prefix="$" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" aria-label="Deduction amount" /></FormField>
        <FormField label="Description" className="col-span-2" description="What the driver will read on the statement."><Input value={detail} onChange={(e) => setDetail(e.target.value)} placeholder="Cracked mirror, unit 0008" aria-label="Deduction description" /></FormField>
        <FormField label="Spread over" description="Weeks; 1 takes it all this week."><Input type="number" min="1" max="52" value={weeks} onChange={(e) => setWeeks(e.target.value)} aria-label="Weeks" /></FormField>
        <FormField label="Why (kept on record)"><Input value={why} onChange={(e) => setWhy(e.target.value)} placeholder="Agreed with the driver" aria-label="Deduction reason" /></FormField>
      </div>
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={!ready || save.isPending} loading={save.isPending} onClick={() => save.mutate()}>Add {cents > 0 ? c(cents) : ''} deduction</Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
      <p className="text-2xs text-muted">Taken whole on this week’s statement, even when that takes it below zero; what this week’s pay does not cover is carried to next week and taken there — nothing is lost. Spread over more than 1 week: an equal part each week instead.</p>
    </li>
  );
}

/**
 * Money the driver paid out of pocket, added and approved here in one step (Accounting is the
 * reviewer). It is dated in this week so this statement pays it, and it is the same reimbursement
 * record the Reimbursements page shows.
 */
function AddReimbursement({ s, onCancel, onDone }: { s: Statement; onCancel: () => void; onDone: () => Promise<void> }) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [category, setCategory] = useState<ReimbursementCategory>('lumper');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [fileId, setFileId] = useState<string | null>(null);
  const [fileName, setFileName] = useState<string | null>(null);
  const [missing, setMissing] = useState('');
  const [uploading, setUploading] = useState(false);
  const cents = Math.round((Number(amount) || 0) * 100);
  const ready = cents > 0 && description.trim().length >= 2 && (fileId || missing.trim().length >= 3);
  const save = useMutation({
    mutationFn: async () => {
      const r = await createReimbursement({ payerDriverId: s.partyId, truckId: s.truckId ?? null, loadId: null, onDate: s.periodEnd, category, receiptCents: cents, driverFundedCents: cents, currency: 'USD', description: description.trim(), paymentSource: 'driver_personal', receiptFileId: fileId, missingReceiptReason: fileId ? null : missing.trim(), note: `Added on statement ${s.settlementNumber}` });
      if (!r.ok || !r.expense) throw new Error(r.blocked ?? 'The reimbursement was not recorded.');
      await reviewReimbursement(r.expense.id, { decision: 'approve', reason: `Approved on statement ${s.settlementNumber}` });
    },
    onSuccess: async () => { await onDone(); toast({ tone: 'success', title: 'Reimbursement added', description: `${c(cents)} added to this statement.` }); },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not added', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <li className="mt-2 flex flex-col gap-2 rounded-lg border border-line bg-surface-muted p-3" data-testid="add-reimbursement">
      <div className="grid grid-cols-2 gap-2">
        <FormField label="Category"><Select value={category} onValueChange={(v) => setCategory(v as ReimbursementCategory)} options={REIMBURSEMENT_CATEGORIES.map((k) => ({ value: k, label: REIMBURSEMENT_CATEGORY_LABEL[k] }))} aria-label="Category" /></FormField>
        <FormField label="Amount the driver paid"><Input prefix="$" type="number" min="0" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="0.00" aria-label="Reimbursement amount" /></FormField>
        <FormField label="Description" className="col-span-2"><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="Lumper at the Atlanta DC" aria-label="Reimbursement description" /></FormField>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <input ref={fileRef} type="file" className="hidden" accept="image/*,.pdf" onChange={async (e) => { const f = e.target.files?.[0]; e.target.value = ''; if (!f) return; setUploading(true); try { const up = await uploadFile(f); setFileId(up.id); setFileName(f.name); } catch (err) { toast({ tone: 'danger', title: 'Upload failed', description: err instanceof Error ? err.message : undefined }); } finally { setUploading(false); } }} />
        <Button variant="secondary" size="sm" icon={<Upload />} loading={uploading} onClick={() => fileRef.current?.click()}>Attach receipt</Button>
        <span className="text-xs text-muted">{fileName ?? 'No receipt attached'}</span>
      </div>
      {!fileId ? <FormField label="Why there is no receipt" description="Recorded against your name."><Input value={missing} onChange={(e) => setMissing(e.target.value)} aria-label="Missing receipt reason" /></FormField> : null}
      <div className="flex gap-2">
        <Button variant="primary" size="sm" disabled={!ready || save.isPending} loading={save.isPending} onClick={() => save.mutate()}>Add and approve {cents > 0 ? c(cents) : ''}</Button>
        <Button variant="secondary" size="sm" onClick={onCancel}>Cancel</Button>
      </div>
      <p className={cn('text-2xs text-muted')}>Only money the driver paid personally. A company-card expense is not a reimbursement.</p>
    </li>
  );
}
