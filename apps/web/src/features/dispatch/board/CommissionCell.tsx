import { useState } from 'react';
import type { WeeklyBoardRow } from '@neway/shared';
import { Alert, Badge, Button, Checkbox, FormField, Input, Modal, Select, Textarea, cn, useToast } from '@/design-system';
import { useWriteFlags, useWriteOverride } from './api';
import { cents, pct } from './sheet';

/**
 * The Commission cell (owner's brief §8): the calculated amount and its explanation for anyone
 * who may see it; for admins, a dialog with the manual layer - an approved amount or an
 * adjustment with a reason, the complaint / junior flags for the week, and Reset to calculated.
 * "Manual" is marked on the cell, subtly.
 */
export function CommissionCell({ row, week, canManage }: { row: WeeklyBoardRow; week: string; canManage: boolean }) {
  const [open, setOpen] = useState(false);
  const c = row.commission;
  if (!c) return null;
  const manual = c.override !== null;
  const attention = c.status === 'needs_miles';
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={c.formula}
        className={cn('flex h-full w-full flex-col items-center justify-center px-2 py-1 text-center hover:bg-nw-hover', attention && 'bg-nw-warning-bg')}
      >
        <span className={cn('text-[13px] font-bold', attention ? 'text-nw-warning-text' : 'text-nw-text')}>{attention ? 'Needs miles' : cents(c.payableCents)}</span>
        <span className="text-[10.5px] text-nw-text-3">
          {c.status === 'needs_miles' ? 'enter miles to price' : c.status === 'no_payment' ? c.tier : `${pct(c.pct)} · ${c.tier}`}
          {c.adjustmentHeld ? (
            <span className="ml-1 text-nw-text-2">· adjustment waits for gross</span>
          ) : manual ? (
            <span className="ml-1 font-semibold text-nw-accent-ink">· Manual</span>
          ) : null}
          {c.bonusWithheld ? <span className="ml-1 text-nw-urgent-text">· bonus withheld</span> : null}
          {c.flags.junior ? <span className="ml-1 text-nw-text-2">· junior</span> : null}
        </span>
      </button>
      {open ? <CommissionDialog row={row} week={week} canManage={canManage} onClose={() => setOpen(false)} /> : null}
    </>
  );
}

function CommissionDialog({ row, week, canManage, onClose }: { row: WeeklyBoardRow; week: string; canManage: boolean; onClose: () => void }) {
  const c = row.commission!;
  const { toast } = useToast();
  const writeOverride = useWriteOverride();
  const writeFlags = useWriteFlags();
  const [mode, setMode] = useState<'amount' | 'adjustment'>(c.override?.mode ?? 'amount');
  const [amount, setAmount] = useState(c.override ? (c.override.amountCents / 100).toFixed(2) : '');
  const [reason, setReason] = useState('');
  const [complaint, setComplaint] = useState(c.flags.complaint);
  const [junior, setJunior] = useState(c.flags.junior);
  const [flagReason, setFlagReason] = useState(c.flags.reason);
  const [error, setError] = useState<string | null>(null);
  const describe = (e: unknown) => (e instanceof Error ? e.message : 'Something went wrong');

  const saveOverride = async (reset: boolean) => {
    setError(null);
    if (reason.trim().length < 3) return setError('A reason is needed');
    const n = Number(amount.replace(/[$,]/g, ''));
    if (!reset && !Number.isFinite(n)) return setError('Enter an amount');
    try {
      await writeOverride.mutateAsync({
        rosterId: row.driverId,
        weekStart: week,
        mode: reset ? null : mode,
        amountCents: reset ? undefined : Math.round(n * 100),
        reason: reason.trim(),
        expectedVersion: c.override?.version ?? null,
      });
      toast({ tone: 'success', title: reset ? 'Back to the calculated commission' : 'Manual commission saved' });
      onClose();
    } catch (e) {
      setError(describe(e));
    }
  };
  const saveFlags = async () => {
    setError(null);
    try {
      await writeFlags.mutateAsync({ rosterId: row.driverId, weekStart: week, complaint, junior, reason: flagReason.trim() });
      toast({ tone: 'success', title: 'Week eligibility saved' });
      onClose();
    } catch (e) {
      setError(describe(e));
    }
  };

  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={`Commission · ${row.driverName}${row.coDriver ? ` // ${row.coDriver}` : ''} · week of ${week}`}
      description={`${row.unit === 'team' ? 'Team' : 'Solo'} truck${row.truckUnit ? ` #${row.truckUnit}` : ''} · policy ${c.policyVersion}`}
      footer={
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      }
    >
      <div className="flex flex-col gap-4">
        <section className="rounded-lg border border-nw-border p-3">
          <div className="text-[11px] font-extrabold tracking-[.06em] text-nw-text-3 uppercase">Calculated</div>
          <div className="mt-1 flex flex-wrap items-baseline gap-x-3 gap-y-1">
            <span className="text-[20px] font-extrabold text-nw-text">{cents(c.calculatedCents)}</span>
            <Badge tone={c.status === 'ok' ? 'success' : c.status === 'needs_miles' ? 'warning' : c.status === 'no_payment' ? 'danger' : 'neutral'} size="sm">
              {c.tier}
            </Badge>
            <span className="text-[12.5px] text-nw-text-2">
              base {pct(c.basePct)} + bonus {pct(c.bonusPct)} = {pct(c.pct)}
            </span>
          </div>
          <p className="mt-1 text-[12.5px] text-nw-text-2">{c.formula}</p>
          {c.override ? (
            <p className="mt-2 text-[12.5px] text-nw-accent-ink">
              Manual {c.override.mode === 'amount' ? 'amount' : 'adjustment'} {cents(c.override.amountCents)} · {c.override.reason} · {c.override.byName} · {c.override.at.slice(0, 16).replace('T', ' ')}
            </p>
          ) : null}
          {c.adjustmentHeld ? (
            <p className="mt-1 text-[12.5px] text-nw-text-2">
              The week has no gross yet, so the adjustment is not paid. It applies by itself once the week has gross.
            </p>
          ) : null}
          <p className="mt-1 text-[13px] font-bold text-nw-text">Payable {cents(c.payableCents)}</p>
        </section>

        {canManage ? (
          <>
            <section className="rounded-lg border border-nw-border p-3">
              <div className="text-[11px] font-extrabold tracking-[.06em] text-nw-text-3 uppercase">Manual commission (this truck, this week)</div>
              <div className="mt-2 grid gap-3 sm:grid-cols-2">
                <FormField label="Kind">
                  <Select
                    options={[
                      { value: 'amount', label: 'Replace with an approved amount' },
                      { value: 'adjustment', label: 'Add an adjustment (+ / −)' },
                    ]}
                    value={mode}
                    onValueChange={(v) => setMode(v as 'amount' | 'adjustment')}
                  />
                </FormField>
                <FormField label="Amount $">
                  <Input prefix="$" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={mode === 'amount' ? '250.00' : '-50.00'} />
                </FormField>
                <FormField label="Reason" required className="sm:col-span-2">
                  <Textarea rows={2} value={reason} onChange={(e) => setReason(e.target.value)} />
                </FormField>
              </div>
              <div className="mt-2 flex justify-end gap-2">
                {c.override ? (
                  <Button variant="secondary" size="sm" loading={writeOverride.isPending} onClick={() => void saveOverride(true)}>
                    Reset to calculated
                  </Button>
                ) : null}
                <Button variant="primary" size="sm" loading={writeOverride.isPending} onClick={() => void saveOverride(false)}>
                  Save manual commission
                </Button>
              </div>
            </section>
            <section className="rounded-lg border border-nw-border p-3">
              <div className="text-[11px] font-extrabold tracking-[.06em] text-nw-text-3 uppercase">Week eligibility</div>
              <div className="mt-2 flex flex-col gap-2">
                <Checkbox checked={complaint} onCheckedChange={(v) => setComplaint(v === true)} label="Verified driver complaint this week" description="Withholds the RPM bonus only; the base rate stays" />
                <Checkbox checked={junior} onCheckedChange={(v) => setJunior(v === true)} label="Junior dispatcher rate" description="Flat junior rate above the floor; forfeiture is a separate admin-approved salary adjustment" />
                <Input size="sm" placeholder="Reason (required when either is on)" value={flagReason} onChange={(e) => setFlagReason(e.target.value)} />
              </div>
              <div className="mt-2 flex justify-end">
                <Button variant="secondary" size="sm" loading={writeFlags.isPending} onClick={() => void saveFlags()}>
                  Save eligibility
                </Button>
              </div>
            </section>
          </>
        ) : (
          <p className="text-[12.5px] text-nw-text-3">Only an administrator can set a manual commission or week eligibility.</p>
        )}
        {error ? <Alert tone="danger">{error}</Alert> : null}
      </div>
    </Modal>
  );
}
