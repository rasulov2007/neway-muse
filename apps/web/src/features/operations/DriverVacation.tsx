import { Palmtree } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { RETURN_DRUG_TEST_AFTER_DAYS, type DriverVacationView } from '@neway/shared';
import { Alert, Button, DatePicker, FormField, Modal, StatusBadge, StatusSymbol, Textarea, cn, useToast } from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { today as companyToday } from '@/lib/clock';
import { formatIsoDate } from '@/lib/format';
import { useCancelVacation, useDriverVacations, useRecordVacationReturn, useStartVacation, useUpdateVacation } from './vacation-api';

/**
 * Vacation on the driver page (owner mockup, 2026-10-17): the overflow menu starts one, a banner
 * says how long the driver has been away, and Manage vacation is the one way to edit the dates,
 * record the actual return or cancel a mistake. The expected return is a plan only.
 */

const errorText = (e: unknown) => (e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong. Try again.');

export function VacationBanner({ vacation, onManage, canManage }: { vacation: DriverVacationView; onManage: () => void; canManage: boolean }) {
  return (
    <div className="flex flex-wrap items-center gap-4 rounded-[12px] bg-nw-warning-bg px-4 py-3" data-testid="vacation-banner">
      <Palmtree className="size-6 shrink-0 text-nw-warning-icon" aria-hidden />
      <div className="min-w-0 flex-1">
        <p className="text-base font-bold text-nw-text">On vacation since {formatIsoDate(vacation.startedOn)}</p>
        <p className="text-sm text-nw-text-2">
          {vacation.daysAway} day{vacation.daysAway === 1 ? '' : 's'} away · Expected return {vacation.expectedReturnOn ? formatIsoDate(vacation.expectedReturnOn) : 'Not set'}
        </p>
        {vacation.expectedReturnOn ? <p className="text-xs text-nw-text-3">The expected return is a planned date; the vacation ends when the actual return is recorded.</p> : null}
      </div>
      {canManage ? (
        <Button variant="outline" size="sm" onClick={onManage} data-testid="manage-vacation">
          Manage vacation
        </Button>
      ) : null}
    </div>
  );
}

/** Vacation details, return readiness and history, under the banner (shown once a driver has any). */
export function VacationSection({ driverId, dispatcherName, safetySlot }: { driverId: string; dispatcherName: string | null; safetySlot?: (v: DriverVacationView) => ReactNode }) {
  const list = useDriverVacations(driverId);
  const rows = list.data ?? [];
  if (list.isPending) return null;
  if (rows.length === 0) return null;
  const latest = rows.find((v) => v.state !== 'cancelled') ?? null;
  return (
    <section aria-label="Vacation" className="grid gap-6 rounded-[12px] border border-nw-border bg-nw-panel p-4 lg:grid-cols-2" data-testid="vacation-section">
      {latest ? (
        <div className="flex flex-col gap-3">
          <h2 className="text-lg font-bold text-nw-text">Vacation</h2>
          <dl className="grid grid-cols-[140px_minmax(0,1fr)] gap-y-1.5 text-sm">
            <dt className="text-nw-text-2">Vacation started</dt>
            <dd className="text-nw-text">{formatIsoDate(latest.startedOn)}</dd>
            <dt className="text-nw-text-2">Expected return</dt>
            <dd className="text-nw-text">{latest.expectedReturnOn ? formatIsoDate(latest.expectedReturnOn) : 'Not set'}</dd>
            <dt className="text-nw-text-2">Actual return</dt>
            <dd className="text-nw-text">{latest.endedOn ? formatIsoDate(latest.endedOn) : 'Not returned'}</dd>
            <dt className="text-nw-text-2">Days away</dt>
            <dd className="font-semibold text-nw-text tabular-nums">{latest.daysAway}</dd>
            {latest.note ? (
              <>
                <dt className="text-nw-text-2">Note</dt>
                <dd className="text-nw-text">{latest.note}</dd>
              </>
            ) : null}
            <dt className="text-nw-text-2">Dispatcher</dt>
            <dd className="text-nw-text">{dispatcherName ?? '—'}</dd>
          </dl>
          <div>
            <h3 className="mb-1.5 text-sm font-bold text-nw-text">Return readiness</h3>
            {latest.drugTestRequired ? (
              <div className="flex items-start gap-2 rounded-lg bg-nw-warning-bg px-3 py-2 text-sm">
                <StatusSymbol family="warning" size={16} className="mt-0.5 shrink-0 text-nw-warning-icon" />
                <span>
                  <span className="block font-semibold text-nw-warning-text">Vacation-return drug test required before the next load</span>
                  <span className="block text-xs text-nw-warning-text">Company policy for {RETURN_DRUG_TEST_AFTER_DAYS}+ days away; recording a return does not clear the driver.</span>
                </span>
              </div>
            ) : (
              <p className="flex items-center gap-2 text-sm text-nw-text-2">
                <StatusSymbol family="done" size={14} className="text-nw-done-icon" /> Under {RETURN_DRUG_TEST_AFTER_DAYS} days away: no vacation-return test by company policy.
              </p>
            )}
            {safetySlot ? safetySlot(latest) : null}
          </div>
        </div>
      ) : (
        <div />
      )}
      <div className="min-w-0">
        <h3 className="mb-2 text-sm font-bold text-nw-text">Vacation history</h3>
        <div className="overflow-x-auto rounded-lg border border-nw-border">
          <table className="w-full min-w-[420px] border-collapse text-sm" data-testid="vacation-history">
            <thead className="bg-nw-subtle text-left text-xs text-nw-text-2">
              <tr>
                <th className="px-3 py-2 font-medium">Start</th>
                <th className="px-3 py-2 font-medium">Returned</th>
                <th className="px-3 py-2 text-right font-medium">Days</th>
                <th className="px-3 py-2 font-medium">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-nw-border">
              {rows.map((v) => (
                <tr key={v.id} className={cn(v.state === 'cancelled' && 'text-nw-text-3')}>
                  <td className="px-3 py-2 tabular-nums">{formatIsoDate(v.startedOn)}</td>
                  <td className="px-3 py-2 tabular-nums">{v.endedOn ? formatIsoDate(v.endedOn) : '—'}</td>
                  <td className="px-3 py-2 text-right tabular-nums">{v.state === 'cancelled' ? '—' : v.daysAway}</td>
                  <td className="px-3 py-2" title={v.cancelReason ?? undefined}>
                    {v.state === 'away' ? <StatusBadge status="in_progress" label="Ongoing" size="sm" /> : v.state === 'returned' ? <StatusBadge status="completed" label="Completed" size="sm" /> : <StatusBadge status="cancelled" label="Cancelled" size="sm" />}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

export function SendOnVacationModal({ driverId, driverName, onClose }: { driverId: string; driverName: string; onClose: () => void }) {
  const { toast } = useToast();
  const today = companyToday();
  const [startedOn, setStartedOn] = useState(today);
  const [expected, setExpected] = useState<string | null>(null);
  const [note, setNote] = useState('');
  const start = useStartVacation(driverId);
  const bad = !startedOn ? 'Pick the start date' : startedOn > today ? 'A vacation starts today or earlier' : expected && expected < startedOn ? 'The expected return cannot be before the start' : null;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={`Send ${driverName} on vacation`}
      description="The driver's status becomes Vacation and the days away count from the start. Loads are not changed."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={bad !== null}
            loading={start.isPending}
            onClick={() =>
              start.mutate(
                { startedOn, expectedReturnOn: expected, note: note.trim() || null },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: `${driverName} is on vacation` });
                    onClose();
                  },
                  onError: (e) => toast({ tone: 'danger', title: 'Not saved', description: errorText(e) }),
                },
              )
            }
            data-testid="confirm-vacation"
          >
            Confirm vacation
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        <FormField label="Vacation start" required>
          <DatePicker aria-label="Vacation start" value={startedOn} onIsoChange={(v) => setStartedOn(v ?? '')} />
        </FormField>
        <FormField label="Expected return" description="Optional. A plan only: it never ends the vacation by itself.">
          <DatePicker aria-label="Expected return" value={expected ?? ''} onIsoChange={(v) => setExpected(v || null)} />
        </FormField>
        <FormField label="Reason / note">
          <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Vacation note" placeholder="Personal time, family trip…" />
        </FormField>
        {bad && startedOn ? <p className="text-xs font-semibold text-nw-urgent-text">{bad}</p> : null}
      </div>
    </Modal>
  );
}

type ManageMode = 'edit' | 'return' | 'cancel';

export function ManageVacationModal({ driverId, driverName, vacation, onClose }: { driverId: string; driverName: string; vacation: DriverVacationView; onClose: () => void }) {
  const { toast } = useToast();
  const today = companyToday();
  const [mode, setMode] = useState<ManageMode>('edit');
  const [startedOn, setStartedOn] = useState(vacation.startedOn);
  const [expected, setExpected] = useState<string | null>(vacation.expectedReturnOn);
  const [note, setNote] = useState(vacation.note ?? '');
  const [returnedOn, setReturnedOn] = useState(today);
  const [reason, setReason] = useState('');
  const update = useUpdateVacation(driverId, vacation.id);
  const back = useRecordVacationReturn(driverId, vacation.id);
  const cancel = useCancelVacation(driverId, vacation.id);
  const done = (title: string, description?: string) => {
    toast({ tone: 'success', title, description });
    onClose();
  };
  const fail = (e: unknown) => toast({ tone: 'danger', title: 'Not saved', description: errorText(e) });
  const editBad = startedOn > today ? 'A vacation starts today or earlier' : expected && expected < startedOn ? 'The expected return cannot be before the start' : null;
  const returnBad = !returnedOn ? 'Pick the actual return date' : returnedOn > today ? 'The actual return cannot be in the future' : returnedOn < vacation.startedOn ? 'The actual return cannot be before the start' : null;
  const tabs: { key: ManageMode; label: string }[] = [
    { key: 'edit', label: 'Edit vacation' },
    { key: 'return', label: 'Record actual return' },
    { key: 'cancel', label: 'Cancel vacation' },
  ];
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title={`Manage vacation · ${driverName}`}
      description={`Since ${formatIsoDate(vacation.startedOn)} · ${vacation.daysAway} days away`}
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>Close</Button>
          {mode === 'edit' ? (
            <Button
              variant="primary"
              disabled={editBad !== null}
              loading={update.isPending}
              onClick={() => update.mutate({ version: vacation.version, startedOn, expectedReturnOn: expected, note: note.trim() || null }, { onSuccess: () => done('Vacation updated'), onError: fail })}
            >
              Save changes
            </Button>
          ) : mode === 'return' ? (
            <Button
              variant="primary"
              disabled={returnBad !== null}
              loading={back.isPending}
              onClick={() =>
                back.mutate(
                  { version: vacation.version, returnedOn },
                  { onSuccess: (v) => done(`${driverName} is back from vacation`, v.drugTestRequired ? 'Vacation-return drug test due before the next load (company policy). Safety clears the driver.' : undefined), onError: fail },
                )
              }
              data-testid="record-return"
            >
              Record actual return
            </Button>
          ) : (
            <Button variant="danger" disabled={reason.trim().length < 3} loading={cancel.isPending} onClick={() => cancel.mutate({ version: vacation.version, reason: reason.trim() }, { onSuccess: () => done('Vacation cancelled', 'Kept in the history with your reason.'), onError: fail })}>
              Cancel vacation
            </Button>
          )}
        </>
      }
    >
      <div role="tablist" aria-label="Vacation action" className="mb-4 flex gap-5 border-b border-nw-border">
        {tabs.map((t) => (
          <button key={t.key} type="button" role="tab" aria-selected={mode === t.key} onClick={() => setMode(t.key)} className={cn('-mb-px border-b-2 pb-2 text-sm font-semibold', mode === t.key ? 'border-nw-accent text-nw-accent-ink' : 'border-transparent text-nw-text-2 hover:text-nw-text')}>
            {t.label}
          </button>
        ))}
      </div>
      {mode === 'edit' ? (
        <div className="flex flex-col gap-3">
          <FormField label="Vacation start" required>
            <DatePicker aria-label="Vacation start" value={startedOn} onIsoChange={(v) => v && setStartedOn(v)} />
          </FormField>
          <FormField label="Expected return" description="A plan only; it never ends the vacation.">
            <DatePicker aria-label="Expected return" value={expected ?? ''} onIsoChange={(v) => setExpected(v || null)} />
          </FormField>
          <FormField label="Reason / note">
            <Textarea rows={2} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} aria-label="Vacation note" />
          </FormField>
          {editBad ? <p className="text-xs font-semibold text-nw-urgent-text">{editBad}</p> : null}
        </div>
      ) : mode === 'return' ? (
        <div className="flex flex-col gap-3">
          <FormField label="Actual return" required>
            <DatePicker aria-label="Actual return" value={returnedOn} onIsoChange={(v) => setReturnedOn(v ?? '')} />
          </FormField>
          <Alert tone="info" description="Recording the return stops the day count and makes the driver available. It does not grant Safety clearance." />
          {returnBad ? <p className="text-xs font-semibold text-nw-urgent-text">{returnBad}</p> : null}
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          <Alert tone="warning" description="For a vacation entered by mistake. It stays in the history, marked cancelled with your reason; the driver becomes available." />
          <FormField label="Why it is cancelled" required>
            <Textarea rows={2} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} aria-label="Cancel reason" />
          </FormField>
        </div>
      )}
    </Modal>
  );
}
