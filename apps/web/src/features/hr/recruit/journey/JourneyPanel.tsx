import { Link, useNavigate } from '@tanstack/react-router';
import { Check, Pause, PhoneCall, Play, Send, UserCheck, X } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { CandidateJourney, RecruitCandidate } from '@neway/shared';
import { Alert, Button, DatePicker, FormField, Input, Modal, Select, StatusSymbol, Textarea, cn, useToast } from '@/design-system';
import { DispatcherSelect } from '@/features/people/DispatcherSelect';
import { today as companyToday } from '@/lib/clock';
import { longDateTime } from '../recruit-format';
import { recruitApi, useRecruitMutation } from '../useRecruit';
import { journeyApi, useCandidateJourney } from '../useJourney';
import { ApplicationReceivedAny, SendApplicationStep } from './ApplicationSteps';
import { ConsentReceivedStep, SendConsentStep } from './ConsentSteps';
import { Pill, StepCard } from './JourneyKit';
import { errorText, useJourneyMutation, useJourneyStep } from './journey-utils';
import { OnboardingStep } from './OnboardingStep';
import { SafetyStatusStep } from './SafetyStatusStep';

/** The nine steps as the recruiter sees them (owner brief, 2026-10-11). */
const STEPS = [
  'Lead received',
  'Send consent',
  'Consent received',
  'Safety review',
  'Send application',
  'Application received',
  'Onboarding & costs',
  'Ready to hire',
  'Driver profile',
] as const;

/**
 * The nine steps as the page's one navigation (owner, 2026-10-11): plain text tabs, the open one
 * underlined in teal, done steps ticked, later steps quiet. Scrolls sideways on a narrow screen.
 */
export function JourneyNav({ candidate: c, active, trailing }: { candidate: RecruitCandidate; active: boolean; trailing?: ReactNode }) {
  const { current, furthest, shown, pick } = useJourneyStep(c);
  // A closed candidate keeps the steps they finished ticked (owner, 2026-10-16).
  const js = c.journeyState;
  const reached = js.onboardingStarted ? 7 : js.safety === 'approved' ? 4 : js.consent === 'received' ? 3 : js.consent === 'sent' ? 2 : 1;
  return (
    <div className="flex items-end gap-2 border-b border-nw-border" data-testid="journey-panel">
      <ol className="relative -mb-px flex min-w-0 flex-1 overflow-x-auto [scrollbar-width:thin]" role="tablist" aria-label="Recruiting journey">
        {STEPS.map((label, i) => {
          const n = i + 1;
          const done = current === 0 ? n <= reached : n < current;
          const here = n === current;
          const reachable = n <= furthest || current === 0;
          const open = active && shown === n;
          return (
            <li key={label} className="shrink-0">
              <button
                type="button"
                role="tab"
                aria-selected={open}
                disabled={!reachable}
                onClick={() => pick(n)}
                aria-current={here ? 'step' : undefined}
                className={cn(
                  'flex h-11 items-center gap-1.5 border-b-2 px-2.5 text-sm whitespace-nowrap transition-colors duration-150 motion-reduce:transition-none xl:px-3',
                  open ? 'border-nw-accent font-semibold text-nw-text' : 'border-transparent font-medium',
                  !open && reachable ? (done ? 'text-nw-done-text hover:text-nw-text' : 'text-nw-text-2 hover:text-nw-text') : '',
                  open && done ? 'text-nw-done-text' : '',
                  !reachable ? 'cursor-default text-nw-text-3 opacity-60' : '',
                )}
                data-testid={`journey-step-${n}`}
              >
                {done ? (
                  <Check aria-hidden className="size-3.5 text-nw-done-icon" />
                ) : (
                  <span className={cn('text-xs tabular-nums', here ? 'font-bold text-nw-accent-ink' : 'text-nw-text-3')}>{n}</span>
                )}
                <span className="sr-only">{done ? 'Done:' : here ? 'Current step:' : 'Later:'}</span>
                {label}
              </button>
            </li>
          );
        })}
      </ol>
      {trailing ? <div className="shrink-0 pb-1.5">{trailing}</div> : null}
    </div>
  );
}

/** The open step's one content panel (the journey read once per page). */
export function JourneyContent({ candidate: c, extra }: { candidate: RecruitCandidate; extra?: Partial<Record<number, ReactNode>> }) {
  const query = useCandidateJourney(c.key);
  const { current, shown } = useJourneyStep(c);
  return (
    <section className="flex min-w-0 flex-col gap-4" data-testid="journey-content">
      {current === 0 ? (
        <Alert tone="neutral" title="Closed">
          {c.lead?.deadReason ? `Disqualified: ${c.lead.deadReason}` : 'This candidate left the hiring pipeline. Everything is kept and audited.'}
        </Alert>
      ) : null}
      {query.isPending ? (
        <p className="text-sm text-nw-text-3">Loading…</p>
      ) : query.isError || !query.data ? (
        <Alert tone="danger" title="The journey could not be loaded" description={errorText(query.error, 'Check the connection and try again.')} />
      ) : (
        <StepBody step={shown} candidate={c} journey={query.data} extra={extra?.[shown] ?? null} />
      )}
    </section>
  );
}

function StepBody({ step, candidate: c, journey: j, extra }: { step: number; candidate: RecruitCandidate; journey: CandidateJourney; extra: ReactNode }) {
  switch (step) {
    case 1:
      return <LeadStep candidate={c} journey={j} />;
    case 2:
      return <SendConsentStep candidate={c} journey={j} />;
    case 3:
      return j.consent.submission ? <ConsentReceivedStep candidate={c} journey={j} /> : <Waiting step={3} title="Consent received" text="The driver has not signed yet." />;
    case 4:
      return j.safety.review && j.safety.review.status !== 'preparing' ? <SafetyStatusStep candidate={c} journey={j} /> : <Waiting step={4} title="Safety review" text="Not sent to Safety yet: upload the MVR and PSP on Consent received, then Send to Safety." />;
    case 5:
      return <SendApplicationStep candidate={c} journey={j} />;
    case 6:
      // The journey application, or an application that came the earlier way (DOT form, external).
      return <ApplicationReceivedAny candidate={c} journey={j} fallback={extra ?? <Waiting step={6} title="Application received" text="The driver has not submitted the application yet." />} />;
    case 7:
      return (
        <>
          {j.onboarding.startedAt ? <OnboardingStep candidate={c} journey={j} /> : <Waiting step={7} title="Onboarding & costs" text="Starts after the application is reviewed." />}
          {extra}
        </>
      );
    case 8:
      return <ReadyStep candidate={c} journey={j} />;
    case 9:
      return <HiredStep candidate={c} journey={j} />;
    default:
      return null;
  }
}

function Waiting({ step, title, text }: { step: number; title: string; text: string }) {
  return <StepCard step={step} title={title} subtitle={text} />;
}

/** Step 1 — Lead received: who, how to reach them, and the next two moves. */
function LeadStep({ candidate: c, journey: j }: { candidate: RecruitCandidate; journey: CandidateJourney }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const contacted = useRecruitMutation((leadId: string) => recruitApi.markContacted(leadId));
  const canManage = j.permissions.canManage;
  const startConsent = () => void navigate({ to: '.', search: ((prev: Record<string, unknown>) => ({ ...prev, step: '2' })) as never, replace: true });
  return (
    <StepCard
      step={1}
      title="Lead received"
      subtitle={`Received ${longDateTime(c.createdAt)} · ${c.sourceLabel}`}
      testId="step-lead"
      footnote="Contact the driver, then send the consent. Their details are in Candidate information."
      actions={
        canManage ? (
          <>
            {c.phone ? (
              <Button variant="outline" icon={<PhoneCall />} asChild>
                <a href={`tel:${c.phone}`}>Contact</a>
              </Button>
            ) : null}
            {c.progress === 'new' && c.leadId ? (
              <Button
                variant="outline"
                loading={contacted.isPending}
                onClick={() => contacted.mutate(c.leadId as string, { onSuccess: () => toast({ tone: 'success', title: 'Marked as contacted' }), onError: (e) => toast({ tone: 'danger', title: 'Not changed', description: errorText(e) }) })}
                data-testid="mark-contacted"
              >
                Mark as contacted
              </Button>
            ) : null}
            {j.consent.submission ? null : (
              <Button variant="primary" icon={<Send />} onClick={startConsent} data-testid="primary-action">
                Send consent
              </Button>
            )}
          </>
        ) : null
      }
    />
  );
}

/** Step 8 — Ready to hire: the checklist read from the records, then Hire, Hold or Withdraw. */
function ReadyStep({ candidate: c, journey: j }: { candidate: RecruitCandidate; journey: CandidateJourney }) {
  const { toast } = useToast();
  const [dialog, setDialog] = useState<'hire' | 'hold' | 'withdraw' | null>(null);
  const release = useJourneyMutation(() => journeyApi.hold(c.key, false, null));
  const h = j.hire;
  if (h.hired) return <HiredStep candidate={c} journey={j} />;
  return (
    <StepCard
      step={8}
      title="Ready to hire"
      subtitle={h.ready ? 'Every prerequisite is met' : 'Read from the records; pending items block the hire'}
      testId="step-ready"
      footnote="Hiring creates the driver under the same id; documents, signatures, audit and costs stay with them."
      actions={
        j.permissions.canManage ? (
          <>
            {h.onHold ? (
              <Button variant="outline" icon={<Play />} loading={release.isPending} onClick={() => release.mutate(undefined, { onSuccess: () => toast({ tone: 'success', title: 'Hold released' }) })}>
                Release hold
              </Button>
            ) : (
              <Button variant="outline" icon={<Pause />} onClick={() => setDialog('hold')} data-testid="hold">
                Hold
              </Button>
            )}
            <Button variant="outline" icon={<X />} className="border-nw-urgent-border text-nw-urgent-text" onClick={() => setDialog('withdraw')} data-testid="withdraw">
              Withdraw
            </Button>
            <Button variant="primary" icon={<UserCheck />} disabled={!h.ready} title={h.ready ? undefined : 'Not ready: see the checklist'} onClick={() => setDialog('hire')} data-testid="hire-driver">
              Hire driver
            </Button>
          </>
        ) : null
      }
    >
      <ul className="rounded-xl border border-nw-border" data-testid="hire-checklist">
        {h.items.map((i) => (
          <li key={i.code} className="flex items-start gap-3 border-b border-nw-border px-3 py-2.5 last:border-0" data-testid={`hire-item-${i.code}`}>
            <StatusSymbol family={i.ok ? 'done' : 'warning'} size={18} className={i.ok ? 'mt-px text-nw-done-icon' : 'mt-px text-nw-warning-icon'} />
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-semibold text-nw-text">{i.label}</span>
              <span className="block text-xs text-nw-text-3">{i.detail}</span>
            </span>
            {i.at ? <span className="text-xs text-nw-text-3">{longDateTime(i.at)}</span> : null}
          </li>
        ))}
      </ul>
      {dialog === 'hire' ? <HireDialog candidate={c} onClose={() => setDialog(null)} /> : null}
      {dialog === 'hold' || dialog === 'withdraw' ? <ReasonDialog candidate={c} kind={dialog} onClose={() => setDialog(null)} /> : null}
    </StepCard>
  );
}

function ReasonDialog({ candidate: c, kind, onClose }: { candidate: RecruitCandidate; kind: 'hold' | 'withdraw'; onClose: () => void }) {
  const { toast } = useToast();
  const [reason, setReason] = useState('');
  const save = useJourneyMutation(() => (kind === 'hold' ? journeyApi.hold(c.key, true, reason.trim()) : journeyApi.withdraw(c.key, reason.trim())));
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="sm"
      title={kind === 'hold' ? 'Put on hold' : 'Withdraw the candidate'}
      description={kind === 'hold' ? 'Nothing moves until the hold is released.' : 'The candidate leaves hiring; costs, documents and history are kept.'}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant={kind === 'withdraw' ? 'danger' : 'primary'}
            disabled={reason.trim().length < 3}
            loading={save.isPending}
            onClick={() => save.mutate(undefined, { onSuccess: () => { toast({ tone: 'success', title: kind === 'hold' ? 'On hold' : 'Withdrawn' }); onClose(); } })}
          >
            {kind === 'hold' ? 'Hold' : 'Withdraw'}
          </Button>
        </>
      }
    >
      {save.error ? <Alert tone="danger" title="Not saved" description={errorText(save.error)} /> : null}
      <FormField label="Reason" required>
        <Textarea value={reason} onChange={(e) => setReason(e.target.value)} rows={3} maxLength={500} />
      </FormField>
    </Modal>
  );
}

function HireDialog({ candidate: c, onClose }: { candidate: RecruitCandidate; onClose: () => void }) {
  const { toast } = useToast();
  const [f, setF] = useState({ hireDate: companyToday(), driverType: 'company', payPlanKind: 'per_mile', payPlanRate: '', dispatcherId: '' });
  const set = (k: keyof typeof f, v: string) => setF((p) => ({ ...p, [k]: v }));
  const hire = useJourneyMutation(() =>
    journeyApi.hire(c.key, {
      hireDate: f.hireDate,
      driverType: f.driverType as 'company',
      payPlanKind: f.payPlanKind as 'per_mile',
      payPlanRate: Number(f.payPlanRate),
      dispatcherId: f.dispatcherId,
    }),
  );
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="md"
      title={`Hire ${c.name}?`}
      footer={
        <>
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!f.dispatcherId || f.payPlanRate === ''}
            loading={hire.isPending}
            onClick={() => hire.mutate(undefined, { onSuccess: (r) => { toast({ tone: 'success', title: 'Driver hired', description: `${c.name} is driver ${r.driverNumber}.` }); onClose(); } })}
            data-testid="confirm-hire"
          >
            Hire driver
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {hire.error ? (
          <div className="sm:col-span-2">
            <Alert tone="danger" title="Not hired" description={errorText(hire.error)} />
          </div>
        ) : null}
        <FormField label="Start date" required>
          <DatePicker aria-label="Start date" value={f.hireDate} onIsoChange={(v) => set('hireDate', v)} />
        </FormField>
        <FormField label="Dispatcher" required>
          <DispatcherSelect value={f.dispatcherId || null} onValueChange={(v) => set('dispatcherId', v ?? '')} />
        </FormField>
        <FormField label="Driver type">
          <Select aria-label="Driver type" value={f.driverType} onValueChange={(v) => set('driverType', v)} options={[{ value: 'company', label: 'Company driver' }, { value: 'lease_operator', label: 'Lease operator' }, { value: 'owner_operator', label: 'Owner operator' }]} />
        </FormField>
        <FormField label="Pay plan">
          <Select aria-label="Pay plan" value={f.payPlanKind} onValueChange={(v) => set('payPlanKind', v)} options={[{ value: 'per_mile', label: 'Per mile ($)' }, { value: 'percent_of_linehaul', label: '% of linehaul' }]} />
        </FormField>
        <FormField label={f.payPlanKind === 'per_mile' ? 'Rate per mile ($)' : 'Percent of linehaul'} required>
          <Input inputMode="decimal" value={f.payPlanRate} onChange={(e) => set('payPlanRate', e.target.value)} placeholder={f.payPlanKind === 'per_mile' ? '0.65' : '25'} />
        </FormField>
      </div>
    </Modal>
  );
}

/** Step 9 — Driver profile: the same person, now on the roster, with every document kept. */
function HiredStep({ candidate: c, journey: j }: { candidate: RecruitCandidate; journey: CandidateJourney }) {
  const hired = j.hire.hired;
  const driverId = hired?.driverId ?? c.driverId;
  return (
    <StepCard
      step={9}
      title="Driver profile · Documents"
      subtitle={hired ? `Hired ${longDateTime(hired.at)}${hired.driverNumber ? ` · driver ${hired.driverNumber}` : ''}` : 'Hired'}
      testId="step-hired"
      footnote="The driver profile holds every document: CDL front and back, medical card, Safety reports and signed consents — nothing is uploaded again."
      actions={
        driverId ? (
          <Button variant="primary" asChild data-testid="open-driver-profile">
            <Link to="/drivers/$driverId" params={{ driverId }} search={{ tab: 'documents' } as never}>
              Open driver profile
            </Link>
          </Button>
        ) : null
      }
    >
      <div className="flex flex-wrap gap-2">
        <Pill family="done">Active driver</Pill>
        <Pill family="neutral">{j.consent.submission?.documents.length ?? 0} signed consents</Pill>
        <Pill family="neutral">{j.safety.reports.length} Safety reports</Pill>
        <Pill family="neutral">{j.costs.entries.length} costs</Pill>
      </div>
    </StepCard>
  );
}
