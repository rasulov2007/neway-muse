import { Link, type LinkProps } from '@tanstack/react-router';
import {
  CalendarDays,
  CalendarRange,
  Calendar,
  Check,
  ChevronLeft,
  ChevronRight,
  Clock,
  Eye,
  FileSpreadsheet,
  Link2,
  Loader2,
  Pencil,
  Percent,
  ShieldCheck,
  TrendingUp,
  TriangleAlert,
  Wallet,
  type LucideIcon,
  House,
  Palmtree,
  Repeat,
  UserX,
} from 'lucide-react';
import { useMemo, type ReactNode } from 'react';
import { addDays, payBlockOf, weekStartMonday } from '@neway/shared';
import { useAccount } from '@/features/auth/auth-context';
import { today as companyToday } from '@/lib/clock';
import { Badge, cn } from '@/design-system';
import type { SaveState, Sheet } from './useSheet';

/**
 * The small chrome the board pages share: the compact page bar, the Admin / Editing / View only
 * pill, the Saving · Saved · Save failed indicator, the period stepper, the board's sub-nav and
 * the undo bar. All restrained: the boards are the page, not the chrome.
 */

/**
 * `pay` marks the three pages that are about what dispatchers earn rather than about freight.
 * They take `dispatch_pay.view`, which the administrator holds and a dispatch lead does not.
 */
const BOARD_NAV: { label: string; to: LinkProps['to']; icon: LucideIcon; permission?: string; anyOf?: string[] }[] = [
  { label: 'Daily Board', to: '/dispatch/daily', icon: CalendarDays, anyOf: ['dispatch.view', 'board_daily.view'] },
  { label: 'Weekly Board', to: '/dispatch/weekly', icon: CalendarRange, anyOf: ['dispatch.view', 'board_weekly.view'] },
  { label: 'Performance', to: '/dispatch/performance', icon: TrendingUp, anyOf: ['dispatch.view', 'board_performance.view'] },
  { label: 'Weekly Report', to: '/dispatch/weekly/report', icon: FileSpreadsheet, permission: 'dispatch_pay.view' },
  { label: 'Commission', to: '/dispatch/commission', icon: Percent, permission: 'dispatch_pay.view' },
  { label: 'Salary Report', to: '/dispatch/salary', icon: Wallet, permission: 'dispatch_pay.view' },
  { label: 'Detention & Layover', to: '/dispatch/claims', icon: Clock, anyOf: ['dispatch.view', 'board_claims.view'] },
  { label: 'Match rows to drivers', to: '/dispatch/roster-match', icon: Link2, permission: 'dispatch.manage' },
  // Owner, 2026-10-16: drivers away on vacation (everyone who sees the board), and the dispatcher
  // rotation report (administrators and dispatch leads).
  { label: 'On vacation', to: '/dispatch/vacations', icon: Palmtree, anyOf: ['dispatch.view', 'drivers.view'] },
  // Owner, 2026-10-30: drivers HOME on the Daily board, beside On vacation.
  { label: 'At home', to: '/dispatch/at-home', icon: House, anyOf: ['dispatch.view', 'board_daily.view'] },
  { label: 'Dispatcher rotation', to: '/dispatch/rotation', icon: Repeat, permission: 'dispatch.manage' },
  // Owner, 2026-10-25: the drivers with no dispatcher, off the Daily Board onto a page of their own.
  { label: 'Unassigned drivers', to: '/dispatch/unassigned', icon: UserX, anyOf: ['dispatch.view', 'board_daily.view'] },
];

/** The board pages this set of permissions may open, in sub-nav order. */
export function boardNavFor(held: readonly string[]): typeof BOARD_NAV {
  return BOARD_NAV.filter((n) => (n.anyOf ? n.anyOf.some((code) => held.includes(code)) : !n.permission || held.includes(n.permission)));
}

/**
 * The boards' own sub-nav — the only way between the board pages (the sidebar has one
 * "Dispatch board" link, owner 2026-09-29). A Porcelain segmented track: icon + word per page,
 * the current one lifted onto the panel.
 *
 * It reads the account itself rather than taking a prop: six pages render this bar, and a single
 * one of them passing the wrong flag would put a link to somebody's salary in front of a
 * dispatcher.
 */
export function BoardNav({ current }: { current: LinkProps['to'] }) {
  const account = useAccount();
  const held = account?.permissions ?? [];
  return (
    <nav
      aria-label="Boards"
      className="flex max-w-full flex-wrap items-center gap-0.5 self-start rounded-[9px] bg-nw-segment p-[3px]"
    >
      {boardNavFor(held).map((n) => {
        const active = n.to === current;
        const Icon = n.icon;
        return (
          <Link
            key={n.label}
            to={n.to}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex h-8 items-center gap-1.5 whitespace-nowrap rounded-md px-3 text-[13px] font-semibold',
              'transition-colors duration-(--duration-base) ease-(--ease-standard)',
              active
                ? 'bg-nw-panel text-nw-accent-ink shadow-segment ring-1 ring-nw-border'
                : 'text-nw-text-2 hover:bg-nw-hover hover:text-nw-text',
            )}
          >
            <Icon aria-hidden className="size-4" />
            {n.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * One row: the board tabs on the left, the controls on the right; no hero, no cards (owner,
 * 2026-10-01: the tabs moved up into the title's place). The page name stays as a hidden h1 for
 * screen readers; `meta`, when a page needs it, is a small line under the row.
 */
export function BoardBar({
  title,
  current,
  meta,
  children,
}: {
  title: string;
  current: LinkProps['to'];
  meta?: ReactNode;
  children?: ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="sr-only">{title}</h1>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <BoardNav current={current} />
        <div className="ml-auto flex flex-wrap items-center gap-1.5">{children}</div>
      </div>
      {meta ? <p className="text-[12px] text-nw-text-2">{meta}</p> : null}
    </div>
  );
}

export function AccessPill({ canWrite, canManage }: { canWrite: boolean; canManage: boolean }) {
  if (canManage)
    return (
      <Badge tone="success" size="sm" icon={<ShieldCheck />}>
        Admin
      </Badge>
    );
  if (canWrite)
    return (
      <Badge tone="info" size="sm" icon={<Pencil />}>
        Editing
      </Badge>
    );
  return (
    <Badge tone="neutral" size="sm" icon={<Eye />}>
      View only
    </Badge>
  );
}

export function SaveIndicator({ state, onDismiss }: { state: SaveState; onDismiss: () => void }) {
  if (state.kind === 'idle') return null;
  if (state.kind === 'saving')
    return (
      <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-nw-text-2" role="status">
        <Loader2 className="size-3.5 animate-spin" aria-hidden /> Saving…
      </span>
    );
  if (state.kind === 'saved')
    return (
      <span className="inline-flex items-center gap-1 text-[12px] font-semibold text-nw-done-text" role="status">
        <Check className="size-3.5" aria-hidden /> Saved
      </span>
    );
  return (
    <button
      type="button"
      onClick={onDismiss}
      title={state.message}
      className="inline-flex items-center gap-1 rounded-md bg-nw-urgent-bg px-2 py-0.5 text-[12px] font-semibold text-nw-urgent-text"
      role="alert"
    >
      <TriangleAlert className="size-3.5" aria-hidden /> {state.conflict ? 'Conflict · reload to see the newer value' : 'Save failed'}
    </button>
  );
}

/**
 * Prev / next arrows around the period. With `options` it is a list that opens downward and the
 * arrows go: the list is the one way to move (owner, 2026-10-19).
 */
export function PeriodStepper({
  label,
  onPrev,
  onNext,
  prevLabel,
  nextLabel,
  options,
  value,
  onPick,
}: {
  label: ReactNode;
  onPrev: () => void;
  onNext: () => void;
  prevLabel: string;
  nextLabel: string;
  options?: { value: string; label: string; group?: string }[];
  value?: string;
  onPick?: (value: string) => void;
}) {
  const groups = useMemo(() => {
    const map = new Map<string, { value: string; label: string }[]>();
    for (const o of options ?? []) map.set(o.group ?? '', [...(map.get(o.group ?? '') ?? []), o]);
    return [...map];
  }, [options]);
  const known = (options ?? []).some((o) => o.value === value);
  const listed = Boolean(options && value !== undefined && onPick);
  return (
    <div className="flex h-8 items-center gap-0.5 rounded-md border border-nw-border-strong bg-nw-panel px-0.5" role="group" aria-label="Period">
      {listed ? null : (
        <button type="button" aria-label={prevLabel} onClick={onPrev} className="grid size-7 place-items-center rounded text-nw-text-2 hover:bg-nw-hover">
          <ChevronLeft className="size-4" aria-hidden />
        </button>
      )}
      {options && value !== undefined && onPick ? (
        <select aria-label="Period" value={value} onChange={(e) => onPick!(e.target.value)} className="h-7 rounded bg-nw-panel px-2 text-[12.5px] font-bold text-nw-text outline-none">
          {known ? null : <option value={value}>{typeof label === 'string' ? label : value}</option>}
          {groups.map(([group, items]) =>
            group ? (
              <optgroup key={group} label={group}>
                {items.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </optgroup>
            ) : (
              items.map((o) => (
                <option key={o.value} value={o.value}>
                  {o.label}
                </option>
              ))
            ),
          )}
        </select>
      ) : (
        <span className="inline-flex items-center gap-1.5 px-1.5 text-[12.5px] font-bold whitespace-nowrap text-nw-text">
          <Calendar className="size-3.5 text-nw-text-3" aria-hidden />
          {label}
        </span>
      )}
      {listed ? null : (
        <button type="button" aria-label={nextLabel} onClick={onNext} className="grid size-7 place-items-center rounded text-nw-text-2 hover:bg-nw-hover">
          <ChevronRight className="size-4" aria-hidden />
        </button>
      )}
    </div>
  );
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const mmdd = (d: string) => `${d.slice(5, 7)}/${d.slice(8, 10)}`;
const monDay = (d: string) => `${MONTHS[Number(d.slice(5, 7)) - 1]} ${d.slice(8, 10)}`;

/**
 * The sheet's week picker: the weeks up to the one we are in, newest first, grouped by pay period
 * ("Sep 07 – Sep 27"), each week as "Week 3 · 09/21-09/27". Prev / next arrows either side.
 */
export function WeekPicker({ week, onChange, label: name = 'Week' }: { week: string; onChange: (weekStart: string) => void; label?: string }) {
  const today = companyToday();
  const weeks = useMemo(() => {
    // The list ends at the week we are in: next week appears only once the calendar reaches it.
    // A later week reached with the arrow still shows, so the control never sits on a blank value.
    const current = weekStartMonday(today);
    const newest = week > current ? week : current;
    const list: string[] = [];
    for (let w = newest; list.length < 27; w = addDays(w, -7)) list.push(w);
    if (!list.includes(week)) list.push(week);
    list.sort((a, b) => (a < b ? 1 : -1));
    const groups = new Map<string, { label: string; weeks: string[] }>();
    for (const w of list) {
      const b = payBlockOf(w);
      // A pay period still running is labelled to the last week it actually holds, not to its end.
      const g = groups.get(b.start) ?? { label: `${monDay(b.start)} – ${monDay(addDays(w, 6))}`, weeks: [] };
      g.weeks.push(w);
      groups.set(b.start, g);
    }
    return [...groups.values()];
  }, [week, today]);
  const label = (w: string) => `Week ${payBlockOf(w).week} · ${mmdd(w)}-${mmdd(addDays(w, 6))}`;
  return (
    <div className="flex h-8 items-center gap-0.5 rounded-md border border-nw-border-strong bg-nw-panel px-0.5" role="group" aria-label={name}>
      <button type="button" aria-label="Previous week" onClick={() => onChange(addDays(week, -7))} className="grid size-7 place-items-center rounded text-nw-text-2 hover:bg-nw-hover">
        <ChevronLeft className="size-4" aria-hidden />
      </button>
      <select aria-label={name} value={week} onChange={(e) => onChange(e.target.value)} className="h-7 rounded bg-nw-panel px-1 text-[12.5px] font-bold text-nw-text outline-none">
        {weeks.map((g) => (
          <optgroup key={g.label} label={g.label}>
            {g.weeks.map((w) => (
              <option key={w} value={w}>
                {label(w)}
              </option>
            ))}
          </optgroup>
        ))}
      </select>
      <button type="button" aria-label="Next week" onClick={() => onChange(addDays(week, 7))} className="grid size-7 place-items-center rounded text-nw-text-2 hover:bg-nw-hover">
        <ChevronRight className="size-4" aria-hidden />
      </button>
    </div>
  );
}

export function UndoBar({ sheet }: { sheet: Sheet }) {
  if (!sheet.undoBar) return null;
  return (
    <div className="fixed bottom-4 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-lg bg-nw-text px-4 py-2 text-[13px] text-nw-panel shadow-md">
      <span>{sheet.undoBar.label}</span>
      <button type="button" onClick={() => void sheet.undo()} className="font-bold text-nw-accent underline-offset-2 hover:underline">
        Undo
      </button>
      <button type="button" aria-label="Dismiss" onClick={sheet.dismissUndoBar} className="opacity-70 hover:opacity-100">
        ×
      </button>
    </div>
  );
}

/** The efficiency pill of the sheet: coloured pill with the percentage and a thin bar under it. */
export function EffPill({ total, goal }: { total: number; goal: number }) {
  const value = goal > 0 ? (total / goal) * 100 : 0;
  const tone = value >= 100 ? 'green' : value >= 60 ? 'amber' : 'red';
  const pillClass = { green: 'bg-(--bd-green-bg) text-(--bd-green-text)', amber: 'bg-(--bd-amber-bg) text-(--bd-amber-text)', red: 'bg-(--bd-red-bg) text-(--bd-red-text)' }[tone];
  const barClass = { green: 'bg-(--bd-green)', amber: 'bg-(--bd-amber)', red: 'bg-(--bd-red)' }[tone];
  return (
    <span className="inline-flex w-14 flex-col items-stretch gap-0.5">
      <span className={cn('tabular inline-flex h-5 items-center justify-center rounded-md text-[11.5px] font-bold', pillClass)}>{value.toFixed(1)}%</span>
      <span className="h-[3px] overflow-hidden rounded-full bg-(--bd-chip)">
        <span className={cn('block h-full rounded-full', barClass)} style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </span>
    </span>
  );
}

export function Hint({ children }: { children: ReactNode }) {
  return <span className="text-[11.5px] text-nw-text-3">{children}</span>;
}
