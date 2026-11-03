import { AlertTriangle, BarChart3, CalendarDays, CheckCircle2, Clock, Copy, Info, List, Plus, Scale, Search, Settings, Truck, X } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { safetyRules as R, type accidentsV2 as A } from '@neway/shared';
import { Button, Modal, cn, useToast } from '@/design-system';
import { nowMs } from '@/lib/clock';
import { useBoard, useBoardSummary, useCan, useRegister } from './api';
import { AccidentSettingsDialog } from './AccidentSettingsDialog';
import { AnalyticsView } from './AnalyticsView';
import { ReportModal } from './ReportModal';
import { DeptChip, DueText, Empty, LoadError, Loading, NInput, NSelect, Panel, Person, Seg, SevBadge, StageBadge, ToneBadge } from './ui';

/**
 * Accidents board (SPEC §1.2, prototype screens/Accidents.tsx) — behind `accidents_v2`.
 * KPIs, Needs attention and the table come from the server (shared rules). P2 fills the Open claims tile and the Claims
 * column; P3 the Net cost tile and column and the work order on Trucks down; P5 the Analytics view (?view=analytics).
 */

type Chip = A.BoardChip;
const RANGE_LABEL: Record<A.RangeKeyV2, string> = { '30d': '30 days', '90d': '90 days', '12m': '12 months', ytd: 'YTD', custom: 'range' };
const INV_LABEL: Record<string, string> = { not_started: 'not started', in_progress: 'in progress', in_review: 'awaiting approval', complete: 'complete' };

export function AccidentsBoardPage({ startReport = false }: { startReport?: boolean }) {
  const navigate = useNavigate();
  const canReport = useCan('accidents.edit');
  const [range, setRange] = useState<A.RangeQuery>({ range: '90d' });
  const [reportOpen, setReportOpen] = useState(startReport);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const search = useSearch({ strict: false }) as { view?: string };
  const [view, setView] = useState<'board' | 'analytics'>(search.view === 'analytics' ? 'analytics' : 'board');
  return (
    <div className="flex min-w-0 flex-col gap-4">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="text-xs font-semibold text-nw-text-3">Safety &amp; Compliance / Accidents</div>
          <h1 className="text-[22px] font-extrabold tracking-[-.022em] text-nw-text">Accidents</h1>
          <p className="text-sm text-nw-text-2">Every accident, its claims, costs and open work in one place.</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Seg
            ariaLabel="View"
            id="view-switch"
            value={view}
            onChange={(v) => v && setView(v)}
            options={[
              { v: 'board', label: <><List className="size-3.5" aria-hidden />Board</> },
              { v: 'analytics', label: <><BarChart3 className="size-3.5" aria-hidden />Analytics</> },
            ]}
          />
          {canReport ? (
            <Button variant="secondary" icon={<Settings />} onClick={() => setSettingsOpen(true)} id="accident-settings-open">
              Settings
            </Button>
          ) : null}
          <Button variant="secondary" icon={<Scale />} onClick={() => void navigate({ to: '/safety/claims' })}>
            Claims board
          </Button>
          {canReport ? (
            <Button variant="primary" icon={<Plus />} onClick={() => setReportOpen(true)} id="new-accident">
              Report accident
            </Button>
          ) : null}
        </div>
      </header>
      <RangePicker value={range} onChange={setRange} />
      {view === 'board' ? <Board range={range} /> : <AnalyticsView range={range} rangeLabel={({ '30d': 'last 30 days', '90d': 'last 90 days', '12m': 'last 12 months', ytd: 'year to date', custom: 'custom range' } as const)[range.range ?? '90d']} />}
      {settingsOpen ? <AccidentSettingsDialog onClose={() => setSettingsOpen(false)} /> : null}
      {reportOpen ? (
        <ReportModal
          onClose={() => setReportOpen(false)}
          onCreated={(id, submitted) => {
            setReportOpen(false);
            if (!submitted) void navigate({ to: '/safety/accidents/$accidentId', params: { accidentId: id } });
          }}
        />
      ) : null}
    </div>
  );
}

function RangePicker({ value, onChange }: { value: A.RangeQuery; onChange: (r: A.RangeQuery) => void }) {
  const [from, setFrom] = useState('2026-01-01');
  const [to, setTo] = useState(() => new Date(nowMs()).toISOString().slice(0, 10));
  const custom = (f: string, t: string) => {
    const a = R.localToUtc(`${f}T00:00`, R.EASTERN);
    const b = R.localToUtc(`${t}T23:59`, R.EASTERN);
    if (a.ok && b.ok) onChange({ range: 'custom', from: a.iso, to: b.iso });
  };
  return (
    <div className="flex flex-wrap items-center gap-3" id="range">
      <Seg
        size="sm"
        ariaLabel="Date range"
        value={value.range ?? '90d'}
        onChange={(k) => (k === 'custom' ? custom(from, to) : k && onChange({ range: k }))}
        options={(['30d', '90d', '12m', 'ytd', 'custom'] as const).map((k) => ({ v: k, label: k === 'custom' ? 'Custom' : RANGE_LABEL[k] }))}
      />
      {value.range === 'custom' ? (
        <span className="inline-flex items-center gap-1.5 text-xs text-nw-text-2">
          <NInput type="date" aria-label="From" value={from} className="h-7 w-[150px]" onChange={(e) => { setFrom(e.target.value); custom(e.target.value, to); }} />
          to
          <NInput type="date" aria-label="To" value={to} className="h-7 w-[150px]" onChange={(e) => { setTo(e.target.value); custom(from, e.target.value); }} />
        </span>
      ) : null}
      <span className="text-xs text-nw-text-3">Range applies to reported cases, costs and downtime. Open work is always shown. Dates are US Eastern.</span>
    </div>
  );
}

function Kpi({ icon, label, value, sub, onClick, active, tone }: { icon: ReactNode; label: string; value: ReactNode; sub: ReactNode; onClick?: () => void; active?: boolean; tone?: 'urgent' | 'warning' }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      type={onClick ? 'button' : undefined}
      onClick={onClick}
      className={cn(
        'flex min-w-0 flex-col gap-1 rounded-[10px] border bg-nw-panel p-3 text-left shadow-sm',
        active ? 'border-nw-accent' : 'border-nw-border',
        onClick ? 'cursor-pointer hover:bg-nw-hover' : '',
      )}
    >
      <span className="flex items-center gap-1.5 text-xs font-semibold text-nw-text-2">
        <span className={cn('[&_svg]:size-3.5', tone === 'urgent' ? 'text-nw-urgent-icon' : tone === 'warning' ? 'text-nw-warning-icon' : 'text-nw-text-3')}>{icon}</span>
        {label}
      </span>
      <span className="text-[24px] leading-tight font-extrabold text-nw-text">{value}</span>
      <span className="text-xs text-nw-text-3">{sub}</span>
    </Tag>
  );
}

const EMPTY_FILTERS = { q: '', driverId: '', truckId: '', severity: '', stage: '', type: '', ownerId: '', nextDept: '', investigation: '', truckDown: '' };

function Board({ range }: { range: A.RangeQuery }) {
  const navigate = useNavigate();
  const [chip, setChip] = useState<Chip>('open');
  const [f, setF] = useState(EMPTY_FILTERS);
  const [allAttention, setAllAttention] = useState(false);
  const [registerOpen, setRegisterOpen] = useState(false);
  const [more, setMore] = useState(false);
  const query: A.BoardQuery = useMemo(() => {
    const q: Record<string, unknown> = { chip, ...range };
    for (const [k, v] of Object.entries(f)) if (v) q[k] = v;
    return q as A.BoardQuery;
  }, [chip, range, f]);
  const summary = useBoardSummary(range);
  const board = useBoard(query);
  // Lists for the filter selects come from every case on the board in range (cheap: one extra read).
  const everyCase = useBoard({ chip: 'all', ...range, pageSize: 200 });
  const open = (id: string, tab?: string) => void navigate({ to: '/safety/accidents/$accidentId', params: { accidentId: id }, search: tab ? { tab } : {} } as never);

  const k = summary.data?.kpis;
  const rangeWord = RANGE_LABEL[summary.data?.range.key ?? range.range ?? '90d'];
  const attention = summary.data?.attention ?? [];
  const shown = allAttention ? attention : attention.slice(0, 6);
  const anyFilter = Object.values(f).some(Boolean);
  const drivers = new Map<string, string>();
  const trucks = new Map<string, string>();
  for (const r of everyCase.data?.items ?? []) {
    if (r.driver) drivers.set(r.driver.id, r.driver.name);
    if (r.truck) trucks.set(r.truck.id, r.truck.unit);
  }
  const loading = 'Loading…';

  return (
    <>
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-6" id="kpis">
        <Kpi icon={<AlertTriangle />} label="Open cases" value={k ? k.openCases.value : loading} sub={k ? `${k.openCases.serious} serious · ${k.openCases.awaitingInvestigation} awaiting investigation` : ''} onClick={() => setChip('open')} active={chip === 'open'} />
        <Kpi
          icon={<CalendarDays />}
          label={`Reported · ${rangeWord}`}
          value={k ? k.reported.value : loading}
          sub={k ? `${k.reported.delta === 0 ? 'Same as' : k.reported.delta > 0 ? `${k.reported.delta} more than` : `${-k.reported.delta} fewer than`} prior period` : ''}
          onClick={() => setChip('all')}
          active={chip === 'all'}
        />
        <Kpi icon={<Truck />} label="Trucks down now" tone={k?.trucksDownNow.value ? 'urgent' : undefined} value={k ? k.trucksDownNow.value : loading} sub={k ? `${Math.round(k.trucksDownNow.truckDaysInRange)} truck-days down in range` : ''} onClick={() => setF({ ...f, truckDown: 'true' })} />
        <Kpi icon={<Clock />} label="Needs attention" tone={k?.needsAttention.urgent ? 'warning' : undefined} value={k ? k.needsAttention.value : loading} sub={k ? `${k.needsAttention.overdueTasks} overdue tasks · ${k.needsAttention.urgent} urgent` : ''} onClick={() => setChip('attention')} active={chip === 'attention'} />
        <Kpi
          icon={<Scale />}
          label="Open claims"
          value={k ? k.openClaims.value : loading}
          sub={k ? `${R.money(k.openClaims.ourCostToComeCents, { compact: true })} our cost to come · ${R.money(k.openClaims.insurerReservesCents, { compact: true })} insurer reserves${k.restrictedClaimsExcluded ? ` · excludes ${R.plural(k.restrictedClaimsExcluded, 'restricted claim')}` : ''}` : ''}
          onClick={() => void navigate({ to: '/safety/claims' })}
        />
        <Kpi
          icon={<BarChart3 />}
          label={`Net cost · ${rangeWord}`}
          value={k ? (k.netCost ? R.money(k.netCost.projectedNetCents, { compact: true }) : '—') : loading}
          sub={k ? (k.netCost ? `${R.money(k.netCost.spentCents, { compact: true })} spent · ${R.money(k.netCost.recoveredCents, { compact: true })} recovered · +${R.money(k.netCost.lostRevenueCents, { compact: true })} lost revenue (not cash)` : 'Repair costs are not shown to your role') : ''}
        />
      </div>

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-[1.7fr_1fr]">
        <Panel
          title="Needs attention"
          sub={summary.data ? `${attention.length} items · urgent first` : undefined}
          pad={false}
          id="attention"
          actions={attention.length > 6 ? <Button size="sm" variant="ghost" onClick={() => setAllAttention((x) => !x)}>{allAttention ? 'Show fewer' : `Show all ${attention.length}`}</Button> : null}
        >
          {summary.isLoading ? <Loading /> : summary.error ? <div className="p-3"><LoadError error={summary.error} /></div> : attention.length === 0 ? (
            <Empty title="Nothing needs attention">Every open case has an owner and nothing is overdue.</Empty>
          ) : (
            <ul className="divide-y divide-nw-border">
              {shown.map((a) => (
                <li key={a.id}>
                  <button type="button" onClick={() => (a.woId && !a.caseId ? void navigate({ to: '/fleet/shop/$orderId', params: { orderId: a.woId } }) : a.claimId && (!a.caseId || a.reason !== 'Overdue task' || !a.tab) ? void navigate({ to: '/safety/claims', search: { claim: a.claimId } } as never) : a.caseId && open(a.caseId, a.tab))} className="flex w-full items-start gap-3 px-4 py-2.5 text-left hover:bg-nw-hover">
                    <span className="mt-0.5">
                      <ToneBadge tone={a.tone === 'info' ? 'neutral' : a.tone}>{a.tone === 'urgent' ? 'Urgent' : a.tone === 'warning' ? 'Warning' : 'Info'}</ToneBadge>
                    </span>
                    <span className="flex min-w-0 flex-1 flex-col">
                      <span className="text-xs text-nw-text-3">
                        {a.reason}
                        {a.caseNumber ? <> · <b className="text-nw-text-2">{a.caseNumber}</b></> : null}
                        {a.truckUnit ? ` · Truck ${a.truckUnit}` : ''}
                      </span>
                      <span className="truncate text-sm font-semibold text-nw-text">{a.title}</span>
                    </span>
                    <span className="flex shrink-0 flex-wrap items-center justify-end gap-2">
                      {a.dept ? <DeptChip dept={a.dept} /> : null}
                      {a.assigneeName ? <Person name={a.assigneeName} /> : null}
                      <DueText iso={a.due} />
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-nw-border px-4 py-2 text-xs text-nw-text-3">
            <Info className="mr-1 inline size-3" aria-hidden />
            Items come from tasks, testing windows, claims, work orders and the case facts.
          </div>
        </Panel>
        <Panel title="Trucks down because of accidents" pad={false} id="trucks-down">
          {summary.isLoading ? <Loading /> : (summary.data?.trucksDown.length ?? 0) === 0 ? (
            <Empty title="No trucks down">All units from accident cases are back in service.</Empty>
          ) : (
            <ul className="divide-y divide-nw-border">
              {summary.data!.trucksDown.map((t) => (
                <li key={t.truckId}>
                  <button type="button" onClick={() => open(t.accidentId, 'equipment')} className="flex w-full flex-col gap-0.5 px-4 py-2.5 text-left hover:bg-nw-hover">
                    <span className="flex items-center gap-2 text-sm font-semibold text-nw-text">
                      <Truck className="size-4 text-nw-text-3" aria-hidden />
                      Truck {t.unit}
                      <ToneBadge tone="urgent">{R.downtimeLabel(t.downMs)}</ToneBadge>
                    </span>
                    <span className="text-xs text-nw-text-3">
                      {t.number} · {t.location}
                    </span>
                    {t.workOrder ? (
                      <span className="text-xs text-nw-text-2">
                        {t.workOrder.number} {t.workOrder.status}
                        {t.workOrder.estimates < t.workOrder.estimatesRequired ? ` (${t.workOrder.estimates}/${t.workOrder.estimatesRequired} estimates)` : ''}
                      </span>
                    ) : null}
                  </button>
                </li>
              ))}
            </ul>
          )}
          <div className="border-t border-nw-border px-4 py-2 text-xs text-nw-text-3">Downtime comes from out-of-service periods; Fleet verifies them. Work-order dates alone under-count it.</div>
        </Panel>
      </div>

      <Panel pad={false} id="board">
        <div className="flex flex-wrap items-center justify-between gap-2 border-b border-nw-border px-4 py-3">
          <div className="flex flex-wrap gap-1.5" role="tablist" aria-label="Cases">
            {(
              [
                ['open', 'Open'],
                ['serious', 'Serious'],
                ['attention', 'Needs attention'],
                ...((board.data?.draftsCount ?? 0) > 0 ? [['drafts', `Drafts (${board.data?.draftsCount})`]] : []),
                ['closed', 'Closed'],
                ['all', 'All in range'],
                ['register', 'DOT register'],
              ] as [Chip, string][]
            ).map(([key, label]) => (
              <button
                key={key}
                type="button"
                role="tab"
                aria-selected={chip === key}
                onClick={() => setChip(key)}
                className={cn('h-7 rounded-full px-3 text-xs font-semibold', chip === key ? 'bg-nw-accent text-nw-on-accent' : 'bg-nw-subtle text-nw-text-2 hover:text-nw-text')}
              >
                {label}
              </button>
            ))}
          </div>
          {chip === 'register' ? (
            <Button size="sm" variant="secondary" icon={<Copy />} onClick={() => setRegisterOpen(true)}>
              Export DOT register
            </Button>
          ) : null}
        </div>
        <div className="flex flex-wrap items-center gap-2 border-b border-nw-border px-4 py-2.5">
          <label className="relative min-w-[220px] flex-1">
            <Search className="pointer-events-none absolute top-2.5 left-2.5 size-4 text-nw-text-3" aria-hidden />
            <NInput id="board-search" className="pl-8" placeholder="Search case, truck, trailer, driver, location…" value={f.q} onChange={(e) => setF({ ...f, q: e.target.value })} aria-label="Search accidents" />
          </label>
          <NSelect ariaLabel="Driver" className="w-auto" value={f.driverId} onChange={(v) => setF({ ...f, driverId: v })}>
            <option value="">All drivers</option>
            {[...drivers].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
          </NSelect>
          <NSelect ariaLabel="Truck" className="w-auto" value={f.truckId} onChange={(v) => setF({ ...f, truckId: v })}>
            <option value="">All trucks</option>
            {[...trucks].sort((a, b) => a[1].localeCompare(b[1])).map(([id, unit]) => <option key={id} value={id}>Truck {unit}</option>)}
          </NSelect>
          <NSelect ariaLabel="Severity" className="w-auto" value={f.severity} onChange={(v) => setF({ ...f, severity: v })}>
            <option value="">Any severity</option>
            {Object.entries(R.SEVERITY_LABEL).map(([key, l]) => <option key={key} value={key}>{l}</option>)}
          </NSelect>
          <NSelect ariaLabel="Stage" className="w-auto" value={f.stage} onChange={(v) => setF({ ...f, stage: v })}>
            <option value="">Any stage</option>
            {Object.entries(R.STAGE_LABEL).map(([key, l]) => <option key={key} value={key}>{l}</option>)}
          </NSelect>
          <NSelect ariaLabel="Accident type" className="w-auto" value={f.type} onChange={(v) => setF({ ...f, type: v })}>
            <option value="">Any type</option>
            {R.ACCIDENT_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
          </NSelect>
          <Button size="sm" variant="secondary" onClick={() => setMore((x) => !x)} aria-expanded={more}>
            More{[f.nextDept, f.investigation, f.truckDown].filter(Boolean).length ? ` (${[f.nextDept, f.investigation, f.truckDown].filter(Boolean).length})` : ''}
          </Button>
          {anyFilter ? (
            <Button size="sm" variant="ghost" icon={<X />} onClick={() => setF(EMPTY_FILTERS)}>
              Clear
            </Button>
          ) : null}
          {more ? (
            <div className="flex w-full flex-wrap gap-2">
              <NSelect ariaLabel="Next action department" className="w-auto" value={f.nextDept} onChange={(v) => setF({ ...f, nextDept: v })}>
                <option value="">Next action: any department</option>
                {['Safety', 'Fleet', 'Dispatch', 'Claims', 'Accounting', 'Management'].map((d) => <option key={d} value={d}>{d}</option>)}
              </NSelect>
              <NSelect ariaLabel="Investigation" className="w-auto" value={f.investigation} onChange={(v) => setF({ ...f, investigation: v })}>
                <option value="">Investigation: any</option>
                <option value="not_started">Not started</option>
                <option value="in_progress">In progress</option>
                <option value="in_review">Awaiting approval</option>
                <option value="complete">Complete</option>
              </NSelect>
              <NSelect ariaLabel="Truck status" className="w-auto" value={f.truckDown} onChange={(v) => setF({ ...f, truckDown: v })}>
                <option value="">Truck status: any</option>
                <option value="true">Out of service now</option>
                <option value="false">In service</option>
              </NSelect>
            </div>
          ) : null}
        </div>
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1180px] text-left text-sm" id="board-table">
            <thead className="border-b border-nw-border text-xs font-semibold text-nw-text-3">
              <tr>
                {['Case', 'Truck & driver', 'Location', 'Severity', 'Stage', 'Equipment', 'Claims', 'Net cost', 'Next action'].map((h) => (
                  <th key={h} className="px-3 py-2 font-semibold">{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {board.isLoading ? (
                <tr><td colSpan={9}><Loading /></td></tr>
              ) : board.error ? (
                <tr><td colSpan={9} className="p-3"><LoadError error={board.error} /></td></tr>
              ) : (board.data?.items.length ?? 0) === 0 ? (
                <tr><td colSpan={9}><Empty title="No cases match">Change the chip or clear the filters. Open work always shows under “Open”.</Empty></td></tr>
              ) : (
                board.data!.items.map((r) => <BoardRowView key={r.id} r={r} onOpen={() => open(r.id)} />)
              )}
            </tbody>
          </table>
        </div>
      </Panel>
      {registerOpen ? <RegisterModal range={range} onClose={() => setRegisterOpen(false)} /> : null}
    </>
  );
}

function BoardRowView({ r, onOpen }: { r: A.BoardRow; onOpen: () => void }) {
  const next = r.next;
  return (
    <tr
      tabIndex={0}
      data-case={r.number}
      onClick={onOpen}
      onKeyDown={(e) => {
        if (e.key === 'Enter') onOpen();
      }}
      className={cn('cursor-pointer border-b border-nw-border align-top last:border-b-0 hover:bg-nw-hover focus-visible:bg-nw-hover focus-visible:outline-none', r.urgent ? 'shadow-[inset_3px_0_0_var(--color-nw-urgent-icon)]' : '')}
    >
      <td className="px-3 py-2">
        <div className="flex flex-wrap items-center gap-1.5 font-bold whitespace-nowrap text-nw-accent-ink">
          {r.number}
          {r.isNew ? <ToneBadge tone="moving">New</ToneBadge> : null}
          {r.isDraft ? <ToneBadge tone="warning">Draft</ToneBadge> : null}
          {r.isTest ? <ToneBadge tone="neutral">Test data</ToneBadge> : null}
        </div>
        <div className="text-xs whitespace-nowrap text-nw-text-3">
          {R.fmtShort(r.occurredAt, r.occurredTz, nowMs())} · {R.fmtTime(r.occurredAt, r.occurredTz)}
        </div>
      </td>
      <td className="px-3 py-2">
        <div className="whitespace-nowrap text-nw-text">
          {r.truck ? `Truck ${r.truck.unit}` : 'Truck not recorded'}
          {r.trailer ? <span className="text-nw-text-3"> · {r.trailer.unit}</span> : null}
        </div>
        <div className="text-xs text-nw-text-3">{r.driver?.name ?? 'Driver not recorded'}</div>
      </td>
      <td className="px-3 py-2">
        <div className="text-nw-text">{r.location.city ? `${r.location.city}, ${r.location.state}` : 'Not recorded yet'}</div>
        <div className="max-w-[180px] truncate text-xs text-nw-text-3">{r.location.road || r.accidentType}</div>
      </td>
      <td className="px-3 py-2">
        <SevBadge sev={r.severity} />
        <div className="max-w-[160px] truncate text-xs text-nw-text-3" title={r.accidentType}>{r.accidentType.split(' — ')[0]}</div>
      </td>
      <td className="px-3 py-2">
        <StageBadge stage={r.stage} />
        {r.stage !== 'closed' && r.stage !== 'draft' ? <div className="text-xs text-nw-text-3">Investigation: {INV_LABEL[r.investigationStatus]}</div> : null}
      </td>
      <td className="px-3 py-2">
        {r.equipment.truckDownNow ? <ToneBadge tone="urgent">Down {R.downtimeLabel(r.equipment.truckDownMs)}</ToneBadge> : <span className="text-nw-text">In service</span>}
        {!r.equipment.truckDownNow && r.equipment.wasDownMs > 0 ? <div className="text-xs text-nw-text-3">Was down {R.downtimeLabel(r.equipment.wasDownMs)}</div> : null}
      </td>
      <td className="px-3 py-2">
        {r.claims.total === 0 ? <span className="text-nw-text-3">None</span> : r.claims.open ? <span className="text-nw-text">{r.claims.open} open</span> : <span className="text-nw-text">Settled</span>}
        {r.claims.total ? <div className="text-xs text-nw-text-3">{R.plural(r.claims.total, 'claim')}</div> : null}
      </td>
      <td className="px-3 py-2">
        {r.money ? (
          <>
            <div className="text-right font-semibold whitespace-nowrap text-nw-text tabular-nums">{R.money(r.money.projectedNetCents, { compact: true })}</div>
            <div className="text-right text-xs text-nw-text-3">{r.money.basis === 'final' ? 'final' : r.money.basis === 'spent' ? `${R.money(r.money.actualCents, { compact: true })} spent` : 'estimate'}</div>
          </>
        ) : (
          <span className="text-xs text-nw-text-3">—</span>
        )}
      </td>
      <td className="px-3 py-2">
        {next && 'closedNote' in next ? (
          <span className="text-xs text-nw-text-3">{next.closedNote}</span>
        ) : next ? (
          <>
            <div className="max-w-[240px] truncate text-nw-text" title={next.title}>{next.title}</div>
            <div className="mt-0.5 flex flex-wrap items-center gap-1.5">
              <DeptChip dept={next.dept} />
              {next.assignee ? <Person name={next.assignee.name} /> : null}
              <DueText iso={next.dueAt} tz={r.occurredTz} />
            </div>
          </>
        ) : (
          <span className="text-xs text-nw-text-3">No open tasks</span>
        )}
      </td>
    </tr>
  );
}

function RegisterModal({ range, onClose }: { range: A.RangeQuery; onClose: () => void }) {
  const { toast } = useToast();
  const rows = useRegister(range, true);
  const n = (v: number | null) => (v === null ? <ToneBadge tone="warning">Not known</ToneBadge> : v);
  const csv = () => {
    const head = 'Date,City or nearest town,State,Driver,Injuries (treated away),Fatalities,Hazmat released,Case';
    const cell = (v: unknown) => {
      const t = v === null || v === undefined ? 'Not known' : String(v);
      return /[",\n]/.test(t) ? `"${t.replace(/"/g, '""')}"` : t;
    };
    return [head, ...(rows.data ?? []).map((r) => [r.date, r.cityOrNearest, r.state, r.driverName, r.injuriesTreatedAway, r.fatalities, r.hazmatReleased, r.caseNumber].map(cell).join(','))].join('\n');
  };
  return (
    <Modal
      open
      onOpenChange={(o) => (o ? undefined : onClose())}
      size="lg"
      title="Accident register (49 CFR 390.15)"
      description="DOT-recordable accidents in the range · keep for 3 years after each accident"
      footer={
        <>
          <span className="mr-auto text-xs text-nw-text-3">Copies of police and insurer accident reports are kept on each case’s Evidence tab.</span>
          <Button variant="secondary" onClick={onClose}>Close</Button>
          <Button
            variant="primary"
            icon={<Copy />}
            disabled={!rows.data}
            onClick={async () => {
              try {
                await navigator.clipboard.writeText(csv());
                toast({ tone: 'success', title: 'Register copied as CSV' });
              } catch {
                toast({ tone: 'danger', title: 'Copy blocked by the browser', description: 'Select the table text instead.' });
              }
            }}
          >
            Copy as CSV
          </Button>
        </>
      }
    >
      {rows.isLoading ? <Loading /> : rows.error ? <LoadError error={rows.error} /> : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-left text-sm">
            <thead className="text-xs text-nw-text-3">
              <tr>{['Date', 'City / nearest town', 'State', 'Driver', 'Injuries', 'Fatalities', 'Hazmat released', 'Case'].map((h) => <th key={h} className="px-2 py-1.5 font-semibold">{h}</th>)}</tr>
            </thead>
            <tbody>
              {(rows.data ?? []).map((r) => (
                <tr key={r.accidentId} className="border-t border-nw-border">
                  <td className="px-2 py-1.5">{r.date}</td>
                  <td className="px-2 py-1.5">{r.cityOrNearest}</td>
                  <td className="px-2 py-1.5">{r.state}</td>
                  <td className="px-2 py-1.5">{r.driverName}</td>
                  <td className="px-2 py-1.5">{n(r.injuriesTreatedAway)}</td>
                  <td className="px-2 py-1.5">{n(r.fatalities)}</td>
                  <td className="px-2 py-1.5">{r.hazmatReleased === 'Not answered' ? <ToneBadge tone="warning">Not answered</ToneBadge> : r.hazmatReleased}</td>
                  <td className="px-2 py-1.5 font-semibold">{r.caseNumber}</td>
                </tr>
              ))}
              {(rows.data ?? []).length === 0 ? <tr><td colSpan={8}><Empty title="No DOT-recordable accidents in this range" /></td></tr> : null}
            </tbody>
          </table>
        </div>
      )}
    </Modal>
  );
}

export function CheckLine({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <span className={cn('inline-flex items-center gap-1 text-xs font-semibold', ok ? 'text-nw-done-text' : 'text-nw-warning-text')}>
      {ok ? <CheckCircle2 className="size-3.5" aria-hidden /> : <AlertTriangle className="size-3.5" aria-hidden />}
      {children}
    </span>
  );
}
