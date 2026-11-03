import { useMemo, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { AlertTriangle, ClipboardPlus } from 'lucide-react';
import { Badge, Button, Card, Combobox, FilterBar, Select, Tooltip, cn } from '@/design-system';
import {
  PTI_GROUP_LABEL,
  PTI_RATINGS,
  PTI_RATING_LABEL,
  addDays,
  daysOpen,
  dueDateOf,
  isDueSoon,
  isUnresolved,
  listPtiComponents,
  openPtiWeek,
  ptiWeek,
  soonest,
  stateOf,
  summarisePti,
  unitCondition,
  weekStartOf,
  workOrderStatus,
  type ComponentCondition,
  type PtiRating,
  type PtiRecord,
  type PtiTruckState,
} from '@/demo';
import { today as companyToday } from '@/lib/clock';
import { ensureRoster } from '@/demo/roster-api';
import { formatIsoDate } from '@/lib/format';
import { ConditionCell } from './components/PtiCondition';
import { PtiReviewDialog } from './components/PtiReviewDialog';
import { isEnabled } from '@/lib/feature-flags';
import { PtiBoardPage } from './pti/BoardPage';
import { ReviewDrawer } from './pti/ReviewDrawer';
import { ptiSearchSchema } from './pti-search';
import { PtiStatusPill as StatusPill } from './components/PtiStatusPill';
import { weekRangeLabel } from './pti-week-label';

const DASH = '—';
/** Unit / Driver · Dispatcher · Receipt status · Review result · Condition · Issue & action · Update */
const COLUMNS = 7;
/** The board's day: the server's clock, in the company's timezone. Read per render, never pinned. */
const todayInCompanyTz = () => companyToday();

/** A unit's condition this week, derived once per render of the board. */
interface UnitCondition {
  conditions: ComponentCondition[];
  worst: ComponentCondition | null;
  dueSoon: boolean;
}

/**
 * The weekly walk-around inspection board.
 *
 * One row per **truck** per week, because the truck is what gets inspected and it keeps its history
 * when the driver changes. Every eligible truck gets a row when the week opens, so a video that
 * never arrived is a visible empty row rather than an absence nobody can see.
 *
 * The grouping is the point of the screen. Trucks on the road are the work queue and sit at the
 * top; trucks in the shop are listed below, because one leaving the shop owes a fresh inspection,
 * and they are exempt from the missing count while they are in there; inactive and sold units are
 * hidden unless asked for. The state is read from the truck record on every render, so Maintenance
 * moving a unit into the shop moves its row without anybody retyping anything.
 */
/** The route's page: the rebuilt board with fleet_v2 on (§7), the pre-flag board otherwise. */
export function PtiPage() {
  return isEnabled('fleet_v2') ? <PtiBoardPage /> : <LegacyPtiPage />;
}

function LegacyPtiPage() {
  const [week, setWeek] = useState(weekStartOf());
  const [showInactive, setShowInactive] = useState(false);
  const [search, setSearch] = useState('');
  const [dispatcher, setDispatcher] = useState('');
  const [status, setStatus] = useState('');
  const [result, setResult] = useState('');
  /** `good` … `replace_now`, or `due_soon`: any component whose window closes within 14 days. */
  const [condition, setCondition] = useState('');
  const [component, setComponent] = useState('');
  const [sort, setSort] = useState<'status' | 'window'>('status');
  /** `null` closed; `{ record: null }` opened from the header on the unit field. */
  const [editing, setEditing] = useState<{ record: PtiRecord | null } | null>(null);


  const query = useQuery({
    queryKey: ['pti', week],
    // The roster first: the week is opened against the trucks on it, so opening it before they
    // have arrived writes a week with no units in it - which is a board of counts and no rows.
    // Opening the week is itself idempotent; it is what guarantees one row per truck.
    queryFn: async () => {
      await ensureRoster();
      return openPtiWeek(week);
    },
  });
  const rows = useMemo(() => query.data ?? ptiWeek(week), [query.data, week]);

  /*
   * With fleet_v2 the review is the drawer at `?review=<unitId>` (§6.1), over this board, on the
   * server's inspection rows. The old modal stays behind the flag until WP5 replaces the board.
   */
  const fleetV2 = isEnabled('fleet_v2');
  const rawSearch = useSearch({ strict: false }) as Record<string, unknown>;
  const reviewing = useMemo(() => ptiSearchSchema.parse(rawSearch).review ?? null, [rawSearch]);
  const navigate = useNavigate();
  const openReview = (unitId: string | null) =>
    void navigate({
      to: '/fleet/pti',
      search: (prev: Record<string, unknown>) => {
        const next: Record<string, unknown> = { ...prev };
        if (unitId) next.review = unitId;
        else delete next.review;
        return next;
      },
      replace: unitId !== null && reviewing !== null,
      resetScroll: false,
    });
  const edit = (record: PtiRecord | null) => {
    if (!fleetV2) return setEditing({ record });
    openReview(record?.truckId ?? rows.find((r) => r.result === 'pending')?.truckId ?? rows[0]?.truckId ?? null);
  };

  /*
   * What each unit's components look like this week — the latest rating per component, carried
   * forward from earlier weeks until re-rated. Its own query rather than a memo on : the
   * board's rows are unchanged by a rating, and the query cache hands back the same array for
   * unchanged data, so a memo keyed on them would never see the new rating.
   */
  const conditionQuery = useQuery({
    queryKey: ['pti', 'conditions', week],
    queryFn: async () => {
      await ensureRoster();
      const map = new Map<string, UnitCondition>();
      for (const row of ptiWeek(week)) {
        const { conditions, worst } = unitCondition(row.truckId, week);
        map.set(row.truckId, {
          conditions,
          worst,
          dueSoon: conditions.some((c) => isDueSoon(c, todayInCompanyTz())),
        });
      }
      return map;
    },
  });
  const conditionByTruck = useMemo(
    () => conditionQuery.data ?? new Map<string, UnitCondition>(),
    [conditionQuery.data],
  );
  const components = useMemo(() => listPtiComponents(), []);

  const visible = useMemo(() => {
    const q = search.trim().toLowerCase();
    return rows.filter((row) => {
      const state = stateOf(row);
      if (state === 'inactive' && !showInactive) return false;
      if (dispatcher && row.dispatcherId !== dispatcher) return false;
      if (status && row.status !== status) return false;
      if (result === 'unresolved') {
        if (!isUnresolved(row)) return false;
      } else if (result === 'rated') {
        if (
          !conditionByTruck.get(row.truckId)?.conditions.some((c) => c.source?.recordId === row.id)
        ) {
          return false;
        }
      } else if (result && row.result !== result) {
        return false;
      }
      if (condition || component) {
        const unit = conditionByTruck.get(row.truckId);
        if (!unit) return false;
        if (condition === 'due_soon') {
          const pool = component
            ? unit.conditions.filter((c) => c.component.id === component)
            : unit.conditions;
          if (!pool.some((c) => isDueSoon(c, todayInCompanyTz()))) return false;
        } else {
          const pool = component
            ? unit.conditions.filter((c) => c.component.id === component)
            : unit.conditions;
          if (condition ? !pool.some((c) => c.rating === condition) : !pool.some((c) => c.rating)) {
            return false;
          }
        }
      }
      if (!q) return true;
      return [row.unitNumber, row.driverName, row.dispatcherName, row.issueNote, row.actionTaken]
        .filter(Boolean)
        .some((value) => String(value).toLowerCase().includes(q));
    });
  }, [
    rows,
    search,
    dispatcher,
    status,
    result,
    condition,
    component,
    showInactive,
    conditionByTruck,
  ]);
  const dueSoonCount = useMemo(
    () =>
      rows.filter(
        (row) => stateOf(row) !== 'inactive' && conditionByTruck.get(row.truckId)?.dueSoon,
      ).length,
    [rows, conditionByTruck],
  );

  const totals = summarisePti(rows);
  const dispatchers = useMemo(() => {
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.dispatcherId && row.dispatcherName) map.set(row.dispatcherId, row.dispatcherName);
    }
    return [...map].sort((a, b) => a[1].localeCompare(b[1]));
  }, [rows]);

  const groups: PtiTruckState[] = showInactive ? ['road', 'shop', 'inactive'] : ['road', 'shop'];
  // A walk-around that has not arrived is only late once the week's deadline has gone by.
  const pastDeadline = todayInCompanyTz() > dueDateOf(week);

  /**
   * The weeks the picker offers: this one, the next, and the last eight.
   *
   * The current week is computed from the clock, so when the calendar rolls over the board opens
   * the new week by itself — nobody has to remember to start it, and the rows for it are created
   * the moment somebody looks.
   */
  const weekOptions = useMemo(() => {
    const current = weekStartOf();
    const weeks = [
      addDays(current, 7),
      current,
      ...Array.from({ length: 8 }, (_, i) => addDays(current, -7 * (i + 1))),
    ];
    return weeks.map((start) => ({
      value: start,
      // The dates are the name of the period. A week number means nothing to somebody
      // reconciling against a calendar, and two different months can both hold a "Week 1".
      label: weekRangeLabel(start),
      description:
        start === current ? 'This week' : start > current ? 'Next week — opens clean' : undefined,
    }));
  }, []);

  function reset() {
    setSearch('');
    setDispatcher('');
    setStatus('');
    setResult('');
    setCondition('');
    setComponent('');
  }

  /** Within a group: NO / LATE / SENT, or the soonest-closing window first when planning. */
  function order(a: PtiRecord, b: PtiRecord): number {
    if (sort === 'window') {
      const wa = conditionByTruck.get(a.truckId)?.worst;
      const wb = conditionByTruck.get(b.truckId)?.worst;
      const sa = wa ? soonest(wa) : Number.POSITIVE_INFINITY;
      const sb = wb ? soonest(wb) : Number.POSITIVE_INFINITY;
      if (sa !== sb) return sa - sb;
    }
    return byStatusThenUnit(a, b);
  }

  return (
    <div className="flex flex-col gap-(--section-gap)">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold text-ink">Pre-trip inspections</h1>
          <p className="text-xs text-nw-text-3">
            One walk-around per truck per week, due by {formatIsoDate(dueDateOf(week))}.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="eyebrow" id="pti-range-label">
            Date range
          </span>
          <Combobox
            aria-label="Date range"
            className="w-56"
            options={weekOptions}
            value={week}
            onValueChange={(value) => setWeek(value ?? weekStartOf())}
            searchPlaceholder="Type a date…"
            emptyMessage="No period matches"
          />
          {/* The general way in: a unit number in hand, not a row found first. */}
          <Button icon={<ClipboardPlus />} onClick={() => edit(null)}>
            Update PTI
          </Button>
        </div>
      </div>

      {/*
        Seven separate cards, not one joined strip: each one is its own count and its own filter,
        and a reader picking "Unresolved actions" off the row should see a thing to press, not a
        segment of a ribbon. Colour is spent only where something is actually wrong.
      */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4 xl:grid-cols-7">
        <Stat
          label="Sent"
          value={totals.sent}
          onClick={() => setStatus(status === 'sent' ? '' : 'sent')}
          active={status === 'sent'}
        />
        {/* Before the deadline these are simply not in yet; after it, they are missing. */}
        <Stat
          label={pastDeadline ? 'Missing' : 'Not in'}
          value={totals.missing}
          tone={pastDeadline && totals.missing > 0 ? 'danger' : undefined}
          onClick={() => setStatus(status === 'no' ? '' : 'no')}
          active={status === 'no'}
        />
        <Stat
          label="Late"
          value={totals.late}
          tone={totals.late > 0 ? 'warn' : undefined}
          onClick={() => setStatus(status === 'late' ? '' : 'late')}
          active={status === 'late'}
        />
        <Stat
          label="Issues open"
          value={totals.issues}
          tone={totals.issues > 0 ? 'warn' : undefined}
          onClick={() => setResult(result === 'issue_found' ? '' : 'issue_found')}
          active={result === 'issue_found'}
        />
        <Stat
          label="Unresolved actions"
          value={totals.unresolved}
          tone={totals.unresolved > 0 ? 'danger' : undefined}
          onClick={() => setResult(result === 'unresolved' ? '' : 'unresolved')}
          active={result === 'unresolved'}
        />
        {/* Components rated Replace now, or Replace soon with a window closing inside 14 days. */}
        <Stat
          label="Due soon"
          value={dueSoonCount}
          tone={dueSoonCount > 0 ? 'warn' : undefined}
          onClick={() => setCondition(condition === 'due_soon' ? '' : 'due_soon')}
          active={condition === 'due_soon'}
        />
        {/* A readout, not a filter: the shop group below is where those trucks are read. */}
        <Stat label="In shop" value={totals.inShop} />
      </div>

      <Card padding="none">
        <div className="flex flex-wrap items-center gap-3 border-b border-line px-5 py-3">
          <FilterBar
            search={{
              value: search,
              onChange: setSearch,
              placeholder: 'Search unit, driver or issue',
            }}
            values={{}}
            onChange={() => {}}
            onClear={reset}
          />
          {/* Filters read as buttons beside the toggle, not as two full-width bars. */}
          <span className="ml-auto flex flex-wrap items-center gap-2">
            <FilterBar
              filters={[
                {
                  key: 'dispatcher',
                  label: 'Team',
                  type: 'select',
                  options: dispatchers.map(([value, label]) => ({ value, label })),
                },
                {
                  key: 'result',
                  label: 'Result',
                  type: 'select',
                  options: [
                    { value: 'pending', label: 'Not reviewed' },
                    { value: 'no_issues', label: 'No issues' },
                    { value: 'issue_found', label: 'Issue found' },
                    { value: 'unresolved', label: 'Issue with no action' },
                    { value: 'rated', label: 'Condition rated this week' },
                  ],
                },
                {
                  key: 'condition',
                  label: 'Condition',
                  type: 'select',
                  options: [
                    { value: 'due_soon', label: 'Due soon' },
                    ...PTI_RATINGS.map((value) => ({ value, label: PTI_RATING_LABEL[value] })),
                  ],
                },
                {
                  key: 'component',
                  label: 'Component',
                  type: 'select',
                  options: components.map((c) => ({ value: c.id, label: c.name })),
                },
              ]}
              values={{ dispatcher, result, condition, component }}
              onChange={(key, value) => {
                const next = value === undefined || value === null ? '' : String(value);
                if (key === 'dispatcher') setDispatcher(next);
                else if (key === 'result') setResult(next);
                else if (key === 'condition') setCondition(next);
                else setComponent(next);
              }}
              onClear={() => {
                setDispatcher('');
                setResult('');
                setCondition('');
                setComponent('');
              }}
            />
            <Select
              aria-label="Sort"
              size="sm"
              className="w-44"
              options={[
                { value: 'status', label: 'Sort: status, unit' },
                { value: 'window', label: 'Sort: soonest window' },
              ]}
              value={sort}
              onValueChange={(value) => setSort(value as 'status' | 'window')}
            />
            <label className="flex items-center gap-2 text-sm text-secondary">
              <input
                type="checkbox"
                className="input-bare size-4"
                checked={showInactive}
                onChange={(event) => setShowInactive(event.target.checked)}
              />
              Show inactive
            </label>
          </span>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              {/*
                Seven columns, each one a thing somebody asks about: who was inspected, whose desk
                it is, whether the walk-around arrived, what the review said, what shape the truck
                is in, what was found and done, and the one control that changes it.
              */}
              <tr className="border-b border-line text-left">
                <Th>Unit / Driver</Th>
                <Th>Dispatcher</Th>
                <Th sub="Sent date">Receipt status</Th>
                <Th sub="Checked date · Reviewer">Review result</Th>
                <Th>Condition</Th>
                <Th>Issue &amp; action</Th>
                <Th>Update</Th>
              </tr>
            </thead>
            <tbody>
              {groups.map((group) => {
                const inGroup = visible.filter((row) => stateOf(row) === group).sort(order);
                if (inGroup.length === 0) return null;
                return (
                  <GroupRows
                    key={group}
                    group={group}
                    rows={inGroup}
                    conditionByTruck={conditionByTruck}
                    onEdit={(record) => edit(record)}
                  />
                );
              })}
              {visible.length === 0 ? (
                <tr>
                  <td colSpan={COLUMNS} className="px-5 py-10 text-center text-sm text-muted">
                    No inspection rows match. Clear the filters, or pick another week.
                  </td>
                </tr>
              ) : null}
            </tbody>
          </table>
        </div>
      </Card>

      {editing ? (
        <PtiReviewDialog
          initial={editing.record}
          rows={rows}
          week={week}
          onClose={() => setEditing(null)}
        />
      ) : null}

      {fleetV2 && reviewing ? (
        <ReviewDrawer unitId={reviewing} week={week} onClose={() => openReview(null)} onNavigate={(unitId) => openReview(unitId)} />
      ) : null}
    </div>
  );
}

/** NO first, then LATE, then SENT: whoever has not sent rises to the top of their group. */
function byStatusThenUnit(a: PtiRecord, b: PtiRecord): number {
  const rank = { no: 0, late: 1, sent: 2 } as const;
  return rank[a.status] - rank[b.status] || a.unitNumber.localeCompare(b.unitNumber);
}

function GroupRows({
  group,
  rows,
  conditionByTruck,
  onEdit,
}: {
  group: PtiTruckState;
  rows: PtiRecord[];
  conditionByTruck: Map<string, UnitCondition>;
  onEdit: (row: PtiRecord) => void;
}) {
  return (
    <>
      <tr className="bg-surface-muted">
        <td colSpan={COLUMNS} className="px-5 py-2">
          <span className="eyebrow">
            {PTI_GROUP_LABEL[group]} · {rows.length}
          </span>
          {group === 'shop' ? (
            <span className="ml-2 text-xs text-muted">
              Exempt from the missing count while in the shop; a fresh inspection is due on release.
            </span>
          ) : null}
        </td>
      </tr>
      {rows.map((row) => (
        <Row key={row.id} row={row} condition={conditionByTruck.get(row.truckId)} onEdit={onEdit} />
      ))}
    </>
  );
}

function Row({
  row,
  condition,
  onEdit,
}: {
  row: PtiRecord;
  condition: UnitCondition | undefined;
  onEdit: (row: PtiRecord) => void;
}) {
  const flagged = isUnresolved(row);
  const open = flagged ? daysOpen(row, todayInCompanyTz()) : null;
  const orderStatus = workOrderStatus(row);
  /*
   * Whether this row is a failure, or simply not in yet.
   *
   * Three things have to be true before red is earned: nothing was sent, the week's deadline has
   * gone by, and the truck was actually out on the road to send one. A unit in the shop owes its
   * walk-around on release and is exempt while it is in there, and an inactive unit owes nothing
   * at all — painting either of them red is how a board full of red stops being read.
   */
  const missing =
    row.status === 'no' && todayInCompanyTz() > dueDateOf(row.weekStart) && stateOf(row) === 'road';

  return (
    /*
     * The row is a row: it reads, it does not act.
     *
     * Everything on it used to be a target — the whole row opened the review dialog and the unit
     * and driver were links out of the board — so reading a line meant landing somewhere. The one
     * thing that changes a record is the button at the end of the line, and it says what it does.
     */
    <tr className="border-b border-line-soft last:border-0 hover:bg-surface-hover">
      <Td>
        {/* The unit names the row; the driver rides under it, because a driver changes and the
            truck does not. `data-unit` is how a test reads the number out of a two-line cell. */}
        <span data-unit className="block font-medium text-ink">
          {row.unitNumber}
        </span>
        {/* Upper case is how the drivers' own sheet reads; the stored name keeps its own case. */}
        <span className="block text-xs whitespace-nowrap">
          {row.driverName ? (
            <span className="text-nw-text-2">{row.driverName.toUpperCase()}</span>
          ) : (
            <span className="text-muted">NO DRIVER</span>
          )}
          {row.driverTag ? <span className="ml-1.5 text-muted">{row.driverTag}</span> : null}
        </span>
        {/* Out of the shop, so a fresh walk-around is owed; a caption, not an alarm. */}
        {row.needsPti ? (
          <span className="block text-xs whitespace-nowrap text-secondary">Owes a fresh PTI</span>
        ) : null}
      </Td>
      <Td>{row.dispatcherName ?? <span className="text-faint">{DASH}</span>}</Td>
      <Td>
        <StatusPill status={row.status} missing={missing} />
        <span className="mt-1 block text-xs whitespace-nowrap text-muted">
          {row.sentDate ? formatIsoDate(row.sentDate) : DASH}
        </span>
      </Td>
      <Td>
        <ResultPill row={row} />
        <span className="mt-1 block text-xs whitespace-nowrap text-muted">
          {row.checkedDate ? formatIsoDate(row.checkedDate) : DASH}
          {row.checkedByName
            ? ` · ${row.checkedByName}`
            : row.status === 'no'
              ? ''
              : ' · Nobody yet'}
        </span>
      </Td>
      <Td>
        <ConditionCell
          conditions={condition?.conditions ?? []}
          worst={condition?.worst ?? null}
          today={todayInCompanyTz()}
        />
      </Td>
      {/* What was found and what was done about it: one question, so one column. */}
      <Td>
        {row.issueNote ? (
          <span className="flex flex-col">
            <span className="line-clamp-2 leading-snug text-secondary">{row.issueNote}</span>
            <span className="text-xs text-muted">{row.issueCategory}</span>
          </span>
        ) : null}
        {row.actionTaken ? (
          <span className="mt-1 flex flex-col">
            <span className="line-clamp-2 leading-snug text-secondary">{row.actionTaken}</span>
            {row.workOrderNumber ? (
              <span className="text-xs text-muted">
                {row.workOrderNumber}
                {orderStatus ? ` · ${orderStatus.replace(/_/g, ' ')}` : ''}
              </span>
            ) : null}
          </span>
        ) : flagged ? (
          <Tooltip content="An issue was found and nothing has been done about it yet.">
            <span className="mt-1 inline-flex items-center gap-1.5 text-danger-text">
              <AlertTriangle className="size-3.5" aria-hidden />
              Nothing yet · {open} day{open === 1 ? '' : 's'}
            </span>
          </Tooltip>
        ) : row.issueNote ? null : (
          <span className="text-faint">{DASH}</span>
        )}
      </Td>
      <Td>
        <Button size="sm" variant="secondary" onClick={() => onEdit(row)}>
          Update PTI
        </Button>
      </Td>
    </tr>
  );
}

/** The result, in the case the drivers' sheet uses. The stored enum is untouched. */
function ResultPill({ row }: { row: PtiRecord }) {
  if (row.result === 'pending') {
    return (
      <Badge tone="neutral" variant="outline" size="sm">
        {row.status === 'no' ? 'NOTHING TO WATCH' : 'NOT REVIEWED'}
      </Badge>
    );
  }
  return row.result === 'issue_found' ? (
    <Badge tone="danger" size="sm">
      ISSUE FOUND
    </Badge>
  ) : (
    <Badge tone="success" size="sm">
      NO ISSUES
    </Badge>
  );
}

/** A column heading, with an optional second line naming what rides under the pill in the cell. */
function Th({ children, sub }: { children: ReactNode; sub?: string }) {
  return (
    <th className="px-3 py-2 align-bottom text-xs font-semibold text-secondary first:pl-5 last:pr-5">
      {children}
      {sub ? (
        <span className="block text-2xs font-normal whitespace-nowrap text-nw-text-3">{sub}</span>
      ) : null}
    </th>
  );
}

function Td({ children }: { children: ReactNode }) {
  return <td className="px-3 py-2.5 align-top first:pl-5 last:pr-5">{children}</td>;
}

/**
 * One count, on its own card, and the filter it stands for.
 *
 * The number leads and the label sits under it, so the card is named "8 Missing" when it is read
 * aloud — the count is the thing. The number is ink unless the count is a problem that is
 * actually present; a board of six coloured numerals teaches people to stop reading the colour.
 *
 * Without `onClick` it is a readout rather than a filter, and is not offered as a target.
 */
function Stat({
  label,
  value,
  tone,
  onClick,
  active,
}: {
  label: string;
  value: number;
  tone?: 'warn' | 'danger';
  onClick?: () => void;
  active?: boolean;
}) {
  const colour =
    tone === 'danger' ? 'text-danger-text' : tone === 'warn' ? 'text-warning-text' : 'text-ink';
  const shell = cn(
    'flex flex-col gap-0.5 rounded-xl border border-nw-border bg-nw-panel px-4 py-3 text-left shadow-card',
    onClick &&
      'cursor-pointer transition-colors duration-(--duration-base) hover:border-nw-border-strong hover:bg-nw-hover focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus',
    active && 'border-nw-accent ring-1 ring-nw-accent',
  );
  const body = (
    <>
      <span className={cn('tabular text-2xl leading-tight font-extrabold', colour)}>{value}</span>
      <span className={cn('text-xs font-medium', active ? 'text-ink' : 'text-nw-text-2')}>
        {label}
      </span>
    </>
  );
  if (!onClick) return <div className={shell}>{body}</div>;
  return (
    <button type="button" aria-pressed={active} onClick={onClick} className={shell}>
      {body}
    </button>
  );
}

export type { PtiRating };
