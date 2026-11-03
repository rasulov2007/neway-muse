import { Link, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import {
  ArrowRight,
  BarChart3,
  CalendarDays,
  FileText,
  Lock,
  Plane,
  ShieldCheck,
  UserCheck,
  Zap,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  DRIVER_LANGUAGES,
  DRIVER_TYPES,
  HIRING_END_REASON_LABELS,
  HIRING_STAGE_LABELS,
  PAY_PLAN_KINDS,
  TRAVEL_MODES,
  TRAVEL_MODE_LABELS,
  isTerminal,
  type DriverRecord,
  type HiringCase,
  type OfferRecord,
  type Orientation,
  type TravelTicket,
} from '@neway/shared';
import {
  Alert,
  Badge,
  Button,
  Checkbox,
  DatePicker,
  FormField,
  Input,
  Modal,
  Select,
  StatusSymbol,
  Textarea,
  cn,
  useToast,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { DispatcherSelect } from '@/features/people/DispatcherSelect';
import { useEmployeeDirectory } from '@/features/people/useEmployees';
import { ApiError, apiGet } from '@/lib/api-client';
import { today as companyToday } from '@/lib/clock';
import { formatDateTime, formatIsoDate } from '@/lib/format';
import { tzShort, zonedToIso } from '@/features/fleet/pm/sheet-format';
import { fieldErrors, money } from './recruiting-kit';
import { hiringApi, useCasePipeline, useDotApplication, useHiringMutation } from './useHiring';

/**
 * Candidate › Offer & onboarding (owner's redesign, 2026-10-01).
 *
 * Four steps after Safety's approval — offer, travel, orientation, hire — each unlocked by the one
 * before it, exactly as the server enforces them: an offer only at the Offer stage (which only
 * Safety's approval reaches), travel only for an accepted offer, orientation only once travel is
 * recorded, the hire only after orientation was attended and the road test passed. A locked step
 * says what it is waiting for. Nothing here sends a message, books travel or pays anyone: each
 * action records something that happened, and says so.
 */

type Tab = 'overview' | 'application' | 'documents' | 'onboarding' | 'costs' | 'activity';
type Family = 'done' | 'moving' | 'warning' | 'urgent' | 'neutral';
type Tone = 'success' | 'info' | 'warning' | 'danger' | 'neutral';
const FAMILY_TONE: Record<Family, Tone> = { done: 'success', moving: 'info', warning: 'warning', urgent: 'danger', neutral: 'neutral' };

const AT_OR_AFTER_OFFER = ['offer', 'ticketed', 'orientation', 'hired', 'active_driver'];

function StateBadge({ family, children, locked }: { family: Family; children: ReactNode; locked?: boolean }) {
  return (
    <Badge tone={FAMILY_TONE[family]} icon={locked ? <Lock aria-hidden className="size-3" /> : <StatusSymbol family={family} size={11} />}>
      {children}
    </Badge>
  );
}

const OFFER_WORD: Record<string, { word: string; family: Family }> = {
  draft: { word: 'Draft', family: 'moving' },
  sent: { word: 'Sent — awaiting answer', family: 'moving' },
  accepted: { word: 'Accepted', family: 'done' },
  declined: { word: 'Declined', family: 'urgent' },
  cancelled: { word: 'Cancelled', family: 'neutral' },
  expired: { word: 'Expired', family: 'warning' },
};

function payPlan(offer: OfferRecord): string {
  if (offer.payPlanRate === null) return 'Not recorded';
  return offer.payPlanKind === 'per_mile' ? `${money(offer.payPlanRate)} per mile` : `${offer.payPlanRate}% of linehaul`;
}

export function DriverFunnelPanel({ hiringCase, onTab }: { hiringCase: HiringCase; onTab?: (tab: Tab) => void }) {
  const pipeline = useCasePipeline(hiringCase.id);
  const application = useDotApplication(hiringCase.id);
  const canManage = useAccount()?.permissions.includes('recruiting.manage') ?? false;
  const [dialog, setDialog] = useState<'offer' | 'travel' | 'orientation' | 'hire' | null>(null);
  const move = useHiringMutation((status: string) => hiringApi.setOfferStatus(hiringCase.id, status));
  const { toast } = useToast();

  if (pipeline.isPending) return <p className="text-sm text-muted">Loading…</p>;
  if (pipeline.error || !pipeline.data) {
    return <Alert tone="danger" title="The offer, travel and orientation could not be loaded" />;
  }
  const { offer, ticket, orientation } = pipeline.data;
  const state = hiringCase.state;
  const ended = isTerminal(state);
  const approved = AT_OR_AFTER_OFFER.includes(state);
  const appStatus = hiringCase.dotApplication?.status ?? (application.data ? 'draft' : null);
  const hired = hiringCase.employeeId !== null;

  // ---- what each step may do now, and why not when it may not
  const offerOpen = offer && ['draft', 'sent', 'accepted'].includes(offer.status);
  const canCreateOffer = state === 'offer' && !offerOpen;
  const offerBlocker = ended
    ? 'The case has ended.'
    : !approved
      ? 'Available after Safety approval.'
      : offerOpen
        ? null
        : state !== 'offer'
          ? 'The case has moved past the offer.'
          : null;
  const canRecordTravel = state === 'offer' && offer?.status === 'accepted' && !ticket;
  const travelBlocker = ticket ? null : ended ? 'The case has ended.' : offer?.status === 'accepted' ? null : 'Available after the offer is accepted.';
  const canRecordOrientation = state === 'ticketed' || state === 'orientation';
  const orientationBlocker = canRecordOrientation || orientation ? null : ended ? 'The case has ended.' : 'Scheduled after travel is recorded.';
  const readyToHire = state === 'orientation' && orientation?.attendance === 'attended' && orientation.roadTest?.result === 'pass';
  const hireBlocker = hired
    ? null
    : ended
      ? 'The case has ended.'
      : state === 'orientation'
        ? orientation?.attendance !== 'attended'
          ? 'Record orientation as attended first.'
          : orientation.roadTest?.result !== 'pass'
            ? 'Needs a passed road test.'
            : null
        : 'Complete orientation before confirming the hire.';

  const offerStatusAction = (status: string, label: string, variant: 'primary' | 'outline' | 'ghost' = 'outline') => (
    <Button
      key={status}
      size="sm"
      variant={variant}
      loading={move.isPending && move.variables === status}
      disabled={move.isPending}
      onClick={() =>
        move.mutate(status, {
          onSuccess: () => toast({ tone: 'success', title: `Offer recorded as ${OFFER_WORD[status]?.word.toLowerCase() ?? status}` }),
          onError: (e) => toast({ tone: 'danger', title: e instanceof ApiError ? e.message : 'Not saved' }),
        })
      }
    >
      {label}
    </Button>
  );

  // ---- the gate banner
  let gate: ReactNode = null;
  if (ended) {
    gate = (
      <GateBanner
        family="neutral"
        title={`${HIRING_STAGE_LABELS[state]} — the case has ended`}
        text={`${hiringCase.endReason ? HIRING_END_REASON_LABELS[hiringCase.endReason] : 'No reason recorded'}${hiringCase.endNote ? ` — ${hiringCase.endNote}` : ''}. Nothing further can be recorded here.`}
      />
    );
  } else if (!approved) {
    const needsApplication = appStatus !== 'submitted';
    gate = (
      <GateBanner
        family="warning"
        title="Safety approval required"
        text={
          needsApplication
            ? 'Complete the DOT application and Safety review before creating an offer.'
            : 'Safety is reviewing the documents and checks. The offer opens as soon as Safety approves the file.'
        }
        action={
          onTab ? (
            <Button variant="primary" onClick={() => onTab(needsApplication ? 'application' : 'documents')}>
              {needsApplication ? (appStatus === 'driver_submitted' ? 'Review application' : appStatus === 'draft' ? 'Continue application' : 'Start application') : 'Open documents'}
            </Button>
          ) : null
        }
      />
    );
  }

  // ---- readiness and the next action
  const readiness: { icon: ReactNode; label: string; word: string; family: Family }[] = [
    {
      icon: <FileText />,
      label: 'Application',
      word: appStatus === 'submitted' ? 'Submitted' : appStatus === 'driver_submitted' ? 'Needs review' : appStatus === 'draft' ? 'In progress' : 'Not started',
      family: appStatus === 'submitted' ? 'done' : appStatus === 'driver_submitted' ? 'warning' : appStatus === 'draft' ? 'moving' : 'neutral',
    },
    {
      icon: <ShieldCheck />,
      label: 'Safety approval',
      word:
        state === 'disqualified'
          ? 'Disqualified'
          : approved
            ? 'Approved'
            : state === 'checks' || state === 'safety_review'
              ? 'Pending'
              : ended
                ? 'Not reached'
                : 'Not started',
      family: state === 'disqualified' ? 'urgent' : approved ? 'done' : state === 'checks' || state === 'safety_review' ? 'warning' : 'neutral',
    },
    {
      icon: <FileText />,
      label: 'Offer acceptance',
      word: offer ? (offer.status === 'sent' ? 'Awaiting answer' : (OFFER_WORD[offer.status]?.word ?? offer.status)) : 'Not started',
      family: offer ? (OFFER_WORD[offer.status]?.family ?? 'neutral') : 'neutral',
    },
    {
      icon: <Plane />,
      label: 'Travel',
      word: ticket ? `Recorded · ${formatIsoDate(ticket.departAt.slice(0, 10))}` : 'Not recorded',
      family: ticket ? 'done' : 'neutral',
    },
    {
      icon: <CalendarDays />,
      label: 'Start date',
      word: hiringCase.hiredAt
        ? `Hired ${formatIsoDate(hiringCase.hiredAt.slice(0, 10))}`
        : orientation
          ? `Orientation ${formatIsoDate(orientation.startDate)}`
          : offer?.orientationDate
            ? `Planned ${formatIsoDate(offer.orientationDate)}`
            : 'Not set',
      family: hiringCase.hiredAt ? 'done' : orientation || offer?.orientationDate ? 'moving' : 'neutral',
    },
  ];

  const next: { text: string; action?: { label: string; run: () => void } } = ended
    ? { text: 'The case has ended; there is nothing left to do here.' }
    : !approved
      ? appStatus !== 'submitted'
        ? { text: 'Complete the DOT application to move forward.', action: onTab ? { label: 'Open application', run: () => onTab('application') } : undefined }
        : { text: 'Waiting on Safety to approve or disqualify the file.', action: onTab ? { label: 'Open documents', run: () => onTab('documents') } : undefined }
      : canCreateOffer
        ? { text: 'Draft the offer: pay plan, bonuses and orientation date.', action: canManage ? { label: 'Create offer', run: () => setDialog('offer') } : undefined }
        : offer?.status === 'draft'
          ? { text: 'Give the offer to the candidate, then mark it sent.' }
          : offer?.status === 'sent'
            ? { text: 'Record the candidate’s answer to the offer.' }
            : canRecordTravel
              ? { text: 'Record the travel booked to orientation.', action: canManage ? { label: 'Record travel', run: () => setDialog('travel') } : undefined }
              : state === 'ticketed'
                ? { text: 'Record orientation and the road test.', action: canManage ? { label: 'Record orientation', run: () => setDialog('orientation') } : undefined }
                : readyToHire && !hired
                  ? { text: 'Everything is in place: confirm the hire.', action: canManage ? { label: 'Confirm hire', run: () => setDialog('hire') } : undefined }
                  : state === 'orientation'
                    ? { text: 'Finish orientation: attendance and a passed road test.', action: canManage ? { label: 'Update orientation', run: () => setDialog('orientation') } : undefined }
                    : state === 'hired'
                      ? { text: 'Hired. The case becomes Active driver at the first dispatch from the boards.' }
                      : { text: 'Driving.' };

  const locked = (reason: string | null) => reason !== null;

  return (
    <div className="grid gap-4 xl:grid-cols-[minmax(0,1fr)_22rem]" data-testid="offer-onboarding">
      <div className="flex min-w-0 flex-col gap-4">
        <div>
          <h2 className="text-xl font-bold text-ink">Offer & onboarding</h2>
          <p className="text-sm text-muted">The steps from Safety approval to the hire. Each one records what happened; nothing is sent from here.</p>
        </div>
        {gate}

        <ol className="flex flex-col gap-3">
          <StepCard
            n={1}
            icon={<FileText />}
            title="Offer letter"
            state={offer ? <StateBadge family={OFFER_WORD[offer.status]?.family ?? 'neutral'}>{OFFER_WORD[offer.status]?.word ?? offer.status}</StateBadge> : locked(offerBlocker) ? <StateBadge family="neutral" locked>Locked</StateBadge> : <StateBadge family="neutral">Not started</StateBadge>}
            hint={offer ? `${offer.offerNumber} · ${offer.driverType?.replace(/_/g, ' ') ?? 'driver'}` : (offerBlocker ?? 'Safety approved the file. Draft the offer.')}
            action={
              canManage ? (
                canCreateOffer ? (
                  <Button variant="primary" onClick={() => setDialog('offer')}>
                    {offer ? 'Create a new offer' : 'Create offer'}
                  </Button>
                ) : offer && state === 'offer' ? (
                  <div className="flex flex-wrap justify-end gap-1.5">
                    {offer.status === 'draft' ? [offerStatusAction('sent', 'Mark as sent', 'primary'), offerStatusAction('cancelled', 'Cancel offer', 'ghost')] : null}
                    {offer.status === 'sent'
                      ? [offerStatusAction('accepted', 'Record accepted', 'primary'), offerStatusAction('declined', 'Record declined'), offerStatusAction('cancelled', 'Cancel offer', 'ghost')]
                      : null}
                    {offer.status === 'expired' ? offerStatusAction('sent', 'Mark as re-sent') : null}
                  </div>
                ) : offerBlocker && !offer ? (
                  <Button variant="outline" disabled icon={<Lock />} title={offerBlocker}>
                    Create offer
                  </Button>
                ) : null
              ) : null
            }
          >
            {offer ? (
              <Facts
                items={[
                  ['Pay plan', payPlan(offer)],
                  ['Sign-on bonus', offer.signOnBonus === null ? 'None' : money(offer.signOnBonus)],
                  ['Referral bonus', offer.referralBonus === null ? 'None' : `${money(offer.referralBonus)} · ${offer.referringDriverName ?? offer.referringDriverId}`],
                  ['Orientation date', offer.orientationDate ? formatIsoDate(offer.orientationDate) : 'Not set'],
                  ['Marked sent', offer.sentAt ? formatDateTime(offer.sentAt) : 'Not yet'],
                  ['Answered', offer.decidedAt ? formatDateTime(offer.decidedAt) : 'Not yet'],
                ]}
              />
            ) : null}
          </StepCard>

          <StepCard
            n={2}
            icon={<Plane />}
            title="Travel arrangements"
            state={ticket ? <StateBadge family="done">Recorded</StateBadge> : travelBlocker ? <StateBadge family="neutral" locked>Locked</StateBadge> : <StateBadge family="moving">Ready</StateBadge>}
            hint={ticket ? `${TRAVEL_MODE_LABELS[ticket.travelMode]}${ticket.carrier ? ` · ${ticket.carrier}` : ''}` : (travelBlocker ?? 'The offer is accepted. Record the travel booked to orientation.')}
            action={
              canManage && canRecordTravel ? (
                <Button variant="primary" onClick={() => setDialog('travel')}>
                  Record travel
                </Button>
              ) : !ticket && travelBlocker && canManage ? (
                <Button variant="outline" disabled icon={<Lock />} title={travelBlocker}>
                  Record travel
                </Button>
              ) : null
            }
          >
            {ticket ? (
              <Facts
                items={[
                  ['Booking reference', ticket.bookingReference ?? 'Not recorded'],
                  ['Departs', formatDateTime(ticket.departAt)],
                  ['Arrives', ticket.arriveAt ? formatDateTime(ticket.arriveAt) : 'Not recorded'],
                  ['Travel cost', ticket.travelCost === null ? 'Not recorded' : money(ticket.travelCost)],
                  ['Lodging', `${ticket.lodgingNights} night${ticket.lodgingNights === 1 ? '' : 's'} · ${ticket.lodgingCost === null ? 'cost not recorded' : money(ticket.lodgingCost)}`],
                  ['Recorded by', ticket.bookedByName],
                ]}
              />
            ) : null}
          </StepCard>

          <StepCard
            n={3}
            icon={<CalendarDays />}
            title="Orientation"
            state={
              orientation ? (
                <StateBadge family={orientation.attendance === 'attended' ? 'done' : orientation.attendance === 'no_show' ? 'urgent' : 'moving'}>
                  {orientation.attendance === 'attended' ? 'Attended' : orientation.attendance === 'no_show' ? 'No-show' : 'Scheduled'}
                </StateBadge>
              ) : orientationBlocker ? (
                <StateBadge family="neutral" locked>
                  Locked
                </StateBadge>
              ) : (
                <StateBadge family="moving">Ready</StateBadge>
              )
            }
            hint={orientation ? `${formatIsoDate(orientation.startDate)} · ${orientation.days} day${orientation.days === 1 ? '' : 's'}` : (orientationBlocker ?? 'Record attendance, the days, per-day pay and the road test.')}
            action={
              canManage && canRecordOrientation ? (
                <Button variant={orientation ? 'outline' : 'primary'} onClick={() => setDialog('orientation')}>
                  {orientation ? 'Update orientation' : 'Record orientation'}
                </Button>
              ) : !orientation && orientationBlocker && canManage ? (
                <Button variant="outline" disabled icon={<Lock />} title={orientationBlocker}>
                  Record orientation
                </Button>
              ) : null
            }
          >
            {orientation ? (
              <Facts
                items={[
                  ['Per-day pay', orientation.perDayPay === null ? 'Not recorded' : money(orientation.perDayPay)],
                  [
                    'Road test',
                    orientation.roadTest
                      ? `${orientation.roadTest.result === 'pass' ? 'Passed' : 'Failed'} ${formatIsoDate(orientation.roadTest.testedOn)} · ${orientation.roadTest.examinerName}`
                      : 'Not taken',
                  ],
                  [
                    'Certificate',
                    orientation.roadTestDocumentId && hiringCase.verificationCaseId ? (
                      <Link
                        to="/safety/compliance"
                        search={{ tab: 'verification', case: hiringCase.verificationCaseId } as never}
                        className="text-primary-text hover:underline"
                      >
                        Filed in the qualification file
                      </Link>
                    ) : (
                      'Not filed'
                    ),
                  ],
                  ['Completed', orientation.completedOn ? formatIsoDate(orientation.completedOn) : 'Not yet'],
                ]}
              />
            ) : null}
          </StepCard>

          <StepCard
            n={4}
            icon={<UserCheck />}
            title="Confirm hire"
            last
            state={hired ? <StateBadge family="done">Hired</StateBadge> : hireBlocker ? <StateBadge family="neutral" locked>Locked</StateBadge> : <StateBadge family="moving">Ready</StateBadge>}
            hint={hired ? (hiringCase.hiredAt ? `Hired ${formatDateTime(hiringCase.hiredAt)}` : 'Hired') : (hireBlocker ?? 'Creates the employee and the driver profile, linked to this case.')}
            action={
              canManage && readyToHire && !hired ? (
                <Button variant="primary" onClick={() => setDialog('hire')}>
                  Confirm hire
                </Button>
              ) : !hired && hireBlocker && canManage ? (
                <Button variant="outline" disabled icon={<Lock />} title={hireBlocker}>
                  Confirm hire
                </Button>
              ) : null
            }
          >
            {hired ? (
              <Facts
                items={[
                  [
                    'Employee',
                    <Link key="e" to="/hr/employees/$employeeId" params={{ employeeId: hiringCase.employeeId as string }} className="text-primary-text hover:underline">
                      Open employee record
                    </Link>,
                  ],
                  [
                    'Driver',
                    hiringCase.driverId ? (
                      <Link key="d" to="/drivers" search={{ driver: hiringCase.driverId } as never} className="text-primary-text hover:underline">
                        Open driver profile
                      </Link>
                    ) : (
                      'Not linked'
                    ),
                  ],
                  ['First dispatch', hiringCase.firstDispatchAt ? formatDateTime(hiringCase.firstDispatchAt) : 'Not yet'],
                  [
                    'Onboarding',
                    hiringCase.onboardingGate ? (
                      <Link
                        key="o"
                        to="/hr/onboarding/$checklistId"
                        params={{ checklistId: hiringCase.onboardingGate.checklistId }}
                        className="text-primary-text hover:underline"
                        title={hiringCase.onboardingGate.blockingTitles.join(', ')}
                      >
                        {hiringCase.onboardingGate.blockingOpen === 0
                          ? 'Nothing blocking is open'
                          : `${hiringCase.onboardingGate.blockingOpen} blocking item${hiringCase.onboardingGate.blockingOpen === 1 ? '' : 's'} open`}
                      </Link>
                    ) : (
                      'No onboarding plan'
                    ),
                  ],
                ]}
              />
            ) : null}
          </StepCard>
        </ol>
      </div>

      <aside className="flex min-w-0 flex-col gap-4">
        <section className="rounded-[10px] border border-nw-border bg-nw-panel p-4" aria-label="Candidate readiness" data-testid="readiness">
          <div className="mb-3 flex items-start gap-3">
            <BarChart3 aria-hidden className="mt-0.5 size-5 text-primary-text" />
            <div>
              <h3 className="text-md font-bold text-ink">Candidate readiness</h3>
              <p className="text-xs text-muted">Where each part of onboarding stands now.</p>
            </div>
          </div>
          <ul className="divide-y divide-nw-border">
            {readiness.map((r) => (
              <li key={r.label} className="flex items-center gap-3 py-2.5 text-sm">
                <span aria-hidden className="text-muted [&_svg]:size-4">
                  {r.icon}
                </span>
                <span className="flex-1 text-ink">{r.label}</span>
                <StateBadge family={r.family}>{r.word}</StateBadge>
              </li>
            ))}
          </ul>
        </section>
        <section className="flex gap-3 rounded-[10px] border border-nw-border bg-nw-panel p-4" aria-label="Next action" data-testid="onboarding-next">
          <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary-text">
            <Zap className="size-5" />
          </span>
          <div className="min-w-0">
            <h3 className="text-md font-bold text-ink">Next action</h3>
            <p className="text-sm text-secondary">{next.text}</p>
            {next.action ? (
              <button
                type="button"
                onClick={next.action.run}
                className="mt-2 inline-flex items-center gap-1 text-sm font-semibold text-primary-text hover:underline"
              >
                {next.action.label} <ArrowRight aria-hidden className="size-4" />
              </button>
            ) : null}
          </div>
        </section>
      </aside>

      {dialog === 'offer' ? <OfferModal hiringCase={hiringCase} onClose={() => setDialog(null)} /> : null}
      {dialog === 'travel' ? <TravelModal hiringCase={hiringCase} onClose={() => setDialog(null)} /> : null}
      {dialog === 'orientation' ? <OrientationModal hiringCase={hiringCase} existing={orientation} offer={offer} ticket={ticket} onClose={() => setDialog(null)} /> : null}
      {dialog === 'hire' ? <HireModal hiringCase={hiringCase} onClose={() => setDialog(null)} /> : null}
    </div>
  );
}

function GateBanner({ family, title, text, action }: { family: 'warning' | 'neutral'; title: string; text: string; action?: ReactNode }) {
  return (
    <div
      role="status"
      className={cn(
        'flex flex-wrap items-center gap-3 rounded-[10px] border px-4 py-3',
        family === 'warning' ? 'border-nw-warning-border bg-nw-warning-bg' : 'border-nw-border bg-nw-subtle',
      )}
      data-testid="safety-gate"
    >
      <span aria-hidden className={cn('flex size-10 shrink-0 items-center justify-center rounded-full bg-nw-panel', family === 'warning' ? 'text-nw-warning-icon' : 'text-muted')}>
        <ShieldCheck className="size-5" />
      </span>
      <div className="min-w-0 flex-1">
        <p className={cn('text-sm font-bold', family === 'warning' ? 'text-nw-warning-text' : 'text-ink')}>{title}</p>
        <p className={cn('text-sm', family === 'warning' ? 'text-nw-warning-text' : 'text-secondary')}>{text}</p>
      </div>
      {action}
    </div>
  );
}

function StepCard({
  n,
  icon,
  title,
  state,
  hint,
  action,
  children,
  last,
}: {
  n: number;
  icon: ReactNode;
  title: string;
  state: ReactNode;
  hint: string;
  action?: ReactNode;
  children?: ReactNode;
  last?: boolean;
}) {
  return (
    <li className="relative grid grid-cols-[2rem_minmax(0,1fr)] gap-3">
      {!last ? <span aria-hidden className="absolute top-9 bottom-[-0.75rem] left-4 w-px border-l border-dashed border-nw-border-strong" /> : null}
      <span className="relative z-10 mt-4 flex size-8 items-center justify-center rounded-full border border-nw-border bg-nw-panel text-sm font-bold text-secondary">{n}</span>
      <div className="min-w-0 rounded-[10px] border border-nw-border bg-nw-panel p-4">
        <div className="flex flex-wrap items-center gap-3">
          <span aria-hidden className="flex size-10 shrink-0 items-center justify-center rounded-full bg-nw-subtle text-secondary [&_svg]:size-5">
            {icon}
          </span>
          <div className="min-w-0 flex-1">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="text-md font-bold text-ink">{title}</h3>
              {state}
            </div>
            <p className="text-sm text-muted">{hint}</p>
          </div>
          {action ? <div className="flex flex-wrap items-center gap-2">{action}</div> : null}
        </div>
        {children ? <div className="mt-3 border-t border-nw-border pt-3">{children}</div> : null}
      </div>
    </li>
  );
}

function Facts({ items }: { items: [string, ReactNode][] }) {
  return (
    <dl className="grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2">
      {items.map(([k, v]) => (
        <div key={k} className="flex min-w-0 items-baseline justify-between gap-3 sm:justify-start">
          <dt className="w-36 shrink-0 text-muted">{k}</dt>
          <dd className="min-w-0 break-words text-ink">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

// ------------------------------------------------------------------------------------------ offer

function OfferModal({ hiringCase, onClose }: { hiringCase: HiringCase; onClose: () => void }) {
  const { toast } = useToast();
  const create = useHiringMutation((body: Parameters<typeof hiringApi.createOffer>[1]) => hiringApi.createOffer(hiringCase.id, body));
  const roster = useQuery({
    queryKey: ['roster', 'drivers', 'picker'],
    queryFn: () => apiGet<{ data: DriverRecord[] }>('/drivers', { pageSize: 10_000 }),
  });
  // No defaults for pay: the recruiter types what was agreed (compensation is never invented).
  const [form, setForm] = useState({
    driverType: '',
    payPlanKind: '',
    payPlanRate: '',
    signOnBonus: '',
    referralBonus: '',
    referringDriverId: '',
    orientationDate: '',
    expiresOn: '',
    notes: '',
  });
  const [tried, setTried] = useState(false);
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));
  const server = fieldErrors(create.error);
  const rate = Number(form.payPlanRate);
  const today = companyToday();
  const local: Record<string, string | null> = {
    driverType: form.driverType ? null : 'Choose the driver type agreed',
    payPlanKind: form.payPlanKind ? null : 'Choose how the driver is paid',
    'payPlan.rate': form.payPlanRate.trim() && Number.isFinite(rate) && rate > 0 ? null : 'Enter the agreed rate',
    orientationDate: form.orientationDate ? null : 'Choose the orientation date',
    expiresOn: form.expiresOn && form.expiresOn < today ? 'The expiry is in the past' : null,
    signOnBonus: form.signOnBonus && !(Number(form.signOnBonus) >= 0) ? 'Enter an amount of $0 or more' : null,
    referralBonus: form.referralBonus && !(Number(form.referralBonus) >= 0) ? 'Enter an amount of $0 or more' : null,
    referringDriverId: form.referralBonus && !form.referringDriverId ? 'A referral bonus needs the driver who referred them' : null,
  };
  const err = (k: string) => (tried ? local[k] : null) ?? server[k] ?? null;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Create driver offer"
      description="Records the offer as agreed. Nothing is sent to the candidate from here."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={create.isPending}
            onClick={() => {
              setTried(true);
              if (Object.values(local).some((v) => v !== null)) return;
              create.mutate(
                {
                  driverType: form.driverType as (typeof DRIVER_TYPES)[number],
                  payPlan: { kind: form.payPlanKind as (typeof PAY_PLAN_KINDS)[number], rate },
                  signOnBonus: form.signOnBonus ? Number(form.signOnBonus) : null,
                  referralBonus: form.referralBonus ? Number(form.referralBonus) : null,
                  referringDriverId: form.referringDriverId || null,
                  orientationDate: form.orientationDate,
                  expiresOn: form.expiresOn || null,
                  notes: form.notes || null,
                },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: 'Offer created as a draft' });
                    onClose();
                  },
                },
              );
            }}
          >
            Create offer
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2" data-testid="offer-form">
        {create.error && Object.keys(server).length === 0 ? (
          <div className="sm:col-span-2">
            <Alert tone="danger" title="Not created" description={create.error instanceof ApiError ? create.error.message : 'Failed.'} />
          </div>
        ) : null}
        <FormField label="Driver type" required error={err('driverType')}>
          <Select
            aria-label="Driver type"
            value={form.driverType}
            onValueChange={(v) => set('driverType', v)}
            options={[{ value: '', label: 'Choose…' }, ...DRIVER_TYPES.map((t) => ({ value: t, label: t.replace(/_/g, ' ') }))]}
          />
        </FormField>
        <FormField label="Pay plan" required error={err('payPlanKind')}>
          <Select
            aria-label="Pay plan"
            value={form.payPlanKind}
            onValueChange={(v) => set('payPlanKind', v)}
            options={[{ value: '', label: 'Choose…' }, ...PAY_PLAN_KINDS.map((k) => ({ value: k, label: k.replace(/_/g, ' ') }))]}
          />
        </FormField>
        <FormField label={form.payPlanKind === 'percent_of_linehaul' ? 'Percent of linehaul' : 'Rate per mile ($)'} required error={err('payPlan.rate')}>
          <Input type="number" step="0.01" min="0" value={form.payPlanRate} onChange={(e) => set('payPlanRate', e.target.value)} />
        </FormField>
        <FormField label="Orientation date" required error={err('orientationDate')}>
          <DatePicker aria-label="Orientation date" value={form.orientationDate} onIsoChange={(e) => set('orientationDate', e)} />
        </FormField>
        <FormField label="Sign-on bonus ($)" error={err('signOnBonus')} description="Blank if none was agreed.">
          <Input type="number" min="0" value={form.signOnBonus} onChange={(e) => set('signOnBonus', e.target.value)} />
        </FormField>
        <FormField label="Offer expires" error={err('expiresOn')}>
          <DatePicker aria-label="Offer expires" value={form.expiresOn} onIsoChange={(e) => set('expiresOn', e)} />
        </FormField>
        <FormField label="Referral bonus ($)" error={err('referralBonus')} description="Blank if none was agreed.">
          <Input type="number" min="0" value={form.referralBonus} onChange={(e) => set('referralBonus', e.target.value)} />
        </FormField>
        <FormField label="Referred by (driver)" error={err('referringDriverId')}>
          <Select
            aria-label="Referred by"
            value={form.referringDriverId}
            onValueChange={(v) => set('referringDriverId', v)}
            options={[
              { value: '', label: roster.isPending ? 'Loading…' : 'Nobody' },
              ...(roster.data?.data ?? []).map((d) => ({ value: d.id, label: `${d.driverNumber} · ${d.firstName} ${d.lastName}` })),
            ]}
          />
        </FormField>
        <div className="sm:col-span-2">
          <FormField label="Notes">
            <Textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}

// ----------------------------------------------------------------------------------------- travel

function TravelModal({ hiringCase, onClose }: { hiringCase: HiringCase; onClose: () => void }) {
  const { toast } = useToast();
  const book = useHiringMutation((body: Parameters<typeof hiringApi.bookTicket>[1]) => hiringApi.bookTicket(hiringCase.id, body));
  const [form, setForm] = useState({
    travelMode: '',
    carrier: '',
    bookingReference: '',
    departAt: '',
    arriveAt: '',
    travelCost: '',
    lodgingNights: '',
    lodgingCost: '',
    notes: '',
  });
  const [tried, setTried] = useState(false);
  const set = (k: string, v: string) => setForm((p) => ({ ...p, [k]: v }));
  const server = fieldErrors(book.error);
  const nights = form.lodgingNights === '' ? 0 : Number(form.lodgingNights);
  const local: Record<string, string | null> = {
    travelMode: form.travelMode ? null : 'Choose how they travel',
    departAt: form.departAt ? null : 'Enter the departure',
    arriveAt: form.arriveAt && form.departAt && form.arriveAt < form.departAt ? 'Arrival is before departure' : null,
    travelCost: form.travelCost && !(Number(form.travelCost) >= 0) ? 'Enter an amount of $0 or more' : null,
    lodgingNights: Number.isInteger(nights) && nights >= 0 ? null : 'A whole number of nights',
    lodgingCost: form.lodgingCost && !(Number(form.lodgingCost) >= 0) ? 'Enter an amount of $0 or more' : null,
  };
  const err = (k: string) => (tried ? local[k] : null) ?? server[k] ?? null;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title="Record travel to orientation"
      description="Records a booking made elsewhere. NeWay does not book or pay for travel. The travel and lodging costs you enter are added to the candidate's costs automatically, once."
      size="lg"
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={book.isPending}
            onClick={() => {
              setTried(true);
              if (Object.values(local).some((v) => v !== null)) return;
              book.mutate(
                {
                  travelMode: form.travelMode as (typeof TRAVEL_MODES)[number],
                  carrier: form.carrier || null,
                  bookingReference: form.bookingReference || null,
                  // Typed as US Eastern wall-clock time, never the browser's zone.
                  departAt: zonedToIso(form.departAt) as string,
                  arriveAt: form.arriveAt ? zonedToIso(form.arriveAt) : null,
                  travelCost: form.travelCost ? Number(form.travelCost) : null,
                  lodgingNights: nights,
                  lodgingCost: form.lodgingCost ? Number(form.lodgingCost) : null,
                  notes: form.notes || null,
                },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: 'Travel recorded — the case is now Ticketed' });
                    onClose();
                  },
                },
              );
            }}
          >
            Record travel
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2" data-testid="travel-form">
        {book.error && Object.keys(server).length === 0 ? (
          <div className="sm:col-span-2">
            <Alert tone="danger" title="Not recorded" description={book.error instanceof ApiError ? book.error.message : 'Failed.'} />
          </div>
        ) : null}
        <FormField label="Mode" required error={err('travelMode')}>
          <Select
            aria-label="Mode"
            value={form.travelMode}
            onValueChange={(v) => set('travelMode', v)}
            options={[{ value: '', label: 'Choose…' }, ...TRAVEL_MODES.map((m) => ({ value: m, label: TRAVEL_MODE_LABELS[m] }))]}
          />
        </FormField>
        <FormField label="Carrier">
          <Input value={form.carrier} onChange={(e) => set('carrier', e.target.value)} />
        </FormField>
        <FormField label="Booking reference">
          <Input value={form.bookingReference} onChange={(e) => set('bookingReference', e.target.value)} />
        </FormField>
        <FormField label="Travel cost ($)" error={err('travelCost')}>
          <Input prefix="$" type="number" min="0" step="0.01" value={form.travelCost} onChange={(e) => set('travelCost', e.target.value)} />
        </FormField>
        <FormField label={`Departs (${tzShort()})`} required error={err('departAt')}>
          <Input type="datetime-local" value={form.departAt} onChange={(e) => set('departAt', e.target.value)} />
        </FormField>
        <FormField label={`Arrives (${tzShort()})`} error={err('arriveAt')}>
          <Input type="datetime-local" value={form.arriveAt} onChange={(e) => set('arriveAt', e.target.value)} />
        </FormField>
        <FormField label="Lodging nights" error={err('lodgingNights')}>
          <Input type="number" min="0" value={form.lodgingNights} onChange={(e) => set('lodgingNights', e.target.value)} />
        </FormField>
        <FormField label="Lodging cost ($)" error={err('lodgingCost')}>
          <Input prefix="$" type="number" min="0" step="0.01" value={form.lodgingCost} onChange={(e) => set('lodgingCost', e.target.value)} />
        </FormField>
        <div className="sm:col-span-2">
          <FormField label="Notes">
            <Textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------ orientation

function OrientationModal({
  hiringCase,
  existing,
  offer,
  ticket,
  onClose,
}: {
  hiringCase: HiringCase;
  existing: Orientation | null;
  offer: OfferRecord | null;
  ticket: TravelTicket | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const record = useHiringMutation((body: Parameters<typeof hiringApi.recordOrientation>[1]) => hiringApi.recordOrientation(hiringCase.id, body));
  const [form, setForm] = useState({
    startDate: existing?.startDate ?? offer?.orientationDate ?? '',
    days: existing ? String(existing.days) : '',
    perDayPay: existing?.perDayPay === null || existing?.perDayPay === undefined ? '' : String(existing.perDayPay),
    attendance: existing?.attendance ?? 'scheduled',
    roadTestTaken: existing?.roadTest !== null && existing?.roadTest !== undefined,
    result: existing?.roadTest?.result ?? '',
    testedOn: existing?.roadTest?.testedOn ?? '',
    examinerName: existing?.roadTest?.examinerName ?? '',
    vehicleType: existing?.roadTest?.vehicleType ?? '',
    completedOn: existing?.completedOn ?? '',
    notes: existing?.notes ?? '',
  });
  const [tried, setTried] = useState(false);
  const set = (k: string, v: string | boolean) => setForm((p) => ({ ...p, [k]: v }));
  const server = fieldErrors(record.error);
  const days = Number(form.days);
  const local: Record<string, string | null> = {
    startDate: form.startDate ? null : 'Choose the start date',
    days: Number.isInteger(days) && days >= 1 ? null : 'At least 1 day',
    perDayPay: form.perDayPay && !(Number(form.perDayPay) >= 0) ? 'Enter an amount of $0 or more' : null,
    result: form.roadTestTaken && !form.result ? 'Choose passed or failed' : null,
    testedOn: form.roadTestTaken && !form.testedOn ? 'Choose the test date' : null,
    examinerName: form.roadTestTaken && !form.examinerName.trim() ? 'Who examined the driver' : null,
    vehicleType: form.roadTestTaken && !form.vehicleType.trim() ? 'The vehicle used for the test' : null,
    completedOn: form.completedOn && form.startDate && form.completedOn < form.startDate ? 'Completion is before the start' : null,
  };
  const err = (k: string) => (tried ? local[k] : null) ?? server[k] ?? null;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={existing ? 'Update orientation' : 'Record orientation'}
      size="lg"
      description="Attended moves the case to Orientation; a no-show ends it. A passed road test files the 391.31 certificate in the qualification file, once. Per-day pay is added to the candidate's costs when attended."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={record.isPending}
            onClick={() => {
              setTried(true);
              if (Object.values(local).some((v) => v !== null)) return;
              record.mutate(
                {
                  startDate: form.startDate,
                  days,
                  perDayPay: form.perDayPay ? Number(form.perDayPay) : null,
                  attendance: form.attendance as Orientation['attendance'],
                  roadTest: form.roadTestTaken
                    ? {
                        result: form.result as 'pass' | 'fail',
                        testedOn: form.testedOn,
                        examinerName: form.examinerName.trim(),
                        vehicleType: form.vehicleType.trim(),
                        notes: null,
                      }
                    : null,
                  completedOn: form.completedOn || null,
                  notes: form.notes || null,
                },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: 'Orientation recorded' });
                    onClose();
                  },
                },
              );
            }}
          >
            Save
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2" data-testid="orientation-form">
        {record.error && Object.keys(server).length === 0 ? (
          <div className="sm:col-span-2">
            <Alert tone="danger" title="Not recorded" description={record.error instanceof ApiError ? record.error.message : 'Failed.'} />
          </div>
        ) : null}
        {ticket ? (
          <p className="text-xs text-muted sm:col-span-2">
            Travel: {TRAVEL_MODE_LABELS[ticket.travelMode]}, arriving {ticket.arriveAt ? formatDateTime(ticket.arriveAt) : 'time not recorded'}.
          </p>
        ) : null}
        <FormField label="Start date" required error={err('startDate')}>
          <DatePicker aria-label="Start date" value={form.startDate} onIsoChange={(e) => set('startDate', e)} />
        </FormField>
        <FormField label="Days" required error={err('days')}>
          <Input type="number" min="1" value={form.days} onChange={(e) => set('days', e.target.value)} />
        </FormField>
        <FormField label="Per-day pay ($)" error={err('perDayPay')} description="As agreed; blank if unpaid or not known.">
          <Input prefix="$" type="number" min="0" step="0.01" value={form.perDayPay} onChange={(e) => set('perDayPay', e.target.value)} />
        </FormField>
        <FormField label="Attendance" required error={err('attendance')}>
          <Select
            aria-label="Attendance"
            value={form.attendance}
            onValueChange={(v) => set('attendance', v)}
            options={[
              { value: 'scheduled', label: 'Scheduled' },
              { value: 'attended', label: 'Attended' },
              { value: 'no_show', label: 'No-show (ends the case)' },
            ]}
          />
        </FormField>
        <div className="sm:col-span-2">
          <Checkbox label="Road test taken" checked={form.roadTestTaken} onCheckedChange={(v) => set('roadTestTaken', v === true)} />
        </div>
        {form.roadTestTaken ? (
          <>
            <FormField label="Result" required error={err('result')}>
              <Select
                aria-label="Road test result"
                value={form.result}
                onValueChange={(v) => set('result', v)}
                options={[
                  { value: '', label: 'Choose…' },
                  { value: 'pass', label: 'Passed' },
                  { value: 'fail', label: 'Failed' },
                ]}
              />
            </FormField>
            <FormField label="Tested on" required error={err('testedOn')}>
              <DatePicker aria-label="Tested on" value={form.testedOn} onIsoChange={(e) => set('testedOn', e)} />
            </FormField>
            <FormField label="Examiner" required error={err('examinerName')}>
              <Input value={form.examinerName} onChange={(e) => set('examinerName', e.target.value)} />
            </FormField>
            <FormField label="Vehicle used" required error={err('vehicleType')} description="e.g. Tractor-semitrailer">
              <Input value={form.vehicleType} onChange={(e) => set('vehicleType', e.target.value)} />
            </FormField>
          </>
        ) : null}
        <FormField label="Completed on" error={err('completedOn')}>
          <DatePicker aria-label="Completed on" value={form.completedOn} onIsoChange={(e) => set('completedOn', e)} />
        </FormField>
        <div className="sm:col-span-2">
          <FormField label="Notes">
            <Textarea rows={2} value={form.notes} onChange={(e) => set('notes', e.target.value)} />
          </FormField>
        </div>
      </div>
    </Modal>
  );
}

// ------------------------------------------------------------------------------------------- hire

function HireModal({ hiringCase, onClose }: { hiringCase: HiringCase; onClose: () => void }) {
  const { toast } = useToast();
  const navigate = useNavigate();
  const directory = useEmployeeDirectory();
  const hire = useHiringMutation((body: Parameters<typeof hiringApi.hire>[1]) => hiringApi.hire(hiringCase.id, body));
  const [form, setForm] = useState({
    hireDate: companyToday(),
    dispatcherId: '',
    managerEmployeeId: '',
    preferredLanguage: 'en',
    startOnboarding: true,
  });
  const [tried, setTried] = useState(false);
  const set = (k: string, v: string | boolean) => setForm((p) => ({ ...p, [k]: v }));
  const server = fieldErrors(hire.error);
  const local: Record<string, string | null> = {
    hireDate: form.hireDate ? null : 'Choose the hire date',
    dispatcherId: form.dispatcherId ? null : 'Choose the dispatcher',
  };
  const err = (k: string) => (tried ? local[k] : null) ?? server[k] ?? null;
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      title={`Confirm hire · ${hiringCase.candidateName}`}
      description="Creates their employee record and driver profile, both linked to this case. The qualification file keeps the id it has had since the application. The offer's bonuses become costs on hire."
      footer={
        <>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={hire.isPending}
            onClick={() => {
              setTried(true);
              if (Object.values(local).some((v) => v !== null)) return;
              hire.mutate(
                {
                  hireDate: form.hireDate,
                  dispatcherId: form.dispatcherId,
                  managerEmployeeId: form.managerEmployeeId || null,
                  preferredLanguage: form.preferredLanguage as (typeof DRIVER_LANGUAGES)[number],
                  startOnboarding: form.startOnboarding,
                },
                {
                  onSuccess: (result) => {
                    toast({
                      tone: 'success',
                      title: `${hiringCase.candidateName} is now ${result.employeeNumber} · ${result.driverNumber}`,
                      description: result.onboardingChecklistId ? 'Their onboarding plan has been created.' : undefined,
                    });
                    onClose();
                    void navigate({ to: '/hr/employees/$employeeId', params: { employeeId: result.employeeId } });
                  },
                },
              );
            }}
          >
            Confirm hire
          </Button>
        </>
      }
    >
      <div className="grid gap-3 sm:grid-cols-2">
        {hire.error && Object.keys(server).length === 0 ? (
          <div className="sm:col-span-2">
            <Alert tone="danger" title="Not hired" description={hire.error instanceof ApiError ? hire.error.message : 'Failed.'} />
          </div>
        ) : null}
        <FormField label="Hire date" required error={err('hireDate')}>
          <DatePicker aria-label="Hire date" value={form.hireDate} onIsoChange={(e) => set('hireDate', e)} />
        </FormField>
        <FormField label="Dispatcher" required error={err('dispatcherId')}>
          <DispatcherSelect value={form.dispatcherId || null} onValueChange={(v) => set('dispatcherId', v ?? '')} />
        </FormField>
        <FormField label="Manager">
          <Select
            aria-label="Manager"
            value={form.managerEmployeeId}
            onValueChange={(v) => set('managerEmployeeId', v)}
            options={[{ value: '', label: 'No manager' }, ...(directory.data ?? []).map((e) => ({ value: e.id, label: e.name }))]}
          />
        </FormField>
        <FormField label="Preferred language">
          <Select
            aria-label="Preferred language"
            value={form.preferredLanguage}
            onValueChange={(v) => set('preferredLanguage', v)}
            options={DRIVER_LANGUAGES.map((l) => ({ value: l, label: l }))}
          />
        </FormField>
        <div className="sm:col-span-2">
          <Checkbox label="Create their onboarding plan now" checked={form.startOnboarding} onCheckedChange={(v) => set('startOnboarding', v === true)} />
        </div>
      </div>
    </Modal>
  );
}
