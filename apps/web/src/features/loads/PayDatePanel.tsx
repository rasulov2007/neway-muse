import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { CalendarClock, Info, Lock, Undo2 } from 'lucide-react';
import { useState } from 'react';
import { instantFromLocal, localParts } from '@neway/shared';
import { Badge, Button, Card, FormField, Input, useToast } from '@/design-system';
import { fetchLoadPay, setLoadPayDate, type Load, type LoadPay } from '@/demo';
import { useAccount } from '@/features/auth/auth-context';
import { easternInstant } from '@/features/accounting/pay-window';
import { formatIsoDate } from '@/lib/format';

const ET = 'America/New_York';
const DONE = new Set(['delivered', 'closed', 'tonu']);

/**
 * Driver pay for one load (owner, 2026-10-21): when the load counts for pay and which pay week
 * that puts it in - Monday noon to Monday noon, US Eastern.
 *
 * Accounting (accounting.edit) can set "Counts for pay on": a date and time, Eastern, that
 * overrides the delivered time for settlements only, with a reason. The delivery stays as it was
 * recorded. The load then sits on that week's statement and on no other; while it is on an
 * approved or paid statement the server refuses the change and says to reopen it first.
 */
export function PayDatePanel({ load }: { load: Load }) {
  const account = useAccount();
  const canView = account?.permissions.includes('accounting.view') ?? false;
  const canEdit = account?.permissions.includes('accounting.edit') ?? false;
  const done = DONE.has(load.status);
  const pay = useQuery({ queryKey: ['accounting', 'load-pay', load.id], queryFn: () => fetchLoadPay(load.id), enabled: canView && done });
  const [editing, setEditing] = useState(false);

  if (!canView || !done) return null;
  return (
    <Card title="Driver pay" description="Which pay week this load is paid in. For settlements only; the delivery stays as recorded.">
      {pay.isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : pay.isError || !pay.data ? (
        <p className="text-sm text-danger-text">{pay.error instanceof Error ? pay.error.message : 'The pay date could not be read.'}</p>
      ) : (
        <PayDateBody p={pay.data} canEdit={canEdit} editing={editing} setEditing={setEditing} />
      )}
    </Card>
  );
}

function PayDateBody({ p, canEdit, editing, setEditing }: { p: LoadPay; canEdit: boolean; editing: boolean; setEditing: (v: boolean) => void }) {
  const locked = p.statements.find((s) => s.onIt && (s.status === 'approved' || s.status === 'paid')) ?? null;
  return (
    <div className="flex flex-col gap-3 text-sm" data-testid="pay-date-panel">
      <dl className="grid grid-cols-[minmax(0,auto)_minmax(0,1fr)] gap-x-4 gap-y-1">
        <dt className="text-muted">Counts for pay on</dt>
        <dd className="flex flex-wrap items-center gap-2 text-ink">
          <span className="font-semibold tabular-nums">{easternInstant(p.payAt)}</span>
          {p.source === 'override' ? (
            <Badge tone="info" size="sm"><span className="inline-flex items-center gap-1"><Info className="size-3" />Set by Accounting</span></Badge>
          ) : (
            <Badge tone="neutral" size="sm"><span className="inline-flex items-center gap-1"><CalendarClock className="size-3" />{p.basis === 'status_updated_at' ? 'Status change time' : 'Delivered time'}</span></Badge>
          )}
        </dd>
        <dt className="text-muted">Pay week</dt>
        <dd className="text-ink">{p.period?.label ?? '—'}</dd>
        {p.deliveredAt ? (<><dt className="text-muted">Delivered</dt><dd className="text-secondary">{easternInstant(p.deliveredAt)}</dd></>) : null}
      </dl>
      {p.override ? (
        <p className="text-xs text-secondary" data-testid="pay-date-changed-by">
          Changed by <span className="font-semibold text-ink">{p.override.byName}</span> on {formatIsoDate(p.override.changedAt.slice(0, 10))}: {p.override.reason}
        </p>
      ) : null}
      {p.statements.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-xs text-secondary">
          {p.statements.map((s) => (
            <li key={s.id}>
              {s.onIt ? 'On ' : 'Taken off '}
              <Link to="/accounting/settlements/$settlementId" params={{ settlementId: s.id }} className="font-medium text-primary-text underline">{s.settlementNumber}</Link>
              {` · ${s.partyName} · ${s.status}`}
              {s.removed ? ` · ${s.removed.reason}` : ''}
            </li>
          ))}
        </ul>
      ) : null}
      {locked ? (
        <p className="flex items-center gap-1 text-xs text-warning-text"><Lock className="size-3" />On {locked.settlementNumber}, which is {locked.status}. {locked.status === 'paid' ? 'A correction goes on next week’s statement.' : 'Reopen that statement to change the pay date.'}</p>
      ) : null}
      {canEdit && !editing ? (
        <div>
          <Button variant="secondary" size="sm" icon={<CalendarClock />} disabled={Boolean(locked)} onClick={() => setEditing(true)}>Change pay date</Button>
        </div>
      ) : null}
      {canEdit && editing ? <PayDateForm p={p} onClose={() => setEditing(false)} /> : null}
    </div>
  );
}

function PayDateForm({ p, onClose }: { p: LoadPay; onClose: () => void }) {
  const { toast } = useToast();
  const queryClient = useQueryClient();
  const start = localParts(p.payAt, ET);
  const [date, setDate] = useState(start?.date ?? '');
  const [time, setTime] = useState(start?.time ?? '12:00');
  const [reason, setReason] = useState('');
  const at = date && time ? instantFromLocal(date, time, ET) : null;
  const ready = Boolean(at) && reason.trim().length >= 3;
  const save = useMutation({
    mutationFn: (clear: boolean) => setLoadPayDate(p.loadId, { at: clear ? null : at, reason: reason.trim(), expectedUpdatedAt: p.updatedAt }),
    onSuccess: async (next) => {
      queryClient.setQueryData(['accounting', 'load-pay', p.loadId], next);
      await queryClient.invalidateQueries({ queryKey: ['accounting'] });
      await queryClient.invalidateQueries({ queryKey: ['load'] });
      toast({ tone: 'success', title: 'Pay date saved', description: next.period ? `Paid in ${next.period.label}.` : undefined });
      onClose();
    },
    onError: (e: unknown) => toast({ tone: 'danger', title: 'Pay date not saved', description: e instanceof Error ? e.message : undefined }),
  });
  return (
    <div className="flex flex-col gap-2 rounded-lg border border-line bg-surface-muted p-3" data-testid="pay-date-form">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
        <FormField label="Counts for pay on (date, ET)"><Input type="date" value={date} onChange={(e) => setDate(e.target.value)} aria-label="Counts for pay on date" /></FormField>
        <FormField label="Time (ET)" description="Before Monday 12:00 noon is the week that is ending."><Input type="time" value={time} onChange={(e) => setTime(e.target.value)} aria-label="Counts for pay on time" /></FormField>
        <FormField label="Why (required, kept on record)" className="sm:col-span-2"><Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Facility closed Sunday; driver was there on time" aria-label="Pay date reason" /></FormField>
      </div>
      <div className="flex flex-wrap gap-2">
        <Button variant="primary" size="sm" disabled={!ready || save.isPending} loading={save.isPending && save.variables === false} onClick={() => save.mutate(false)}>Save pay date</Button>
        {p.override ? <Button variant="outline" size="sm" icon={<Undo2 />} disabled={reason.trim().length < 3 || save.isPending} loading={save.isPending && save.variables === true} onClick={() => save.mutate(true)}>Use the delivered time</Button> : null}
        <Button variant="secondary" size="sm" onClick={onClose}>Cancel</Button>
      </div>
      <p className="text-2xs text-muted">The load moves to the pay week of this time and off any other week’s draft. The delivery stays as recorded.</p>
    </div>
  );
}
