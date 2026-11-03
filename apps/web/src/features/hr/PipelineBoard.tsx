import { Link, useNavigate } from '@tanstack/react-router';
import {
  ArrowUpRight,
  CircleDot,
  FileText,
  Info,
  MoreHorizontal,
  Search,
  ShieldCheck,
  Users,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  HIRING_END_REASON_LABELS,
  HIRING_STAGES,
  HIRING_STAGE_LABELS,
  HIRING_TERMINAL_STATES,
  JOURNEY_STUCK_AFTER_DAYS,
  isJourneyExit,
  journeyPlaceOfCase,
  type HiringCase,
  type HiringState,
  type JourneyStep,
  type Lead,
} from '@neway/shared';
import {
  Alert,
  Avatar,
  Badge,
  Button,
  DropdownMenu,
  IconButton,
  Input,
  MenuItem,
  Select,
  StatusSymbol,
  cn,
} from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { today as companyToday } from '@/lib/clock';
import { formatIsoDate } from '@/lib/format';
import { DropCaseDialog, canDropCase } from './CandidateHiringParts';
import type { HrSearch } from './hr-search';
import { PanelEmpty } from './RecruitingKit';
import {
  AssignRecruiterDialog,
  FollowUpDialog,
  type FollowUpTarget,
  type RecruiterTarget,
} from './RecruitingParts';
import { useHiringCases, useLeads } from './useHiring';

/**
 * Recruiting › Pipeline (owner's redesign, 2026-10-01).
 *
 * The stages are the funnel's own (HIRING_STAGES), every one of them, in order; the ended states
 * are counted beneath. Lead and Prequalified hold the leads not yet converted (read from the
 * leads, since a case only opens at conversion); every later stage holds hiring cases. Checks and
 * Safety review are the qualification file's — this board reads them and never copies them.
 *
 * A live queue, not a period report: everyone on a stage now, whenever they arrived.
 */

type Row =
  | { kind: 'lead'; key: string; stage: HiringState; lead: Lead; name: string; recruiterName: string | null; days: number; stuck: boolean }
  | { kind: 'case'; key: string; stage: HiringState; hc: HiringCase; name: string; recruiterName: string | null; days: number; stuck: boolean };

const LIVE_STAGES = HIRING_STAGES.filter((s) => s !== 'active_driver');

function daysSince(iso: string, today: string): number {
  const from = Date.parse(`${new Date(iso).toLocaleDateString('en-CA', { timeZone: 'America/New_York' })}T00:00:00Z`);
  return Math.max(0, Math.round((Date.parse(`${today}T00:00:00Z`) - from) / 86_400_000));
}

function stuckAfter(state: HiringState): number | null {
  const place = journeyPlaceOfCase(state);
  return isJourneyExit(place) ? null : JOURNEY_STUCK_AFTER_DAYS[place as JourneyStep];
}

/** The one next thing to do, from the real record. */
function nextStep(row: Row): string {
  if (row.kind === 'lead') {
    const l = row.lead;
    if (l.status === 'new') return 'Call the lead';
    if (l.status === 'prequalified') return 'Convert to a candidate';
    if (l.prequalResult && !l.prequalResult.qualifies) return 'Does not prequalify — decide on the lead';
    return 'Record the prequalification answers';
  }
  const c = row.hc;
  switch (c.state) {
    case 'lead':
    case 'prequalified':
      return 'Start the DOT application';
    case 'application':
      return c.dotApplication ? 'Complete the DOT application' : 'Start the DOT application';
    case 'checks':
      return 'Collect documents and consents';
    case 'safety_review':
      return 'Waiting on Safety to approve or disqualify';
    case 'offer':
      return c.offerId ? 'Get the offer accepted, then record travel' : 'Draft the offer';
    case 'ticketed':
      return 'Record orientation and the road test';
    case 'orientation':
      return 'Hire once orientation and the road test are done';
    case 'hired':
      return 'Waiting for the first dispatch';
    case 'active_driver':
      return 'Driving';
    default:
      return c.endReason ? HIRING_END_REASON_LABELS[c.endReason] : 'Ended';
  }
}

const STAGE_ICON: Partial<Record<HiringState, React.ReactNode>> = {
  application: <FileText aria-hidden className="size-3.5" />,
  checks: <ShieldCheck aria-hidden className="size-3.5" />,
  safety_review: <ShieldCheck aria-hidden className="size-3.5" />,
};

function StageChip({ state }: { state: HiringState }) {
  const tone =
    state === 'safety_review' || state === 'checks'
      ? 'warning'
      : state === 'hired' || state === 'active_driver'
        ? 'success'
        : (HIRING_TERMINAL_STATES as readonly string[]).includes(state)
          ? 'neutral'
          : 'info';
  return (
    <Badge tone={tone} icon={STAGE_ICON[state] ?? <CircleDot aria-hidden className="size-3.5" />}>
      {HIRING_STAGE_LABELS[state]}
    </Badge>
  );
}

export function PipelineBoard({
  search,
  update,
  onOpenTab,
}: {
  search: HrSearch;
  update: (patch: Record<string, unknown>) => void;
  onOpenTab: (tab: string, extra?: Record<string, unknown>) => void;
}) {
  const account = useAccount();
  const canManage = account?.permissions.includes('recruiting.manage') ?? false;
  const canSeeSafety = account?.permissions.includes('compliance.view') ?? false;
  const today = companyToday();
  const cases = useHiringCases();
  const newLeads = useLeads({ page: 1, pageSize: 10_000, status: 'new', sort: 'createdAt', dir: 'asc' });
  const contactedLeads = useLeads({ page: 1, pageSize: 10_000, status: 'contacted', sort: 'createdAt', dir: 'asc' });
  const preqLeads = useLeads({ page: 1, pageSize: 10_000, status: 'prequalified', sort: 'createdAt', dir: 'asc' });
  const [followUp, setFollowUp] = useState<FollowUpTarget | null>(null);
  const [assign, setAssign] = useState<RecruiterTarget | null>(null);
  const [drop, setDrop] = useState<HiringCase | null>(null);
  // A big pipeline renders in pages of 50; the counts above are always the full counts.
  const [shown, setShown] = useState(50);

  const loading = cases.isPending || newLeads.isPending || contactedLeads.isPending || preqLeads.isPending;
  const error = cases.error ?? newLeads.error ?? contactedLeads.error ?? preqLeads.error;

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = [];
    const leadRows = [...(newLeads.data?.data ?? []), ...(contactedLeads.data?.data ?? []), ...(preqLeads.data?.data ?? [])];
    for (const l of leadRows) {
      if (l.hiringCaseId) continue;
      const stage: HiringState = l.status === 'prequalified' ? 'prequalified' : 'lead';
      const since = l.status === 'prequalified' ? (l.prequalifiedAt ?? l.createdAt) : l.status === 'contacted' ? (l.contactedAt ?? l.createdAt) : l.createdAt;
      const days = daysSince(since, today);
      const limit = l.status === 'new' ? JOURNEY_STUCK_AFTER_DAYS.lead : JOURNEY_STUCK_AFTER_DAYS.contacted;
      out.push({ kind: 'lead', key: `lead:${l.id}`, stage, lead: l, name: l.name, recruiterName: l.recruiterName, days, stuck: limit !== null && days > limit });
    }
    for (const c of cases.data ?? []) {
      const limit = stuckAfter(c.state);
      out.push({ kind: 'case', key: `case:${c.id}`, stage: c.state, hc: c, name: c.candidateName, recruiterName: c.recruiterName, days: c.daysInState, stuck: limit !== null && c.daysInState > limit });
    }
    return out;
  }, [cases.data, newLeads.data, contactedLeads.data, preqLeads.data, today]);

  // Lead lists are paged at 200; their totals are the true counts even past that.
  const leadTotals = {
    lead: (newLeads.data?.total ?? 0) + (contactedLeads.data?.total ?? 0),
    prequalified: preqLeads.data?.total ?? 0,
  };
  const count = (state: HiringState) =>
    rows.filter((r) => r.kind === 'case' && r.stage === state).length +
    (state === 'lead' ? leadTotals.lead : state === 'prequalified' ? leadTotals.prequalified : 0);
  const activeCount = LIVE_STAGES.reduce((n, s) => n + count(s), 0);
  const truncated =
    (newLeads.data?.total ?? 0) > 200 || (contactedLeads.data?.total ?? 0) > 200 || (preqLeads.data?.total ?? 0) > 200;

  const stage = (HIRING_STAGES as readonly string[]).concat(HIRING_TERMINAL_STATES).includes(search.stage ?? '')
    ? (search.stage as HiringState)
    : null;
  const recruiters = [...new Set(rows.map((r) => r.recruiterName).filter((n): n is string => !!n))].sort();
  const q = (search.q ?? '').trim().toLowerCase();
  const visible = rows
    .filter((r) => (stage ? r.stage === stage : (LIVE_STAGES as readonly string[]).includes(r.stage)))
    .filter((r) => !q || r.name.toLowerCase().includes(q) || (r.kind === 'lead' && r.lead.phone.includes(q)))
    .filter((r) =>
      !search.recruiter ? true : search.recruiter === '__none' ? !r.recruiterName : r.recruiterName === search.recruiter,
    )
    .sort((a, b) => Number(b.stuck) - Number(a.stuck) || b.days - a.days || a.name.localeCompare(b.name));

  const heading = stage ? HIRING_STAGE_LABELS[stage] : 'Active candidates';
  const headingCount = stage ? count(stage) : activeCount;

  return (
    <div className="grid gap-4 lg:grid-cols-[15.5rem_minmax(0,1fr)]" data-testid="pipeline-board">
      <nav
        aria-label="Pipeline stages"
        className="scroll-quiet flex gap-1 overflow-x-auto rounded-[10px] border border-nw-border bg-nw-panel p-2 lg:h-fit lg:flex-col lg:overflow-visible"
      >
        <StageButton
          label="All active"
          count={loading ? null : activeCount}
          active={stage === null}
          icon={<Users aria-hidden className="size-4" />}
          onClick={() => update({ stage: undefined })}
        />
        <ol className="flex gap-1 lg:ml-3 lg:flex-col lg:border-l lg:border-nw-border lg:pl-2">
          {LIVE_STAGES.map((s) => (
            <li key={s}>
              <StageButton
                label={HIRING_STAGE_LABELS[s]}
                count={loading ? null : count(s)}
                active={stage === s}
                onClick={() => update({ stage: s })}
              />
            </li>
          ))}
        </ol>
        <p className="hidden px-2 pt-2 text-2xs font-semibold tracking-wide text-faint uppercase lg:block">Completed</p>
        <StageButton
          label={HIRING_STAGE_LABELS.active_driver}
          count={loading ? null : count('active_driver')}
          active={stage === 'active_driver'}
          onClick={() => update({ stage: 'active_driver' })}
        />
      </nav>

      <div className="flex min-w-0 flex-col gap-4">
        <div className="flex flex-wrap items-center gap-3 rounded-[10px] border border-nw-border bg-nw-panel px-4 py-3">
          <span aria-hidden className="flex size-9 shrink-0 items-center justify-center rounded-full bg-info-soft text-info-text">
            <Info className="size-4" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-sm font-semibold text-ink">Safety manages document checks and hiring approval.</p>
            <p className="text-xs text-muted">
              A candidate's consents, documents and hiring decision live in the qualification file. This board reads them; it does
              not copy them. The offer opens only after Safety approves.
            </p>
          </div>
          {canSeeSafety ? (
            <Link
              to="/safety/compliance"
              search={{ tab: 'verification' } as never}
              className="inline-flex items-center gap-1 text-sm font-semibold text-primary-text hover:underline"
            >
              Open Safety <ArrowUpRight aria-hidden className="size-4" />
            </Link>
          ) : null}
        </div>

        <section className="rounded-[10px] border border-nw-border bg-nw-panel" aria-label={heading}>
          <header className="flex flex-wrap items-center gap-3 px-4 pt-4 pb-3">
            <h2 className="flex items-center gap-2 text-lg font-bold text-ink">
              {heading}
              <span className="tabular rounded-full bg-nw-subtle px-2 py-0.5 text-xs font-semibold text-secondary">
                {loading ? '…' : headingCount}
              </span>
            </h2>
            <div className="ml-auto flex w-full flex-col gap-2 sm:w-auto sm:flex-row">
              <label className="relative min-w-0 flex-1 sm:w-60 sm:flex-none">
                <span className="sr-only">Search candidates</span>
                <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2 text-muted" />
                <Input
                  className="pl-8"
                  placeholder="Search candidates…"
                  value={search.q ?? ''}
                  onChange={(e) => update({ q: e.target.value || undefined })}
                />
              </label>
              <Select
                aria-label="Recruiter"
                className="w-full sm:w-52"
                value={search.recruiter ?? ''}
                onValueChange={(v) => update({ recruiter: v || undefined })}
                options={[
                  { value: '', label: 'All recruiters' },
                  { value: '__none', label: 'Unassigned' },
                  ...recruiters.map((r) => ({ value: r, label: r })),
                ]}
              />
            </div>
          </header>

          {error ? (
            <div className="px-4 pb-4">
              <Alert tone="danger" title="The pipeline could not be loaded" description={error instanceof Error ? error.message : undefined} />
            </div>
          ) : loading ? (
            <p className="px-4 pb-6 text-sm text-muted">Loading…</p>
          ) : visible.length === 0 ? (
            <PanelEmpty
              icon={<Users />}
              title={q || search.recruiter ? 'Nobody matches the search' : stage ? `Nobody at ${HIRING_STAGE_LABELS[stage]}` : 'Nobody in the pipeline'}
              description={
                q || search.recruiter
                  ? 'Clear the search or pick another recruiter.'
                  : 'New people enter as leads. Convert a prequalified lead to start their application.'
              }
              action={
                q || search.recruiter ? (
                  <Button variant="outline" onClick={() => update({ q: undefined, recruiter: undefined })}>
                    Clear search
                  </Button>
                ) : (
                  <Button variant="outline" onClick={() => onOpenTab('leads')}>
                    Go to leads
                  </Button>
                )
              }
            />
          ) : (
            <ul className="flex flex-col gap-2 px-4 pb-4">
              {visible.slice(0, shown).map((row) => (
                <CandidateRow
                  key={row.key}
                  row={row}
                  canManage={canManage}
                  onOpenLead={(id) => onOpenTab('leads', { lead: id })}
                  onFollowUp={() =>
                    setFollowUp(
                      row.kind === 'lead'
                        ? { kind: 'lead', id: row.lead.id, name: row.name, phone: row.lead.phone, email: row.lead.email, leadIsNew: row.lead.status === 'new' }
                        : { kind: 'case', id: row.hc.id, name: row.name, phone: null, email: null },
                    )
                  }
                  onAssign={() =>
                    setAssign(
                      row.kind === 'lead'
                        ? { kind: 'lead', id: row.lead.id, name: row.name, currentId: row.lead.recruiterEmployeeId }
                        : { kind: 'case', id: row.hc.id, name: row.name, currentId: row.hc.recruiterId },
                    )
                  }
                  onDrop={row.kind === 'case' ? () => setDrop(row.hc) : undefined}
                />
              ))}
            </ul>
          )}
          {!loading && visible.length > shown ? (
            <div className="flex justify-center px-4 pb-4">
              <Button variant="outline" onClick={() => setShown((n) => n + 50)}>
                Show {Math.min(50, visible.length - shown)} more of {visible.length - shown}
              </Button>
            </div>
          ) : null}
          {truncated ? (
            <p className="px-4 pb-3 text-xs text-muted">Showing the oldest 200 leads per status here; the Leads tab lists every one.</p>
          ) : null}

          <footer className="flex flex-wrap gap-2 border-t border-nw-border px-4 py-3" aria-label="Ended">
            {HIRING_TERMINAL_STATES.map((s) => (
              <button
                key={s}
                type="button"
                aria-pressed={stage === s}
                onClick={() => update({ stage: stage === s ? undefined : s })}
                className={cn(
                  'inline-flex items-center gap-2 rounded-lg border px-2.5 py-1 text-xs font-medium transition-colors duration-(--duration-fast)',
                  stage === s ? 'border-primary-border bg-primary-soft text-primary-text' : 'border-nw-border bg-nw-panel text-secondary hover:bg-nw-hover',
                )}
              >
                <StatusSymbol family="neutral" size={11} />
                {HIRING_STAGE_LABELS[s]}
                <span className="tabular rounded-full bg-nw-subtle px-1.5 text-2xs font-semibold">{loading ? '…' : count(s)}</span>
              </button>
            ))}
          </footer>
        </section>
      </div>

      {followUp ? <FollowUpDialog target={followUp} onClose={() => setFollowUp(null)} /> : null}
      {assign ? <AssignRecruiterDialog target={assign} onClose={() => setAssign(null)} /> : null}
      {drop ? <DropCaseDialog hiringCase={drop} onClose={() => setDrop(null)} /> : null}
    </div>
  );
}

function StageButton({
  label,
  count,
  active,
  icon,
  onClick,
}: {
  label: string;
  count: number | null;
  active: boolean;
  icon?: React.ReactNode;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-current={active ? 'true' : undefined}
      className={cn(
        'flex w-full min-w-max items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm transition-colors duration-(--duration-fast) lg:min-w-0',
        'focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus',
        active ? 'bg-primary-soft font-semibold text-primary-text' : 'text-ink hover:bg-nw-hover',
      )}
    >
      {icon ?? (
        <span
          aria-hidden
          className={cn('size-3.5 shrink-0 rounded-full border-2', active ? 'border-primary bg-primary' : 'border-nw-border-strong bg-nw-panel')}
        />
      )}
      <span className="flex-1 truncate">{label}</span>
      <span className="tabular min-w-6 rounded-full bg-nw-subtle px-1.5 py-0.5 text-center text-xs font-semibold text-secondary">
        {count === null ? '…' : count}
      </span>
    </button>
  );
}

function CandidateRow({
  row,
  canManage,
  onOpenLead,
  onFollowUp,
  onAssign,
  onDrop,
}: {
  row: Row;
  canManage: boolean;
  onOpenLead: (id: string) => void;
  onFollowUp: () => void;
  onAssign: () => void;
  onDrop?: () => void;
}) {
  const navigate = useNavigate();
  const ended = row.kind === 'case' && isJourneyExit(journeyPlaceOfCase(row.hc.state));
  const open = () => {
    if (row.kind === 'lead') return onOpenLead(row.lead.id);
    if (row.hc.applicantId) {
      void navigate({ to: '/hr/recruiting/$candidateId', params: { candidateId: row.hc.applicantId } });
    } else if (row.hc.verificationCaseId) {
      void navigate({ to: '/safety/compliance', search: { tab: 'verification', case: row.hc.verificationCaseId } as never });
    }
  };
  const canOpen = row.kind === 'lead' || Boolean(row.hc.applicantId || row.hc.verificationCaseId);
  return (
    <li
      className="grid items-center gap-3 rounded-[10px] border border-nw-border bg-nw-panel p-3 transition-colors duration-(--duration-fast) hover:border-nw-border-strong sm:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)_11.5rem] sm:gap-4 sm:p-4"
      data-testid="pipeline-row"
    >
      <div className="flex min-w-0 items-center gap-3">
        <Avatar name={row.name} size="lg" />
        <div className="min-w-0">
          <p className="truncate font-semibold text-ink" title={row.name}>
            {row.name}
          </p>
          <p className={cn('flex flex-wrap items-center gap-x-1.5 text-xs', row.stuck ? 'text-nw-warning-text' : 'text-muted')}>
            <span>{row.recruiterName ?? 'Unassigned'}</span>
            <span aria-hidden>·</span>
            {row.stuck ? <StatusSymbol family="warning" size={11} className="text-nw-warning-icon" /> : null}
            <span>
              {ended && row.kind === 'case' && row.hc.closedAt
                ? `Ended ${formatIsoDate(row.hc.closedAt.slice(0, 10))}`
                : `${row.days} day${row.days === 1 ? '' : 's'} in stage${row.stuck ? ' · overdue' : ''}`}
            </span>
          </p>
          <div className="mt-1.5">
            {row.kind === 'lead' ? (
              <Badge tone={row.lead.status === 'prequalified' ? 'success' : 'info'} icon={<CircleDot aria-hidden className="size-3.5" />}>
                {row.lead.status === 'new' ? 'New lead' : row.lead.status === 'contacted' ? 'Contacted' : 'Prequalified'}
              </Badge>
            ) : (
              <StageChip state={row.hc.state} />
            )}
          </div>
        </div>
      </div>
      <div className="min-w-0 sm:border-l sm:border-nw-border sm:pl-4">
        <p className="text-xs text-muted">{ended ? 'Why it ended' : 'Next step'}</p>
        <p className="text-sm font-medium text-ink">
          {nextStep(row)}
          {ended && row.kind === 'case' && row.hc.endNote ? <span className="text-muted"> — {row.hc.endNote}</span> : null}
        </p>
      </div>
      <div className="flex items-center gap-2 sm:justify-end">
        <Button variant="primary" onClick={open} disabled={!canOpen} title={canOpen ? undefined : 'This case has no candidate record to open'}>
          {row.kind === 'lead' ? 'Open lead' : 'Open candidate'}
        </Button>
        {canManage && !ended ? (
          <DropdownMenu
            trigger={
              <IconButton label={`More actions for ${row.name}`} variant="ghost">
                <MoreHorizontal />
              </IconButton>
            }
          >
            <MenuItem onSelect={onFollowUp}>Record a follow-up</MenuItem>
            <MenuItem onSelect={onAssign}>{row.recruiterName ? 'Change recruiter' : 'Assign recruiter'}</MenuItem>
            {onDrop && row.kind === 'case' && canDropCase(row.hc) ? (
              <MenuItem onSelect={onDrop}>
                <span className="text-danger-text">Drop from hiring…</span>
              </MenuItem>
            ) : null}
          </DropdownMenu>
        ) : null}
      </div>
    </li>
  );
}
