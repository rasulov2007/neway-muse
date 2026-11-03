import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  ChevronRight,
  CircleCheck,
  Copy,
  FileText,
  Lock,
  Mail,
  MoreVertical,
  Phone,
  UserPlus,
} from 'lucide-react';
import { useState } from 'react';
import {
  HIRING_DOCUMENTS,
  HIRING_END_REASON_LABELS,
  JOURNEY_LABELS,
  JOURNEY_NEXT_ACTION,
  JOURNEY_STEPS,
  JOURNEY_STUCK_AFTER_DAYS,
  JOURNEY_WAITING_ON,
  LEAD_SOURCE_LABELS,
  hiringDocumentState,
  isJourneyExit,
  journeyPlaceOfCase,
  journeySteps,
  lastLiveStep,
  type ApplicantRecord,
  type HiringCase,
  type JourneyPlace,
  type JourneyStep,
} from '@neway/shared';
import {
  Avatar,
  Badge,
  Button,
  Card,
  DropdownMenu,
  IconButton,
  MenuItem,
  StatusSymbol,
  Tabs,
  TabsContent,
  cn,
  useToast,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { formatDateTime, formatIsoDate, formatMoney } from '@/lib/format';
import { CandidateDocuments, DropCaseDialog, canDropCase } from './CandidateHiringParts';
import { CostsPanel } from './CostsPanel';
import { DotApplicationWizard } from './DotApplicationWizard';
import { DriverFunnelPanel } from './DriverFunnelPanel';
import { AssignRecruiterDialog, FollowUpDialog } from './RecruitingParts';
import {
  useCaseActivity,
  useCaseCosts,
  useCaseDocuments,
  useDotApplication,
  useLeads,
} from './useHiring';

/**
 * A driver candidate's profile (owner's design, 2026-09-30): progress on the left, what to do next
 * in the middle, contact and recruiter on the right. Every stage, count and date is read from the
 * hiring case, the DOT application, the driver file and the audit trail — never set to match a
 * picture. Offer, travel, orientation, hire, costs and history keep their existing panels.
 */

const TABS = ['overview', 'application', 'documents', 'onboarding', 'costs', 'activity'] as const;
type Tab = (typeof TABS)[number];

const DRIVER_TYPE_LABELS: Record<string, string> = {
  company: 'Company driver',
  owner_operator: 'Owner-operator',
  lease_operator: 'Lease operator',
};

const PLACE_FAMILY: Record<JourneyPlace, 'moving' | 'done' | 'urgent' | 'neutral' | 'warning'> = {
  lead: 'neutral',
  contacted: 'moving',
  application: 'moving',
  documents: 'moving',
  safety_review: 'warning',
  offer_travel: 'moving',
  orientation: 'moving',
  hired: 'done',
  first_load: 'done',
  disqualified: 'urgent',
  dropped: 'neutral',
};
const PLACE_TONE: Record<JourneyPlace, 'info' | 'success' | 'danger' | 'neutral' | 'warning'> = {
  lead: 'neutral',
  contacted: 'info',
  application: 'info',
  documents: 'info',
  safety_review: 'warning',
  offer_travel: 'info',
  orientation: 'info',
  hired: 'success',
  first_load: 'success',
  disqualified: 'danger',
  dropped: 'neutral',
};

export function DriverCandidateProfile({
  candidate,
  hiringCase,
}: {
  candidate: ApplicantRecord;
  hiringCase: HiringCase;
}) {
  const account = useAccount();
  const canManage = account?.permissions.includes('recruiting.manage') ?? false;
  const { toast } = useToast();
  // The open tab lives in the URL, so a refresh or the back button returns to it.
  const navigate = useNavigate();
  const raw = useSearch({ strict: false }) as { tab?: string };
  const tab: Tab = (TABS as readonly string[]).includes(raw.tab ?? '') ? (raw.tab as Tab) : 'overview';
  const setTab = (next: Tab) =>
    void navigate({ to: '.', search: { tab: next === 'overview' ? undefined : next } as never, replace: true });
  const [dialog, setDialog] = useState<'follow' | 'recruiter' | 'drop' | null>(null);
  const leads = useLeads({ page: 1, pageSize: 10_000 });
  const lead = leads.data?.data.find((l) => l.hiringCaseId === hiringCase.id) ?? null;
  const place = journeyPlaceOfCase(hiringCase.state);
  const phone = candidate.phone || lead?.phone || null;
  const email =
    candidate.email && !candidate.email.endsWith('.lead') ? candidate.email : (lead?.email ?? null);

  const copy = (value: string) =>
    void navigator.clipboard?.writeText(value).then(
      () => toast({ tone: 'success', title: 'Copied' }),
      () => toast({ tone: 'warning', title: 'Copy is not available here' }),
    );

  return (
    <div className="page-surface-workspace flex flex-col gap-4" data-testid="driver-profile">
      <nav aria-label="Breadcrumb" className="flex items-center gap-1.5 text-xs text-muted">
        <Link to="/hr/recruiting" className="hover:text-ink hover:underline">
          Recruiting
        </Link>
        <ChevronRight aria-hidden className="size-3" />
        <span className="text-ink">{candidate.name}</span>
      </nav>

      <header className="flex flex-wrap items-center gap-4">
        <Avatar name={candidate.name} size="lg" />
        <div className="min-w-0 flex-1">
          <h1 className="flex flex-wrap items-center gap-2 text-2xl font-bold text-ink">
            {candidate.name}
            <Badge tone={PLACE_TONE[place]} size="sm">
              <StatusSymbol family={PLACE_FAMILY[place]} size={11} />
              {JOURNEY_LABELS[place]}
            </Badge>
          </h1>
          <p className="text-sm text-muted">
            {[
              candidate.applicantNumber,
              candidate.driverType
                ? (DRIVER_TYPE_LABELS[candidate.driverType] ?? candidate.driverType)
                : 'Driver',
              candidate.location ?? lead?.state,
            ]
              .filter(Boolean)
              .join(' · ')}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <DropdownMenu
            trigger={
              <Button variant="outline" icon={<Mail />}>
                Contact
              </Button>
            }
          >
            {phone ? (
              <MenuItem
                onSelect={() => {
                  window.location.href = `tel:${phone.replace(/[^\d+]/g, '')}`;
                }}
              >
                <Phone aria-hidden className="size-4" /> Call {phone}
              </MenuItem>
            ) : null}
            {email ? (
              <MenuItem
                onSelect={() => {
                  window.location.href = `mailto:${email}`;
                }}
              >
                <Mail aria-hidden className="size-4" /> Email {email}
              </MenuItem>
            ) : null}
            {phone ? (
              <MenuItem onSelect={() => copy(phone)}>
                <Copy aria-hidden className="size-4" /> Copy phone number
              </MenuItem>
            ) : null}
            {canManage ? (
              <MenuItem onSelect={() => setDialog('follow')}>Record a follow-up…</MenuItem>
            ) : null}
          </DropdownMenu>
          <DropdownMenu
            trigger={
              <IconButton label="More actions" variant="outline">
                <MoreVertical />
              </IconButton>
            }
          >
            {canManage ? (
              <MenuItem onSelect={() => setDialog('recruiter')}>
                {hiringCase.recruiterName ? 'Change recruiter' : 'Assign recruiter'}
              </MenuItem>
            ) : null}
            {canManage ? (
              <MenuItem onSelect={() => setDialog('follow')}>Record a follow-up</MenuItem>
            ) : null}
            <MenuItem onSelect={() => setTab('activity')}>View activity</MenuItem>
            {canManage && canDropCase(hiringCase) ? (
              <MenuItem onSelect={() => setDialog('drop')}>
                <span className="text-danger-text">Drop from hiring…</span>
              </MenuItem>
            ) : null}
          </DropdownMenu>
        </div>
      </header>

      <Tabs
        items={[
          { value: 'overview', label: 'Overview' },
          { value: 'application', label: 'DOT application' },
          { value: 'documents', label: 'Documents' },
          { value: 'onboarding', label: 'Offer & onboarding' },
          { value: 'costs', label: 'Costs' },
          { value: 'activity', label: 'Activity' },
        ]}
        value={tab}
        onValueChange={(v) => setTab(v as Tab)}
        aria-label="Candidate"
      >
        <TabsContent value="overview" className="pt-4">
          <Overview
            candidate={candidate}
            hiringCase={hiringCase}
            lead={lead}
            phone={phone}
            email={email}
            canManage={canManage}
            onTab={setTab}
            onAssign={() => setDialog('recruiter')}
          />
        </TabsContent>
        {/* Kept mounted so what was typed survives a visit to another tab. */}
        <TabsContent value="application" className="pt-4 data-[state=inactive]:hidden" forceMount>
          <DotApplicationWizard hiringCase={hiringCase} candidate={candidate} canEdit={canManage} />
        </TabsContent>
        <TabsContent value="documents" className="pt-4">
          <CandidateDocuments hiringCase={hiringCase} canEdit={canManage} />
        </TabsContent>
        <TabsContent value="onboarding" className="pt-4">
          <DriverFunnelPanel hiringCase={hiringCase} onTab={setTab} />
        </TabsContent>
        <TabsContent value="costs" className="pt-4">
          <CostsPanel hiringCase={hiringCase} />
        </TabsContent>
        <TabsContent value="activity" className="pt-4">
          <ActivityFeed caseId={hiringCase.id} />
        </TabsContent>
      </Tabs>

      {dialog === 'follow' ? (
        <FollowUpDialog
          target={{ kind: 'case', id: hiringCase.id, name: candidate.name, phone, email }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'recruiter' ? (
        <AssignRecruiterDialog
          target={{
            kind: 'case',
            id: hiringCase.id,
            name: candidate.name,
            currentId: hiringCase.recruiterId,
          }}
          onClose={() => setDialog(null)}
        />
      ) : null}
      {dialog === 'drop' ? (
        <DropCaseDialog hiringCase={hiringCase} onClose={() => setDialog(null)} />
      ) : null}
    </div>
  );
}

// ---------------------------------------------------------------------------------- overview

function Overview({
  candidate,
  hiringCase,
  lead,
  phone,
  email,
  canManage,
  onTab,
  onAssign,
}: {
  candidate: ApplicantRecord;
  hiringCase: HiringCase;
  lead: {
    cdlClass: string | null;
    yearsExperience: number | null;
    source: string;
    state: string | null;
  } | null;
  phone: string | null;
  email: string | null;
  canManage: boolean;
  onTab: (tab: Tab) => void;
  onAssign: () => void;
}) {
  const place = journeyPlaceOfCase(hiringCase.state);
  const steps = journeySteps(place, isJourneyExit(place) ? lastLiveStep(hiringCase) : null);
  const atIndex = steps.findIndex((s) => s.state === 'current' || s.state === 'stopped');
  const stepEvents = new Map<JourneyStep, string>();
  for (const e of hiringCase.events) {
    const p = journeyPlaceOfCase(e.toState);
    if (!isJourneyExit(p) && !stepEvents.has(p)) stepEvents.set(p, e.at);
  }
  const upcoming = steps.filter((s) => s.state === 'todo').slice(0, 3);

  return (
    <div className="grid gap-4 lg:grid-cols-[16.5rem_minmax(0,1fr)] xl:grid-cols-[16.5rem_minmax(0,1fr)_19rem]">
      <Card padding="none" className="h-fit p-4" data-testid="hiring-progress">
        <div className="mb-3 flex items-baseline justify-between">
          <h2 className="text-md font-bold text-ink">Hiring progress</h2>
          <span className="text-xs text-muted">
            {atIndex >= 0 ? `Step ${atIndex + 1} of ${JOURNEY_STEPS.length}` : ''}
          </span>
        </div>
        <ol className="flex flex-col">
          {steps.map((s, i) => (
            <li
              key={s.step}
              className="relative flex gap-3 pb-4 last:pb-0"
              aria-current={s.state === 'current' ? 'step' : undefined}
            >
              {i < steps.length - 1 ? (
                <span
                  aria-hidden
                  className={cn(
                    'absolute top-7 left-[13px] h-[calc(100%-1.5rem)] w-px',
                    s.state === 'done' ? 'bg-success' : 'bg-line-strong',
                  )}
                />
              ) : null}
              <span
                className={cn(
                  'relative z-10 flex size-7 shrink-0 items-center justify-center rounded-full text-xs font-bold',
                  s.state === 'done' && 'bg-success text-inverse',
                  s.state === 'current' && 'bg-surface text-primary-text ring-2 ring-primary',
                  s.state === 'stopped' && 'bg-surface ring-2 ring-danger',
                  s.state === 'todo' && 'bg-neutral-soft text-faint',
                )}
              >
                {s.state === 'done' ? (
                  <CircleCheck className="size-4" />
                ) : s.state === 'stopped' ? (
                  <StatusSymbol family="urgent" size={13} className="text-nw-urgent-icon" />
                ) : (
                  i + 1
                )}
              </span>
              <span
                className={cn(
                  'min-w-0 rounded-md px-1.5 py-0.5',
                  s.state === 'current' && 'bg-primary-soft',
                )}
              >
                <span
                  className={cn(
                    'block text-sm font-semibold',
                    s.state === 'todo' ? 'text-faint' : 'text-ink',
                  )}
                >
                  {s.label}
                </span>
                <span className="block text-2xs text-muted">
                  {s.state === 'done'
                    ? stepEvents.has(s.step)
                      ? `Done · ${formatIsoDate(stepEvents.get(s.step)!.slice(0, 10))}`
                      : 'Done'
                    : s.state === 'current'
                      ? `In progress · ${hiringCase.daysInState} day${hiringCase.daysInState === 1 ? '' : 's'}`
                      : s.state === 'stopped'
                        ? `${JOURNEY_LABELS[place]} here`
                        : 'Not started'}
                </span>
              </span>
            </li>
          ))}
        </ol>
      </Card>

      <div className="flex min-w-0 flex-col gap-4">
        <NextAction hiringCase={hiringCase} canManage={canManage} onTab={onTab} />

        <Card padding="none" className="p-4">
          <h2 className="mb-3 text-md font-bold text-ink">Candidate details</h2>
          <dl className="grid gap-x-8 gap-y-2 text-sm sm:grid-cols-2">
            <Fact label="Position" value={candidate.position} />
            <Fact label="CDL class" value={lead?.cdlClass ?? '—'} />
            <Fact
              label="Driver type"
              value={
                candidate.driverType
                  ? (DRIVER_TYPE_LABELS[candidate.driverType] ?? candidate.driverType)
                  : 'Not recorded'
              }
            />
            <Fact
              label="Experience"
              value={
                lead?.yearsExperience != null
                  ? `${lead.yearsExperience} year${lead.yearsExperience === 1 ? '' : 's'} · self-reported`
                  : '—'
              }
            />
            <Fact
              label="Applied"
              value={formatIsoDate(candidate.appliedOn ?? hiringCase.openedAt.slice(0, 10))}
            />
            <Fact
              label="Source"
              value={
                candidate.source
                  ? (LEAD_SOURCE_LABELS[candidate.source] ?? candidate.source)
                  : lead
                    ? (LEAD_SOURCE_LABELS[lead.source] ?? lead.source)
                    : '—'
              }
            />
          </dl>
        </Card>

        <DocumentsSummary hiringCase={hiringCase} onTab={onTab} />
        <RecentActivity caseId={hiringCase.id} onTab={onTab} />
      </div>

      <div className="flex min-w-0 flex-col gap-4 lg:col-span-2 xl:col-span-1">
        <Card padding="none" className="p-4" data-testid="contact-card">
          <h2 className="mb-3 text-md font-bold text-ink">Contact & recruiter</h2>
          <dl className="flex flex-col gap-2 text-sm">
            <div className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-muted">Email</dt>
              <dd className="min-w-0 break-all text-right">
                {email ? (
                  <a className="text-primary-text hover:underline" href={`mailto:${email}`}>
                    {email}
                  </a>
                ) : (
                  <span className="text-faint">Not on file</span>
                )}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-muted">Phone</dt>
              <dd className="min-w-0 break-all text-right">
                {phone ? (
                  <a
                    className="text-ink hover:underline"
                    href={`tel:${phone.replace(/[^\d+]/g, '')}`}
                  >
                    {phone}
                  </a>
                ) : (
                  <span className="text-faint">Not on file</span>
                )}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="shrink-0 text-muted">Location</dt>
              <dd className="text-right text-ink">{candidate.location ?? lead?.state ?? '—'}</dd>
            </div>
            <div className="mt-2 flex items-baseline justify-between gap-3 border-t border-line pt-3">
              <dt className="shrink-0 text-muted">Recruiter</dt>
              <dd className="text-right text-ink">{hiringCase.recruiterName ?? 'Unassigned'}</dd>
            </div>
          </dl>
          {canManage ? (
            <Button
              variant="outline"
              size="sm"
              icon={<UserPlus />}
              className="mt-3"
              onClick={onAssign}
            >
              {hiringCase.recruiterName ? 'Change recruiter' : 'Assign recruiter'}
            </Button>
          ) : null}
        </Card>

        <Card padding="none" className="p-4">
          <h2 className="text-md font-bold text-ink">Upcoming steps</h2>
          <p className="mb-3 text-xs text-muted">Open as the earlier steps finish.</p>
          {isJourneyExit(place) ? (
            <p className="text-sm text-muted">The case has ended; no steps follow.</p>
          ) : upcoming.length === 0 ? (
            <p className="text-sm text-muted">Nothing left after this step.</p>
          ) : (
            <ul className="flex flex-col gap-2">
              {upcoming.map((s) => (
                <li
                  key={s.step}
                  className="flex items-center gap-2 rounded-lg border border-line px-3 py-2 text-sm text-secondary"
                >
                  <Lock aria-hidden className="size-3.5 text-faint" />
                  {s.label}
                </li>
              ))}
            </ul>
          )}
        </Card>

        <CostSummaryCard caseId={hiringCase.id} onTab={onTab} />
      </div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex items-baseline justify-between gap-3 sm:justify-start">
      <dt className="w-24 shrink-0 text-muted">{label}</dt>
      <dd className="min-w-0 text-ink">{value}</dd>
    </div>
  );
}

/** The one thing to do now, from the real stage and, for the application, its real state. */
function NextAction({
  hiringCase,
  canManage,
  onTab,
}: {
  hiringCase: HiringCase;
  canManage: boolean;
  onTab: (tab: Tab) => void;
}) {
  const place = journeyPlaceOfCase(hiringCase.state);
  const application = useDotApplication(hiringCase.id);
  if (isJourneyExit(place)) {
    return (
      <Card padding="none" data-testid="next-action">
        <div className="flex items-center gap-3 p-4">
          <StatusSymbol family={place === 'disqualified' ? 'urgent' : 'neutral'} size={18} />
          <div>
            <p className="font-semibold text-ink">{JOURNEY_LABELS[place]}</p>
            <p className="text-sm text-muted">
              {hiringCase.endReason
                ? HIRING_END_REASON_LABELS[hiringCase.endReason]
                : 'No reason recorded'}
              {hiringCase.endNote ? ` — ${hiringCase.endNote}` : ''}
              {hiringCase.closedAt ? ` · ${formatIsoDate(hiringCase.closedAt.slice(0, 10))}` : ''}
            </p>
          </div>
        </div>
      </Card>
    );
  }
  const step = place as JourneyStep;
  const limit = JOURNEY_STUCK_AFTER_DAYS[step];
  const late = limit !== null ? Math.max(0, hiringCase.daysInState - limit) : 0;
  let title = JOURNEY_NEXT_ACTION[step];
  let detail = `Waiting on: ${JOURNEY_WAITING_ON[step]}`;
  let action: { label: string; tab: Tab } | null = null;
  if (step === 'application') {
    const started = application.data !== null && application.data !== undefined;
    title = started ? 'Complete the DOT application' : 'Start the DOT application';
    detail = started
      ? 'The draft is saved; finish the remaining sections, then review and submit.'
      : 'Record the applicant’s answers, then review and submit.';
    action = { label: started ? 'Continue application' : 'Start application', tab: 'application' };
  } else if (step === 'documents') {
    action = { label: 'Upload documents', tab: 'documents' };
  } else if (step === 'safety_review') {
    detail =
      'Safety approves or disqualifies in the qualification file. The offer opens only after approval.';
    action = { label: 'See documents', tab: 'documents' };
  } else if (step === 'offer_travel' || step === 'orientation') {
    action = {
      label: step === 'orientation' ? 'Record orientation' : 'Open offer & travel',
      tab: 'onboarding',
    };
  } else if (step === 'hired') {
    detail = 'Becomes an active driver at the first dispatch from the boards.';
  }
  return (
    <Card
      padding="none"
      className="border-primary-border bg-primary-soft"
      data-testid="next-action"
    >
      <div className="flex flex-wrap items-center gap-4 p-4">
        <span
          className="flex size-11 shrink-0 items-center justify-center rounded-full bg-surface text-primary-text"
          aria-hidden
        >
          <FileText className="size-5" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="font-semibold text-ink">{title}</p>
          <p className="text-sm text-secondary">{detail}</p>
          {late > 0 ? (
            <p className="mt-1 inline-flex items-center gap-1 text-xs font-semibold text-nw-warning-text">
              <StatusSymbol family="warning" size={11} className="text-nw-warning-icon" /> {late}{' '}
              day{late === 1 ? '' : 's'} overdue on this step
            </p>
          ) : null}
        </div>
        {action ? (
          <Button
            variant="primary"
            onClick={() => onTab(action.tab)}
            disabled={!canManage && action.tab === 'application'}
            title={
              !canManage && action.tab === 'application'
                ? 'Editing the application takes recruiting.manage'
                : undefined
            }
          >
            {action.label} <ChevronRight aria-hidden className="size-4" />
          </Button>
        ) : null}
      </div>
    </Card>
  );
}

function DocumentsSummary({
  hiringCase,
  onTab,
}: {
  hiringCase: HiringCase;
  onTab: (tab: Tab) => void;
}) {
  const docs = useCaseDocuments(hiringCase.id);
  const before = HIRING_DOCUMENTS.filter((d) => d.timing === 'before_hire');
  return (
    <Card padding="none" className="p-4" data-testid="documents-summary">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-md font-bold text-ink">Documents</h2>
        {docs.data?.driverId ? (
          <button
            type="button"
            className="text-sm font-semibold text-primary-text hover:underline"
            onClick={() => onTab('documents')}
          >
            Open documents
          </button>
        ) : null}
      </div>
      {docs.isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : docs.error ? (
        <p className="text-sm text-danger-text">The documents could not be loaded.</p>
      ) : !docs.data.driverId ? (
        <div className="flex flex-wrap items-center gap-3 rounded-lg border border-line bg-surface-muted px-4 py-3">
          <FileText aria-hidden className="size-5 text-muted" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink">Available after application submission</p>
            <p className="text-xs text-muted">
              Submitting the DOT application opens the driver file the documents go into.
            </p>
          </div>
          <button
            type="button"
            className="inline-flex items-center gap-1 text-sm font-semibold text-primary-text hover:underline"
            onClick={() => onTab('application')}
          >
            Continue application <ChevronRight aria-hidden className="size-4" />
          </button>
        </div>
      ) : (
        <div>
          <p className="mb-2 text-sm text-ink">
            <span className="font-bold">
              {
                before.filter(
                  (d) => hiringDocumentState(docs.data.documents, d.code) === 'approved',
                ).length
              }{' '}
              of {before.length}
            </span>{' '}
            needed before hire are approved by Safety.
          </p>
          <ul className="grid gap-1.5 sm:grid-cols-2">
            {before.map((d) => {
              const state = hiringDocumentState(docs.data.documents, d.code);
              return (
                <li key={d.code} className="flex items-center gap-2 text-xs">
                  <StatusSymbol
                    family={
                      state === 'approved'
                        ? 'done'
                        : state === 'rejected'
                          ? 'urgent'
                          : state === 'waiting_for_safety'
                            ? 'moving'
                            : 'neutral'
                    }
                    size={11}
                    className={
                      state === 'approved'
                        ? 'text-nw-done-icon'
                        : state === 'rejected'
                          ? 'text-nw-urgent-icon'
                          : state === 'waiting_for_safety'
                            ? 'text-nw-moving-icon'
                            : 'text-nw-neutral-icon'
                    }
                  />
                  <span className="truncate text-secondary">{d.label}</span>
                  <span className="ml-auto shrink-0 text-muted">
                    {state === 'approved'
                      ? 'Approved'
                      : state === 'rejected'
                        ? 'Rejected'
                        : state === 'waiting_for_safety'
                          ? 'Waiting'
                          : state === 'expired'
                            ? 'Expired'
                            : 'Missing'}
                  </span>
                </li>
              );
            })}
          </ul>
        </div>
      )}
    </Card>
  );
}

function RecentActivity({ caseId, onTab }: { caseId: string; onTab: (tab: Tab) => void }) {
  const activity = useCaseActivity(caseId);
  return (
    <Card padding="none" className="p-4">
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-md font-bold text-ink">Recent activity</h2>
        <button
          type="button"
          className="text-sm font-semibold text-primary-text hover:underline"
          onClick={() => onTab('activity')}
        >
          View all
        </button>
      </div>
      {activity.isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : (
        <ActivityList entries={(activity.data ?? []).slice(0, 4)} />
      )}
    </Card>
  );
}

export function ActivityFeed({ caseId }: { caseId: string }) {
  const activity = useCaseActivity(caseId);
  return (
    <Card padding="none" className="p-4" data-testid="activity-feed">
      <h2 className="mb-3 text-md font-bold text-ink">Activity</h2>
      {activity.isPending ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : activity.error ? (
        <p className="text-sm text-danger-text">The activity could not be loaded.</p>
      ) : (
        <ActivityList entries={activity.data} />
      )}
    </Card>
  );
}

function ActivityList({
  entries,
}: {
  entries: {
    id: string;
    at: string;
    kind: string;
    title: string;
    detail: string | null;
    byName: string;
  }[];
}) {
  if (entries.length === 0) return <p className="text-sm text-muted">Nothing recorded yet.</p>;
  return (
    <ol className="flex flex-col">
      {entries.map((e, i) => (
        <li key={e.id} className="relative flex gap-3 pb-3 last:pb-0">
          {i < entries.length - 1 ? (
            <span aria-hidden className="absolute top-3 left-[5px] h-full w-px bg-line" />
          ) : null}
          <span
            aria-hidden
            className={cn(
              'relative z-10 mt-1.5 size-2.5 shrink-0 rounded-full',
              e.kind === 'stage'
                ? 'bg-primary'
                : e.kind === 'follow_up'
                  ? 'bg-nw-warning-icon'
                  : 'bg-line-strong',
            )}
          />
          <span className="grid min-w-0 flex-1 gap-0.5 sm:grid-cols-[10rem_minmax(0,1fr)] sm:gap-3">
            <span className="text-xs text-muted">{formatDateTime(e.at)}</span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold text-ink first-letter:uppercase">
                {e.title}
              </span>
              <span className="block text-xs text-muted">
                {e.byName}
                {e.detail ? ` · ${e.detail}` : ''}
              </span>
            </span>
          </span>
        </li>
      ))}
    </ol>
  );
}

function CostSummaryCard({ caseId, onTab }: { caseId: string; onTab: (tab: Tab) => void }) {
  const costs = useCaseCosts(caseId);
  return (
    <Card padding="none" className="p-4">
      <div className="flex items-center justify-between">
        <h2 className="text-md font-bold text-ink">Recruiting costs</h2>
        <button
          type="button"
          className="text-sm font-semibold text-primary-text hover:underline"
          onClick={() => onTab('costs')}
        >
          Open costs
        </button>
      </div>
      {costs.isPending ? (
        <p className="mt-2 text-sm text-muted">Loading…</p>
      ) : costs.error ? (
        <p className="mt-2 text-sm text-danger-text">Costs could not be loaded.</p>
      ) : (
        <>
          <p className="tabular mt-2 text-2xl font-bold text-ink">
            {formatMoney(costs.data.summary.total)}
          </p>
          <p className="text-xs text-muted">
            {costs.data.entries.length === 0
              ? 'No costs recorded.'
              : `${costs.data.entries.length} cost${costs.data.entries.length === 1 ? '' : 's'} recorded`}
          </p>
        </>
      )}
    </Card>
  );
}
