import { Link } from '@tanstack/react-router';
import {
  AlertTriangle,
  ArrowRight,
  Briefcase,
  CalendarDays,
  ChevronLeft,
  ChevronRight,
  FileText,
  MoreHorizontal,
  Users,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  JOURNEY_LABELS,
  JOURNEY_NEXT_ACTION,
  JOURNEY_STEPS,
  JOURNEY_STUCK_AFTER_DAYS,
  LEAD_SOURCE_LABELS,
  LEAD_STATUS_LABELS,
  addDays,
  easternDay,
  isJourneyExit,
  journeyPeople,
  weekStartMonday,
  type HiringCalendarEvent,
  type JourneyPerson,
  type JourneyStep,
  type Lead,
  type LeadStatus,
} from '@neway/shared';
import {
  Avatar,
  Badge,
  Button,
  Card,
  DropdownMenu,
  ErrorState,
  IconButton,
  MenuItem,
  StatusSymbol,
  cn,
} from '@/design-system';
import { formatIsoDate } from '@/lib/format';
import { useAccount } from '@/features/auth/auth-context';
import { useJobOpenings } from './useHr';
import { useHiringCalendar, useHiringCases, useLatestFollowUps, useLeads } from './useHiring';
import {
  AssignRecruiterDialog,
  FollowUpDialog,
  type FollowUpTarget,
  type RecruiterTarget,
} from './RecruitingParts';
import { StatCard } from './RecruitingKit';
import { type Period } from './recruiting-kit';

/**
 * Recruiting › Overview (owner's design, 2026-09-30).
 *
 * Every figure is read from the leads and hiring cases on each visit. Two kinds of number sit
 * here and are labelled as such: "now" figures (who is on each step, who is overdue, open
 * positions) are not bounded by the period, because a queue is a queue; period figures (hires,
 * lead sources, recent leads) count what started or finished inside the chosen dates.
 */

const PAGE = 5;

function daysLabel(days: number): string {
  return days === 0 ? 'Added today' : `${days} day${days === 1 ? '' : 's'} in stage`;
}

function overdueBy(p: JourneyPerson): number {
  if (isJourneyExit(p.place)) return 0;
  const limit = JOURNEY_STUCK_AFTER_DAYS[p.place as JourneyStep];
  return limit === null ? 0 : Math.max(0, p.daysOnStep - limit);
}

export function RecruitingOverview({
  period,
  today,
  onOpenTab,
}: {
  period: Period;
  today: string;
  onOpenTab: (tab: string, extra?: Record<string, unknown>) => void;
}) {
  const leads = useLeads({ page: 1, pageSize: 10_000 });
  const cases = useHiringCases();
  const openings = useJobOpenings();
  const followUps = useLatestFollowUps();
  const canManage = useAccount()?.permissions.includes('recruiting.manage') ?? false;
  const range = period;
  const loading = leads.isPending || cases.isPending;
  const error = leads.error ?? cases.error;

  const people = useMemo(
    () => (leads.data && cases.data ? journeyPeople(leads.data.data, cases.data, today) : []),
    [leads.data, cases.data, today],
  );
  const live = people.filter((p) => !isJourneyExit(p.place) && p.place !== 'first_load');
  const overdue = live.filter((p) => p.stuck).sort((a, b) => overdueBy(b) - overdueBy(a));
  const hired = (cases.data ?? []).filter(
    (c) => c.hiredAt && easternDay(c.hiredAt) >= range.from && easternDay(c.hiredAt) <= range.to,
  );
  const openPositions = (openings.data ?? [])
    .filter((j) => j.status === 'open')
    .reduce((n, j) => n + Math.max(0, j.positionsCount - j.hiredCount), 0);
  const lastFollowUp = new Map((followUps.data ?? []).map((f) => [f.entityId, f]));

  const [step, setStep] = useState<JourneyStep>(() => 'lead');
  const [chosen, setChosen] = useState(false);
  // Until someone picks a tile, open on the first step that has people on it.
  const firstBusy = JOURNEY_STEPS.find((s) => people.some((p) => p.place === s)) ?? 'lead';
  const selected = chosen ? step : firstBusy;

  const [followUp, setFollowUp] = useState<FollowUpTarget | null>(null);
  const [assign, setAssign] = useState<RecruiterTarget | null>(null);

  const followTarget = (p: JourneyPerson): FollowUpTarget => ({
    kind: p.kind,
    id: p.id,
    name: p.name,
    phone: p.phone,
    email: p.email,
    leadIsNew: p.kind === 'lead' && p.place === 'lead',
  });

  if (error)
    return (
      <ErrorState
        error={error}
        onRetry={() => void Promise.all([leads.refetch(), cases.refetch()])}
      />
    );

  const hiredLabel =
    period.key === 'month'
      ? 'Hired this month'
      : period.key === 'week'
        ? 'Hired this week'
        : 'Hired in period';

  return (
    <div className="flex flex-col gap-4" data-testid="recruiting-overview">
      <section className="grid grid-cols-2 gap-3 xl:grid-cols-4" aria-label="Recruiting figures">
        <SummaryCard
          icon={<Users />}
          label="Active candidates"
          value={loading ? null : live.length}
          hint="Now, on any step before first load"
        />
        <SummaryCard
          icon={<AlertTriangle />}
          label="Needs attention"
          value={loading ? null : overdue.length}
          hint="Now, past the step's time limit"
          tone={overdue.length > 0 ? 'warning' : undefined}
        />
        <SummaryCard
          icon={<Briefcase />}
          label={hiredLabel}
          value={loading ? null : hired.length}
          hint={`${formatIsoDate(range.from)} – ${formatIsoDate(range.to)}`}
        />
        <SummaryCard
          icon={<FileText />}
          label="Open positions"
          value={openings.isPending ? null : openPositions}
          hint="Seats still to fill on open openings"
        />
      </section>

      {!loading && overdue.length > 0 ? (
        <div
          role="status"
          className="flex flex-wrap items-center gap-3 rounded-[10px] border border-nw-warning-border bg-nw-warning-bg px-4 py-2.5"
          data-testid="attention-banner"
        >
          <StatusSymbol family="warning" size={16} className="text-nw-warning-icon" />
          <p className="text-sm font-semibold text-nw-warning-text">
            {overdue.length} candidate{overdue.length === 1 ? '' : 's'} need
            {overdue.length === 1 ? 's' : ''} a follow-up
          </p>
          <span className="text-xs text-nw-warning-text">
            Oldest: {overdue[0]!.name}, {overdueBy(overdue[0]!)} day
            {overdueBy(overdue[0]!) === 1 ? '' : 's'} overdue
          </span>
          <Button
            variant="outline"
            size="sm"
            className="ml-auto"
            onClick={() => {
              setStep(overdue[0]!.place as JourneyStep);
              setChosen(true);
            }}
          >
            View candidate
          </Button>
        </div>
      ) : null}

      <div className="grid gap-4 xl:grid-cols-[minmax(0,1.9fr)_minmax(0,1fr)]">
        <Card padding="none" className="flex flex-col" data-testid="hiring-pipeline">
          <header className="flex items-center justify-between gap-2 px-5 pt-4 pb-3">
            <h2 className="text-md font-bold text-ink">Hiring pipeline</h2>
            <button
              type="button"
              onClick={() => onOpenTab('pipeline')}
              className="inline-flex items-center gap-1 text-sm font-semibold text-primary-text hover:underline"
            >
              View full pipeline <ArrowRight aria-hidden className="size-4" />
            </button>
          </header>
          <div
            className="grid grid-cols-1 gap-2.5 px-5 sm:grid-cols-3"
            role="tablist"
            aria-label="Hiring stages"
          >
            {JOURNEY_STEPS.map((s) => {
              const count = people.filter((p) => p.place === s).length;
              const on = s === selected;
              return (
                <button
                  key={s}
                  type="button"
                  role="tab"
                  aria-selected={on}
                  data-testid={`stage-${s}`}
                  onClick={() => {
                    setStep(s);
                    setChosen(true);
                  }}
                  className={cn(
                    'flex h-12 items-center justify-between rounded-lg border px-4 text-left text-sm font-semibold transition-colors focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
                    on
                      ? 'border-transparent bg-primary text-inverse shadow-segment'
                      : 'border-line bg-surface text-ink hover:bg-surface-hover',
                  )}
                >
                  <span>{JOURNEY_LABELS[s]}</span>
                  <span className="tabular text-base">{loading ? '…' : count}</span>
                </button>
              );
            })}
          </div>
          <StageList
            key={selected}
            step={selected}
            people={people
              .filter((p) => p.place === selected)
              .sort((a, b) => overdueBy(b) - overdueBy(a) || b.daysOnStep - a.daysOnStep)}
            loading={loading}
            canManage={canManage}
            lastFollowUp={lastFollowUp}
            onFollowUp={(p) => setFollowUp(followTarget(p))}
          />
        </Card>

        <div className="flex flex-col gap-4">
          <ThisWeek today={today} onViewCalendar={() => onOpenTab('calendar')} />
          <LeadSources
            leads={leads.data?.data ?? []}
            from={range.from}
            to={range.to}
            loading={loading}
          />
        </div>
      </div>

      <RecentLeads
        leads={(leads.data?.data ?? []).filter(
          (l) => easternDay(l.createdAt) >= range.from && easternDay(l.createdAt) <= range.to,
        )}
        loading={loading}
        canManage={canManage}
        caseRecruiter={new Map((cases.data ?? []).map((c) => [c.id, c.recruiterId]))}
        onViewAll={() => onOpenTab('leads')}
        onFollowUp={(l) =>
          setFollowUp({
            kind: l.hiringCaseId ? 'case' : 'lead',
            id: l.hiringCaseId ?? l.id,
            name: l.name,
            phone: l.phone,
            email: l.email,
            leadIsNew: l.status === 'new',
          })
        }
        onAssign={(l, currentId) =>
          setAssign({
            kind: l.hiringCaseId ? 'case' : 'lead',
            id: l.hiringCaseId ?? l.id,
            name: l.name,
            currentId,
          })
        }
        onOpenLead={(l) => onOpenTab('leads', { lead: l.id })}
      />

      {followUp ? <FollowUpDialog target={followUp} onClose={() => setFollowUp(null)} /> : null}
      {assign ? <AssignRecruiterDialog target={assign} onClose={() => setAssign(null)} /> : null}
    </div>
  );
}

function SummaryCard({
  icon,
  label,
  value,
  hint,
  tone,
}: {
  icon: React.ReactNode;
  label: string;
  value: number | null;
  hint: string;
  tone?: 'warning';
}) {
  // The same number card every Recruiting tab uses.
  return <StatCard icon={icon} label={label} value={value} hint={hint} tone={tone ?? 'primary'} />;
}

function StageList({
  step,
  people,
  loading,
  canManage,
  lastFollowUp,
  onFollowUp,
}: {
  step: JourneyStep;
  people: JourneyPerson[];
  loading: boolean;
  canManage: boolean;
  lastFollowUp: Map<string, { at: string; byName: string }>;
  onFollowUp: (p: JourneyPerson) => void;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(people.length / PAGE));
  const shown = people.slice(page * PAGE, page * PAGE + PAGE);
  return (
    <section
      className="mt-4 border-t border-line px-5 pt-4 pb-5"
      aria-label={`${JOURNEY_LABELS[step]} candidates`}
      data-testid="stage-list"
    >
      <div className="mb-3 flex items-center gap-2">
        <h3 className="text-md font-bold text-ink">{JOURNEY_LABELS[step]}</h3>
        <span className="rounded-full bg-surface-muted px-2.5 py-0.5 text-xs font-semibold text-secondary">
          {loading ? '…' : `${people.length} candidate${people.length === 1 ? '' : 's'}`}
        </span>
        <span className="ml-auto text-xs text-muted">Most overdue first</span>
      </div>
      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : people.length === 0 ? (
        <p
          className="rounded-lg border border-dashed border-line px-4 py-5 text-center text-sm text-muted"
          data-testid="stage-empty"
        >
          Nobody is on {JOURNEY_LABELS[step]} right now.{' '}
          {step === 'lead'
            ? 'Add a lead to start.'
            : `People arrive here from ${JOURNEY_LABELS[JOURNEY_STEPS[Math.max(0, JOURNEY_STEPS.indexOf(step) - 1)]!]}.`}
        </p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {shown.map((p) => {
            const late = overdueBy(p);
            const follow = lastFollowUp.get(p.id);
            return (
              <li
                key={p.key}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line px-4 py-3"
                data-testid={`candidate-${p.id}`}
              >
                <Avatar name={p.name} />
                <span className="min-w-0 flex-1">
                  <ProfileLink
                    person={p}
                    className="block truncate font-semibold text-ink hover:underline"
                  >
                    {p.name}
                  </ProfileLink>
                  <span className="block truncate text-xs text-muted">
                    {p.source ? (LEAD_SOURCE_LABELS[p.source] ?? p.source) : 'Source not recorded'}{' '}
                    · {p.recruiterName ?? 'Unassigned'}
                  </span>
                  <span className="mt-0.5 flex items-center gap-1 text-xs text-muted">
                    <FileText aria-hidden className="size-3.5" /> Next: {JOURNEY_NEXT_ACTION[step]}
                  </span>
                  {follow ? (
                    <span className="block text-2xs text-faint">
                      Last follow-up {formatIsoDate(easternDay(follow.at))} by {follow.byName}
                    </span>
                  ) : null}
                </span>
                {late > 0 ? (
                  <span
                    className="inline-flex items-center gap-1 rounded-md border border-nw-warning-border bg-nw-warning-bg px-2 py-1 text-xs font-semibold text-nw-warning-text"
                    data-testid="overdue"
                  >
                    <StatusSymbol family="warning" size={12} className="text-nw-warning-icon" />
                    {late} day{late === 1 ? '' : 's'} overdue
                  </span>
                ) : (
                  <span className="rounded-md bg-surface-muted px-2 py-1 text-xs font-semibold text-secondary">
                    {daysLabel(p.daysOnStep)}
                  </span>
                )}
                <span className="flex gap-2">
                  {late > 0 && canManage ? (
                    <Button variant="outline" size="sm" onClick={() => onFollowUp(p)}>
                      Follow up
                    </Button>
                  ) : null}
                  <Button variant={late > 0 ? 'ghost' : 'outline'} size="sm" asChild>
                    <ProfileLink person={p}>
                      {p.kind === 'case' ? 'Open profile' : 'Open lead'}
                    </ProfileLink>
                  </Button>
                </span>
              </li>
            );
          })}
        </ul>
      )}
      {pages > 1 ? (
        <div className="mt-3 flex items-center justify-end gap-2 text-xs text-muted">
          <span>
            {page * PAGE + 1}–{Math.min(people.length, page * PAGE + PAGE)} of {people.length}
          </span>
          <IconButton
            label="Previous page"
            size="sm"
            disabled={page === 0}
            onClick={() => setPage(page - 1)}
          >
            <ChevronLeft />
          </IconButton>
          <IconButton
            label="Next page"
            size="sm"
            disabled={page >= pages - 1}
            onClick={() => setPage(page + 1)}
          >
            <ChevronRight />
          </IconButton>
        </div>
      ) : null}
    </section>
  );
}

function ProfileLink({
  person,
  children,
  className,
}: {
  person: JourneyPerson;
  children: React.ReactNode;
  className?: string;
}) {
  if (person.kind === 'case' && person.applicantId) {
    return (
      <Link
        to="/hr/recruiting/$candidateId"
        params={{ candidateId: person.applicantId }}
        className={className}
      >
        {children}
      </Link>
    );
  }
  return (
    <Link
      to="/hr/recruiting"
      search={{ tab: 'leads', employeeId: person.id }}
      className={className}
    >
      {children}
    </Link>
  );
}

const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];
const EVENT_LABEL: Record<HiringCalendarEvent['kind'], string> = {
  travel: 'Travel',
  orientation: 'Orientation',
  hired: 'Hired',
};
const EVENT_FAMILY: Record<HiringCalendarEvent['kind'], 'moving' | 'warning' | 'done'> = {
  travel: 'moving',
  orientation: 'warning',
  hired: 'done',
};
const EVENT_ICON: Record<HiringCalendarEvent['kind'], string> = {
  travel: 'text-nw-moving-icon',
  orientation: 'text-nw-warning-icon',
  hired: 'text-nw-done-icon',
};

function ThisWeek({ today, onViewCalendar }: { today: string; onViewCalendar: () => void }) {
  const [start, setStart] = useState(() => weekStartMonday(today));
  const end = addDays(start, 6);
  const events = useHiringCalendar(start, end);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  const [day, setDay] = useState<string | null>(null);
  const list = (events.data ?? []).filter((e) => (day ? e.date === day : true));
  return (
    <Card padding="none" data-testid="this-week">
      <header className="flex items-center gap-2 px-4 pt-4 pb-3">
        <CalendarDays aria-hidden className="size-4 text-muted" />
        <h2 className="text-md font-bold text-ink">This week</h2>
        <span className="ml-auto flex items-center gap-1">
          <IconButton
            label="Previous week"
            size="sm"
            onClick={() => {
              setStart(addDays(start, -7));
              setDay(null);
            }}
          >
            <ChevronLeft />
          </IconButton>
          <span className="tabular text-xs font-semibold text-ink" data-testid="week-range">
            {formatIsoDate(start)} – {formatIsoDate(end)}
          </span>
          <IconButton
            label="Next week"
            size="sm"
            onClick={() => {
              setStart(addDays(start, 7));
              setDay(null);
            }}
          >
            <ChevronRight />
          </IconButton>
        </span>
      </header>
      <div className="mx-4 grid grid-cols-7 overflow-hidden rounded-lg border border-line">
        {days.map((d, i) => {
          const has = (events.data ?? []).some((e) => e.date === d);
          const on = day === d;
          return (
            <button
              key={d}
              type="button"
              aria-pressed={on}
              aria-label={`${WEEKDAYS[i]} ${formatIsoDate(d)}${has ? ', has events' : ''}`}
              onClick={() => setDay(on ? null : d)}
              className={cn(
                'flex flex-col items-center gap-0.5 border-line py-2 text-xs not-last:border-r',
                d === today && 'bg-primary-soft',
                on && 'ring-2 ring-inset ring-primary',
              )}
            >
              <span className="text-muted">{WEEKDAYS[i]}</span>
              <span className={cn('font-semibold', d === today ? 'text-primary-text' : 'text-ink')}>
                {Number(d.slice(8))}
              </span>
              <span
                className={cn('size-1.5 rounded-full', has ? 'bg-primary' : 'bg-transparent')}
                aria-hidden
              />
            </button>
          );
        })}
      </div>
      <div className="px-4 pt-3 pb-4">
        {events.isPending ? (
          <p className="text-sm text-muted">Loading…</p>
        ) : events.error ? (
          <p className="text-sm text-danger-text">The week could not be loaded.</p>
        ) : list.length === 0 ? (
          <div className="flex flex-col items-center gap-1 py-4 text-center">
            <CalendarDays aria-hidden className="size-6 text-faint" />
            <p className="text-sm font-semibold text-ink">No travel or orientation scheduled</p>
            <p className="text-xs text-muted">
              Driver travel, orientation and hires appear here for the {day ? 'day' : 'week'}.
            </p>
          </div>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {list.map((e) => (
              <li key={e.id} className="flex items-center gap-2 text-sm">
                <StatusSymbol
                  family={EVENT_FAMILY[e.kind]}
                  size={12}
                  className={EVENT_ICON[e.kind]}
                />
                <span className="font-semibold text-ink">{EVENT_LABEL[e.kind]}</span>
                <span className="truncate text-secondary">{e.candidateName}</span>
                <span className="ml-auto text-xs text-muted">{formatIsoDate(e.date)}</span>
              </li>
            ))}
          </ul>
        )}
        <div className="mt-3 flex justify-center">
          <Button variant="outline" size="sm" onClick={onViewCalendar}>
            View calendar
          </Button>
        </div>
      </div>
    </Card>
  );
}

function LeadSources({
  leads,
  from,
  to,
  loading,
}: {
  leads: Lead[];
  from: string;
  to: string;
  loading: boolean;
}) {
  const counts = new Map<string, number>();
  for (const l of leads) {
    const day = easternDay(l.createdAt);
    if (day < from || day > to) continue;
    counts.set(l.source, (counts.get(l.source) ?? 0) + 1);
  }
  const rows = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map((r) => r[1]));
  return (
    <Card padding="none" className="p-4" data-testid="lead-sources">
      <h2 className="text-md font-bold text-ink">Lead sources</h2>
      <p className="mb-3 text-xs text-muted">
        Leads added {formatIsoDate(from)} – {formatIsoDate(to)}
      </p>
      {loading ? (
        <p className="text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="text-sm text-muted">No leads in this period.</p>
      ) : (
        <ul className="flex flex-col gap-2.5">
          {rows.map(([source, n]) => (
            <li key={source} className="grid grid-cols-[7rem_1fr_2rem] items-center gap-3 text-sm">
              <span className="truncate text-secondary">
                {LEAD_SOURCE_LABELS[source] ?? source}
              </span>
              <span className="h-2.5 overflow-hidden rounded-full bg-surface-muted" aria-hidden>
                <span
                  className="block h-full rounded-full bg-primary"
                  style={{ width: `${(n / max) * 100}%` }}
                />
              </span>
              <span className="tabular text-right font-semibold text-ink">{n}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}

const LEAD_FAMILY: Record<LeadStatus, 'neutral' | 'moving' | 'done' | 'urgent' | 'warning'> = {
  new: 'neutral',
  no_answer: 'warning',
  contacted: 'moving',
  prequalified: 'moving',
  converted: 'done',
  dead: 'urgent',
};
const LEAD_TONE: Record<LeadStatus, 'neutral' | 'info' | 'success' | 'danger'> = {
  new: 'neutral',
  no_answer: 'neutral',
  contacted: 'info',
  prequalified: 'info',
  converted: 'success',
  dead: 'danger',
};

function RecentLeads({
  leads,
  loading,
  canManage,
  caseRecruiter,
  onViewAll,
  onFollowUp,
  onAssign,
  onOpenLead,
}: {
  leads: Lead[];
  loading: boolean;
  canManage: boolean;
  caseRecruiter: Map<string, string | null>;
  onViewAll: () => void;
  onFollowUp: (l: Lead) => void;
  onAssign: (l: Lead, currentId: string | null) => void;
  onOpenLead: (l: Lead) => void;
}) {
  const rows = [...leads].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, 8);
  return (
    <Card padding="none" data-testid="recent-leads">
      <header className="flex items-center justify-between px-4 pt-4 pb-2">
        <h2 className="text-md font-bold text-ink">Recent leads</h2>
        <button
          type="button"
          onClick={onViewAll}
          className="inline-flex items-center gap-1 text-sm font-semibold text-primary-text hover:underline"
        >
          View all leads <ChevronRight aria-hidden className="size-4" />
        </button>
      </header>
      {loading ? (
        <p className="px-4 pb-4 text-sm text-muted">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-4 pb-4 text-sm text-muted">No leads were added in this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead className="border-y border-line bg-surface-muted text-left text-xs font-semibold text-muted">
              <tr>
                <th className="px-4 py-2">Name</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Recruiter</th>
                <th className="px-3 py-2">Action</th>
                <th className="w-10 px-2 py-2">
                  <span className="sr-only">More</span>
                </th>
              </tr>
            </thead>
            <tbody className="divide-y divide-line-soft">
              {rows.map((l) => {
                const recruiterId = l.hiringCaseId
                  ? (caseRecruiter.get(l.hiringCaseId) ?? l.recruiterEmployeeId)
                  : l.recruiterEmployeeId;
                return (
                  <tr key={l.id}>
                    <td className="px-4 py-2">
                      <span className="flex items-center gap-2">
                        <Avatar name={l.name} size="sm" />
                        <span className="min-w-0">
                          <span className="block truncate font-semibold text-ink">{l.name}</span>
                          <span className="block text-xs text-muted">{l.phone}</span>
                        </span>
                      </span>
                    </td>
                    <td className="px-3 py-2 text-secondary">
                      {LEAD_SOURCE_LABELS[l.source] ?? l.source}
                    </td>
                    <td className="px-3 py-2">
                      <Badge tone={LEAD_TONE[l.status]} size="sm">
                        <StatusSymbol family={LEAD_FAMILY[l.status]} size={11} />
                        {LEAD_STATUS_LABELS[l.status]}
                      </Badge>
                    </td>
                    <td className="px-3 py-2 text-secondary">{l.recruiterName ?? 'Unassigned'}</td>
                    <td className="px-3 py-2">
                      {canManage && !recruiterId ? (
                        <button
                          type="button"
                          className="font-semibold text-primary-text hover:underline"
                          onClick={() => onAssign(l, null)}
                        >
                          Assign
                        </button>
                      ) : l.applicantId ? (
                        <Link
                          to="/hr/recruiting/$candidateId"
                          params={{ candidateId: l.applicantId }}
                          className="font-semibold text-primary-text hover:underline"
                        >
                          Open profile
                        </Link>
                      ) : (
                        <button
                          type="button"
                          className="font-semibold text-primary-text hover:underline"
                          onClick={() => onOpenLead(l)}
                        >
                          Open lead
                        </button>
                      )}
                    </td>
                    <td className="px-2 py-2">
                      <DropdownMenu
                        trigger={
                          <IconButton label={`More for ${l.name}`} size="sm" variant="ghost">
                            <MoreHorizontal />
                          </IconButton>
                        }
                      >
                        <MenuItem onSelect={() => onOpenLead(l)}>Open lead</MenuItem>
                        {canManage && l.status !== 'dead' ? (
                          <MenuItem onSelect={() => onFollowUp(l)}>Follow up</MenuItem>
                        ) : null}
                        {canManage && l.status !== 'dead' ? (
                          <MenuItem onSelect={() => onAssign(l, recruiterId ?? null)}>
                            {recruiterId ? 'Change recruiter' : 'Assign recruiter'}
                          </MenuItem>
                        ) : null}
                      </DropdownMenu>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </Card>
  );
}
