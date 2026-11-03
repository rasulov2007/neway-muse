import { BarChart3, Briefcase, CircleDollarSign, Clock, Download, Info, Megaphone, UserRound, Users } from 'lucide-react';
import {
  CAMPAIGN_CHANNEL_LABELS,
  LEAD_SOURCE_LABELS,
  type CampaignChannel,
  type HiringAnalytics,
} from '@neway/shared';
import { Alert, Button, cn } from '@/design-system';
import { Panel, PanelEmpty, StatCard } from './RecruitingKit';
import { money, moneyOrDash, rangeLabel, type Period } from './recruiting-kit';
import { useHiringAnalytics } from './useHiring';

/**
 * Recruiting › Analytics (owner's redesign, 2026-10-01).
 *
 * Every figure is computed on read by the API from the funnel's own records (shared
 * `computeHiringAnalytics`); nothing here adds, divides or guesses. The metrics have different
 * scopes, and each panel says which:
 *   - leads and candidates: leads added in the period (a cohort), and how far they got;
 *   - hires, cost per hire and retention: hires whose hire date is in the period;
 *   - time in stage: stays that ended in the period;
 *   - campaign spend, cost per lead / per hire: the spend entries dated in the period (plus the
 *     campaign's own cost entries incurred in it) over the period's leads and the period's hires.
 * A figure that cannot be computed is a dash with its reason, never a zero.
 */

function pct(value: number | null): string {
  return value === null ? '—' : `${Math.round(value * 100)}%`;
}

const sourceLabel = (key: string) => LEAD_SOURCE_LABELS[key] ?? key.replace(/_/g, ' ');

export function HiringAnalyticsView({
  period,
  onOpenTab,
}: {
  period: Period;
  onOpenTab: (tab: string, extra?: Record<string, unknown>) => void;
}) {
  const analytics = useHiringAnalytics({ from: period.from, to: period.to });
  const a = analytics.data;
  const fresh = a && a.period.from === period.from && a.period.to === period.to;

  return (
    <div className="flex flex-col gap-4" data-testid="analytics-tab">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-xl font-bold text-ink">Recruiting performance</h2>
          <p className="text-sm text-muted">Hiring results for {rangeLabel(period.from, period.to)} (US Eastern dates).</p>
        </div>
        <Button variant="outline" icon={<Download />} disabled={!a || !fresh} onClick={() => a && exportCsv(a)}>
          Export CSV
        </Button>
      </div>

      {analytics.error ? (
        <Alert tone="danger" title="Analytics could not be loaded" description={analytics.error instanceof Error ? analytics.error.message : undefined} />
      ) : null}

      <section className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Headline figures" aria-busy={!fresh}>
        <StatCard icon={<UserRound />} label="Leads" value={fresh ? a.totals.leads : null} hint="Added in the period" testId="an-leads" />
        <StatCard
          icon={<Users />}
          tone="info"
          label="Candidates"
          value={fresh ? a.totals.converted : null}
          hint="Of those leads, now candidates"
          testId="an-candidates"
        />
        <StatCard icon={<Briefcase />} tone="violet" label="Hires" value={fresh ? a.totals.hires : null} hint="Hire date in the period" testId="an-hires" />
        <StatCard
          icon={<CircleDollarSign />}
          label="Cost per hire"
          value={fresh ? moneyOrDash(a.costPerHire.directPerHire) : null}
          hint={fresh ? (a.costPerHire.directPerHire === null ? 'No hires in this period' : 'Direct cost of the period’s hires') : undefined}
          testId="an-cph"
        />
      </section>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Funnel by source" description="Leads added in the period, and how far each source's leads got.">
          {!fresh ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : a.funnelBySource.length === 0 ? (
            <PanelEmpty
              icon={<BarChart3 />}
              title="No leads in this period."
              description="Choose a wider period in the header, or add leads to see source performance."
              action={
                <Button variant="outline" size="sm" onClick={() => onOpenTab('leads')}>
                  Go to leads
                </Button>
              }
            />
          ) : (
            <FunnelTable rows={a.funnelBySource} />
          )}
        </Panel>

        <Panel title="Time in stage" description="Median days a candidate spent in each stage, over stays that ended in the period.">
          {!fresh ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : a.stageDurations.every((s) => s.n === 0) ? (
            <PanelEmpty
              icon={<Clock />}
              title="No completed stages in this period."
              description="When candidates move through the pipeline, stage timing appears here."
            />
          ) : (
            <StageTimes rows={a.stageDurations} />
          )}
        </Panel>
      </div>

      <Panel
        title="Campaign performance"
        description={`For ${rangeLabel(period.from, period.to)}: leads added and hires made in the period; spend is the campaign's spend entries dated in the period plus its own fees incurred in it. Cost per lead and per hire divide that spend by the period's leads and hires.`}
        bodyClassName="px-0"
      >
        {!fresh ? (
          <p className="px-4 text-sm text-muted">Loading…</p>
        ) : a.funnelByCampaign.length === 0 ? (
          <PanelEmpty
            icon={<Megaphone />}
            title="No campaign activity for this period."
            action={
              <Button variant="outline" size="sm" onClick={() => onOpenTab('campaigns')}>
                Go to campaigns
              </Button>
            }
          />
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full min-w-[46rem] text-sm">
              <thead>
                <tr className="border-y border-nw-border bg-nw-subtle text-xs font-semibold text-nw-text-2">
                  <th className="px-4 py-2 text-left">Campaign</th>
                  <th className="px-4 py-2 text-left">Channel</th>
                  <th className="px-4 py-2 text-right">Leads</th>
                  <th className="px-4 py-2 text-right">Candidates</th>
                  <th className="px-4 py-2 text-right">Hires</th>
                  <th className="px-4 py-2 text-right">Spend in period</th>
                  <th className="px-4 py-2 text-right">Cost / lead</th>
                  <th className="px-4 py-2 text-right">Cost / hire</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-nw-border">
                {a.funnelByCampaign.map((r) => (
                  <tr key={r.key}>
                    <td className="px-4 py-2 font-medium text-ink">{r.label}</td>
                    <td className="px-4 py-2 text-secondary">{CAMPAIGN_CHANNEL_LABELS[r.channel as CampaignChannel] ?? r.channel}</td>
                    <td className="tabular px-4 py-2 text-right">{r.leads}</td>
                    <td className="tabular px-4 py-2 text-right">{r.converted}</td>
                    <td className="tabular px-4 py-2 text-right" title={`${r.hired} of the period's leads reached a hire; ${r.hiresInPeriod} hire${r.hiresInPeriod === 1 ? '' : 's'} made in the period`}>
                      {r.hiresInPeriod}
                    </td>
                    <td className="tabular px-4 py-2 text-right" title={`Spend entries ${money(r.spendEntries)} + campaign fees ${money(r.spend - r.spendEntries)}. To date: ${money(r.spendToDate)}`}>
                      {money(r.spend)}
                    </td>
                    <td className="tabular px-4 py-2 text-right" title={r.costPerLead === null ? 'No leads added in the period' : `Over ${r.leads} lead${r.leads === 1 ? '' : 's'} in the period`}>
                      {moneyOrDash(r.costPerLead)}
                    </td>
                    <td className="tabular px-4 py-2 text-right" title={r.costPerHire === null ? 'No hires in the period' : `Over ${r.hiresInPeriod} hire${r.hiresInPeriod === 1 ? '' : 's'} in the period`}>
                      {moneyOrDash(r.costPerHire)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Panel>

      <div className="grid gap-4 lg:grid-cols-2">
        <Panel title="Hiring costs" description={fresh ? `${a.costPerHire.hires} hire${a.costPerHire.hires === 1 ? '' : 's'} in the period.` : undefined}>
          {!fresh ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : (
            <>
              <dl className="divide-y divide-nw-border text-sm">
                <CostRow label="Direct cost, total" value={money(a.costPerHire.directTotal)} hint="Everything charged to the period's hires and their leads" />
                <CostRow label="Direct cost per hire" value={moneyOrDash(a.costPerHire.directPerHire)} testId="direct-cost-per-hire" />
                <CostRow label="True cost, total" value={money(a.costPerHire.trueTotal)} hint="Every cost in the period plus campaign spend dated in it" />
                <CostRow label="True cost per hire" value={moneyOrDash(a.costPerHire.truePerHire)} />
                <CostRow
                  label="Cost per retained hire at 90 days"
                  value={moneyOrDash(a.costPerRetainedHire90.value)}
                  hint={a.costPerRetainedHire90.reason ?? undefined}
                />
                <CostRow
                  label="Days to first load"
                  value={a.daysToFirstLoad.meanDays === null ? '—' : `${a.daysToFirstLoad.meanDays} d (n=${a.daysToFirstLoad.n})`}
                  hint={a.daysToFirstLoad.reason ?? undefined}
                />
              </dl>
              <details className="mt-3 text-xs text-muted">
                <summary className="cursor-pointer font-semibold text-secondary">What these count</summary>
                <ul className="mt-2 list-disc space-y-1 pl-4">
                  {a.costPerHire.notes.map((n) => (
                    <li key={n}>{n}</li>
                  ))}
                </ul>
              </details>
            </>
          )}
        </Panel>

        <Panel title="Retention" description="Of the period's hires old enough to judge, how many are still employed 30, 60 and 90 days after their hire date.">
          {!fresh ? (
            <p className="text-sm text-muted">Loading…</p>
          ) : (
            <>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-xs font-semibold text-nw-text-2">
                    <th className="py-1.5 text-left">After</th>
                    <th className="py-1.5 text-right">Eligible</th>
                    <th className="py-1.5 text-right">Retained</th>
                    <th className="py-1.5 text-right">Rate</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-nw-border">
                  {a.retention.map((r) => (
                    <tr key={r.days}>
                      <td className="py-1.5 text-ink">{r.days} days</td>
                      <td className="tabular py-1.5 text-right">{r.eligible}</td>
                      <td className="tabular py-1.5 text-right">{r.retained}</td>
                      <td className="tabular py-1.5 text-right" title={r.reason ?? undefined}>
                        {pct(r.rate)}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {a.retention.every((r) => r.eligible === 0) ? (
                <p className="mt-3 flex items-start gap-2 rounded-lg border border-info-border bg-info-soft px-3 py-2 text-xs text-info-text">
                  <Info aria-hidden className="mt-0.5 size-3.5 shrink-0" />
                  {a.retention[0]?.reason ?? 'No eligible hires yet'}. Retention appears once hires reach these milestones.
                </p>
              ) : null}
            </>
          )}
        </Panel>
      </div>
    </div>
  );
}

function CostRow({ label, value, hint, testId }: { label: string; value: string; hint?: string; testId?: string }) {
  return (
    <div className="flex items-baseline justify-between gap-4 py-2">
      <dt className="text-secondary">
        {label}
        {hint ? <span className="block text-2xs text-muted">{hint}</span> : null}
      </dt>
      <dd className={cn('tabular shrink-0 text-right font-semibold', value === '—' ? 'text-faint' : 'text-ink')} data-testid={testId}>
        {value}
      </dd>
    </div>
  );
}

function FunnelTable({ rows }: { rows: HiringAnalytics['funnelBySource'] }) {
  const max = Math.max(1, ...rows.map((r) => r.leads));
  return (
    <table className="w-full text-sm">
      <thead>
        <tr className="text-xs font-semibold text-nw-text-2">
          <th className="py-1.5 text-left">Source</th>
          <th className="py-1.5 text-right">Leads</th>
          <th className="py-1.5 text-right">Candidates</th>
          <th className="py-1.5 text-right">Offer</th>
          <th className="py-1.5 text-right">Hired</th>
        </tr>
      </thead>
      <tbody className="divide-y divide-nw-border">
        {rows.map((r) => (
          <tr key={r.key}>
            <td className="py-2 pr-3">
              <span className="block text-ink">{sourceLabel(r.key)}</span>
              <span className="mt-1 block h-1.5 rounded-full bg-nw-track" aria-hidden>
                <span className="block h-full rounded-full bg-nw-chart-1" style={{ width: `${(r.leads / max) * 100}%` }} />
              </span>
            </td>
            <td className="tabular py-2 text-right">{r.leads}</td>
            <td className="tabular py-2 text-right">{r.converted}</td>
            <td className="tabular py-2 text-right">{r.offer}</td>
            <td className="tabular py-2 text-right">{r.hired}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function StageTimes({ rows }: { rows: HiringAnalytics['stageDurations'] }) {
  const measured = rows.filter((r) => r.n > 0);
  const max = Math.max(1, ...measured.map((r) => r.medianDays ?? 0));
  return (
    <ul className="flex flex-col gap-2 text-sm">
      {measured.map((r) => (
        <li key={r.stage} className="grid grid-cols-[8rem_minmax(0,1fr)_5.5rem] items-center gap-3">
          <span className="truncate text-ink">{r.label}</span>
          <span className="h-2 rounded-full bg-nw-track" aria-hidden>
            <span className="block h-full rounded-full bg-nw-chart-2" style={{ width: `${((r.medianDays ?? 0) / max) * 100}%` }} />
          </span>
          <span className="tabular text-right text-secondary">
            {r.medianDays} d <span className="text-2xs text-muted">n={r.n}</span>
          </span>
        </li>
      ))}
    </ul>
  );
}

/** A CSV of what is on screen, built from the same API response; nothing is recomputed. */
function exportCsv(a: HiringAnalytics) {
  const esc = (v: unknown) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines: unknown[][] = [
    ['Recruiting performance', `${a.period.from} to ${a.period.to}`, 'US Eastern dates'],
    [],
    ['Totals'],
    ['Leads added', a.totals.leads],
    ['Converted into candidates', a.totals.converted],
    ['Hires (hire date in period)', a.totals.hires],
    ['Direct cost per hire', a.costPerHire.directPerHire ?? 'n/a'],
    ['True cost per hire', a.costPerHire.truePerHire ?? 'n/a'],
    [],
    ['Funnel by source', 'Leads', 'Candidates', 'Checks', 'Offer', 'Hired'],
    ...a.funnelBySource.map((r) => [sourceLabel(r.key), r.leads, r.converted, r.checks, r.offer, r.hired]),
    [],
    ['Time in stage', 'Median days', 'Mean days', 'Stays'],
    ...a.stageDurations.map((r) => [r.label, r.medianDays ?? 'n/a', r.meanDays ?? 'n/a', r.n]),
    [],
    ['Campaign', 'Channel', 'Leads (period)', 'Candidates (period)', 'Hires made (period)', 'Spend in period', 'Of which dated spend entries', 'Cost per lead (period)', 'Cost per hire (period)', 'Spend to date'],
    ...a.funnelByCampaign.map((r) => [r.label, r.channel, r.leads, r.converted, r.hiresInPeriod, r.spend, r.spendEntries, r.costPerLead ?? 'n/a', r.costPerHire ?? 'n/a', r.spendToDate]),
    [],
    ['Retention after (days)', 'Eligible', 'Retained', 'Rate'],
    ...a.retention.map((r) => [r.days, r.eligible, r.retained, r.rate ?? 'n/a']),
    [],
    ['Notes'],
    ...a.costPerHire.notes.map((n) => [n]),
  ];
  const csv = lines.map((row) => row.map(esc).join(',')).join('\r\n');
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = `recruiting-performance-${a.period.from}-to-${a.period.to}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
