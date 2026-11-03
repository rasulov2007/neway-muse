import { Link, useNavigate } from '@tanstack/react-router';
import { CheckCircle2, ClipboardCheck, Clock, DollarSign, FileText, MoreVertical, Phone, Search, ShieldCheck, UserPlus, Users, X } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  CANDIDATE_SAFETY_LABELS,
  RECRUIT_BOARD_COLUMNS,
  RECRUIT_PROGRESS,
  RECRUIT_BOARD_COLUMN_LABELS,
  type RecruitBoardCard,
  type RecruitBoardColumn,
  type RecruitScope,
} from '@neway/shared';
import { Button, DropdownMenu, MenuItem, Select, cn } from '@/design-system';
import { ApiError } from '@/lib/api-client';
import { formatPhone } from '@/lib/format';
import type { HrSearch } from '../hr-search';
import { ListStatusMenu } from './ListStatusMenu';
import { Initials, QuietState } from './RecruitKit';
import { ageLabel, shortDateTime } from './recruit-format';
import { useRecruitBoard, useRecruiters } from './useRecruit';

/** The column's dot: one token family per stage, the word beside it carries the meaning. */
const COLUMN_DOT: Record<RecruitBoardColumn, string> = {
  new_lead: 'bg-nw-urgent-icon',
  lead_screening: 'bg-nw-moving-icon',
  consent_sent: 'bg-nw-warning-icon',
  consent_received: 'bg-nw-done-icon',
  safety_review: 'bg-nw-warning-icon',
  application: 'bg-nw-moving-icon',
  onboarding: 'bg-nw-accent',
  ready_to_hire: 'bg-nw-done-icon',
  disqualified: 'bg-nw-urgent-icon',
};

const DRIVER_TYPE_SHORT: Record<NonNullable<RecruitBoardCard['driverType']>, { short: string; long: string }> = {
  company: { short: 'CD', long: 'Company driver' },
  lease_operator: { short: 'LO', long: 'Lease operator' },
  owner_operator: { short: 'OO', long: 'Owner operator' },
};

function useMinuteNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  return now;
}

/**
 * The candidate pipeline board (owner mockup, 2026-10-15): the six steps across the top, each
 * active candidate once under the step their derived progress falls in. Nothing moves by dragging;
 * every change goes through the candidate's journey, where the checks run.
 */
export function RecruitBoardView({
  search,
  update,
  canSeeAll,
  canManage,
}: {
  search: HrSearch;
  update: (patch: Record<string, unknown>) => void;
  canSeeAll: boolean;
  canManage: boolean;
}) {
  // My leads (owner, 2026-10-16): everyone can narrow the board to their own leads.
  const mineOnly = !canSeeAll || search.leads === 'mine';
  const scope: RecruitScope = mineOnly ? 'mine' : 'all';
  const recruiter = mineOnly ? undefined : search.recruiter;
  const board = useRecruitBoard({ scope, recruiter, q: search.q || undefined });
  const recruiters = useRecruiters(canSeeAll);
  const now = useMinuteNow();

  const [term, setTerm] = useState(search.q ?? '');
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    const t = window.setTimeout(() => update({ q: term.trim() || undefined }), 300);
    return () => window.clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [term]);

  const cards = board.data?.cards;
  const byColumn = useMemo(() => {
    const map = new Map<RecruitBoardColumn, RecruitBoardCard[]>(RECRUIT_BOARD_COLUMNS.map((c) => [c, []]));
    for (const c of cards ?? []) map.get(c.column)?.push(c);
    // New leads always on top (owner, 2026-10-15), then each step in journey order; inside a step
    // the newest first.
    for (const list of map.values()) {
      list.sort((a, b) => RECRUIT_PROGRESS.indexOf(a.progress) - RECRUIT_PROGRESS.indexOf(b.progress) || b.createdAt.localeCompare(a.createdAt) || a.key.localeCompare(b.key));
    }
    return map;
  }, [cards]);
  const count = (pred: (c: RecruitBoardCard) => boolean) => (cards ? cards.filter(pred).length : undefined);

  return (
    <div className="flex flex-col gap-4" data-testid="recruit-board">
      <div className="flex flex-col gap-3 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex flex-wrap items-center gap-2.5">
          <label className="relative w-full sm:w-72">
            <span className="sr-only">Search candidates</span>
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-nw-text-3" />
            <input
              type="text"
              value={term}
              onChange={(e) => setTerm(e.target.value)}
              placeholder="Search name, phone or email…"
              className="h-10 w-full rounded-[10px] border border-nw-border-strong bg-nw-field pr-9 pl-9 text-sm text-nw-text placeholder:text-nw-text-3 focus:border-nw-accent focus:outline-none"
              data-testid="board-search"
            />
            {term ? (
              <button type="button" aria-label="Clear search" onClick={() => setTerm('')} className="absolute top-1/2 right-2.5 -translate-y-1/2 rounded p-0.5 text-nw-text-3 hover:text-nw-text">
                <X className="size-4" />
              </button>
            ) : null}
          </label>
          {canSeeAll ? (
            <div role="group" aria-label="Whose leads" className="flex rounded-[10px] border border-nw-border-strong bg-nw-subtle p-0.5" data-testid="board-leads-scope">
              {([['all', 'All leads'], ['mine', 'My leads']] as const).map(([value, label]) => {
                const active = (value === 'mine') === mineOnly;
                return (
                  <button
                    key={value}
                    type="button"
                    aria-pressed={active}
                    onClick={() => update({ leads: value === 'mine' ? 'mine' : undefined, recruiter: undefined })}
                    className={cn(
                      'h-8 rounded-[8px] px-3 text-[13px] font-semibold transition-colors',
                      active ? 'bg-nw-panel text-nw-text shadow-sm' : 'text-nw-text-3 hover:text-nw-text-2',
                    )}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          ) : null}
          {canSeeAll && !mineOnly ? (
            <div className="w-full sm:w-56">
              <Select
                aria-label="Recruiter"
                value={recruiter ?? 'everyone'}
                onValueChange={(v) => update({ recruiter: v === 'everyone' ? undefined : v })}
                options={[
                  { value: 'everyone', label: 'All recruiters' },
                  { value: 'none', label: 'Unassigned' },
                  ...(recruiters.data ?? []).map((r) => ({ value: r.employeeId, label: r.name })),
                ]}
              />
            </div>
          ) : (
            <span className="rounded-[9px] border border-nw-border bg-nw-subtle px-3 py-2 text-[13px] text-nw-text-2" data-testid="board-scope">
              {board.data?.scope.label ?? 'Loading…'}
            </span>
          )}
        </div>
        <div className="grid grid-cols-2 gap-2.5 sm:grid-cols-4 xl:w-auto" data-testid="board-metrics">
          <SummaryCard icon={<Users />} label="Active candidates" value={count((c) => c.column !== 'disqualified')} loading={board.isPending} tone="text-nw-moving-icon" />
          <SummaryCard icon={<Clock />} label="Awaiting consent" value={count((c) => c.progress === 'consent_sent')} loading={board.isPending} tone="text-nw-warning-icon" />
          <SummaryCard icon={<ShieldCheck />} label="Safety review" value={count((c) => c.column === 'safety_review')} loading={board.isPending} tone="text-nw-accent" />
          <SummaryCard icon={<CheckCircle2 />} label="Ready to hire" value={count((c) => c.column === 'ready_to_hire')} loading={board.isPending} tone="text-nw-done-icon" />
        </div>
      </div>

      {board.isError && !board.data ? (
        <QuietState
          tone="error"
          title="The board could not load"
          description={board.error instanceof ApiError ? board.error.message : 'Check the connection and try again.'}
          action={<Button variant="outline" onClick={() => void board.refetch()}>Try again</Button>}
        />
      ) : (
        <div className="-mx-1 overflow-x-auto px-1 pb-2" data-testid="board-scroll">
          <div className="grid min-w-[2250px] grid-cols-9 gap-3">
            {RECRUIT_BOARD_COLUMNS.map((col) => (
              <Column key={col} column={col} cards={byColumn.get(col) ?? []} loading={board.isPending} now={now} canManage={canManage} searching={Boolean(search.q)} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function SummaryCard({ icon, label, value, loading, tone }: { icon: ReactNode; label: string; value: number | undefined; loading: boolean; tone: string }) {
  return (
    <div className="flex min-w-0 items-center gap-3 rounded-[12px] border border-nw-border bg-nw-panel px-3.5 py-2.5 shadow-sm">
      <span className={cn('shrink-0 [&_svg]:size-5', tone)} aria-hidden>
        {icon}
      </span>
      <div className="min-w-0">
        <p className="truncate text-xs text-nw-text-2">{label}</p>
        <p className="text-xl leading-tight font-bold text-nw-text tabular-nums">{loading || value === undefined ? 'Loading…' : value}</p>
      </div>
    </div>
  );
}

function Column({
  column,
  cards,
  loading,
  now,
  canManage,
  searching,
}: {
  column: RecruitBoardColumn;
  cards: RecruitBoardCard[];
  loading: boolean;
  now: number;
  canManage: boolean;
  searching: boolean;
}) {
  const head = RECRUIT_BOARD_COLUMN_LABELS[column];
  return (
    <section className="flex min-w-0 flex-col rounded-[14px] border border-nw-border bg-nw-subtle" aria-label={head.title} data-testid={`board-column-${column}`}>
      <header className="px-3.5 pt-3 pb-2.5">
        <div className="flex items-center gap-2">
          <span className={cn('size-2.5 shrink-0 rounded-full', COLUMN_DOT[column])} aria-hidden />
          <h2 className="min-w-0 flex-1 truncate text-[15px] font-bold text-nw-text">{head.title}</h2>
          <span className="rounded-full bg-nw-panel px-2 py-0.5 text-xs font-semibold text-nw-text-2 tabular-nums ring-1 ring-nw-border" data-testid="column-count">
            {loading ? '…' : cards.length}
          </span>
        </div>
        <p className="mt-0.5 truncate pl-[18px] text-xs text-nw-text-3">{head.subtitle}</p>
      </header>
      {/* Each column scrolls on its own, as tall as the screen allows, so the board's sideways
          scrollbar stays in view however long a column gets (owner, 2026-10-16). */}
      <div className="flex max-h-[max(440px,calc(100vh-300px))] flex-col gap-2.5 overflow-y-auto px-2.5 pb-2.5" data-testid="column-cards">
        {loading ? (
          <p className="px-1 py-6 text-center text-sm text-nw-text-3">Loading…</p>
        ) : cards.length === 0 ? (
          <p className="rounded-[10px] border border-dashed border-nw-border px-3 py-6 text-center text-[13px] text-nw-text-3">
            {searching ? 'No match here' : 'Nobody at this step'}
          </p>
        ) : (
          cards.map((c) => <Card key={c.key} card={c} now={now} canManage={canManage} />)
        )}
      </div>
    </section>
  );
}

/** One concise next action or blocking requirement, from what the server derived. */
function nextLine(c: RecruitBoardCard): { icon: ReactNode; text: string } {
  if (c.column === 'safety_review' && c.safety) return { icon: <ShieldCheck />, text: `Safety: ${CANDIDATE_SAFETY_LABELS[c.safety]}` };
  if (c.column === 'onboarding' || c.column === 'ready_to_hire') return { icon: <ClipboardCheck />, text: c.nextStep };
  if (c.column === 'application') return { icon: <FileText />, text: c.nextStep };
  return { icon: <ArrowStep />, text: c.nextStep };
}

function ArrowStep() {
  return (
    <svg viewBox="0 0 16 16" aria-hidden fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 8h9M8.5 4.5 12 8l-3.5 3.5" />
    </svg>
  );
}

function Card({ card: c, now, canManage }: { card: RecruitBoardCard; now: number; canManage: boolean }) {
  const navigate = useNavigate();
  const next = nextLine(c);
  const type = c.driverType ? DRIVER_TYPE_SHORT[c.driverType] : null;
  const open = () => void navigate({ to: '/hr/recruiting/$candidateId', params: { candidateId: c.key } });
  return (
    <article
      className="group relative flex min-w-0 cursor-pointer flex-col gap-2.5 rounded-[12px] border border-nw-border bg-nw-panel p-3 transition-colors duration-150 hover:border-nw-border-strong motion-reduce:transition-none"
      onClick={(e) => {
        // The status menu, the overflow menu and the buttons act on their own.
        if ((e.target as HTMLElement).closest('button, a, [role="menu"], [role="menuitem"]')) return;
        open();
      }}
      data-testid="board-card"
      data-column={c.column}
      data-progress={c.progress}
    >
      <div className="flex min-w-0 items-start gap-2.5">
        <Initials name={c.name} />
        <div className="min-w-0 flex-1">
          <Link
            to="/hr/recruiting/$candidateId"
            params={{ candidateId: c.key }}
            className="line-clamp-2 block text-[14.5px] leading-snug font-semibold break-words text-nw-text hover:underline focus-visible:underline"
            title={c.name}
          >
            {c.name || 'Unnamed candidate'}
          </Link>
          <p className="text-[13px] whitespace-nowrap text-nw-text-2 tabular-nums">{c.phone ? formatPhone(c.phone) : 'No phone'}</p>
        </div>
        <DropdownMenu
          align="end"
          trigger={
            <button type="button" aria-label={`More for ${c.name}`} className="-mr-1 inline-flex size-8 shrink-0 items-center justify-center rounded-[8px] text-nw-text-2 hover:bg-nw-hover hover:text-nw-text">
              <MoreVertical className="size-4" />
            </button>
          }
        >
          <MenuItem onSelect={open}>Open candidate</MenuItem>
          {c.phone ? (
            <MenuItem onSelect={() => window.open(`tel:${c.phone}`, '_self')} icon={<Phone />}>
              Call {formatPhone(c.phone)}
            </MenuItem>
          ) : null}
        </DropdownMenu>
      </div>

      <p className="truncate text-[13px] text-nw-text-2">
        Recruiter: {c.recruiter?.name ?? <span className="text-nw-warning-text">Unassigned</span>}
      </p>

      <div className="flex min-w-0 flex-wrap items-center gap-1.5">
        {type ? (
          <span title={type.long} className="inline-flex h-7 items-center rounded-[8px] bg-nw-subtle px-2 text-xs font-bold text-nw-text-2 ring-1 ring-nw-border ring-inset">
            {type.short}
          </span>
        ) : null}
        <ListStatusMenu row={c} size="sm" />
      </div>

      <p className="flex min-w-0 items-center gap-2 text-[13px] text-nw-text">
        <span className="shrink-0 text-nw-text-3 [&_svg]:size-3.5" aria-hidden>
          {next.icon}
        </span>
        <span className="truncate" title={next.text}>
          {next.text}
        </span>
      </p>

      {c.column === 'onboarding' || c.column === 'ready_to_hire' ? (
        c.costCents !== null ? (
          <p className="flex items-center gap-2 text-[13px] text-nw-text" data-testid="card-cost">
            <DollarSign aria-hidden className="size-3.5 text-nw-text-3" />
            {(c.costCents / 100).toLocaleString('en-US', { style: 'currency', currency: 'USD' })} recorded
          </p>
        ) : null
      ) : null}

      {c.column === 'ready_to_hire' && canManage ? (
        <Button
          variant="primary"
          size="sm"
          icon={<UserPlus />}
          className="w-full"
          onClick={() => void navigate({ to: '/hr/recruiting/$candidateId', params: { candidateId: c.key }, search: { action: 'hire' } as never })}
          data-testid="board-hire"
        >
          Hire driver
        </Button>
      ) : null}

      {c.stageSince ? (
        <p className="flex items-center gap-2 text-xs text-nw-text-3" title={`At this step since ${shortDateTime(c.stageSince)} (Eastern)`}>
          <Clock aria-hidden className="size-3.5" />
          {ageLabel(c.stageSince, now)}
        </p>
      ) : null}
    </article>
  );
}
