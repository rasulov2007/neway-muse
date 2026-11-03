import { useMutation } from '@tanstack/react-query';
import { useState } from 'react';
import { Button, FormField, Input, Modal, Radio, RadioGroup, useToast } from '@/design-system';
import { setLeaseWeek, setRecurringAmount, setRecurringWeek, stopRecurringDeduction } from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { formatMoney } from '@/lib/format';

/**
 * Changing a lease charge or a recurring deduction (owner, 2026-10-20): skip it this week, take
 * another amount this week, change a recurring amount from now on, or - administrators only -
 * stop a recurring deduction. Each change is one record on the server; the statement, the
 * driver's Financial account and the PDF all read it, so it shows the same everywhere.
 */

export function useIsAdmin(): boolean {
  return useAccount()?.roles.includes('administrator') ?? false;
}

export interface ChangeTarget {
  kind: 'lease' | 'recurring';
  /** Lease charge code or recurring deduction id. */
  ref: string;
  driverId: string;
  description: string;
  /** The amount on the statement now (or the recurring amount). */
  cents: number;
  /** The settlement week, for a one-week change. Null on the Financial account (from now on only). */
  periodStart: string | null;
}

const c = (cents: number) => formatMoney(cents / 100);

/** One week only: skip (0), another amount, or put back (null). */
async function applyWeek(t: ChangeTarget, cents: number | null, reason: string) {
  if (!t.periodStart) throw new Error('No week to change.');
  if (t.kind === 'lease') return setLeaseWeek(t.driverId, { periodStart: t.periodStart, code: t.ref, cents, reason });
  return setRecurringWeek(t.driverId, t.ref, { periodStart: t.periodStart, cents, reason });
}

/** "Skip this week" and "Put back": one reason, one press. */
export function SkipWeekDialog({ target, undo, onClose, onDone }: { target: ChangeTarget; undo?: boolean; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { toast } = useToast();
  const [reason, setReason] = useState(undo ? 'Put back' : '');
  const save = useMutation({
    mutationFn: () => applyWeek(target, undo ? null : 0, reason.trim()),
    onSuccess: async () => {
      await onDone();
      toast({ tone: 'success', title: undo ? `${target.description} put back` : `${target.description} skipped this week`, description: undo ? undefined : `${c(target.cents)} is not taken this week. Next week it is taken as usual.` });
      onClose();
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not changed', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="sm"
      title={undo ? `Put back ${target.description}?` : `Skip ${target.description} this week?`}
      description={undo ? `It is taken again this week: ${c(target.cents)}.` : `${c(target.cents)} is not taken from this week's pay. Only this week; the plan stays as it is.`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate()}>{undo ? 'Put back' : 'Skip this week'}</Button>
        </>
      }
    >
      <FormField label="Why (kept on record)" required>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Truck in the shop all week" aria-label="Reason" />
      </FormField>
    </Modal>
  );
}

/** Edit: this week only, or (recurring) from now on. */
export function EditAmountDialog({ target, onClose, onDone }: { target: ChangeTarget; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { toast } = useToast();
  const canWeek = target.periodStart !== null;
  const canForward = target.kind === 'recurring';
  const [scope, setScope] = useState<'week' | 'forward'>(canWeek ? 'week' : 'forward');
  const [amount, setAmount] = useState((target.cents / 100).toFixed(2));
  const [reason, setReason] = useState('');
  const cents = Math.round((Number(amount.replace(/[$,\s]/g, '')) || 0) * 100);
  const ready = reason.trim().length >= 3 && cents >= 0 && (scope === 'week' || cents > 0) && cents !== target.cents;
  const save = useMutation({
    mutationFn: () => (scope === 'week' ? applyWeek(target, cents, reason.trim()) : setRecurringAmount(target.driverId, target.ref, { amountCents: cents, reason: reason.trim() })),
    onSuccess: async () => {
      await onDone();
      toast({ tone: 'success', title: `${target.description}: ${c(cents)}`, description: scope === 'week' ? 'This week only.' : 'From now on. Statements already approved are not changed.' });
      onClose();
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not changed', description: e instanceof Error ? e.message : undefined }),
  });
  /** Drops this week's change: the plan's amount is taken again. */
  const reset = useMutation({
    mutationFn: () => applyWeek(target, null, reason.trim().length >= 3 ? reason.trim() : 'Back to the plan amount'),
    onSuccess: async () => {
      await onDone();
      toast({ tone: 'success', title: `${target.description}: back to the plan`, description: 'This week takes the plan amount again.' });
      onClose();
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not changed', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="sm"
      title={`Edit ${target.description}`}
      description={`Now ${c(target.cents)}.`}
      footer={
        <>
          {canWeek && scope === 'week' ? (
            <Button variant="link" className="mr-auto" disabled={reset.isPending} onClick={() => reset.mutate()}>
              Back to plan
            </Button>
          ) : null}
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={!ready} loading={save.isPending} onClick={() => save.mutate()}>Save {c(cents)}</Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {canWeek && canForward ? (
          <RadioGroup value={scope} onValueChange={(v) => setScope(v as 'week' | 'forward')} aria-label="Which weeks">
            <Radio value="week" label="This week only" />
            <Radio value="forward" label="From now on (every later week)" />
          </RadioGroup>
        ) : null}
        <FormField label="Amount" required>
          <Input prefix="$" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" aria-label="Amount" />
        </FormField>
        <FormField label="Why (kept on record)" required>
          <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Agreed with the driver" aria-label="Reason" />
        </FormField>
      </div>
    </Modal>
  );
}

/** Delete = stop for good, kept on record as cancelled (administrators only). */
export function StopRecurringDialog({ target, onClose, onDone }: { target: ChangeTarget; onClose: () => void; onDone: () => Promise<unknown> }) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const save = useMutation({
    mutationFn: () => stopRecurringDeduction(target.driverId, target.ref, reason.trim()),
    onSuccess: async () => {
      await onDone();
      toast({ tone: 'success', title: `${target.description} deleted`, description: 'Not taken from any later statement. Kept on record as cancelled, with the reason.' });
      onClose();
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Not deleted', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="sm"
      title={`Delete ${target.description}?`}
      description="It stops from this week on: no later statement takes it. Statements already approved keep what they took."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>Cancel</Button>
          <Button variant="danger" disabled={reason.trim().length < 3} loading={save.isPending} onClick={() => save.mutate()}>Delete</Button>
        </>
      }
    >
      <FormField label="Why (kept on record)" required>
        <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Agreement ended" aria-label="Reason" />
      </FormField>
    </Modal>
  );
}
