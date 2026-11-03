import { Link } from '@tanstack/react-router';
import { CalendarDays, ChevronLeft, ChevronRight, Plus, UserPlus, Users } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  JOURNEY_LABELS,
  JOURNEY_STEPS,
  JOURNEY_STUCK_AFTER_DAYS,
  JOURNEY_WAITING_ON,
  LEAD_SOURCE_LABELS,
  addDays,
  journeyPeople,
  summarizeJourney,
  weekStartMonday,
  type HiringCalendarEvent,
  type JourneyPerson,
  type JourneyStep,
} from '@neway/shared';
import {
  Avatar,
  Badge,
  Button,
  Card,
  ErrorState,
  KpiCard,
  PageHeader,
  StatusSymbol,
  cn,
} from '@/design-system';
import { today as companyToday } from '@/lib/clock';
import { formatIsoDate } from '@/lib/format';
import { AddLeadModal } from './LeadsTab';
import { useHiringCalendar, useHiringCases, useLeads } from './useHiring';

/**
 * Driver hiring, on one screen (owner, 2026-09-29): HR is the hiring of drivers and nothing else.
 *
 * Every number here is read from the leads and the hiring cases on each visit — who came in, where
 * each person is, who has sat on a step too long, and how many made it versus fell out, by source.
 * The steps are the journey's nine; Safety's approve / disqualify is the Safety review step and is
 * decided in the qualification file, never here.
 */

type Period = 'week' | 'month' | '30d';
const PERIODS: { value: Period; label: string }[] = [
  { value: 'week', label: 'This week' },
  { value: 'month', label: 'This month' },
  { value: '30d', label: 'Last 30 days' },
];
const CARD_LIMIT = 6;

function periodRange(period: Period, today: string): { from: string; to: string } {
  if (period === 'week') return { from: weekStartMonday(today), to: today };
  if (period === 'month') return { from: `${today.slice(0, 8)}01`, to: today };
  return { from: addDays(today, -29), to: today };
}

export function HiringDashboardPage() {
  const today = companyToday();
  const [period, setPeriod] = useState<Period>('month');
  const [adding, setAdding] = useState(false);
  const [openStep, setOpenStep] = useState<JourneyStep | null>(null);
  const leads = useLeads({ page: 1, pageSize: 10_000 });
  const cases = useHiringCases();
  const loading = leads.isPending || cases.isPending;
  const error = leads.error ?? cases.error;

  const people = useMemo(
    () => (leads.data && cases.data ? journeyPeople(leads.data.data, cases.data, today) : []),
    [leads.data, cases.data, today],
  );
  const range = periodRange(period, today);
  const summary = useMemo(() => summarizeJourney(people, range.from, range.to), [people, range.from, range.to]);
  const stuck = useMemo(
    () => people.filter((p) => p.stuck).sort((a, b) => b.daysOnStep - a.daysOnStep),
    [people],
  );
  const exits = useMemo(
    () =>
      people
        .filter((p) => (p.place === 'dropped' || p.place === 'disqualified') && p.since.slice(0, 10) >= range.from)
        .sort((a, b) => b.since.localeCompare(a.since))
        .slice(0, 8),
    [people, range.from],
  );

  return (
    <div className="page-surface-workspace flex flex-col gap-(--section-gap)">
      <PageHeader
        title="Driver hiring"
        description="Every lead from first call to first load: where each driver is, what is stuck, and who made it."
        actions={
          <>
            <span className="inline-flex rounded-[9px] bg-nw-segment p-[3px]" role="group" aria-label="Period">
              {PERIODS.map((p) => (
                <button
                  key={p.value}
                  type="button"
                  aria-pressed={period === p.value}
                  onClick={() => setPeriod(p.value)}
                  className={cn(
                    'h-7 rounded-md px-3 text-xs font-semibold',
                    period === p.value
                      ? 'bg-nw-panel text-nw-accent-ink shadow-segment ring-1 ring-nw-border'
                      : 'text-nw-text-2 hover:text-nw-text',
                  )}
                >
                  {p.label}
                </button>
              ))}
            </span>
            <Button variant="outline" asChild>
              <Link to="/hr/recruiting">
                <Users aria-hidden className="size-4" />
                All leads & candidates
              </Link>
            </Button>
            <Button icon={<Plus />} onClick={() => setAdding(true)}>
              Add lead
            </Button>
          </>
        }
      />

      {error ? (
        <ErrorState error={error} onRetry={() => void Promise.all([leads.refetch(), cases.refetch()])} />
      ) : (
        <>
          <section className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" aria-label="Hiring figures">
            <KpiCard label="Leads in" value={loading ? 'Loading…' : summary.started} hint={`${formatIsoDate(range.from)} – ${formatIsoDate(range.to)}`} icon={<UserPlus />} iconTile />
            <KpiCard label="In progress" value={loading ? 'Loading…' : summary.inProgress} hint="Started this period, still on the way" iconTile />
            <KpiCard label="Stuck now" value={loading ? 'Loading…' : summary.stuck} hint="Longer than the step allows" tone={summary.stuck > 0 ? 'urgent' : undefined} iconTile />
            <KpiCard label="Hired" value={loading ? 'Loading…' : summary.passed} hint="Reached Hired or first load" iconTile />
            <KpiCard label="Dropped" value={loading ? 'Loading…' : summary.dropped} hint="Stopped answering, another job, no-show" iconTile />
            <KpiCard label="Disqualified" value={loading ? 'Loading…' : summary.disqualified} hint="By Safety or prequalification" iconTile />
          </section>

          {!loading && stuck.length > 0 ? <StuckList people={stuck} /> : null}

          <section aria-label="Where every driver is" className="grid gap-3 md:grid-cols-2 xl:grid-cols-3">
            {JOURNEY_STEPS.map((step) => (
              <StepCard
                key={step}
                step={step}
                people={people.filter((p) => p.place === step).sort((a, b) => b.daysOnStep - a.daysOnStep)}
                loading={loading}
                expanded={openStep === step}
                onToggle={() => setOpenStep(openStep === step ? null : step)}
              />
            ))}
          </section>

          <WeekCalendar today={today} />

          <div className="grid gap-3 xl:grid-cols-2">
            <SourcesCard rows={summary.bySource} loading={loading} />
            <ExitsCard people={exits} loading={loading} />
          </div>
        </>
      )}

      {adding ? <AddLeadModal onClose={() => setAdding(false)} /> : null}
    </div>
  );
}

/** Where the person's record opens: the candidate for a case, the lead in the leads list. */
function PersonLink({ person, children, className }: { person: JourneyPerson; children: React.ReactNode; className?: string }) {
  if (person.kind === 'case' && person.applicantId) {
    return (
      <Link to="/hr/recruiting/$candidateId" params={{ candidateId: person.applicantId }} className={className}>
        {children}
      </Link>
    );
  }
  return (
    <Link to="/hr/recruiting" search={{ tab: 'leads', employeeId: person.id }} className={className}>
      {children}
    </Link>
  );
}

function daysLabel(days: number): string {
  return days === 0 ? 'today' : `${days} day${days === 1 ? '' : 's'}`;
}

function StuckList({ people }: { people: JourneyPerson[] }) {
  return (
    <Card padding="none" className="overflow-hidden" data-testid="stuck-list">
      <header className="flex items-center gap-2 border-b border-nw-border px-4 py-3">
        <StatusSymbol family="urgent" size={14} className="text-nw-urgent-icon" />
        <h2 className="text-sm font-bold text-nw-text">Stuck · {people.length}</h2>
        <span className="text-xs text-nw-text-3">Longer on a step than it should take. Oldest first.</span>
      </header>
      <ul className="divide-y divide-nw-border">
        {people.slice(0, 10).map((p) => (
          <li key={p.key} className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-2 text-sm">
            <PersonLink person={p} className="flex min-w-48 items-center gap-2 font-semibold text-nw-text hover:underline">
              <Avatar name={p.name} size="sm" />
              {p.name}
            </PersonLink>
            <span className="text-nw-text-2">{JOURNEY_LABELS[p.place]}</span>
            <span className="font-semibold text-nw-urgent-text">
              {daysLabel(p.daysOnStep)} · limit {JOURNEY_STUCK_AFTER_DAYS[p.place as JourneyStep]}
            </span>
            <span className="text-xs text-nw-text-3">Waiting on: {JOURNEY_WAITING_ON[p.place as JourneyStep]}</span>
            {p.recruiterName ? <span className="ml-auto text-xs text-nw-text-3">{p.recruiterName}</span> : null}
          </li>
        ))}
      </ul>
      {people.length > 10 ? <p className="px-4 py-2 text-xs text-nw-text-3">and {people.length - 10} more on the step cards below.</p> : null}
    </Card>
  );
}

function StepCard({
  step,
  people,
  loading,
  expanded,
  onToggle,
}: {
  step: JourneyStep;
  people: JourneyPerson[];
  loading: boolean;
  expanded: boolean;
  onToggle: () => void;
}) {
  const stuck = people.filter((p) => p.stuck).length;
  const shown = expanded ? people : people.slice(0, CARD_LIMIT);
  return (
    <Card padding="none" className="flex flex-col overflow-hidden" data-testid={`step-${step}`}>
      <header className="flex items-start justify-between gap-2 border-b border-nw-border px-4 py-3">
        <div>
          <h2 className="text-sm font-bold text-nw-text">{JOURNEY_LABELS[step]}</h2>
          <p className="text-[11.5px] text-nw-text-3">{JOURNEY_WAITING_ON[step]}</p>
        </div>
        <div className="flex items-center gap-1.5">
          {stuck > 0 ? (
            <Badge tone="danger" size="sm">
              <StatusSymbol family="urgent" size={11} className="text-nw-urgent-icon" />
              {stuck} stuck
            </Badge>
          ) : null}
          <span className="tabular inline-flex h-6 min-w-6 items-center justify-center rounded-md bg-nw-subtle px-1.5 text-xs font-bold text-nw-text">
            {loading ? '…' : people.length}
          </span>
        </div>
      </header>
      {loading ? (
        <p className="px-4 py-4 text-sm text-nw-text-3">Loading…</p>
      ) : people.length === 0 ? (
        <p className="px-4 py-4 text-sm text-nw-text-3">Nobody on this step.</p>
      ) : (
        <ul className="flex flex-col">
          {shown.map((p) => (
            <li key={p.key} className={cn('border-l-[3px]', p.stuck ? 'border-nw-urgent-icon' : 'border-transparent')}>
              <PersonLink person={p} className="flex items-center gap-2.5 px-3.5 py-2 hover:bg-nw-hover">
                <Avatar name={p.name} size="sm" />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold text-nw-text">{p.name}</span>
                  <span className="block truncate text-[11.5px] text-nw-text-3">
                    {p.source ? (LEAD_SOURCE_LABELS[p.source] ?? p.source) : 'Source not recorded'}
                    {p.recruiterName ? ` · ${p.recruiterName}` : ''}
                  </span>
                </span>
                <span className={cn('tabular shrink-0 text-xs font-semibold', p.stuck ? 'text-nw-urgent-text' : 'text-nw-text-2')}>
                  {daysLabel(p.daysOnStep)}
                </span>
              </PersonLink>
            </li>
          ))}
        </ul>
      )}
      {people.length > CARD_LIMIT ? (
        <button type="button" onClick={onToggle} className="mt-auto border-t border-nw-border px-4 py-2 text-left text-xs font-semibold text-nw-accent-ink hover:bg-nw-hover">
          {expanded ? 'Show fewer' : `Show all ${people.length}`}
        </button>
      ) : null}
    </Card>
  );
}

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
/** Written out in full so the class names are in the source for Tailwind to find. */
const EVENT_TEXT: Record<HiringCalendarEvent['kind'], string> = {
  travel: 'text-nw-moving-text',
  orientation: 'text-nw-warning-text',
  hired: 'text-nw-done-text',
};
const EVENT_ICON: Record<HiringCalendarEvent['kind'], string> = {
  travel: 'text-nw-moving-icon',
  orientation: 'text-nw-warning-icon',
  hired: 'text-nw-done-icon',
};
const WEEKDAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export function WeekCalendar({ today }: { today: string }) {
  const [start, setStart] = useState(() => weekStartMonday(today));
  const end = addDays(start, 6);
  const events = useHiringCalendar(start, end);
  const days = Array.from({ length: 7 }, (_, i) => addDays(start, i));
  return (
    <Card padding="none" className="overflow-hidden" data-testid="hiring-calendar">
      <header className="flex flex-wrap items-center gap-2 border-b border-nw-border px-4 py-3">
        <CalendarDays aria-hidden className="size-4 text-nw-text-3" />
        <h2 className="text-sm font-bold text-nw-text">This week's travel, orientation and hires</h2>
        <div className="ml-auto flex items-center gap-1">
          <Button variant="ghost" size="sm" aria-label="Previous week" icon={<ChevronLeft />} onClick={() => setStart(addDays(start, -7))} />
          <span className="tabular text-xs font-semibold text-nw-text">
            {formatIsoDate(start)} – {formatIsoDate(end)}
          </span>
          <Button variant="ghost" size="sm" aria-label="Next week" icon={<ChevronRight />} onClick={() => setStart(addDays(start, 7))} />
        </div>
      </header>
      <div className="overflow-x-auto">
        <div className="grid min-w-[760px] grid-cols-7 divide-x divide-nw-border">
          {days.map((day, i) => {
            const mine = (events.data ?? []).filter((e) => e.date === day);
            return (
              <div key={day} className={cn('min-h-32 p-2', day === today && 'bg-nw-accent-tint/40')}>
                <p className={cn('mb-1.5 text-[11.5px] font-semibold', day === today ? 'text-nw-accent-ink' : 'text-nw-text-2')}>
                  {WEEKDAYS[i]} {day.slice(8)}
                </p>
                {events.isPending ? <p className="text-2xs text-nw-text-3">Loading…</p> : null}
                <div className="flex flex-col gap-1.5">
                  {mine.map((e) => (
                    <Link
                      key={e.id}
                      to={e.applicantId ? '/hr/recruiting/$candidateId' : '/hr/recruiting'}
                      params={e.applicantId ? { candidateId: e.applicantId } : undefined}
                      className="rounded-md border border-nw-border bg-nw-panel px-2 py-1.5 hover:bg-nw-hover"
                    >
                      <span className={cn('flex items-center gap-1 text-[11px] font-bold', EVENT_TEXT[e.kind])}>
                        <StatusSymbol family={EVENT_FAMILY[e.kind]} size={11} className={EVENT_ICON[e.kind]} />
                        {EVENT_LABEL[e.kind]}
                      </span>
                      <span className="block truncate text-xs font-semibold text-nw-text">{e.candidateName}</span>
                      {e.detail ? <span className="block truncate text-2xs text-nw-text-3">{e.detail}</span> : null}
                    </Link>
                  ))}
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
}

function SourcesCard({ rows, loading }: { rows: ReturnType<typeof summarizeJourney>['bySource']; loading: boolean }) {
  return (
    <Card padding="none" className="overflow-hidden" data-testid="sources">
      <header className="border-b border-nw-border px-4 py-3">
        <h2 className="text-sm font-bold text-nw-text">Where the drivers come from</h2>
        <p className="text-[11.5px] text-nw-text-3">Leads that started in the period, and how they ended so far.</p>
      </header>
      {loading ? (
        <p className="px-4 py-4 text-sm text-nw-text-3">Loading…</p>
      ) : rows.length === 0 ? (
        <p className="px-4 py-4 text-sm text-nw-text-3">No leads started in this period.</p>
      ) : (
        <table className="w-full text-sm">
          <thead className="text-left text-[11px] font-semibold uppercase tracking-wide text-nw-text-3">
            <tr>
              <th className="px-4 py-2">Source</th>
              <th className="px-2 py-2 text-right">Leads</th>
              <th className="px-2 py-2 text-right">Hired</th>
              <th className="px-2 py-2 text-right">Dropped</th>
              <th className="px-2 py-2 text-right">Disqualified</th>
              <th className="px-4 py-2 text-right">Hire rate</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-nw-border">
            {rows.map((r) => (
              <tr key={r.source}>
                <td className="px-4 py-2 font-semibold text-nw-text">{LEAD_SOURCE_LABELS[r.source] ?? r.source}</td>
                <td className="tabular px-2 py-2 text-right">{r.started}</td>
                <td className="tabular px-2 py-2 text-right text-nw-done-text">{r.passed}</td>
                <td className="tabular px-2 py-2 text-right text-nw-text-2">{r.dropped}</td>
                <td className="tabular px-2 py-2 text-right text-nw-text-2">{r.disqualified}</td>
                <td className="tabular px-4 py-2 text-right font-semibold">{r.started ? `${Math.round((r.passed / r.started) * 100)}%` : '—'}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </Card>
  );
}

function ExitsCard({ people, loading }: { people: JourneyPerson[]; loading: boolean }) {
  return (
    <Card padding="none" className="overflow-hidden" data-testid="exits">
      <header className="border-b border-nw-border px-4 py-3">
        <h2 className="text-sm font-bold text-nw-text">Who fell out, and why</h2>
        <p className="text-[11.5px] text-nw-text-3">Most recent first, in the period.</p>
      </header>
      {loading ? (
        <p className="px-4 py-4 text-sm text-nw-text-3">Loading…</p>
      ) : people.length === 0 ? (
        <p className="px-4 py-4 text-sm text-nw-text-3">Nobody dropped or was disqualified in this period.</p>
      ) : (
        <ul className="divide-y divide-nw-border">
          {people.map((p) => (
            <li key={p.key} className="flex items-center gap-3 px-4 py-2 text-sm">
              <PersonLink person={p} className="flex min-w-40 items-center gap-2 font-semibold text-nw-text hover:underline">
                <Avatar name={p.name} size="sm" />
                {p.name}
              </PersonLink>
              <Badge tone={p.place === 'disqualified' ? 'danger' : 'neutral'} size="sm">
                <StatusSymbol family={p.place === 'disqualified' ? 'urgent' : 'neutral'} size={11} />
                {JOURNEY_LABELS[p.place]}
              </Badge>
              <span className="min-w-0 flex-1 truncate text-xs text-nw-text-2">{p.endReason?.replace(/_/g, ' ') ?? 'No reason recorded'}</span>
              <span className="text-xs text-nw-text-3">{formatIsoDate(p.since.slice(0, 10))}</span>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
