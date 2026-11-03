import { Bed, Bus, Plane, Plus } from 'lucide-react';
import { useState } from 'react';
import {
  COST_TREATMENT_LABELS,
  COST_TYPES,
  COST_TYPE_LABELS,
  ONBOARDING_TASK_STATUSES,
  TRAVEL_KIND_LABELS,
  costTreatment,
  type CandidateCostView,
  type CandidateJourney,
  type CostParty,
  type CostType,
  type OnboardingTaskStatus,
  type OnboardingTaskView,
  type RecruitCandidate,
  type TravelItemView,
  type TravelKind,
} from '@neway/shared';
import { Alert, Button, DatePicker, FormField, Input, Modal, Select, Textarea, cn, useToast, type StatusSymbolFamily } from '@/design-system';
import { today as companyToday } from '@/lib/clock';
import { formatMoney } from '@/lib/format';
import { longDate, longDateTime } from '../recruit-format';
import { journeyApi } from '../useJourney';
import { Pill, StepCard } from './JourneyKit';
import { errorText, useJourneyMutation } from './journey-utils';

const TASK_LOOK: Record<OnboardingTaskStatus, { family: StatusSymbolFamily; word: string }> = {
  pending: { family: 'neutral', word: 'Pending' },
  in_progress: { family: 'moving', word: 'In progress' },
  done: { family: 'done', word: 'Done' },
  failed: { family: 'urgent', word: 'Failed' },
  waived: { family: 'neutral', word: 'Waived' },
};
const TRAVEL_ICON: Record<TravelKind, React.ReactNode> = { flight: <Plane aria-hidden className="size-4" />, hotel: <Bed aria-hidden className="size-4" />, ground: <Bus aria-hidden className="size-4" /> };
const PARTY: Record<CostParty, string> = { company: 'Company', driver: 'Driver' };

/**
 * Step 7 — Onboarding and costs. Checklist (each task's status, owner, date, result and evidence)
 * and Travel & costs (bookings, and every cost with who paid, whose cost it is, its approval,
 * payment and where it sits in Accounting). Booking, approval and payment are three different
 * things here, because they are three different things in the money.
 */
export function OnboardingStep({ candidate: c, journey: j }: { candidate: RecruitCandidate; journey: CandidateJourney }) {
  const [tab, setTab] = useState<'checklist' | 'travel'>('checklist');
  const s = j.costs.summary;
  return (
    <StepCard step={7} title="Onboarding & costs" subtitle="Checklist, travel and what it costs" testId="step-onboarding" footnote="Tasks, travel and costs are tracked here; costs reach Accounting by its own rules, once, and stay with the person whatever happens.">
      <nav className="flex gap-1 rounded-lg border border-nw-border bg-nw-subtle p-1" role="tablist">
        {(['checklist', 'travel'] as const).map((t) => (
          <button
            key={t}
            type="button"
            role="tab"
            aria-selected={tab === t}
            onClick={() => setTab(t)}
            className={cn('h-9 flex-1 rounded-md text-sm font-semibold', tab === t ? 'bg-nw-panel text-nw-text shadow-segment' : 'text-nw-text-3 hover:text-nw-text-2')}
            data-testid={`onboarding-tab-${t}`}
          >
            {t === 'checklist' ? 'Checklist' : 'Travel & costs'}
          </button>
        ))}
      </nav>
      {!j.hire.ready && j.hire.items.some((i) => !i.ok) ? (
        <div className="rounded-[10px] border border-nw-warning-border bg-nw-warning-bg px-4 py-3 text-sm text-nw-warning-text" data-testid="hire-blockers">
          <p className="font-semibold">Before Ready to hire</p>
          <ul className="mt-1 list-disc pl-5">
            {j.hire.items
              .filter((i) => !i.ok)
              .map((i) => (
                <li key={i.code}>
                  {i.label}: {i.detail}
                </li>
              ))}
          </ul>
        </div>
      ) : null}
      {tab === 'checklist' ? (
        <Checklist candidate={c} journey={j} />
      ) : (
        <>
          <Travel candidate={c} journey={j} />
          {/* What we spent on this candidate (owner, 2026-10-12), not what was planned. */}
          <div className="grid grid-cols-3 gap-2 rounded-xl border border-nw-border p-3 text-sm" data-testid="cost-summary">
            <span>
              <span className="block text-xs text-nw-text-3">Spent</span>
              <span className="text-lg font-bold text-nw-text">{formatMoney(s.spent)}</span>
            </span>
            <span>
              <span className="block text-xs text-nw-text-3">Company's cost</span>
              <span className="font-semibold text-nw-text">{formatMoney(s.companyCost)}</span>
            </span>
            <span>
              <span className="block text-xs text-nw-text-3">Driver owes</span>
              <span className="font-semibold text-nw-text">{formatMoney(s.driverCost)}</span>
            </span>
            {s.planned > 0 ? <span className="col-span-3 text-xs text-nw-text-3">{formatMoney(s.planned)} more recorded as planned, not yet confirmed as spent.</span> : null}
          </div>
          <Costs candidate={c} journey={j} />
        </>
      )}
    </StepCard>
  );
}

function Checklist({ candidate: c, journey: j }: { candidate: RecruitCandidate; journey: CandidateJourney }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <ul className="rounded-xl border border-nw-border" data-testid="onboarding-tasks">
        {j.onboarding.tasks.map((t) => (
          <TaskRow key={t.id} candidate={c} task={t} canEdit={j.permissions.canManage} />
        ))}
      </ul>
      {j.permissions.canManage ? (
        <Button variant="outline" size="sm" icon={<Plus />} className="w-fit" onClick={() => setAdding(true)}>
          Add task
        </Button>
      ) : null}
      {adding ? <AddTaskDialog candidate={c} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function TaskRow({ candidate: c, task: t, canEdit }: { candidate: RecruitCandidate; task: OnboardingTaskView; canEdit: boolean }) {
  const { toast } = useToast();
  const [editing, setEditing] = useState(false);
  const look = TASK_LOOK[t.status];
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-nw-border px-3 py-2.5 last:border-0" data-testid={`task-${t.code}`}>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-nw-text">
          {t.label}
          {t.required ? '' : ' (optional)'}
        </span>
        <span className="block text-xs text-nw-text-3">
          {[t.result ? `Result: ${t.result}` : null, t.ownerName ? `Owner: ${t.ownerName}` : null, t.dueOn ? `Due ${longDate(t.dueOn)}` : null, t.completedAt ? `${look.word} ${longDate(t.completedAt)} by ${t.completedByName ?? ''}` : null, t.note]
            .filter(Boolean)
            .join(' · ') || 'Not started'}
        </span>
      </span>
      <Pill family={look.family}>{look.word}</Pill>
      {canEdit ? (
        <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
          Update
        </Button>
      ) : null}
      {editing ? (
        <TaskDialog
          candidate={c}
          task={t}
          onClose={() => setEditing(false)}
          onSaved={() => {
            toast({ tone: 'success', title: `${t.label} updated` });
            setEditing(false);
          }}
        />
      ) : null}
    </li>
  );
}

function TaskDialog({ candidate: c, task: t, onClose, onSaved }: { candidate: RecruitCandidate; task: OnboardingTaskView; onClose: () => void; onSaved: () => void }) {
  const [status, setStatus] = useState<OnboardingTaskStatus>(t.status);
  const [result, setResult] = useState(t.result ?? '');
  const [dueOn, setDueOn] = useState(t.dueOn ?? '');
  const [note, setNote] = useState(t.note ?? '');
  const save = useJourneyMutation(() =>
    journeyApi.updateTask(c.key, t.id, { status, result: result.trim() || null, dueOn: dueOn || null, note: note.trim() || null, ownerEmployeeId: t.ownerEmployeeId, evidenceFileId: t.evidenceFileId, version: t.version }),
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={t.label}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={save.isPending} onClick={() => save.mutate(undefined, { onSuccess: onSaved })} data-testid="save-task">
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {save.error ? <Alert tone="danger" title="Not saved" description={errorText(save.error)} /> : null}
        <FormField label="Status">
          <Select aria-label="Status" value={status} onValueChange={(v) => setStatus(v as OnboardingTaskStatus)} options={ONBOARDING_TASK_STATUSES.map((s) => ({ value: s, label: TASK_LOOK[s].word }))} />
        </FormField>
        <FormField label={t.code === 'drug_test' ? 'Result (required when done)' : 'Result'}>
          <Input value={result} onChange={(e) => setResult(e.target.value)} placeholder={t.code === 'drug_test' ? 'Negative' : ''} maxLength={200} />
        </FormField>
        <FormField label="Due">
          <DatePicker aria-label="Due" value={dueOn} onIsoChange={setDueOn} />
        </FormField>
        <FormField label={status === 'waived' ? 'Why it is waived (required)' : 'Note'}>
          <Textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={2000} />
        </FormField>
      </div>
    </Modal>
  );
}

function AddTaskDialog({ candidate: c, onClose }: { candidate: RecruitCandidate; onClose: () => void }) {
  const [label, setLabel] = useState('');
  const [required, setRequired] = useState(true);
  const add = useJourneyMutation(() => journeyApi.addTask(c.key, { label: label.trim(), required, dueOn: null }));
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title="Add an onboarding task"
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={label.trim().length < 2} loading={add.isPending} onClick={() => add.mutate(undefined, { onSuccess: onClose })}>
            Add task
          </Button>
        </>
      }
    >
      {add.error ? <Alert tone="danger" title="Not added" description={errorText(add.error)} /> : null}
      <FormField label="Task">
        <Input value={label} onChange={(e) => setLabel(e.target.value)} maxLength={120} />
      </FormField>
      <FormField label="Required for the hire">
        <Select aria-label="Required" value={required ? 'yes' : 'no'} onValueChange={(v) => setRequired(v === 'yes')} options={[{ value: 'yes', label: 'Required' }, { value: 'no', label: 'Optional' }]} />
      </FormField>
    </Modal>
  );
}

// ---------------------------------------------------------------------------------- travel

function Travel({ candidate: c, journey: j }: { candidate: RecruitCandidate; journey: CandidateJourney }) {
  const [adding, setAdding] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold tracking-wide text-nw-text-3 uppercase">Travel arrangements</h3>
        {j.permissions.canManage ? (
          <Button variant="outline" size="sm" icon={<Plus />} onClick={() => setAdding(true)} data-testid="add-travel">
            Add booking
          </Button>
        ) : null}
      </div>
      {j.travel.length === 0 ? (
        <p className="rounded-xl border border-dashed border-nw-border px-3 py-4 text-center text-sm text-nw-text-3">No travel booked.</p>
      ) : (
        <ul className="rounded-xl border border-nw-border" data-testid="travel-list">
          {j.travel.map((t) => (
            <TravelRow key={t.id} candidate={c} item={t} canEdit={j.permissions.canManage} />
          ))}
        </ul>
      )}
      {adding ? <TravelDialog candidate={c} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function TravelRow({ candidate: c, item: t, canEdit }: { candidate: RecruitCandidate; item: TravelItemView; canEdit: boolean }) {
  const { toast } = useToast();
  const [cancelling, setCancelling] = useState(false);
  const [reason, setReason] = useState('');
  const cancel = useJourneyMutation(() => journeyApi.cancelTravel(c.key, t.id, reason.trim(), t.version));
  const when =
    t.kind === 'hotel'
      ? [t.checkInOn ? `in ${longDate(t.checkInOn)}` : null, t.checkOutOn ? `out ${longDate(t.checkOutOn)}` : null].filter(Boolean).join(' · ')
      : [t.departAt ? `departs ${longDateTime(t.departAt)}` : null, t.arriveAt ? `arrives ${longDateTime(t.arriveAt)}` : null].filter(Boolean).join(' · ');
  return (
    <li className="flex flex-wrap items-center gap-3 border-b border-nw-border px-3 py-2.5 last:border-0">
      <span className="text-nw-text-2">{TRAVEL_ICON[t.kind]}</span>
      <span className="min-w-0 flex-1">
        <span className="block text-sm font-semibold text-nw-text">
          {TRAVEL_KIND_LABELS[t.kind]}
          {t.vendor ? ` · ${t.vendor}` : ''}
          {t.routeFrom || t.routeTo ? ` · ${t.routeFrom ?? '?'} → ${t.routeTo ?? '?'}` : ''}
        </span>
        <span className="block text-xs text-nw-text-3">{[t.bookingReference ? `Ref ${t.bookingReference}` : null, when, t.cancelReason ? `Cancelled: ${t.cancelReason}` : null].filter(Boolean).join(' · ')}</span>
      </span>
      {t.cost !== null ? <span className="text-sm font-semibold tabular-nums text-nw-text" data-testid="travel-cost">{formatMoney(t.cost)}</span> : null}
      <Pill family={t.status === 'cancelled' ? 'urgent' : t.status === 'rescheduled' ? 'warning' : 'done'}>{t.status === 'cancelled' ? 'Cancelled' : t.status === 'rescheduled' ? 'Rescheduled' : 'Booked'}</Pill>
      {canEdit && t.status !== 'cancelled' ? (
        cancelling ? (
          <span className="flex items-center gap-2">
            <Input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Why" className="h-8 w-40" />
            <Button
              variant="danger"
              size="sm"
              disabled={reason.trim().length < 3}
              loading={cancel.isPending}
              onClick={() => cancel.mutate(undefined, { onSuccess: () => toast({ tone: 'success', title: 'Booking cancelled; its costs are kept' }), onError: (e) => toast({ tone: 'danger', title: 'Not cancelled', description: errorText(e) }) })}
            >
              Cancel booking
            </Button>
          </span>
        ) : (
          <Button variant="ghost" size="sm" onClick={() => setCancelling(true)}>
            Cancel…
          </Button>
        )
      ) : null}
    </li>
  );
}

function TravelDialog({ candidate: c, onClose }: { candidate: RecruitCandidate; onClose: () => void }) {
  const [kind, setKind] = useState<TravelKind>('flight');
  const [f, setF] = useState({ vendor: '', routeFrom: '', routeTo: '', bookingReference: '', depart: '', arrive: '', checkIn: '', checkOut: '', notes: '', price: '', paidBy: 'company' });
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const toIso = (local: string) => (local ? new Date(local).toISOString() : null);
  const add = useJourneyMutation(() =>
    journeyApi.addTravel(c.key, {
      kind,
      vendor: f.vendor || null,
      routeFrom: f.routeFrom || null,
      routeTo: f.routeTo || null,
      bookingReference: f.bookingReference || null,
      departAt: kind === 'hotel' ? null : toIso(f.depart),
      arriveAt: kind === 'hotel' ? null : toIso(f.arrive),
      checkInOn: kind === 'hotel' ? f.checkIn || null : null,
      checkOutOn: kind === 'hotel' ? f.checkOut || null : null,
      notes: f.notes || null,
      price: f.price ? Number(f.price) : null,
      paidBy: f.paidBy as 'company' | 'driver',
    }),
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title="Add a booking"
      description="Enter the price and it is recorded as spent on this candidate."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" loading={add.isPending} onClick={() => add.mutate(undefined, { onSuccess: onClose })} data-testid="save-travel">
            Add booking
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {add.error ? (
          <div className="sm:col-span-2">
            <Alert tone="danger" title="Not added" description={errorText(add.error)} />
          </div>
        ) : null}
        <FormField label="Type">
          <Select aria-label="Type" value={kind} onValueChange={(v) => setKind(v as TravelKind)} options={(['flight', 'hotel', 'ground'] as const).map((k) => ({ value: k, label: TRAVEL_KIND_LABELS[k] }))} />
        </FormField>
        <FormField label={kind === 'flight' ? 'Airline' : kind === 'hotel' ? 'Hotel' : 'Company'}>
          <Input value={f.vendor} onChange={(e) => set('vendor', e.target.value)} maxLength={120} />
        </FormField>
        {kind === 'hotel' ? (
          <>
            <FormField label="Check-in">
              <DatePicker aria-label="Check-in" value={f.checkIn} onIsoChange={(v) => set('checkIn', v)} />
            </FormField>
            <FormField label="Check-out">
              <DatePicker aria-label="Check-out" value={f.checkOut} onIsoChange={(v) => set('checkOut', v)} />
            </FormField>
          </>
        ) : (
          <>
            <FormField label="From">
              <Input value={f.routeFrom} onChange={(e) => set('routeFrom', e.target.value)} placeholder="Chicago (ORD)" maxLength={120} />
            </FormField>
            <FormField label="To">
              <Input value={f.routeTo} onChange={(e) => set('routeTo', e.target.value)} placeholder="Dallas (DFW)" maxLength={120} />
            </FormField>
            <FormField label="Departs">
              <Input type="datetime-local" value={f.depart} onChange={(e) => set('depart', e.target.value)} />
            </FormField>
            <FormField label="Arrives">
              <Input type="datetime-local" value={f.arrive} onChange={(e) => set('arrive', e.target.value)} />
            </FormField>
          </>
        )}
        <FormField label={kind === 'flight' ? 'Ticket price ($)' : kind === 'hotel' ? 'Room total ($)' : 'Price ($)'}>
          <Input prefix="$" inputMode="decimal" value={f.price} onChange={(e) => set('price', e.target.value.replace(/[^\d.]/g, ''))} placeholder="0.00" data-testid="travel-price" />
        </FormField>
        <FormField label="Paid by">
          <Select
            aria-label="Paid by"
            value={f.paidBy}
            onValueChange={(v) => set('paidBy', v)}
            options={[
              { value: 'company', label: 'Company' },
              { value: 'driver', label: 'Driver (we reimburse)' },
            ]}
          />
        </FormField>
        <FormField label="Booking reference">
          <Input value={f.bookingReference} onChange={(e) => set('bookingReference', e.target.value)} maxLength={80} />
        </FormField>
        <div className="sm:col-span-2">
          <FormField label="Notes">
            <Textarea value={f.notes} onChange={(e) => set('notes', e.target.value)} rows={2} maxLength={1000} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------------------------- costs

function Costs({ candidate: c, journey: j }: { candidate: RecruitCandidate; journey: CandidateJourney }) {
  // `true` opens an empty expense; a cost type opens it for that screening's actual price.
  const [adding, setAdding] = useState<boolean | CostType>(false);
  // A replaced estimate is kept on record but not listed beside the actual price (owner, 2026-10-12).
  const shown = j.costs.entries.filter((e) => !e.voided);
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs font-bold tracking-wide text-nw-text-3 uppercase">Costs</h3>
        {j.permissions.canManage ? (
          <Button variant="outline" size="sm" icon={<Plus />} onClick={() => setAdding(true)} data-testid="add-cost">
            Add expense
          </Button>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <p className="rounded-xl border border-dashed border-nw-border px-3 py-4 text-center text-sm text-nw-text-3">No costs recorded.</p>
      ) : (
        <ul className="rounded-xl border border-nw-border" data-testid="cost-list">
          {shown.map((e) => (
            <CostRow key={e.id} candidate={c} cost={e} journey={j} onActual={() => setAdding(e.type as CostType)} />
          ))}
        </ul>
      )}
      {adding ? <CostDialog candidate={c} journey={j} initialType={typeof adding === 'string' ? adding : undefined} onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

function CostRow({ candidate: c, cost: e, journey: j, onActual }: { candidate: RecruitCandidate; cost: CandidateCostView; journey: CandidateJourney; onActual: () => void }) {
  const { toast } = useToast();
  const [agreeing, setAgreeing] = useState(false);
  const [note, setNote] = useState('');
  const decide = useJourneyMutation((d: 'approved' | 'rejected') => journeyApi.decideCost(c.key, e.id, { decision: d, note: null, version: e.version }));
  const pay = useJourneyMutation(() => journeyApi.costPayment(c.key, e.id, companyToday(), e.version));
  const agree = useJourneyMutation(() => journeyApi.costAgreement(c.key, e.id, note.trim(), e.version));
  const fail = (title: string) => (err: unknown) => toast({ tone: 'danger', title, description: errorText(err) });
  return (
    <li className={cn('flex flex-col gap-1.5 border-b border-nw-border px-3 py-2.5 last:border-0', e.voided && 'opacity-60')} data-testid={`cost-${e.id}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="min-w-0 flex-1 text-sm font-semibold text-nw-text">
          {e.label}
          {e.vendor ? ` · ${e.vendor}` : ''}
          <span className="ml-2 font-normal text-nw-text-3">{longDate(e.incurredOn)}</span>
        </span>
        <span className="text-sm font-semibold tabular-nums text-nw-text">{formatMoney(e.amount)}</span>
      </div>
      <div className="flex flex-wrap items-center gap-2 text-xs text-nw-text-3">
        <span>
          Paid by {PARTY[e.paidBy]} · {PARTY[e.costOwner]} cost · {COST_TREATMENT_LABELS[e.treatment]}
        </span>
        <Pill family={e.approvalStatus === 'approved' ? 'done' : e.approvalStatus === 'rejected' ? 'urgent' : 'neutral'}>{e.approvalStatus === 'approved' ? 'Approved' : e.approvalStatus === 'rejected' ? 'Rejected' : 'Planned'}</Pill>
        {e.treatment !== 'personal' && e.source === 'manual' ? <Pill family={e.paymentStatus === 'paid' ? 'done' : 'warning'}>{e.paymentStatus === 'paid' ? `Paid ${e.paidAt ? longDate(e.paidAt) : ''}` : 'Unpaid'}</Pill> : null}
        <span>{e.accounting.note ?? ''}</span>
        {e.refundAmount > 0 || e.nonrefundableFee !== null ? <span>Refund {formatMoney(e.refundAmount)}{e.nonrefundableFee !== null ? ` · non-refundable ${formatMoney(e.nonrefundableFee)}` : ''}</span> : null}
      </div>
      {j.permissions.canManage && !e.voided ? (
        <div className="flex flex-wrap items-center gap-2">
          {e.source !== 'manual' ? (
            <Button size="sm" variant="outline" onClick={onActual} data-testid="enter-actual-price">
              Enter actual price
            </Button>
          ) : null}
          {e.treatment === 'driver_charge' && !e.driverAgreementNote ? (
            agreeing ? (
              <>
                <Input value={note} onChange={(ev) => setNote(ev.target.value)} placeholder="How the driver agreed" className="h-8 w-64" />
                <Button size="sm" variant="outline" disabled={note.trim().length < 5} loading={agree.isPending} onClick={() => agree.mutate(undefined, { onError: fail('Not saved') })}>
                  Save agreement
                </Button>
              </>
            ) : (
              <Button size="sm" variant="outline" onClick={() => setAgreeing(true)}>
                Record driver agreement
              </Button>
            )
          ) : null}
          {e.approvalStatus === 'planned' ? (
            <>
              <Button size="sm" variant="outline" loading={decide.isPending} onClick={() => decide.mutate('approved', { onError: fail('Not approved') })} data-testid="approve-cost">
                Approve
              </Button>
              <Button size="sm" variant="ghost" onClick={() => decide.mutate('rejected', { onError: fail('Not rejected') })}>
                Reject
              </Button>
            </>
          ) : null}
          {e.approvalStatus === 'approved' && e.paymentStatus === 'unpaid' && e.treatment !== 'personal' && e.source === 'manual' ? (
            <Button size="sm" variant="outline" loading={pay.isPending} onClick={() => pay.mutate(undefined, { onError: fail('Not recorded') })} data-testid="record-payment">
              {e.treatment === 'reimbursement' ? 'Record reimbursement paid' : 'Record payment'}
            </Button>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}

function CostDialog({ candidate: c, journey: j, onClose, initialType }: { candidate: RecruitCandidate; journey: CandidateJourney; onClose: () => void; initialType?: CostType }) {
  const [f, setF] = useState({ type: initialType ?? ('travel' as CostType), amount: '', incurredOn: companyToday(), vendor: '', paidBy: 'company' as CostParty, costOwner: 'company' as CostParty, travelItemId: '', agreement: '', note: '' });
  const [clientKey] = useState(() => `cst-${crypto.randomUUID().replace(/-/g, '').slice(0, 20)}`);
  const set = <K extends keyof typeof f>(k: K, v: (typeof f)[K]) => setF((p) => ({ ...p, [k]: v }));
  const treatment = costTreatment(f.paidBy, f.costOwner);
  const add = useJourneyMutation(() =>
    journeyApi.addCost(c.key, {
      type: f.type,
      amount: Number(f.amount),
      incurredOn: f.incurredOn,
      vendor: f.vendor || null,
      paidBy: f.paidBy,
      costOwner: f.costOwner,
      // Recorded as spent (owner, 2026-10-12): the expense is what we paid, not a plan.
      approvalStatus: 'approved',
      travelItemId: f.travelItemId || null,
      driverAgreementNote: treatment === 'driver_charge' ? f.agreement || null : null,
      note: f.note || null,
      clientKey,
    }),
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title="Add expense"
      description="Saved as planned. Approval books it where it belongs; payment is recorded separately."
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button variant="primary" disabled={!(Number(f.amount) > 0)} loading={add.isPending} onClick={() => add.mutate(undefined, { onSuccess: onClose })} data-testid="save-cost">
            Add expense
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {add.error ? (
          <div className="sm:col-span-2">
            <Alert tone="danger" title="Not added" description={errorText(add.error)} />
          </div>
        ) : null}
        <FormField label="Category">
          <Select aria-label="Category" value={f.type} onValueChange={(v) => set('type', v as CostType)} options={COST_TYPES.map((t) => ({ value: t, label: COST_TYPE_LABELS[t] }))} />
        </FormField>
        <FormField label="Amount ($)">
          <Input prefix="$" inputMode="decimal" value={f.amount} onChange={(e) => set('amount', e.target.value)} placeholder="320.00" />
        </FormField>
        <FormField label="Date">
          <DatePicker aria-label="Date" value={f.incurredOn} onIsoChange={(v) => set('incurredOn', v)} />
        </FormField>
        <FormField label="Vendor">
          <Input value={f.vendor} onChange={(e) => set('vendor', e.target.value)} maxLength={120} />
        </FormField>
        <FormField label="Paid by">
          <Select aria-label="Paid by" value={f.paidBy} onValueChange={(v) => set('paidBy', v as CostParty)} options={[{ value: 'company', label: 'Company' }, { value: 'driver', label: 'Driver' }]} />
        </FormField>
        <FormField label="Whose cost">
          <Select aria-label="Whose cost" value={f.costOwner} onValueChange={(v) => set('costOwner', v as CostParty)} options={[{ value: 'company', label: 'Company' }, { value: 'driver', label: 'Driver' }]} />
        </FormField>
        <div className="sm:col-span-2">
          <p className="rounded-lg bg-nw-subtle px-3 py-2 text-xs text-nw-text-2">
            {COST_TREATMENT_LABELS[treatment]}:{' '}
            {treatment === 'company_expense'
              ? 'one recruiting expense in Accounting once approved.'
              : treatment === 'reimbursement'
                ? 'the company owes the driver; paid only when that payment is recorded.'
                : treatment === 'driver_charge'
                  ? "charged to the driver only with their recorded agreement and approval, once they are on the roster."
                  : 'recorded; the company pays nothing.'}
          </p>
        </div>
        {treatment === 'driver_charge' ? (
          <div className="sm:col-span-2">
            <FormField label="Driver's agreement">
              <Input value={f.agreement} onChange={(e) => set('agreement', e.target.value)} placeholder="e.g. Agreed by text on Oct 11 to repay the ticket" maxLength={1000} />
            </FormField>
          </div>
        ) : null}
        {j.travel.length > 0 ? (
          <FormField label="Booking (optional)">
            <Select
              aria-label="Booking"
              value={f.travelItemId || 'none'}
              onValueChange={(v) => set('travelItemId', v === 'none' ? '' : v)}
              options={[{ value: 'none', label: 'Not a booking' }, ...j.travel.map((t) => ({ value: t.id, label: `${TRAVEL_KIND_LABELS[t.kind]}${t.vendor ? ` · ${t.vendor}` : ''}` }))]}
            />
          </FormField>
        ) : null}
        <div className="sm:col-span-2">
          <FormField label="Note">
            <Textarea value={f.note} onChange={(e) => set('note', e.target.value)} rows={2} maxLength={1000} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}
