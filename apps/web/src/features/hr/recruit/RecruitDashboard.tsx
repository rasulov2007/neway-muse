import { useNavigate } from '@tanstack/react-router';
import { ArrowRight, BarChart3, Check, Clock, Trophy, Users } from 'lucide-react';
import { useMemo } from 'react';
import { RECRUIT_STAGE_LABELS, type RecruitDashboard as Dashboard, type RecruitScope, type RecruitStage } from '@neway/shared';
import { Button, DatePicker, Select, StatusSymbol, cn, type StatusSymbolFamily } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { today as companyToday } from '@/lib/clock';
import type { HrSearch } from '../hr-search';
import { QuietState } from './RecruitKit';
import { shortDate } from './recruit-format';
import { useRecruiters } from './useRecruit';
import { useRecruitDashboard } from './useJourney';

/** Each stage's family: the symbol and the word carry it, the colour only supports (SPEC §7). */
const STAGE_FAMILY: Record<RecruitStage, StatusSymbolFamily> = {
  new_lead: 'urgent',
  consent_pending: 'warning',
  safety_review: 'info',
  application_pending: 'warning',
  onboarding: 'moving',
  hired: 'done',
  closed: 'neutral',
};

const STAGE_ICON: Record<RecruitStage, string> = {
  new_lead: 'text-nw-urgent-icon',
  consent_pending: 'text-nw-warning-icon',
  safety_review: 'text-nw-moving-icon',
  application_pending: 'text-nw-warning-icon',
  onboarding: 'text-nw-accent',
  hired: 'text-nw-done-icon',
  closed: 'text-nw-text-3',
};

const PRESETS = ['month', '7d', '30d', 'last_month', 'year', 'custom'] as const;
type Preset = (typeof PRESETS)[number];
const PRESET_LABEL: Record<Preset, string> = {
  month: 'This month',
  '7d': 'Last 7 days',
  '30d': 'Last 30 days',
  last_month: 'Last month',
  year: 'This year',
  custom: 'Custom range',
};

const addDays = (iso: string, n: number) => new Date(Date.parse(`${iso}T12:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** The period a preset means on the company's (Eastern) calendar. */
function presetRange(preset: Preset, today: string): { from: string; to: string } {
  const y = today.slice(0, 4);
  const m = today.slice(5, 7);
  switch (preset) {
    case '7d':
      return { from: addDays(today, -6), to: today };
    case '30d':
      return { from: addDays(today, -29), to: today };
    case 'last_month': {
      const firstThis = `${y}-${m}-01`;
      const lastPrev = addDays(firstThis, -1);
      return { from: `${lastPrev.slice(0, 7)}-01`, to: lastPrev };
    }
    case 'year':
      return { from: `${y}-01-01`, to: today };
    default:
      return { from: `${y}-${m}-01`, to: today };
  }
}

function periodOf(search: HrSearch, today: string): { preset: Preset; from: string; to: string } {
  const preset = (PRESETS as readonly string[]).includes(search.period ?? '') ? (search.period as Preset) : 'month';
  const iso = /^\d{4}-\d{2}-\d{2}$/;
  if (preset === 'custom' && search.from && search.to && iso.test(search.from) && iso.test(search.to)) {
    return { preset, from: search.from, to: search.to };
  }
  return { preset: preset === 'custom' ? 'month' : preset, ...presetRange(preset === 'custom' ? 'month' : preset, today) };
}

const RANGE = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', timeZone: 'UTC' });
const rangeLabel = (from: string, to: string) => {
  const a = new Date(`${from}T12:00:00Z`);
  const b = new Date(`${to}T12:00:00Z`);
  const year = b.getUTCFullYear();
  return from.slice(0, 7) === to.slice(0, 7)
    ? `${RANGE.format(a)}–${b.getUTCDate()}, ${year}`
    : `${RANGE.format(a)} – ${RANGE.format(b)}, ${year}`;
};

/**
 * The Recruiting dashboard (owner brief, 2026-10-11). One cohort — the leads received in the
 * chosen period — counted every way: total, hired, conversion, in progress, by source, by stage, by
 * day. The stages add up to the total, and every number opens the list it was counted from.
 */
export function RecruitDashboard({ search, update }: { search: HrSearch; update: (patch: Record<string, unknown>) => void }) {
  const today = companyToday();
  const account = useAccount();
  const canSeeAll = account?.permissions.includes('recruiting.manage') ?? false;
  const scope: RecruitScope = canSeeAll ? 'all' : 'mine';
  const { preset, from, to } = periodOf(search, today);
  const recruiter = canSeeAll ? search.recruiter : undefined;
  const query = useRecruitDashboard({ from, to, scope, recruiter });
  const recruiters = useRecruiters(canSeeAll);
  const navigate = useNavigate();
  const d = query.data;

  /** The list, cut the way the number was counted. */
  const openList = (cut: { stage?: RecruitStage; source?: string; filter?: string } = {}) =>
    void navigate({
      to: '/hr/recruiting',
      search: { tab: canSeeAll ? 'candidates' : 'my-leads', from, to, recruiter, ...cut } as never,
    });

  return (
    <div className="flex flex-col gap-5" data-testid="recruit-dashboard">
      <div className="flex flex-wrap items-center gap-2.5" role="group" aria-label="Dashboard filters">
        <div className="w-44">
          <Select
            aria-label="Period"
            value={preset}
            onValueChange={(v) => update(v === 'custom' ? { period: 'custom', from, to } : { period: v === 'month' ? undefined : v, from: undefined, to: undefined })}
            options={PRESETS.map((p) => ({ value: p, label: PRESET_LABEL[p] }))}
          />
        </div>
        {preset === 'custom' ? (
          <>
            <div className="w-40">
              <DatePicker aria-label="From" value={from} onIsoChange={(v) => v && update({ period: 'custom', from: v, to })} />
            </div>
            <span className="text-nw-text-3">–</span>
            <div className="w-40">
              <DatePicker aria-label="To" value={to} onIsoChange={(v) => v && update({ period: 'custom', from, to: v })} />
            </div>
          </>
        ) : (
          <span className="rounded-[9px] border border-nw-border bg-nw-panel px-3 py-1.5 text-[13px] font-medium text-nw-text-2" data-testid="dashboard-range">
            {rangeLabel(from, to)}
          </span>
        )}
        {canSeeAll ? (
          <div className="w-56">
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
          <span className="text-[13px] text-nw-text-3">Your leads</span>
        )}
      </div>

      {query.isPending ? (
        <QuietState title="Loading…" description="Counting the leads received in this period." />
      ) : query.isError || !d ? (
        <QuietState tone="error" title="The dashboard could not be loaded" description="Check the connection and try again." action={<Button variant="outline" onClick={() => void query.refetch()}>Try again</Button>} />
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 xl:grid-cols-4" data-testid="dashboard-kpis">
            <Kpi icon={<Users />} label="Total leads" hint="Leads received in the period" value={d.total} onClick={() => openList()} testId="kpi-total" />
            <Kpi icon={<Check />} label="Hired" hint="From these leads" value={d.hired} onClick={() => openList({ stage: 'hired' })} testId="kpi-hired" />
            <Kpi icon={<BarChart3 />} label="Lead → hire" hint="Hired ÷ total leads" value={d.conversion === null ? '—' : `${(d.conversion * 100).toFixed(d.conversion > 0 && d.conversion < 0.1 ? 1 : 0)}%`} testId="kpi-conversion" />
            <Kpi icon={<Clock />} label="In progress" hint="Not hired, not closed" value={d.inProgress} onClick={() => openList({ filter: 'active' })} testId="kpi-in-progress" />
          </div>

          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Sources dashboard={d} onOpen={(source) => openList({ source })} />
            <Stages dashboard={d} onOpen={(stage) => openList({ stage })} />
          </div>
          <div className="grid grid-cols-1 gap-4 xl:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)]">
            <Trend dashboard={d} />
            <NextActions dashboard={d} onOpen={(stage) => openList({ stage })} />
          </div>
          <Recent dashboard={d} onAll={() => openList()} />
          <p className="text-xs text-nw-text-3">Stages and hires count the leads received in the selected period ({rangeLabel(d.period.from, d.period.to)}), on the company's Eastern calendar.</p>
        </>
      )}
    </div>
  );
}

function Panel({ title, action, children, testId }: { title: string; action?: React.ReactNode; children: React.ReactNode; testId?: string }) {
  return (
    <section className="rounded-[12px] border border-nw-border bg-nw-panel" data-testid={testId}>
      <header className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
        <h2 className="text-[17px] font-bold text-nw-text">{title}</h2>
        {action}
      </header>
      <div className="px-5 pb-4">{children}</div>
    </section>
  );
}

function Kpi({ icon, label, hint, value, onClick, testId }: { icon: React.ReactNode; label: string; hint: string; value: number | string; onClick?: () => void; testId: string }) {
  const body = (
    <>
      <span aria-hidden className="flex size-11 shrink-0 items-center justify-center rounded-full bg-nw-accent-tint text-nw-accent-ink [&_svg]:size-5">
        {icon}
      </span>
      <span className="flex min-w-0 flex-col">
        <span className="text-sm font-semibold text-nw-text">{label}</span>
        <span className="text-xs text-nw-text-3">{hint}</span>
        <span className="mt-1 text-[30px] leading-9 font-bold tracking-tight text-nw-text" data-testid={`${testId}-value`}>
          {value}
        </span>
      </span>
    </>
  );
  const cls = 'flex items-start gap-4 rounded-[12px] border border-nw-border bg-nw-panel px-5 py-4 text-left shadow-card';
  return onClick ? (
    <button type="button" onClick={onClick} className={cn(cls, 'cursor-pointer transition-colors hover:border-nw-accent hover:bg-nw-hover')} data-testid={testId}>
      {body}
    </button>
  ) : (
    <div className={cls} data-testid={testId}>
      {body}
    </div>
  );
}

function Sources({ dashboard: d, onOpen }: { dashboard: Dashboard; onOpen: (source: string) => void }) {
  const top = d.sources[0];
  const max = Math.max(1, ...d.sources.map((s) => s.leads));
  return (
    <Panel
      title="Where leads come from"
      testId="dashboard-sources"
      action={
        top && d.total > 0 ? (
          <span className="inline-flex items-center gap-1.5 rounded-full bg-nw-accent-tint px-3 py-1 text-xs font-semibold text-nw-accent-ink">
            <Trophy aria-hidden className="size-3.5" />
            Top source · {top.label}
          </span>
        ) : null
      }
    >
      {d.sources.length === 0 ? (
        <p className="py-6 text-center text-sm text-nw-text-3">No leads in this period.</p>
      ) : (
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-nw-border text-left text-xs font-semibold text-nw-text-3">
              <th className="py-2 font-semibold">Source</th>
              <th className="w-[38%] py-2" aria-label="Share" />
              <th className="py-2 text-right font-semibold">Leads</th>
              <th className="py-2 text-right font-semibold">Hired</th>
            </tr>
          </thead>
          <tbody>
            {d.sources.map((s) => (
              <tr key={s.key} className="cursor-pointer border-b border-nw-border last:border-0 hover:bg-nw-hover" onClick={() => onOpen(s.key)} data-testid={`source-${s.key}`}>
                <td className="py-2.5 pr-3 font-medium text-nw-text">{s.label}</td>
                <td className="py-2.5 pr-3">
                  <span className="block h-4 rounded-r-[4px] bg-nw-accent" style={{ width: `${Math.max(4, (s.leads / max) * 100)}%`, opacity: 0.35 + 0.65 * (s.leads / max) }} />
                </td>
                <td className="py-2.5 text-right tabular-nums">
                  <span className="font-semibold text-nw-text">{s.leads}</span>{' '}
                  <span className="text-nw-text-3">({d.total ? Math.round((s.leads / d.total) * 100) : 0}%)</span>
                </td>
                <td className="py-2.5 text-right tabular-nums text-nw-text">{s.hired}</td>
              </tr>
            ))}
            <tr className="font-semibold">
              <td className="pt-3 text-nw-text">Total</td>
              <td />
              <td className="pt-3 text-right tabular-nums text-nw-text">
                {d.total} <span className="font-normal text-nw-text-3">(100%)</span>
              </td>
              <td className="pt-3 text-right tabular-nums text-nw-text">{d.hired}</td>
            </tr>
          </tbody>
        </table>
      )}
    </Panel>
  );
}

function Stages({ dashboard: d, onOpen }: { dashboard: Dashboard; onOpen: (stage: RecruitStage) => void }) {
  return (
    <Panel title="Recruiting stages" testId="dashboard-stages">
      <ul className="flex flex-col">
        {d.stages.map((s) => (
          <li key={s.stage}>
            <button type="button" onClick={() => onOpen(s.stage)} className="flex w-full items-center gap-3 rounded-lg px-1 py-2 text-left hover:bg-nw-hover" data-testid={`stage-${s.stage}`}>
              <StatusSymbol family={STAGE_FAMILY[s.stage]} size={14} className={STAGE_ICON[s.stage]} />
              <span className="flex-1 text-sm text-nw-text">{s.label}</span>
              <span className="min-w-9 rounded-md border border-nw-border bg-nw-subtle px-2 py-0.5 text-center text-sm font-semibold tabular-nums text-nw-text">{s.count}</span>
            </button>
          </li>
        ))}
      </ul>
      <div className="mt-2 flex items-center justify-between border-t border-nw-border pt-3 text-sm font-semibold text-nw-text">
        <span>Total</span>
        <span className="tabular-nums">{d.total}</span>
      </div>
      <p className="mt-1 text-xs text-nw-text-3">Active (not hired, not closed): {d.inProgress}</p>
    </Panel>
  );
}

function Trend({ dashboard: d }: { dashboard: Dashboard }) {
  const max = Math.max(1, ...d.trend.map((t) => t.leads));
  // Long periods are summed by week so the bars stay readable.
  const points = useMemo(() => {
    if (d.trend.length <= 31) return d.trend.map((t) => ({ label: shortDate(t.date), value: t.leads, key: t.date }));
    const weeks: { label: string; value: number; key: string }[] = [];
    for (let i = 0; i < d.trend.length; i += 7) {
      const slice = d.trend.slice(i, i + 7);
      weeks.push({ label: shortDate(slice[0]?.date ?? ''), value: slice.reduce((s, t) => s + t.leads, 0), key: slice[0]?.date ?? String(i) });
    }
    return weeks;
  }, [d.trend]);
  const top = Math.max(1, ...points.map((p) => p.value), max);
  return (
    <Panel title="Lead trend" testId="dashboard-trend">
      <div className="flex h-48 items-end gap-1.5 overflow-x-auto pt-5" role="img" aria-label={`Leads received per ${d.trend.length > 31 ? 'week' : 'day'}`}>
        {points.map((p) => (
          <div key={p.key} className="flex min-w-[26px] flex-1 flex-col items-center justify-end gap-1" title={`${p.label}: ${p.value} lead${p.value === 1 ? '' : 's'}`}>
            <span className="text-xs font-semibold tabular-nums text-nw-text">{p.value || ''}</span>
            <span className="w-full max-w-9 rounded-t-[4px] bg-nw-accent" style={{ height: `${Math.max(p.value ? 6 : 1, (p.value / top) * 130)}px`, opacity: p.value ? 1 : 0.25 }} />
            <span className="text-[11px] whitespace-nowrap text-nw-text-3">{p.label}</span>
          </div>
        ))}
      </div>
    </Panel>
  );
}

function NextActions({ dashboard: d, onOpen }: { dashboard: Dashboard; onOpen: (stage: RecruitStage) => void }) {
  return (
    <Panel title="Next actions" testId="dashboard-next">
      <ul className="flex flex-col gap-2">
        {d.nextActions.map((a) => (
          <li key={a.key} className="flex items-center gap-3 rounded-lg py-1.5">
            <span className="flex size-10 shrink-0 items-center justify-center rounded-full bg-nw-accent-tint text-sm font-bold text-nw-accent-ink tabular-nums">{a.count}</span>
            <span className="flex-1 text-sm text-nw-text">{a.label}</span>
            <Button variant="outline" size="sm" onClick={() => onOpen(a.stage)} data-testid={`next-${a.key}`}>
              View
            </Button>
          </li>
        ))}
      </ul>
    </Panel>
  );
}

function Recent({ dashboard: d, onAll }: { dashboard: Dashboard; onAll: () => void }) {
  const navigate = useNavigate();
  return (
    <Panel
      title="Recent leads"
      testId="dashboard-recent"
      action={
        <button type="button" onClick={onAll} className="inline-flex items-center gap-1 text-sm font-semibold text-nw-accent-ink hover:underline">
          View all <ArrowRight aria-hidden className="size-3.5" />
        </button>
      }
    >
      {d.recent.length === 0 ? (
        <p className="py-4 text-center text-sm text-nw-text-3">No leads in this period.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-nw-border text-left text-xs font-semibold text-nw-text-3">
                <th className="py-2">Name</th>
                <th className="py-2">Source</th>
                <th className="py-2">Stage</th>
                <th className="py-2">Recruiter</th>
                <th className="py-2">Received</th>
              </tr>
            </thead>
            <tbody>
              {d.recent.map((r) => (
                <tr key={r.key} className="cursor-pointer border-b border-nw-border last:border-0 hover:bg-nw-hover" onClick={() => void navigate({ to: '/hr/recruiting/$candidateId', params: { candidateId: r.key } })}>
                  <td className="py-2.5 font-semibold text-nw-accent-ink underline-offset-2 hover:underline">{r.name}</td>
                  <td className="py-2.5 text-nw-text">{r.sourceLabel}</td>
                  <td className="py-2.5">
                    <span className="inline-flex items-center gap-2 text-nw-text">
                      <StatusSymbol family={STAGE_FAMILY[r.stage]} size={12} className={STAGE_ICON[r.stage]} />
                      {RECRUIT_STAGE_LABELS[r.stage]}
                    </span>
                  </td>
                  <td className="py-2.5 text-nw-text">{r.recruiter ?? 'Unassigned'}</td>
                  <td className="py-2.5 text-nw-text-2">{shortDate(r.receivedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </Panel>
  );
}
