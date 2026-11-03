import { ChevronLeft, ChevronRight } from 'lucide-react';
import { useMemo } from 'react';
import { weekStartMonday, type FleetSpendPeriod } from '@neway/shared';
import { WeekPicker } from '@/features/dispatch/board/chrome';
import { periodStart } from './expense-search';

/**
 * The one period control of the Costs page (owner, 2026-10-09): the week picker for Week, and the
 * same arrow-and-list control listing months, quarters or years for the others. `at` is any day of
 * the chosen period (YYYY-MM-DD); the current period is the default and the newest in the list.
 */
export function ExpensePeriodPicker({
  period,
  at,
  today,
  onChange,
}: {
  period: FleetSpendPeriod;
  at: string;
  today: string;
  onChange: (at: string) => void;
}) {
  if (period === 'week') {
    const current = weekStartMonday(today);
    const week = weekStartMonday(at);
    return <WeekPicker week={week} onChange={(w) => onChange(w > current ? current : w)} />;
  }
  return <ListPicker period={period} at={at} today={today} onChange={onChange} />;
}

const MONTH = new Intl.DateTimeFormat('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' });
const SHORT_MONTH = new Intl.DateTimeFormat('en-US', { month: 'short', timeZone: 'UTC' });
const day = (iso: string) => new Date(`${iso}T12:00:00Z`);

function shift(period: Exclude<FleetSpendPeriod, 'week'>, start: string, steps: number): string {
  const d = day(start);
  if (period === 'year') d.setUTCFullYear(d.getUTCFullYear() + steps);
  else d.setUTCMonth(d.getUTCMonth() + steps * (period === 'quarter' ? 3 : 1));
  return d.toISOString().slice(0, 10);
}

function label(period: Exclude<FleetSpendPeriod, 'week'>, start: string): string {
  if (period === 'month') return MONTH.format(day(start));
  if (period === 'year') return start.slice(0, 4);
  const q = Math.floor((Number(start.slice(5, 7)) - 1) / 3) + 1;
  return `Q${q} ${start.slice(0, 4)} · ${SHORT_MONTH.format(day(start))}–${SHORT_MONTH.format(day(shift('month', start, 2)))}`;
}

/** How far back each list reaches. */
const DEPTH: Record<Exclude<FleetSpendPeriod, 'week'>, number> = { month: 24, quarter: 12, year: 6 };

function ListPicker({
  period,
  at,
  today,
  onChange,
}: {
  period: Exclude<FleetSpendPeriod, 'week'>;
  at: string;
  today: string;
  onChange: (at: string) => void;
}) {
  const current = periodStart(period, today);
  const chosen = periodStart(period, at) > current ? current : periodStart(period, at);
  const options = useMemo(() => {
    const list: string[] = [];
    for (let i = 0; i < DEPTH[period]; i += 1) list.push(shift(period, current, -i));
    if (!list.includes(chosen)) list.push(chosen);
    return list;
  }, [period, current, chosen]);
  const next = shift(period, chosen, 1);
  return (
    <div className="flex h-8 items-center gap-0.5 rounded-md border border-nw-border-strong bg-nw-panel px-0.5" role="group" aria-label={`Choose ${period}`}>
      <button
        type="button"
        aria-label={`Previous ${period}`}
        onClick={() => onChange(shift(period, chosen, -1))}
        className="grid size-7 place-items-center rounded text-nw-text-2 hover:bg-nw-hover"
      >
        <ChevronLeft className="size-4" aria-hidden />
      </button>
      <select
        aria-label={period === 'month' ? 'Month' : period === 'quarter' ? 'Quarter' : 'Year'}
        value={chosen}
        onChange={(e) => onChange(e.target.value)}
        className="h-7 rounded bg-nw-panel px-1 text-[12.5px] font-bold text-nw-text outline-none"
        data-testid="expense-period-select"
      >
        {options.map((o) => (
          <option key={o} value={o}>
            {label(period, o)}
          </option>
        ))}
      </select>
      <button
        type="button"
        aria-label={`Next ${period}`}
        disabled={next > current}
        onClick={() => onChange(next)}
        className="grid size-7 place-items-center rounded text-nw-text-2 hover:bg-nw-hover disabled:opacity-40"
      >
        <ChevronRight className="size-4" aria-hidden />
      </button>
    </div>
  );
}
