import { Button } from '@/design-system';
import { HiringAnalyticsView } from '../HiringAnalyticsPage';
import { PeriodControl } from '../RecruitingKit';
import { rangeLabel, type Period } from '../recruiting-kit';
import { QuietState, RecruitCard } from './RecruitKit';
import { useRecruitAnalytics } from './useRecruit';

function pct(v: number | null): string {
  return v === null ? '—' : `${Math.round(v * 100)}%`;
}

/**
 * Recruiting analytics (owner's redesign, 2026-10-08): leads added in a period, how many of them
 * are hired, the conversion between the two (defined on the page), by source and by recruiter.
 * Nothing is estimated: a figure with no denominator says so. The full funnel, cost and retention
 * analytics stay below.
 */
export function RecruitAnalytics({
  period,
  today,
  onPeriod,
  onOpenTab,
}: {
  period: Period;
  today: string;
  onPeriod: (p: { period?: string; from?: string; to?: string }) => void;
  onOpenTab: (tab: string, extra?: Record<string, unknown>) => void;
}) {
  const range = { from: period.from, to: period.to };
  const data = useRecruitAnalytics(range);
  const a = data.data;
  return (
    <div className="flex flex-col gap-5" data-testid="recruit-analytics">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-nw-text-2">{rangeLabel(range.from, range.to)} · leads added in the period, US Eastern dates</p>
        <PeriodControl period={period} today={today} onChange={onPeriod} />
      </div>
      {data.isPending ? (
        <RecruitCard><QuietState title="Loading…" /></RecruitCard>
      ) : data.error || !a ? (
        <RecruitCard>
          <QuietState tone="error" title="Analytics are unavailable right now" action={<Button variant="outline" onClick={() => void data.refetch()}>Try again</Button>} />
        </RecruitCard>
      ) : (
        <>
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <Figure label="Leads" value={String(a.leads)} />
            <Figure label="Hired" value={String(a.hired)} hint="Of those leads" />
            <Figure label="Conversion" value={pct(a.conversion)} hint={a.conversion === null ? 'No leads in the period' : a.conversionDefinition} />
          </div>
          <div className="grid grid-cols-1 gap-5 lg:grid-cols-2">
            <RecruitCard title="Lead sources" testId="lead-sources">
              {a.sources.length === 0 ? (
                <QuietState title="No leads in this period" />
              ) : (
                <ul className="flex flex-col gap-3">
                  {a.sources.map((s) => {
                    const max = Math.max(...a.sources.map((x) => x.leads), 1);
                    return (
                      <li key={s.key} className="grid grid-cols-[110px_minmax(0,1fr)_40px] items-center gap-3 text-sm">
                        <span className="truncate text-nw-text-2">{s.label}</span>
                        <span className="h-2.5 rounded-full bg-nw-track" aria-hidden>
                          <span className="block h-full rounded-full bg-nw-accent" style={{ width: `${(s.leads / max) * 100}%` }} />
                        </span>
                        <span className="text-right font-semibold text-nw-text">{s.leads}</span>
                      </li>
                    );
                  })}
                </ul>
              )}
            </RecruitCard>
            <RecruitCard title="Recruiter results" testId="recruiter-results">
              {a.recruiters.length === 0 ? (
                <QuietState title="No leads in this period" />
              ) : (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="text-left text-xs tracking-[0.08em] text-nw-text-3 uppercase">
                      <th className="pb-2 font-semibold">Recruiter</th>
                      <th className="pb-2 text-right font-semibold">Leads</th>
                      <th className="pb-2 text-right font-semibold">Hired</th>
                      <th className="pb-2 text-right font-semibold">Conversion</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-nw-border">
                    {a.recruiters.map((r) => (
                      <tr key={r.employeeId ?? 'none'}>
                        <td className="py-2.5 font-medium text-nw-text">{r.name}</td>
                        <td className="py-2.5 text-right text-nw-text-2">{r.leads}</td>
                        <td className="py-2.5 text-right text-nw-text-2">{r.hired}</td>
                        <td className="py-2.5 text-right text-nw-text-2">{pct(r.conversion)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </RecruitCard>
          </div>
          <p className="text-xs text-nw-text-3">Conversion: {a.conversionDefinition} A lead added late in the period may still be hired later.</p>
        </>
      )}
      <details className="rounded-[16px] border border-nw-border bg-nw-panel p-4">
        <summary className="cursor-pointer text-sm font-semibold text-nw-text">Funnel, cost per hire and retention</summary>
        <div className="pt-4">
          <HiringAnalyticsView period={period} onOpenTab={onOpenTab} />
        </div>
      </details>
    </div>
  );
}

function Figure({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="flex min-h-[104px] flex-col justify-between rounded-xl border border-nw-border-strong bg-nw-panel px-5 py-4 shadow-card">
      <span className="text-[13px] font-medium text-nw-text-2">{label}</span>
      <span className="text-[34px] leading-[40px] font-bold tracking-tight text-nw-text">{value}</span>
      {hint ? <span className="text-xs text-nw-text-3">{hint}</span> : null}
    </div>
  );
}
