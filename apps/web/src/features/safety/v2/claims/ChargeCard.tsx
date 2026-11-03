import { useState } from 'react';
import {
  CHARGE_PROGRESS,
  DRIVER_CHARGE_BASIS_LABEL,
  DRIVER_RESPONSE_LABEL,
  NOTIFY_METHOD_LABEL,
  isActiveCharge,
  type DriverCharge,
  type SafetyClaim,
} from '@neway/shared';
import { Button, cn } from '@/design-system';
import { formatDateTime, formatIsoDate } from '@/lib/format';
import { useCan, useSafetyWrite, safetyApi } from '../api';
import { FactList, money } from '../ui';
import {
  ApplyChargeDialog,
  ApproveDialog,
  DisputeDialog,
  NotifyDialog,
  PaymentDialog,
  ReasonActionDialog,
  RejectDialog,
  ResolveDialog,
  WaiveAdjustDialog,
} from './ChargeDialogs';
import { chargePill } from './parts';

type Open = null | 'apply' | 'notify' | 'send' | 'approve' | 'reject' | 'payment' | 'pause' | 'resume' | 'dispute' | 'resolve' | 'change';

/**
 * The driver charge card (Claims v2 §6.3): state, the six steps, what is wrong now, the facts, and
 * the buttons the signed-in role may press in this state. A button that is allowed but blocked
 * stays visible and says why; one the role may never press is not drawn.
 */
export function ChargeCard({ claim, charges }: { claim: SafetyClaim; charges: DriverCharge[] }) {
  const [open, setOpen] = useState<Open>(null);
  const canApply = useCan('claims.apply_charges');
  const isMgmt = useCan('claims.approve_exceptions');
  const isSafety = useCan('safety.manage');
  const isAccounting = useCan('accounting.edit');
  const charge = charges.find((c) => isActiveCharge(c.state)) ?? charges[0] ?? null;
  const decide = useSafetyWrite((approve: boolean) => safetyApi.post(`/driver-charges/${charge?.id}/change-request/${approve ? 'approve' : 'decline'}`, { version: charge?.version }), 'Decision saved');
  const liable = claim.liabilityParty === 'our_driver' || claim.liabilityParty === 'shared';
  const closed = claim.stage === 'closed' || Boolean(claim.voidedAt);

  if (!charge || !isActiveCharge(charge.state) && charge.state !== 'recovered' && charge.state !== 'waived' && charge.state !== 'rejected') {
    return (
      <section className="rounded-[12px] border border-nw-border bg-nw-panel p-4" aria-label="Driver charge" data-testid="charge-card">
        {open === 'apply' ? <ApplyChargeDialog claim={claim} onClose={() => setOpen(null)} /> : null}
        <h3 className="text-[15px] font-bold text-nw-text">Driver charge</h3>
        <p className="mt-1 text-sm text-nw-text-2">
          No charge on this claim. A deductible is applied only when liability is our driver; it then waits, frozen, until the driver is told.
        </p>
        {(canApply || isMgmt) && !closed ? (
          <div className="mt-3">
            <Button variant="primary" disabled={!liable || !claim.driverId} onClick={() => setOpen('apply')} data-testid="apply-charge">
              Apply driver deductible
            </Button>
            {!liable ? <p className="mt-1 text-xs text-nw-text-3">Record liability as our driver first.</p> : !claim.driverId ? <p className="mt-1 text-xs text-nw-text-3">Name the driver on the claim first.</p> : null}
          </div>
        ) : null}
      </section>
    );
  }

  const c = charge;
  const at = CHARGE_PROGRESS.findIndex((p) => p.key === (c.state === 'paused' || c.state === 'disputed' || c.state === 'pending_management' ? (c.stateBeforeHold ?? 'on_hold') : c.state));
  const finished = ['recovered', 'waived', 'rejected', 'cancelled'].includes(c.state);
  const note = stateNote(c);
  const btn = (label: string, key: Open, variant: 'primary' | 'outline' = 'outline', show = true) =>
    show ? (
      <Button key={label} size="sm" variant={variant} onClick={() => setOpen(key)} data-testid={`charge-${key}`}>
        {label}
      </Button>
    ) : null;

  return (
    <section className="overflow-hidden rounded-[12px] border border-nw-border bg-nw-panel" aria-label="Driver charge" data-testid="charge-card">
      {open === 'notify' ? <NotifyDialog charge={c} claimNumber={claim.number} onClose={() => setOpen(null)} /> : null}
      {open === 'send' ? <ReasonActionDialog charge={c} action="send-to-accounting" title="Send to Accounting" button="Send to Accounting" onClose={() => setOpen(null)} /> : null}
      {open === 'approve' ? <ApproveDialog charge={c} onClose={() => setOpen(null)} /> : null}
      {open === 'reject' ? <RejectDialog charge={c} onClose={() => setOpen(null)} /> : null}
      {open === 'payment' ? <PaymentDialog charge={c} onClose={() => setOpen(null)} /> : null}
      {open === 'pause' ? <ReasonActionDialog charge={c} action="pause" title="Put on hold" button="Put on hold" onClose={() => setOpen(null)} /> : null}
      {open === 'resume' ? <ReasonActionDialog charge={c} action="resume" title="Resume" button="Resume" onClose={() => setOpen(null)} /> : null}
      {open === 'dispute' ? <DisputeDialog charge={c} onClose={() => setOpen(null)} /> : null}
      {open === 'resolve' ? <ResolveDialog charge={c} onClose={() => setOpen(null)} /> : null}
      {open === 'change' ? <WaiveAdjustDialog charge={c} isMgmt={isMgmt} onClose={() => setOpen(null)} /> : null}
      {open === 'apply' ? <ApplyChargeDialog claim={claim} onClose={() => setOpen(null)} /> : null}

      <header className="flex flex-wrap items-center justify-between gap-2 border-b border-nw-border px-4 py-3">
        <h3 className="flex items-center gap-2 text-[15px] font-bold text-nw-text">
          Driver charge · {money(c.amountCents)} {chargePill(c.state)}
        </h3>
        <span className="text-xs text-nw-text-3">
          {DRIVER_CHARGE_BASIS_LABEL[c.basis]} · {c.driverKind === 'company' ? 'company driver' : 'owner-operator'}
        </span>
      </header>
      <div className="flex flex-col gap-3 p-4">
        <ol className="flex flex-wrap gap-1.5" aria-label="Charge progress">
          {CHARGE_PROGRESS.map((p, i) => (
            <li
              key={p.key}
              className={cn(
                'rounded-md px-2 py-0.5 text-[12px] font-semibold',
                finished && c.state === 'recovered' ? 'bg-nw-done-bg text-nw-done-text' : i === at ? 'bg-nw-accent text-nw-on-accent' : i < at ? 'bg-nw-accent-tint text-nw-accent-ink' : 'bg-nw-subtle text-nw-text-3',
              )}
            >
              {p.label}
            </li>
          ))}
        </ol>
        {note ? <div className={cn('rounded-[10px] border px-3 py-2 text-[13px]', note.tone === 'urgent' ? 'border-nw-urgent-border bg-nw-urgent-bg text-nw-urgent-text' : 'border-nw-warning-border bg-nw-warning-bg text-nw-warning-text')}>{note.text}</div> : null}
        <FactList
          rows={[
            ['Driver', `${c.driverName} · ${c.driverKind === 'company' ? 'Company driver' : 'Owner-operator'}`],
            ['Applied', `${formatDateTime(c.createdAt)} by ${c.createdBy}`],
            ['Notification', c.notifiedOn ? `${formatIsoDate(c.notifiedOn)} · ${c.notifyMethod ? NOTIFY_METHOD_LABEL[c.notifyMethod] : ''} · ${c.driverResponse ? DRIVER_RESPONSE_LABEL[c.driverResponse] : ''}` : <span className="font-semibold text-nw-urgent-text">Not informed</span>],
            ['Recovery plan', c.installmentCents ? `${c.installmentsTotal} × ${money(c.installmentCents)} · ${c.recoveryMethod === 'settlement_deduction' ? 'weekly settlements' : c.recoveryMethod === 'escrow' ? 'escrow' : 'direct payment'}` : '—'],
            ['Recovered', `${money(c.recoveredCents)} of ${money(c.amountCents)}`],
            ...(c.adjustReason ? ([['Reason', c.adjustReason]] as [string, string][]) : []),
          ]}
        />
        {c.recoveryLog.length > 0 ? (
          <ul className="rounded-[10px] border border-nw-border px-3 py-2 text-[12.5px]">
            {c.recoveryLog.map((l, i) => (
              <li key={i} className={cn('flex justify-between gap-2 py-0.5', l.reversed && 'text-nw-text-3 line-through')}>
                <span>{l.label}</span>
                <span className="tabular">{money(l.cents)}</span>
              </li>
            ))}
          </ul>
        ) : null}
        {!closed ? (
          <div className="flex flex-wrap gap-2">
            {btn('Mark driver informed', 'notify', 'primary', c.state === 'on_hold' && (isSafety || isMgmt))}
            {btn('Send to Accounting', 'send', 'primary', c.state === 'informed' && (isSafety || isMgmt))}
            {btn('Approve', 'approve', 'primary', c.state === 'pending_accounting' && (isAccounting || isMgmt))}
            {btn('Reject', 'reject', 'outline', c.state === 'pending_accounting' && (isAccounting || isMgmt))}
            {btn('Record payment', 'payment', 'outline', (c.state === 'approved' || c.state === 'recovering') && (isAccounting || isMgmt))}
            {btn('Put on hold', 'pause', 'outline', ['informed', 'pending_accounting', 'approved', 'recovering'].includes(c.state) && (isSafety || isAccounting || isMgmt))}
            {btn('Resume', 'resume', 'primary', c.state === 'paused' && (isSafety || isAccounting || isMgmt))}
            {btn('Record dispute', 'dispute', 'outline', ['on_hold', 'informed', 'pending_accounting', 'approved', 'recovering', 'paused'].includes(c.state) && (isSafety || isAccounting || isMgmt))}
            {btn('Resolve dispute', 'resolve', 'primary', c.state === 'disputed' && isMgmt)}
            {btn('Waive / adjust', 'change', 'outline', isActiveCharge(c.state) && c.state !== 'pending_management' && (isSafety || isAccounting || isMgmt))}
            {c.state === 'pending_management' && isMgmt ? (
              <>
                <Button size="sm" variant="primary" loading={decide.isPending} onClick={() => decide.mutate(true)} data-testid="charge-change-approve">
                  Approve {c.pendingChange?.kind === 'waive' ? 'waiver' : 'amount'}
                </Button>
                <Button size="sm" variant="outline" loading={decide.isPending} onClick={() => decide.mutate(false)}>
                  Decline
                </Button>
              </>
            ) : null}
            {finished && (canApply || isMgmt) && liable ? btn('Apply a new charge', 'apply') : null}
          </div>
        ) : null}
        <p className="text-[11.5px] text-nw-text-3">Every action is stamped with time, employee and role in the timeline. Duplicate guard: one active charge per claim, driver and basis.</p>
      </div>
    </section>
  );
}

function stateNote(c: DriverCharge): { tone: 'urgent' | 'warning'; text: string } | null {
  switch (c.state) {
    case 'on_hold':
      return { tone: 'urgent', text: `Driver has not been informed. Charge is frozen and cannot reach Accounting. On hold ${c.ageDays} day${c.ageDays === 1 ? '' : 's'} · escalates to the Safety Manager at 3 business days and Management at 7.` };
    case 'disputed':
      return { tone: 'urgent', text: `Disputed${c.disputeRaisedBy ? ` by ${c.disputeRaisedBy}` : ''}: “${c.disputeText ?? ''}”. Unposted deductions are frozen until Management decides.` };
    case 'pending_management':
      return { tone: 'warning', text: `Waiting on Management: ${c.pendingChange?.kind === 'waive' ? 'waiver' : `amount ${money(c.pendingChange?.amountCents ?? c.amountCents)}`} asked by ${c.pendingChange?.requestedBy ?? '—'} — ${c.pendingChange?.reason ?? ''}` };
    case 'pending_accounting':
      return { tone: 'warning', text: `With Accounting for ${c.ageDays} day${c.ageDays === 1 ? '' : 's'}: they check the authorization, the lease and the amount, then approve or reject here.` };
    case 'paused':
      return { tone: 'warning', text: 'Paused: settlements skip this charge until it is resumed.' };
    case 'rejected':
      return { tone: 'warning', text: `Rejected by Accounting: ${c.rejectReason ?? ''}` };
    default:
      return null;
  }
}
