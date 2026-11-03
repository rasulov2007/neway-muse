import { useNavigate, useSearch } from '@tanstack/react-router';
import { ChevronDown, ChevronRight, ChevronUp, Info, Minus, Settings, Trophy } from 'lucide-react';
import { useMemo, useState } from 'react';
import {
  payBlockOf,
  periodOf,
  scoreBand,
  shiftPeriod,
  weekStartMonday,
  type PeriodKind,
  type PerformanceDriverRow,
  type PerformanceRow,
  type PerformanceTargets,
  type ScoreBand,
} from '@neway/shared';
import { Alert, Button, FormField, Input, Modal, cn, useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { today as companyToday } from '@/lib/clock';
import { formatMoney, formatNumber } from '@/lib/format';
import { usePerformance, useSavePerformanceTargets } from './api';
import { BoardNav } from './chrome';
import { salarySearchSchema } from './search';

/**
 * Dispatcher Performance: who is running the best board this period, and why.
 *
 * Four scores, each a percentage of a target the fleet sets, and OVERALL is their weighted
 * average. The ranking is by OVERALL, and under every name is the one number that turns a
 * leaderboard into something a person can act on — how far behind the rank above they are.
 *
 * A score that could not be measured is a dash, never a zero. A dispatcher with no trucks has no
 * efficiency; a week where no GPS arrival was recorded has no on-time. Printing 0% there would
 * rank somebody bottom for a thing that never happened, and the first person to notice would
 * stop believing the whole board.
 */

const KIND_LABEL: Record<PeriodKind, string> = {
  week: 'Week',
  pay_period: 'Pay period',
  month: 'Full Month',
};

/** Score colours: green at or above target, amber from 80%, red below. */
const BAND_CLASS: Record<ScoreBand, string> = {
  good: 'bg-nw-done-bg text-nw-done-text',
  warn: 'bg-nw-warning-bg text-nw-warning-text',
  bad: 'bg-nw-urgent-bg text-nw-urgent-text',
  none: 'text-nw-text-3',
};

/** The podium edges: gold, silver, bronze, then nothing. */
const PODIUM_EDGE = [
  'border-l-4 border-l-nw-warning-icon bg-nw-warning-bg/30',
  'border-l-4 border-l-nw-neutral-icon bg-nw-subtle',
  'border-l-4 border-l-nw-accent bg-nw-accent-tint/30',
];

const DASH = '—';

function pctText(value: number | null): string {
  return value === null ? DASH : `${value.toFixed(1)}%`;
}

function Score({ value, bar = false }: { value: number | null; bar?: boolean }) {
  const band = scoreBand(value);
  return (
    <span className="inline-flex flex-col items-center gap-0.5">
      <span
        className={cn(
          'inline-flex min-w-16 justify-center rounded-md px-2 py-0.5 text-[12.5px] font-bold tabular-nums',
          BAND_CLASS[band],
        )}
      >
        {pctText(value)}
      </span>
      {/* A short bar under efficiency: the one score people read as "how full is the week". */}
      {bar && value !== null ? (
        <span aria-hidden className="block h-1 w-16 overflow-hidden rounded-full bg-nw-subtle">
          <span
            className={cn(
              'block h-full rounded-full',
              band === 'good'
                ? 'bg-nw-done-icon'
                : band === 'warn'
                  ? 'bg-nw-warning-icon'
                  : 'bg-nw-urgent-icon',
            )}
            style={{ width: `${Math.min(100, Math.max(2, value))}%` }}
          />
        </span>
      ) : null}
    </span>
  );
}

/** ▲▼ against the previous period. No arrow at all when there is nothing to compare with. */
function Movement({ value }: { value: number | null }) {
  if (value === null) return null;
  if (value === 0) {
    return (
      <span className="inline-flex items-center text-[11px] font-bold text-nw-text-3">
        <Minus aria-hidden className="size-3" />
        <span className="sr-only">no change in rank</span>
      </span>
    );
  }
  const up = value > 0;
  return (
    <span
      className={cn(
        'inline-flex items-center gap-0.5 text-[11px] font-bold',
        up ? 'text-nw-done-text' : 'text-nw-urgent-text',
      )}
    >
      {up ? <ChevronUp aria-hidden className="size-3" /> : <ChevronDown aria-hidden className="size-3" />}
      {Math.abs(value)}
      <span className="sr-only">{up ? 'places up' : 'places down'} since the previous period</span>
    </span>
  );
}

/**
 * One number in the hero band.
 *
 * `band` tints the figure when the number is a score with a target behind it, so the state of the
 * fleet is readable before anything is compared. The label beside it always says what it is, so
 * the tint is an aid and never the message.
 */
function StatTile({
  label,
  value,
  note,
  band = 'none',
}: {
  label: string;
  value: string;
  note?: string;
  band?: ScoreBand;
}) {
  return (
    <div className="rounded-xl bg-nw-panel/[0.07] px-3 py-2.5 ring-1 ring-nw-panel/10 transition-colors hover:bg-nw-panel/[0.11]">
      <div className="text-[10px] font-bold tracking-[.08em] text-nw-panel/50 uppercase">{label}</div>
      <div
        className={cn(
          'mt-1 text-[21px] leading-none font-bold tracking-[-.01em] tabular-nums',
          band === 'good'
            ? 'text-nw-done-icon'
            : band === 'warn'
              ? 'text-nw-warning-icon'
              : band === 'bad'
                ? 'text-nw-urgent-icon'
                : 'text-nw-panel',
        )}
      >
        {value}
      </div>
      {note ? <div className="mt-1 text-[10px] text-nw-panel/45">{note}</div> : null}
    </div>
  );
}

/**
 * A dispatcher's face on the board, which this product does not have — so, their initials.
 *
 * The ring is the medal colour on the podium and quiet everywhere else. A photograph would be
 * better and there is nowhere to get one from, so this says who it is without pretending.
 */
function Avatar({
  name,
  size = 'md',
  ring,
}: {
  name: string;
  size?: 'sm' | 'md' | 'lg';
  ring?: 1 | 2 | 3;
}) {
  const initials = name
    .split(/[\s/]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((part) => part[0]?.toUpperCase() ?? '')
    .join('');
  return (
    <span
      aria-hidden
      className={cn(
        'inline-flex shrink-0 items-center justify-center rounded-full bg-nw-accent-ink font-bold text-nw-on-accent',
        size === 'lg'
          ? 'size-20 text-[24px]'
          : size === 'md'
            ? 'size-14 text-[17px]'
            : 'size-8 text-[12px]',
        ring === 1
          ? 'ring-3 ring-nw-warning-icon'
          : ring === 2
            ? 'ring-3 ring-nw-neutral-icon'
            : ring === 3
              ? 'ring-3 ring-nw-accent'
              : 'ring-1 ring-nw-border',
      )}
    >
      {initials || DASH}
    </span>
  );
}

/**
 * A place on the podium, on the dark band.
 *
 * The leader stands in the middle and a step higher, with the crown; the other two flank them.
 * Under each is what this company actually competes on — the gross that board booked — and the
 * one score that would move that person up, because a podium that only ranks is a poster.
 */
function PodiumCard({ row, place }: { row: PerformanceRow; place: 1 | 2 | 3 }) {
  const lift = weakest(row);
  return (
    <div className={cn('flex flex-col items-center text-center', place === 1 ? '' : 'md:pt-10')}>
      <div className="relative">
        <Avatar name={row.dispatcherName} size={place === 1 ? 'lg' : 'md'} ring={place} />
        {place === 1 ? (
          <span className="absolute -top-2 -right-2">
            <Crown />
          </span>
        ) : (
          <span
            className={cn(
              'absolute -right-1 -bottom-1 flex size-6 items-center justify-center rounded-full text-[12px] font-bold text-nw-status-glyph ring-2 ring-nw-text',
              place === 2 ? 'bg-nw-neutral-icon' : 'bg-nw-accent',
            )}
          >
            {place}
          </span>
        )}
      </div>

      <div
        className={cn('mt-2 font-bold text-nw-panel', place === 1 ? 'text-[19px]' : 'text-[15px]')}
        title={row.dispatcherNickname ? (row.dispatcherFullName ?? row.dispatcherName) : undefined}
      >
        {row.dispatcherNickname || row.dispatcherName}
      </div>
      <div className="mt-0.5 flex items-center gap-1.5">
        <Movement value={row.movement} />
        <span className="text-[11px] text-nw-panel/50">
          {row.loads} load{row.loads === 1 ? '' : 's'} · {formatNumber(row.miles)} mi
        </span>
      </div>

      {/* The plinth: what was booked, then the score it was judged on. */}
      <div
        className={cn(
          'mt-3 w-full rounded-[14px] bg-nw-panel/[0.07] px-4 ring-1 ring-nw-panel/10',
          place === 1 ? 'py-4' : 'py-3',
        )}
      >
        <div className="text-[10px] font-bold tracking-[.08em] text-nw-panel/45 uppercase">Booked</div>
        <div
          className={cn(
            'mt-0.5 font-bold tracking-[-.01em] text-nw-panel tabular-nums',
            place === 1 ? 'text-[26px]' : 'text-[20px]',
          )}
        >
          {formatMoney(row.gross)}
        </div>
        <div className="mt-2 flex items-center justify-center gap-1.5">
          <span className={cn('rounded-md px-2 py-0.5 text-[11px] font-bold', BAND_CLASS[scoreBand(row.overall)])}>
            {pctText(row.overall)}
          </span>
          <span className={cn('rounded-md px-2 py-0.5 text-[11px] font-semibold', BAND_CLASS[scoreBand(row.rpmPct)])}>
            {row.rpm === null ? `${DASH} RPM` : `$${row.rpm.toFixed(2)}`}
          </span>
        </div>
      </div>

      <p className="mt-2 text-[11px] text-nw-panel/45">
        {place === 1
          ? 'Holding the crown'
          : row.behindPct !== null
            ? `${row.behindPct.toFixed(1)}% off the lead`
            : ''}
      </p>
      {lift ? (
        <p className="text-[11px] text-nw-panel/35">
          Lift {LIFT_LABEL[lift.key]} · {LIFT_ADVICE[lift.key]}
        </p>
      ) : null}
    </div>
  );
}

/** The Week / Pay period / Month switch, as one segmented control rather than three buttons. */
function KindSwitch({ kind, onChange }: { kind: PeriodKind; onChange: (k: PeriodKind) => void }) {
  return (
    <div className="inline-flex rounded-full bg-nw-panel/10 p-0.5 ring-1 ring-nw-panel/10">
      {(['week', 'pay_period', 'month'] as PeriodKind[]).map((k) => (
        <button
          key={k}
          type="button"
          aria-pressed={k === kind}
          onClick={() => onChange(k)}
          className={cn(
            'rounded-full px-3.5 py-1 text-[12px] font-bold transition-colors',
            k === kind ? 'bg-nw-panel text-nw-text' : 'text-nw-panel/60 hover:text-nw-panel',
          )}
        >
          {KIND_LABEL[k]}
        </button>
      ))}
    </div>
  );
}

/** `09/21` — the short form the board's own pickers use. */
function shortDate(iso: string): string {
  const [, m, d] = iso.split('-');
  return `${m}/${d}`;
}

function monthDay(iso: string): string {
  const date = new Date(`${iso}T00:00:00Z`);
  return new Intl.DateTimeFormat('en-US', { month: 'short', day: '2-digit', timeZone: 'UTC' }).format(date);
}

interface PeriodOption {
  start: string;
  label: string;
  group: string;
}

/**
 * The periods a person can choose, newest first, each one labelled with the dates it covers.
 *
 * A period picker that says "Week 3" and nothing else asks the reader to hold a calendar in their
 * head. Weeks are grouped under the four-week pay block they belong to, which is how this company
 * already counts them on the Salary Report.
 */
function periodOptions(kind: PeriodKind, today: string, back = 26): PeriodOption[] {
  const out: PeriodOption[] = [];
  const current = periodOf(kind, today).start;
  for (let i = 0; i < back; i += 1) {
    const start = shiftPeriod(kind, current, -i);
    const { end } = periodOf(kind, start);
    if (kind === 'week') {
      const block = payBlockOf(weekStartMonday(start));
      out.push({
        start,
        label: `Week ${block.week} · ${shortDate(start)}-${shortDate(end)}`,
        group: `${monthDay(block.start)} – ${monthDay(block.end)}`,
      });
      continue;
    }
    if (kind === 'pay_period') {
      const block = payBlockOf(weekStartMonday(start));
      out.push({
        start,
        label: `Pay period ${block.block} · ${shortDate(start)}-${shortDate(end)}`,
        group: new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: 'UTC' }).format(
          new Date(`${start}T00:00:00Z`),
        ),
      });
      continue;
    }
    out.push({
      start,
      label: new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
        new Date(`${start}T00:00:00Z`),
      ),
      group: new Intl.DateTimeFormat('en-US', { year: 'numeric', timeZone: 'UTC' }).format(
        new Date(`${start}T00:00:00Z`),
      ),
    });
  }
  return out;
}

/** The picker itself: a native select, so it works on a phone and reads to a screen reader. */
function PeriodPicker({
  kind,
  value,
  onChange,
}: {
  kind: PeriodKind;
  value: string;
  onChange: (start: string) => void;
}) {
  const options = useMemo(() => periodOptions(kind, companyToday()), [kind]);
  const groups = useMemo(() => {
    const map = new Map<string, PeriodOption[]>();
    for (const option of options) {
      const list = map.get(option.group) ?? [];
      list.push(option);
      map.set(option.group, list);
    }
    return [...map];
  }, [options]);
  // A period reached with the arrows that is older than the list still has to be selectable.
  const known = options.some((o) => o.start === value);
  return (
    <select
      aria-label="Period"
      className="h-8 rounded-md border border-nw-panel/20 bg-nw-panel/10 px-2 text-[12.5px] font-semibold text-nw-panel"
      value={value}
      onChange={(e) => onChange(e.target.value)}
    >
      {known ? null : <option value={value}>{`${shortDate(value)} …`}</option>}
      {groups.map(([group, items]) => (
        <optgroup key={group} label={group}>
          {items.map((o) => (
            <option key={o.start} value={o.start}>
              {o.label}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

/**
 * The score holding a dispatcher back, and the sentence that says what to do about it.
 *
 * A leaderboard that only ranks is a scoreboard somebody reads once. The lowest of the four is
 * the one place effort pays, and naming it turns "you are fourth" into "book longer miles". It is
 * taken from the scores that exist — an unmeasured one is not a weakness, it is a blank.
 */
const LIFT_ADVICE: Record<'onTime' | 'rpm' | 'efficiency' | 'activity', string> = {
  onTime: 'hit more appointments on time',
  rpm: 'book better-paying freight',
  efficiency: 'keep every truck loaded',
  activity: 'put more miles under the trucks',
};

const LIFT_LABEL: Record<'onTime' | 'rpm' | 'efficiency' | 'activity', string> = {
  onTime: 'On-time',
  rpm: 'RPM',
  efficiency: 'Efficiency',
  activity: 'Activity',
};

function weakest(row: {
  onTimePct: number | null;
  rpmPct: number | null;
  efficiencyPct: number | null;
  activityPct: number | null;
}): { key: keyof typeof LIFT_LABEL; value: number } | null {
  const parts = [
    ['onTime', row.onTimePct],
    ['rpm', row.rpmPct],
    ['efficiency', row.efficiencyPct],
    ['activity', row.activityPct],
  ] as const;
  const measured = parts.filter((p): p is readonly [keyof typeof LIFT_LABEL, number] => p[1] !== null);
  if (measured.length === 0) return null;
  const [key, value] = measured.reduce((low, p) => (p[1] < low[1] ? p : low));
  return { key, value };
}

/** The crown the leader wears until somebody takes it. */
function Crown() {
  return (
    <span
      title="Top of the board"
      className="inline-flex size-6 items-center justify-center rounded-full bg-nw-warning-icon text-nw-status-glyph"
    >
      <Trophy aria-hidden className="size-3.5" />
      <span className="sr-only">leading this period</span>
    </span>
  );
}

const TH =
  'h-9 border-b border-nw-border px-3 text-[10.5px] font-bold tracking-[.04em] text-nw-text-3 uppercase whitespace-nowrap';
const TD = 'border-b border-nw-border px-3 py-2.5 text-[12.5px] text-nw-text whitespace-nowrap';

/**
 * A money figure wearing its score's colour.
 *
 * The number and the judgement of it are one thing on this board: `$67,491.00` in green says "on
 * target" without a second column to read. The word is still in the score column beside it, so the
 * colour is never carrying the meaning alone.
 */
function Money({ value, band, rpm = false }: { value: number | null; band: ScoreBand; rpm?: boolean }) {
  if (value === null) return <span className="text-nw-text-3">{DASH}</span>;
  return (
    <span
      className={cn(
        'inline-flex rounded-md px-2 py-0.5 font-semibold tabular-nums',
        BAND_CLASS[band],
      )}
    >
      {rpm ? `$${value.toFixed(2)}` : formatMoney(value)}
    </span>
  );
}

/** A `<tbody>` fragment: a dispatcher and the drivers opened under them, as one group of rows. */
function FragmentRows({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/**
 * One driver under an opened board.
 *
 * Indented and quieter than the dispatcher above it, and the two board-level columns — how many
 * drivers, how much per truck — are dashes, because a driver is one of the drivers and has one
 * truck. Everything else is the same measure against their own truck.
 */
function DriverRow({ driver }: { driver: PerformanceDriverRow }) {
  return (
    <tr className="bg-nw-subtle/40">
      <td className={TD} />
      <td className={TD}>
        <div className="flex items-center gap-2 pl-6">
          <span className="text-[12.5px] font-semibold text-nw-text-2">{driver.name}</span>
          {driver.payTag ? (
            <span className="rounded bg-nw-info-bg px-1.5 py-px text-[10.5px] font-bold text-nw-info-text">
              {driver.payTag}
            </span>
          ) : null}
          {driver.truckUnit ? (
            <span className="text-[11px] text-nw-text-3">#{driver.truckUnit}</span>
          ) : null}
        </div>
      </td>
      <td className={cn(TD, 'text-center text-nw-text-3')}>{DASH}</td>
      <td className={cn(TD, 'text-center tabular-nums')}>{driver.loads}</td>
      <td className={cn(TD, 'text-center tabular-nums')}>
        {driver.cancelled === 0 ? <span className="text-nw-text-3">{DASH}</span> : driver.cancelled}
      </td>
      <td className={cn(TD, 'text-right')}>
        <Money value={driver.gross} band={scoreBand(driver.efficiencyPct)} />
      </td>
      <td className={cn(TD, 'text-center text-nw-text-3')}>{DASH}</td>
      <td className={cn(TD, 'text-right tabular-nums')}>{formatNumber(driver.miles)}</td>
      <td className={cn(TD, 'text-right')}>
        <Money value={driver.rpm} band={scoreBand(driver.rpmPct)} rpm />
      </td>
      <td className={cn(TD, 'text-right tabular-nums')}>
        {driver.avgWeightLbs === null ? DASH : formatNumber(driver.avgWeightLbs)}
      </td>
      <td className={cn(TD, 'text-center text-nw-text-3')}>{pctText(driver.onTimePickupPct)}</td>
      <td className={cn(TD, 'text-center text-nw-text-3')}>{pctText(driver.onTimeDeliveryPct)}</td>
      <td className={cn(TD, 'text-center')}>
        <Score value={driver.onTimePct} />
      </td>
      <td className={cn(TD, 'text-center')}>
        <Score value={driver.rpmPct} />
      </td>
      <td className={cn(TD, 'text-center')}>
        <Score value={driver.efficiencyPct} bar />
      </td>
      <td className={cn(TD, 'text-center')}>
        <Score value={driver.activityPct} />
      </td>
      <td className={cn(TD, 'text-center')}>
        <Score value={driver.overall} />
      </td>
    </tr>
  );
}

export function PerformancePage() {
  const navigate = useNavigate();
  const account = useAccount();
  const canManage = account?.permissions.includes('dispatch.manage') ?? false;
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const search = useMemo(() => salarySearchSchema.parse(rawSearch), [rawSearch]);
  const kind: PeriodKind = search.kind ?? 'week';
  const date = search.date ?? companyToday();
  const board = usePerformance(kind, date);
  const [explaining, setExplaining] = useState(false);
  const [settingTargets, setSettingTargets] = useState(false);
  /* Which boards are open. Several at once: comparing two teams is the usual reason to open one. */
  const [opened, setOpened] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = (id: string) =>
    setOpened((current) => {
      const next = new Set(current);
      if (!next.delete(id)) next.add(id);
      return next;
    });

  const period = useMemo(() => periodOf(kind, date), [kind, date]);
  const move = (n: number) =>
    void navigate({
      to: '/dispatch/performance',
      search: { kind, date: shiftPeriod(kind, period.start, n) },
      replace: true,
    });
  const setKind = (next: PeriodKind) =>
    void navigate({ to: '/dispatch/performance', search: { kind: next, date }, replace: true });

  /* Memoised so the reader's own line is not recomputed on every render. */
  const rows = useMemo(() => board.data?.rows ?? [], [board.data?.rows]);
  const podium = rows.slice(0, 3);
  const summary = board.data?.summary;
  /*
   * The reader's own line. Matched on the dispatcher name, which is what the roster stores against
   * each driver — there is no dispatcher id on an account to join on yet. No match, no strip.
   */
  const mine = useMemo(() => {
    const name = account?.name?.trim().toLowerCase();
    if (!name) return null;
    return (
      rows.find(
        (r) =>
          r.dispatcherName.trim().toLowerCase() === name ||
          r.dispatcherFullName?.trim().toLowerCase() === name,
      ) ?? null
    );
  }, [rows, account?.name]);

  return (
    <div className="flex flex-col gap-3">
      <BoardNav current="/dispatch/performance" />

      {/*
       * The leaderboard itself: one dark stage carrying the title, the period, the podium and the
       * fleet's totals. The table below is the detail; this is the standing.
       */}
      <section className="relative overflow-hidden rounded-[16px] bg-linear-to-b from-nw-text via-nw-text to-nw-accent-ink px-5 pt-4 pb-5">
        {/* The arc of light behind the winner, and a trophy watermark in the corner. */}
        <span
          aria-hidden
          className="pointer-events-none absolute -top-40 left-1/2 size-[560px] -translate-x-1/2 rounded-full bg-nw-accent/20 blur-3xl"
        />
        <Trophy
          aria-hidden
          className="pointer-events-none absolute -top-8 -right-8 size-52 text-nw-panel/[0.03]"
        />

        <div className="relative flex flex-wrap items-start justify-between gap-3">
          <div>
            <div className="flex items-center gap-2">
              <span className="flex size-8 items-center justify-center rounded-[10px] bg-nw-warning-icon/20 text-nw-warning-icon">
                <Trophy aria-hidden className="size-4.5" />
              </span>
              <h2 className="text-[17px] font-bold tracking-[-.01em] text-nw-panel">
                Dispatcher Performance
              </h2>
            </div>
            <p className="mt-1 text-[11.5px] text-nw-panel/50">
              {board.isPending
                ? 'Loading…'
                : `${period.start} → ${period.end} · ${board.data?.weeks.toFixed(1) ?? DASH} week${(board.data?.weeks ?? 0) === 1 ? '' : 's'}`}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-1.5">
            <Button size="sm" variant="secondary" icon={<Info />} onClick={() => setExplaining(true)}>
              How it works
            </Button>
            <Button size="sm" variant="secondary" onClick={() => move(-1)} aria-label="Previous period">
              ‹
            </Button>
            <PeriodPicker
              kind={kind}
              value={period.start}
              onChange={(start) =>
                void navigate({ to: '/dispatch/performance', search: { kind, date: start }, replace: true })
              }
            />
            <Button size="sm" variant="secondary" onClick={() => move(1)} aria-label="Next period">
              ›
            </Button>
            {canManage ? (
              <Button size="sm" variant="secondary" icon={<Settings />} onClick={() => setSettingTargets(true)}>
                Settings
              </Button>
            ) : null}
          </div>
        </div>

        <div className="relative mt-3 flex justify-center">
          <KindSwitch kind={kind} onChange={setKind} />
        </div>

        {/* The podium: second, first, third — the leader in the middle and a step higher. */}
        {podium.length > 0 ? (
          <div className="relative mt-5 grid items-end gap-4 md:grid-cols-3">
            {podium[1] ? <PodiumCard row={podium[1]} place={2} /> : <div />}
            <PodiumCard row={podium[0]!} place={1} />
            {podium[2] ? <PodiumCard row={podium[2]} place={3} /> : <div />}
          </div>
        ) : board.isPending ? (
          <p className="relative mt-6 text-center text-[12.5px] text-nw-panel/50">Loading…</p>
        ) : (
          <p className="relative mt-6 text-center text-[12.5px] text-nw-panel/50">
            No dispatcher has a board in this period.
          </p>
        )}

        {/* Where the person reading it stands. The whole reason to open a leaderboard. */}
        {mine ? (
          <p className="relative mx-auto mt-5 w-fit rounded-full bg-nw-panel/[0.07] px-4 py-1.5 text-[12px] text-nw-panel/70 ring-1 ring-nw-panel/10">
            You are <span className="font-bold text-nw-panel">#{mine.rank}</span> of {rows.length} on{' '}
            <span className="font-bold text-nw-panel">{pctText(mine.overall)}</span>
            {mine.behindPct !== null ? (
              <span className="text-nw-panel/50"> · {mine.behindPct.toFixed(1)}% off #{mine.rank - 1}</span>
            ) : (
              <span className="text-nw-warning-icon"> · you are holding the crown</span>
            )}
          </p>
        ) : null}

        <div className="relative mt-5 grid grid-cols-2 gap-2 sm:grid-cols-4 xl:grid-cols-8">
          <StatTile label="Dispatchers" value={summary ? String(summary.dispatchers) : DASH} />
          <StatTile
            label="Loads"
            value={summary ? formatNumber(summary.loads) : DASH}
            note={summary ? `${summary.cancelled} cancelled` : undefined}
          />
          <StatTile label="Revenue" value={summary ? formatMoney(summary.gross) : DASH} />
          <StatTile label="Miles" value={summary ? formatNumber(summary.miles) : DASH} />
          <StatTile
            label="Fleet RPM"
            value={summary?.rpm === null || !summary ? DASH : `$${summary.rpm.toFixed(2)}`}
            note={board.data ? `target $${board.data.targets.rpm.toFixed(2)}` : undefined}
            band={
              summary?.rpm != null && board.data
                ? scoreBand((summary.rpm / board.data.targets.rpm) * 100)
                : 'none'
            }
          />
          <StatTile
            label="On-time"
            value={pctText(summary?.onTimePct ?? null)}
            band={scoreBand(summary?.onTimePct ?? null)}
          />
          <StatTile
            label="Avg overall"
            value={pctText(summary?.avgOverall ?? null)}
            note="score"
            band={scoreBand(summary?.avgOverall ?? null)}
          />
          <StatTile
            label="Efficiency"
            value={pctText(summary?.efficiencyPct ?? null)}
            note={board.data ? `$${formatNumber(board.data.targets.grossPerTruckWeek)}/truck/wk` : undefined}
            band={scoreBand(summary?.efficiencyPct ?? null)}
          />
        </div>
      </section>

      {board.isError ? <Alert tone="danger">The performance board could not be read.</Alert> : null}

      <div className="overflow-x-auto rounded-[10px] border border-nw-border bg-nw-panel">
        <table className="w-full border-collapse">
          <thead>
            <tr>
              <th className={cn(TH, 'text-left')}>Rank</th>
              <th className={cn(TH, 'text-left')}>Dispatcher / driver</th>
              <th className={TH}>Drv / Truck</th>
              <th className={TH}>Loads</th>
              <th className={TH}>CXL</th>
              <th className={cn(TH, 'text-right')}>Total gross</th>
              <th className={cn(TH, 'text-right')}>Avg / truck</th>
              <th className={cn(TH, 'text-right')}>Miles</th>
              <th className={cn(TH, 'text-right')}>RPM</th>
              <th className={cn(TH, 'text-right')}>Avg wt</th>
              <th className={TH}>OT pick</th>
              <th className={TH}>OT del</th>
              <th className={TH}>On-time</th>
              <th className={TH}>RPM%</th>
              <th className={TH}>Efficiency</th>
              <th className={TH}>Activity%</th>
              <th className={TH}>Overall</th>
            </tr>
          </thead>
          <tbody>
            {board.isPending ? (
              <tr>
                <td className={cn(TD, 'text-center text-nw-text-3')} colSpan={17}>
                  Loading…
                </td>
              </tr>
            ) : rows.length === 0 ? (
              <tr>
                <td className={cn(TD, 'text-center text-nw-text-3')} colSpan={17}>
                  No dispatcher has a board in this period.
                </td>
              </tr>
            ) : (
              rows.map((row) => {
                const open = opened.has(row.dispatcherId);
                return (
                  <FragmentRows key={row.dispatcherId}>
                    <tr
                      className={cn(
                        'cursor-pointer transition-colors hover:bg-nw-hover',
                        PODIUM_EDGE[row.rank - 1] ?? '',
                      )}
                      onClick={() => toggle(row.dispatcherId)}
                    >
                      <td className={TD}>
                        <div className="flex flex-col items-start gap-0.5">
                          {row.rank === 1 ? (
                            <Crown />
                          ) : (
                            <span
                              className={cn(
                                'flex size-6 shrink-0 items-center justify-center rounded-full text-[11.5px] font-bold',
                                row.rank === 2
                                  ? 'bg-nw-neutral-icon text-nw-status-glyph'
                                  : row.rank === 3
                                    ? 'bg-nw-accent text-nw-on-accent'
                                    : 'bg-nw-subtle text-nw-text-2',
                              )}
                            >
                              {row.rank}
                            </span>
                          )}
                          <Movement value={row.movement} />
                        </div>
                      </td>
                      <td className={TD}>
                        <div className="flex items-center gap-1.5">
                          {/*
                            * The whole row is the target — a four-pixel chevron is not something to
                            * ask a dispatcher to hit. `aria-expanded` is on the button so the state
                            * is announced rather than only drawn.
                            */}
                          <button
                            type="button"
                            aria-expanded={open}
                            aria-label={`${open ? 'Hide' : 'Show'} the drivers on ${row.dispatcherName}'s board`}
                            className="text-nw-text-3 hover:text-nw-text"
                            onClick={(e) => {
                              e.stopPropagation();
                              toggle(row.dispatcherId);
                            }}
                          >
                            {open ? (
                              <ChevronDown aria-hidden className="size-4" />
                            ) : (
                              <ChevronRight aria-hidden className="size-4" />
                            )}
                          </button>
                          <Avatar name={row.dispatcherName} size="sm" />
                          <div>
                            <div
                              className={cn(
                                'font-bold',
                                row.rank === 1 ? 'text-nw-warning-text' : 'text-nw-text',
                              )}
                            >
                              <span title={row.dispatcherNickname ? (row.dispatcherFullName ?? row.dispatcherName) : undefined}>
                                {row.dispatcherNickname || row.dispatcherName}
                              </span>
                            </div>
                            {row.behindPct !== null ? (
                              <div className="text-[11px] text-nw-text-3">
                                {row.behindPct.toFixed(1)}% behind #{row.rank - 1}
                                {(() => {
                                  const lift = weakest(row);
                                  return lift ? (
                                    <>
                                      {' · lift '}
                                      <span className="font-semibold text-nw-text-2">
                                        {LIFT_LABEL[lift.key]}
                                      </span>
                                    </>
                                  ) : null;
                                })()}
                              </div>
                            ) : row.rank === 1 ? (
                              <div className="text-[11px] font-semibold text-nw-warning-text">
                                Holding the crown
                              </div>
                            ) : null}
                          </div>
                        </div>
                      </td>
                      <td className={cn(TD, 'text-center tabular-nums')}>
                        {row.drivers} / {row.trucks}
                      </td>
                      <td className={cn(TD, 'text-center tabular-nums')}>{row.loads}</td>
                      <td className={cn(TD, 'text-center tabular-nums')}>
                        {row.cancelled === 0 ? <span className="text-nw-text-3">{DASH}</span> : row.cancelled}
                      </td>
                      <td className={cn(TD, 'text-right')}>
                        <Money value={row.gross} band={scoreBand(row.efficiencyPct)} />
                      </td>
                      <td className={cn(TD, 'text-right tabular-nums')}>
                        {row.grossPerTruck === null ? DASH : formatMoney(row.grossPerTruck)}
                      </td>
                      <td className={cn(TD, 'text-right tabular-nums')}>{formatNumber(row.miles)}</td>
                      <td className={cn(TD, 'text-right')}>
                        <Money value={row.rpm} band={scoreBand(row.rpmPct)} rpm />
                      </td>
                      <td className={cn(TD, 'text-right tabular-nums')}>
                        {row.avgWeightLbs === null ? DASH : formatNumber(row.avgWeightLbs)}
                      </td>
                      <td className={cn(TD, 'text-center text-nw-text-3')}>{pctText(row.onTimePickupPct)}</td>
                      <td className={cn(TD, 'text-center text-nw-text-3')}>{pctText(row.onTimeDeliveryPct)}</td>
                      <td className={cn(TD, 'text-center')}>
                        <Score value={row.onTimePct} />
                      </td>
                      <td className={cn(TD, 'text-center')}>
                        <Score value={row.rpmPct} />
                      </td>
                      <td className={cn(TD, 'text-center')}>
                        <Score value={row.efficiencyPct} bar />
                      </td>
                      <td className={cn(TD, 'text-center')}>
                        <Score value={row.activityPct} />
                      </td>
                      <td className={cn(TD, 'text-center')}>
                        <Score value={row.overall} />
                      </td>
                    </tr>
                    {open
                      ? row.driverRows.map((driver) => (
                          <DriverRow key={driver.driverId} driver={driver} />
                        ))
                      : null}
                  </FragmentRows>
                );
              })
            )}
          </tbody>
        </table>
      </div>

      {explaining ? (
        <HowItWorks targets={board.data?.targets} onClose={() => setExplaining(false)} />
      ) : null}
      {settingTargets && board.data ? (
        <TargetsDialog targets={board.data.targets} onClose={() => setSettingTargets(false)} />
      ) : null}
    </div>
  );
}

function HowItWorks({ targets, onClose }: { targets?: PerformanceTargets; onClose: () => void }) {
  const rpm = targets?.rpm ?? 2.9;
  const gross = targets?.grossPerTruckWeek ?? 10_000;
  const miles = targets?.milesPerTruckWeek ?? 5_000;
  return (
    <Modal open onOpenChange={(next) => (next ? undefined : onClose())} title="How the scores are worked out" size="md">
      <div className="flex flex-col gap-3 text-[13px] text-nw-text-2">
        <p>
          Every load picked up in the period counts, and it belongs to the dispatcher whose board
          the driver is on. Cancelled and TONU loads earn nothing and are counted in CXL.
        </p>
        <dl className="flex flex-col gap-2">
          <Explain term="RPM%">
            Average rate per mile ÷ ${rpm.toFixed(2)} × 100. Book better-paying freight to raise it.
          </Explain>
          <Explain term="Efficiency">
            Total gross ÷ (your trucks × ${formatNumber(gross)} × weeks) × 100. Five trucks over one
            week is a ${formatNumber(gross * 5)} goal; ${formatNumber(gross * 5.5)} booked is 110%.
          </Explain>
          <Explain term="Activity%">
            Miles per truck ÷ {formatNumber(miles)} miles per truck per week × 100. Trucks sitting
            still sink this.
          </Explain>
          <Explain term="On-time">
            The share of pickups and deliveries made inside the appointment, blended half and half.
            A stop with no recorded arrival is left out rather than counted late.
          </Explain>
          <Explain term="Overall">
            The weighted average of the four, and what the board ranks by. The ▲▼ arrow is movement
            against the previous period, and the line under each name is the gap to the rank above.
          </Explain>
        </dl>
        <p className="rounded-md bg-nw-info-bg px-3 py-2 text-[12.5px] text-nw-info-text">
          A dash is a score that could not be measured — no trucks on the board, no miles run, no
          arrival recorded. It is never counted as zero, and OVERALL is taken over the scores that
          do exist.
        </p>
      </div>
    </Modal>
  );
}

function Explain({ term, children }: { term: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[12px] font-bold tracking-[.03em] text-nw-text uppercase">{term}</dt>
      <dd className="text-[12.5px] text-nw-text-2">{children}</dd>
    </div>
  );
}

function TargetsDialog({ targets, onClose }: { targets: PerformanceTargets; onClose: () => void }) {
  const { toast } = useToast();
  const save = useSavePerformanceTargets();
  const [form, setForm] = useState({
    rpm: String(targets.rpm),
    grossPerTruckWeek: String(targets.grossPerTruckWeek),
    milesPerTruckWeek: String(targets.milesPerTruckWeek),
    onTime: String(targets.weights.onTime),
    rpmWeight: String(targets.weights.rpm),
    efficiency: String(targets.weights.efficiency),
    activity: String(targets.weights.activity),
  });
  const set = (key: keyof typeof form, value: string) => setForm((f) => ({ ...f, [key]: value }));
  const positive = (value: string) => Number(value) > 0;
  const ready =
    positive(form.rpm) &&
    positive(form.grossPerTruckWeek) &&
    positive(form.milesPerTruckWeek) &&
    [form.onTime, form.rpmWeight, form.efficiency, form.activity].every((v) => Number(v) >= 0) &&
    [form.onTime, form.rpmWeight, form.efficiency, form.activity].some((v) => Number(v) > 0);

  return (
    <Modal open onOpenChange={(next) => (next ? undefined : onClose())} title="Performance targets" size="md">
      <div className="flex flex-col gap-3">
        <div className="grid gap-3 sm:grid-cols-3">
          <FormField label="RPM target ($/mi)">
            <Input value={form.rpm} onChange={(e) => set('rpm', e.target.value)} inputMode="decimal" />
          </FormField>
          <FormField label="Gross per truck / week ($)">
            <Input
              value={form.grossPerTruckWeek}
              onChange={(e) => set('grossPerTruckWeek', e.target.value)}
              inputMode="numeric"
            />
          </FormField>
          <FormField label="Miles per truck / week">
            <Input
              value={form.milesPerTruckWeek}
              onChange={(e) => set('milesPerTruckWeek', e.target.value)}
              inputMode="numeric"
            />
          </FormField>
        </div>
        <p className="text-[12px] text-nw-text-3">
          The four weights decide OVERALL. They are taken relative to each other, so they need not
          add up to 1.
        </p>
        <div className="grid gap-3 sm:grid-cols-4">
          <FormField label="On-time">
            <Input value={form.onTime} onChange={(e) => set('onTime', e.target.value)} inputMode="decimal" />
          </FormField>
          <FormField label="RPM">
            <Input value={form.rpmWeight} onChange={(e) => set('rpmWeight', e.target.value)} inputMode="decimal" />
          </FormField>
          <FormField label="Efficiency">
            <Input value={form.efficiency} onChange={(e) => set('efficiency', e.target.value)} inputMode="decimal" />
          </FormField>
          <FormField label="Activity">
            <Input value={form.activity} onChange={(e) => set('activity', e.target.value)} inputMode="decimal" />
          </FormField>
        </div>
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose}>
            Cancel
          </Button>
          <Button
            variant="primary"
            disabled={!ready}
            loading={save.isPending}
            onClick={() =>
              save.mutate(
                {
                  rpm: Number(form.rpm),
                  grossPerTruckWeek: Number(form.grossPerTruckWeek),
                  milesPerTruckWeek: Number(form.milesPerTruckWeek),
                  weights: {
                    onTime: Number(form.onTime),
                    rpm: Number(form.rpmWeight),
                    efficiency: Number(form.efficiency),
                    activity: Number(form.activity),
                  },
                },
                {
                  onSuccess: () => {
                    toast({ tone: 'success', title: 'Saved', description: 'The board was rescored.' });
                    onClose();
                  },
                  onError: (e: unknown) =>
                    toast({
                      tone: 'danger',
                      title: 'That did not save',
                      description: e instanceof Error ? e.message : undefined,
                    }),
                },
              )
            }
          >
            Save targets
          </Button>
        </div>
      </div>
    </Modal>
  );
}
