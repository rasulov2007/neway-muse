import { CircleAlert, Info, Table2 } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import { useNavigate } from '@tanstack/react-router';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ReferenceArea, Tooltip, XAxis, YAxis } from 'recharts';
import { safetyRules as R, type accidentsV2 as A } from '@neway/shared';
import { Button, ChartFrame, ChartLegend, ChartTooltip, Drawer, chartTheme, cn } from '@/design-system';
import { nowMs } from '@/lib/clock';
import { useAnalytics } from './api';
import { Empty, LoadError, Loading, Panel, SevBadge, ToneBadge } from './ui';

/**
 * Analytics view (SPEC §1.6, §7.14; prototype screens/Analytics.tsx). Every number comes from
 * `GET /safety/accidents-v2/analytics` (the shared rule). Charts use Recharts with the repo's chartTheme — the
 * validated series pair and the sequential ramp for severity, no new colours, no dual axes — each with hover and
 * keyboard tooltips, a "Show as tables" twin and a drill-down to exactly the cases behind the mark (ACCEPTANCE M5/M6).
 */

type An = A.AnalyticsResponse;
type Drill = { title: string; ids: string[]; note?: string };

const SEV: { key: R.Severity; label: string; color: string }[] = [
  { key: 'minor', label: 'Minor', color: chartTheme.sequential[1] },
  { key: 'moderate', label: 'Moderate', color: chartTheme.sequential[3] },
  { key: 'serious', label: 'Serious', color: chartTheme.sequential[5] },
  { key: 'critical', label: 'Critical', color: chartTheme.sequential[6] },
];
const S1 = chartTheme.series[0];
const S2 = chartTheme.series[1];
const PREVENT_LABEL = R.PREVENT_LABEL;
const money = (c: number | null | undefined, compact = true) => R.money(c, { compact });
const mLabel = (m: string) => R.monthLabel(m);

export function AnalyticsView({ range, rangeLabel }: { range: A.RangeQuery; rangeLabel: string }) {
  const q = useAnalytics(range);
  const [drill, setDrill] = useState<Drill | null>(null);
  const [tables, setTables] = useState(false);
  if (q.isLoading) return <Loading />;
  if (q.error || !q.data) return <LoadError error={q.error ?? new Error('No data')} />;
  const a = q.data;
  const open = (title: string, ids: string[], note?: string) => setDrill({ title, ids, note });
  const k = a.kpis;
  const rate = k.ratePerMillionMiles;
  const share = k.preventableShare;
  const seeMoney = k.netCostCents !== null;
  return (
    <div className="flex min-w-0 flex-col gap-3" id="analytics">
      <div className={cn('flex flex-wrap items-center gap-2 rounded-[10px] border px-3 py-2 text-sm', a.sample.smallSample ? 'border-nw-warning-border bg-nw-warning-bg text-nw-warning-text' : 'border-nw-border bg-nw-panel text-nw-text-2')} id="sample-banner">
        {a.sample.smallSample ? <CircleAlert className="size-4 shrink-0" aria-hidden /> : <Info className="size-4 shrink-0" aria-hidden />}
        <span className="min-w-0 flex-1">
          Based on {R.plural(a.sample.cases, 'case')} ({rangeLabel}). {a.sample.smallSample ? 'Small sample — treat trends as directional, not conclusive.' : 'Every chart opens the cases behind it.'} Driver-level numbers are for review conversations, not rankings.
        </span>
        <Button size="sm" variant="ghost" icon={<Table2 />} id="toggle-tables" aria-pressed={tables} onClick={() => setTables((t) => !t)}>
          {tables ? 'Hide tables' : 'Show as tables'}
        </Button>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6" id="analytics-kpis">
        <Kpi label="Accidents" value={String(k.accidents)} sub={`${k.dotRecordable} DOT-recordable`} onClick={() => open('All accidents in range', k.caseIds)} />
        <Kpi
          label="Rate per 1M miles"
          value={rate.value === null ? '—' : rate.value.toFixed(2)}
          sub={rate.value === null ? `Not shown: ${'reason' in rate ? rate.reason.toLowerCase() : ''}` : `DOT-recordable ${rate.dotValue.toFixed(2)} · ${rate.qualifyingMonths} of ${rate.totalMonths} months have enough mileage data`}
        />
        <Kpi label="Preventable" value={share.value === null ? '—' : R.pct(share.value)} sub={`${share.preventable} of ${share.decided} decided · ${share.notDecided} not decided yet`} onClick={() => open('Preventable cases', share.caseIds)} />
        <Kpi label="Investigation time" value={k.investigationDays.median === null ? '—' : `${k.investigationDays.median.toFixed(0)} days`} sub={`Median, report → approved · ${k.investigationDays.within14} of ${k.investigationDays.count} within 14 days`} />
        <Kpi label="Net accident cost" value={seeMoney ? money(k.netCostCents) : '—'} sub={seeMoney ? `${money(k.spentCents)} spent · ${money(k.recoveredCents)} recovered` : 'Repair costs are not shown to your role'} />
        <Kpi label="Truck downtime" value={`${k.downtime.truckDays.toFixed(0)} days`} sub={k.downtime.lostRevenueCents === null ? 'Lost contribution not shown to your role' : `≈ ${money(k.downtime.lostRevenueCents)} lost contribution (not cash)`} />
      </div>

      {a.insights.length ? (
        <Panel title="What deserves attention" sub="Computed from the cases below — each opens its evidence" id="insights" pad={false}>
          <ul className="divide-y divide-nw-border">
            {a.insights.map((x) => (
              <li key={x.id} className="flex flex-wrap items-start gap-2 px-4 py-2.5 text-sm text-nw-text">
                <ToneBadge tone={x.tone === 'warning' ? 'warning' : 'info'}>{x.tone === 'warning' ? 'Check' : 'Note'}</ToneBadge>
                <span className="min-w-0 flex-1">{x.text}</span>
                <Button size="sm" variant="ghost" onClick={() => open('Cases behind this insight', x.caseIds)}>{R.plural(x.caseIds.length, 'case')}</Button>
              </li>
            ))}
          </ul>
        </Panel>
      ) : null}

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Panel title="Accidents by month" sub="Stacked by severity · click a month">
          <ByMonth a={a} onDrill={open} />
          {tables ? <DataTable cols={['Month', 'Minor', 'Moderate', 'Serious', 'Critical']} rows={a.byMonth.map((b) => [mLabel(b.month), b.minor, b.moderate, b.serious, b.critical])} /> : null}
        </Panel>
        <Panel title="Accidents per million miles" sub="Shaded months lack enough odometer data (needs 70% of trucks)">
          <RateChart a={a} onDrill={open} />
          {tables ? <DataTable cols={['Month', 'Rate', 'Note']} rows={a.ratePerMonth.map((p) => [mLabel(p.month), p.value === null ? '—' : p.value.toFixed(2), p.note])} /> : null}
        </Panel>
        <Panel title="By accident type" sub="Click a type">
          <BarList rows={a.byType.map((t) => ({ key: t.type, label: t.type, value: t.count, ids: t.caseIds }))} onSelect={(r) => open(r.label, r.ids)} />
          {tables ? <DataTable cols={['Type', 'Cases']} rows={a.byType.map((t) => [t.type, t.count])} /> : null}
        </Panel>
        <Panel title="Preventability outcomes" sub="Company determination — separate from fault and from FMCSA review">
          <BarList rows={a.preventability.map((p) => ({ key: p.outcome, label: PREVENT_LABEL[p.outcome], value: p.count, ids: p.caseIds, color: p.outcome === 'preventable' ? S2 : p.outcome === 'non_preventable' ? S1 : chartTheme.other }))} onSelect={(r) => open(r.label, r.ids)} />
          <p className="mt-2 text-xs text-nw-text-3">“Not decided” cases are open investigations; they are excluded from the preventable share.</p>
          {tables ? <DataTable cols={['Outcome', 'Cases']} rows={a.preventability.map((p) => [PREVENT_LABEL[p.outcome], p.count])} /> : null}
        </Panel>
        {a.cashByMonth ? (
          <Panel title="Cash cost by month" sub="Spent vs. recovered, by month the accident happened">
            <Grouped
              id="chart-cost"
              data={a.cashByMonth.map((b) => ({ key: b.month, label: mLabel(b.month), a: b.spentCents, b: b.recoveredCents, ids: b.caseIds }))}
              series={[{ key: 'a', label: 'Spent', color: S2 }, { key: 'b', label: 'Recovered', color: S1 }]}
              format={(v) => money(v)}
              onSelect={(d) => open(`Costs — ${d.label}`, d.ids)}
            />
            {tables ? <DataTable cols={['Month', 'Spent', 'Recovered']} rows={a.cashByMonth.map((b) => [mLabel(b.month), money(b.spentCents, false), money(b.recoveredCents, false)])} /> : null}
          </Panel>
        ) : null}
        {a.estimateVsFinal ? (
          <Panel title="Estimate at report vs. final cost" sub={a.estimateBias ? `Closed cases · estimates were ${R.pct(a.estimateBias.pct)} ${a.estimateBias.direction} overall` : 'No closed cases in range'}>
            {a.estimateVsFinal.length ? (
              <Grouped
                id="chart-est"
                data={a.estimateVsFinal.slice(-14).map((e) => ({ key: e.accidentId, label: e.number.slice(-3), a: e.estimateCents, b: e.finalCents, ids: [e.accidentId], note: e.number }))}
                series={[{ key: 'a', label: 'Estimate at report', color: S1 }, { key: 'b', label: 'Final cost', color: S2 }]}
                format={(v) => money(v)}
                onSelect={(d) => open(d.note ?? d.label, d.ids)}
              />
            ) : (
              <Empty title="No closed cases in this range" />
            )}
            {tables && a.estimateVsFinal.length ? <DataTable cols={['Case', 'Estimate at report', 'Final cost']} rows={a.estimateVsFinal.map((e) => [e.number, money(e.estimateCents, false), money(e.finalCents, false)])} /> : null}
          </Panel>
        ) : null}
        <Panel title="Downtime by truck" sub="Verified out-of-service days · click to see the cases">
          {a.downtimeByTruck.length ? <BarList rows={a.downtimeByTruck.map((r) => ({ key: r.truckId, label: `Truck ${r.unit}`, value: r.truckDays, ids: r.caseIds, sub: R.plural(r.caseIds.length, 'case') }))} format={(v) => `${v} d`} onSelect={(r) => open(r.label, r.ids)} /> : <Empty title="No downtime in range" />}
          {tables && a.downtimeByTruck.length ? <DataTable cols={['Truck', 'Truck-days', 'Cases']} rows={a.downtimeByTruck.map((r) => [`Truck ${r.unit}`, r.truckDays, r.caseIds.length])} /> : null}
        </Panel>
        <Panel title="Where accidents happen" sub="Highway and state · click to see the cases">
          {a.whereByCorridor.length ? <BarList rows={a.whereByCorridor.map((w) => ({ key: w.label, label: w.label, value: w.count, ids: w.caseIds }))} onSelect={(r) => open(r.label, r.ids)} /> : <Empty title="No accidents in range" />}
          {tables && a.whereByCorridor.length ? <DataTable cols={['Where', 'Cases']} rows={a.whereByCorridor.map((w) => [w.label, w.count])} /> : null}
        </Panel>
      </div>

      <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
        <Panel title="Repeat involvement (last 12 months)" sub="Two or more cases. Includes non-preventable cases; miles driven differ by driver." id="repeat" pad={false}>
          {a.repeatInvolvement.length === 0 ? (
            <Empty title="No repeat involvement" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-nw-border text-left text-xs text-nw-text-3">
                    <th className="px-4 py-2 font-semibold">Driver / truck</th>
                    <th className="px-2 py-2 text-right font-semibold">Cases</th>
                    <th className="px-2 py-2 text-right font-semibold">Preventable</th>
                    <th className="px-4 py-2 font-semibold">Cases</th>
                  </tr>
                </thead>
                <tbody>
                  {a.repeatInvolvement.map((r) => (
                    <tr key={`${r.kind}:${r.id}`} className="border-b border-nw-border last:border-0">
                      <td className="px-4 py-2 text-nw-text">{r.label}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{r.cases}</td>
                      <td className="px-2 py-2 text-right tabular-nums">{r.preventable}</td>
                      <td className="px-4 py-2">
                        <button type="button" className="text-nw-accent-ink hover:underline" onClick={() => open(r.label, r.caseIds, 'Pattern to check, not a finding of fault')}>
                          {r.numbers.map((n) => n.slice(-3)).join(', ')}
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Panel>
        <Panel title="Follow-through" sub="Investigations, corrective actions and recoveries" id="follow-through">
          <FollowThrough a={a} />
        </Panel>
      </div>
      {drill ? <DrillDrawer a={a} drill={drill} onClose={() => setDrill(null)} /> : null}
    </div>
  );
}

function Kpi({ label, value, sub, onClick }: { label: string; value: string; sub: ReactNode; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={cn('flex min-w-0 flex-col rounded-[10px] border border-nw-border bg-nw-panel px-3.5 py-3 text-left shadow-(--nw-shadow-card)', onClick && 'cursor-pointer hover:border-nw-accent')}>
      <span className="text-xs font-semibold text-nw-text-3">{label}</span>
      <span className="text-[22px] font-extrabold tracking-[-.02em] text-nw-text tabular-nums">{value}</span>
      <span className="text-xs text-nw-text-3">{sub}</span>
    </Tag>
  );
}

function FollowThrough({ a }: { a: An }) {
  const f = a.followThrough;
  const row = (k: string, v: ReactNode) => (
    <div className="grid grid-cols-[minmax(0,10rem)_1fr] gap-3 border-b border-nw-border py-2 text-sm last:border-0">
      <dt className="text-nw-text-3">{k}</dt>
      <dd className="text-nw-text">{v}</dd>
    </div>
  );
  return (
    <dl>
      {row(
        'Corrective actions',
        <>
          {f.correctiveActions.done} of {f.correctiveActions.total} completed · {f.correctiveActions.onTime} on time
          {f.correctiveActions.overdue ? <> · <ToneBadge tone="urgent">{f.correctiveActions.overdue} overdue</ToneBadge></> : null}
        </>,
      )}
      {row('Own-damage claims', f.ownDamageReceivedCents === null ? 'Not shown to your role' : `${money(f.ownDamageReceivedCents, false)} received of ${money(f.ownDamageExpectedCents, false)} expected (after deductibles)`)}
      {row('Recoveries from others', f.recoveriesCents === null ? 'Not shown to your role' : `${money(f.recoveriesCents, false)} of ${money(f.recoveriesPursuedCents, false)} pursued${f.recoveriesPursuedCents ? ` (${R.pct(f.recoveriesCents / f.recoveriesPursuedCents)})` : ''}`)}
      {row('Time to settle a claim', `${f.medianDaysToSettle === null ? '—' : `${f.medianDaysToSettle.toFixed(0)} days median`} (${f.settled} settled)`)}
      {row('FMCSA preventability reviews', `${f.cpdp.submitted} submitted · ${f.cpdp.notPreventable} ruled not preventable · ${f.cpdp.eligibleNotSubmitted} eligible, not submitted`)}
    </dl>
  );
}

/* ------------------------------------------------------------------------------------------------ charts */

function TooltipBox({ label, rows }: { label: string; rows: { name: string; value: string; color: string }[] }) {
  return <ChartTooltip label={label} rows={rows} />;
}

function ByMonth({ a, onDrill }: { a: An; onDrill: (t: string, ids: string[]) => void }) {
  const data = a.byMonth.map((b) => ({ ...b, label: mLabel(b.month) }));
  const max = Math.max(1, ...data.map((d) => d.minor + d.moderate + d.serious + d.critical));
  const pick = (i?: number | null) => {
    const d = typeof i === 'number' ? data[i] : undefined;
    if (d) onDrill(`Accidents in ${d.label}`, d.caseIds);
  };
  return (
    <div id="chart-month" aria-label="Accidents per month by severity">
      <ChartFrame height={220}>
        <BarChart data={data} margin={chartTheme.margin} barCategoryGap={chartTheme.bar.categoryGap} maxBarSize={chartTheme.bar.maxSize} onClick={(s) => pick(s?.activeTooltipIndex === undefined ? null : Number(s.activeTooltipIndex))} accessibilityLayer>
          <CartesianGrid vertical={false} stroke={chartTheme.grid} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={chartTheme.axisTick} />
          <YAxis allowDecimals={false} domain={[0, max]} tickLine={false} axisLine={false} tick={chartTheme.axisTick} width={28} />
          <Tooltip
            cursor={chartTheme.tooltip.cursorFill}
            content={({ active, payload, label }) =>
              active && payload?.length ? <TooltipBox label={String(label)} rows={SEV.map((s) => ({ name: s.label, value: String((payload[0]?.payload as Record<string, number>)[s.key] ?? 0), color: s.color }))} /> : null
            }
          />
          {SEV.map((s, i) => (
            <Bar key={s.key} dataKey={s.key} name={s.label} stackId="sev" fill={s.color} stroke={chartTheme.surface} strokeWidth={1} radius={i === SEV.length - 1 ? [chartTheme.bar.radius, chartTheme.bar.radius, 0, 0] : 0} cursor="pointer" isAnimationActive={false} />
          ))}
        </BarChart>
      </ChartFrame>
      <ChartLegend items={SEV.map((s) => ({ label: s.label, color: s.color }))} />
    </div>
  );
}

function RateChart({ a, onDrill }: { a: An; onDrill: (t: string, ids: string[], note?: string) => void }) {
  const data = a.ratePerMonth.map((p) => ({ ...p, label: mLabel(p.month) }));
  const gaps = data.filter((d) => d.value === null);
  if (data.every((d) => d.value === null))
    return <p className="py-6 text-center text-sm text-nw-text-3" id="chart-rate">Not enough odometer data in this range — {data[0]?.note.toLowerCase() ?? 'no mileage data'}.</p>;
  return (
    <div id="chart-rate" aria-label="Accident rate per million miles">
      <ChartFrame height={220}>
        <LineChart data={data} margin={chartTheme.margin} onClick={(s) => { const d = typeof s?.activeTooltipIndex === 'number' ? data[s.activeTooltipIndex] : undefined; if (d) onDrill(`Accidents in ${d.label}`, d.caseIds, d.note); }} accessibilityLayer>
          <CartesianGrid vertical={false} stroke={chartTheme.grid} />
          {gaps.map((g) => <ReferenceArea key={g.month} x1={g.label} x2={g.label} fill={chartTheme.band} fillOpacity={1} ifOverflow="extendDomain" label={{ value: 'not enough data', position: 'insideTop', fill: chartTheme.axis, fontSize: 10 }} />)}
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={chartTheme.axisTick} />
          <YAxis tickLine={false} axisLine={false} tick={chartTheme.axisTick} width={36} />
          <Tooltip cursor={chartTheme.tooltip.cursorLine} content={({ active, payload, label }) => (active && payload?.length ? <TooltipBox label={String(label)} rows={[{ name: (payload[0]?.payload as { note: string }).note, value: (payload[0]?.payload as { value: number | null }).value === null ? '—' : ((payload[0]?.payload as { value: number }).value).toFixed(2), color: S1 }]} /> : null)} />
          <Line type="monotone" dataKey="value" name="Per 1M miles" stroke={S1} strokeWidth={chartTheme.line.strokeWidth} dot={{ r: 3, fill: S1 }} activeDot={chartTheme.dot} connectNulls={false} isAnimationActive={false} />
        </LineChart>
      </ChartFrame>
    </div>
  );
}

function Grouped({ id, data, series, format, onSelect }: { id: string; data: { key: string; label: string; a: number; b: number; ids: string[]; note?: string }[]; series: { key: 'a' | 'b'; label: string; color: string }[]; format: (v: number) => string; onSelect: (d: { label: string; ids: string[]; note?: string }) => void }) {
  return (
    <div id={id}>
      <ChartFrame height={220}>
        <BarChart data={data} margin={chartTheme.margin} barGap={chartTheme.bar.gap} barCategoryGap={chartTheme.bar.categoryGap} maxBarSize={chartTheme.bar.maxSize} onClick={(s) => { const d = typeof s?.activeTooltipIndex === 'number' ? data[s.activeTooltipIndex] : undefined; if (d) onSelect(d); }} accessibilityLayer>
          <CartesianGrid vertical={false} stroke={chartTheme.grid} />
          <XAxis dataKey="label" tickLine={false} axisLine={false} tick={chartTheme.axisTick} />
          <YAxis tickLine={false} axisLine={false} tick={chartTheme.axisTick} tickFormatter={(v: number) => format(v)} width={52} />
          <Tooltip cursor={chartTheme.tooltip.cursorFill} content={({ active, payload, label }) => (active && payload?.length ? <TooltipBox label={(payload[0]?.payload as { note?: string }).note ?? String(label)} rows={series.map((s) => ({ name: s.label, value: format((payload[0]?.payload as Record<string, number>)[s.key] ?? 0), color: s.color }))} /> : null)} />
          {series.map((s) => <Bar key={s.key} dataKey={s.key} name={s.label} fill={s.color} radius={[chartTheme.bar.radius, chartTheme.bar.radius, 0, 0]} cursor="pointer" isAnimationActive={false} />)}
        </BarChart>
      </ChartFrame>
      <ChartLegend items={series.map((s) => ({ label: s.label, color: s.color }))} />
    </div>
  );
}

/** Horizontal bars as buttons: every bar is focusable, says its value, and opens its cases. */
function BarList({ rows, onSelect, format = (v) => String(v) }: { rows: { key: string; label: string; value: number; ids: string[]; sub?: string; color?: string }[]; onSelect: (r: { label: string; ids: string[] }) => void; format?: (v: number) => string }) {
  const max = Math.max(1, ...rows.map((r) => r.value));
  if (!rows.length) return <Empty title="No cases" />;
  return (
    <ul className="flex flex-col gap-1">
      {rows.map((r) => (
        <li key={r.key}>
          <button type="button" onClick={() => onSelect(r)} title={`${r.label}: ${format(r.value)}`} className="grid w-full grid-cols-[minmax(0,11rem)_1fr_auto] items-center gap-2 rounded-md px-1.5 py-1 text-left text-sm hover:bg-nw-hover focus-visible:outline-2 focus-visible:outline-nw-accent">
            <span className="truncate text-nw-text">{r.label}{r.sub ? <span className="ml-1 text-xs text-nw-text-3">· {r.sub}</span> : null}</span>
            <span className="h-3 rounded-[3px] bg-nw-track">
              <span className="block h-3 rounded-[3px]" style={{ width: `${(r.value / max) * 100}%`, background: r.color ?? S1 }} />
            </span>
            <span className="min-w-8 text-right text-xs font-semibold text-nw-text tabular-nums">{format(r.value)}</span>
          </button>
        </li>
      ))}
    </ul>
  );
}

function DataTable({ cols, rows }: { cols: string[]; rows: (string | number)[][] }) {
  return (
    <div className="mt-3 overflow-x-auto rounded-md border border-nw-border">
      <table className="w-full text-xs">
        <thead>
          <tr className="border-b border-nw-border text-left text-nw-text-3">
            {cols.map((c, i) => <th key={c} className={cn('px-2.5 py-1.5 font-semibold', i > 0 && 'text-right')}>{c}</th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={i} className="border-b border-nw-border last:border-0">
              {r.map((v, j) => <td key={j} className={cn('px-2.5 py-1.5 text-nw-text', j > 0 && 'text-right tabular-nums')}>{v}</td>)}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/* ------------------------------------------------------------------------------------------------ drill-down */

function DrillDrawer({ a, drill, onClose }: { a: An; drill: Drill; onClose: () => void }) {
  const navigate = useNavigate();
  const cs = drill.ids.map((id) => a.cases[id]).filter((c): c is A.AnalyticsCaseRef => Boolean(c)).sort((x, y) => y.occurredAt.localeCompare(x.occurredAt));
  return (
    <Drawer open onOpenChange={(o) => (o ? undefined : onClose())} size="lg" title={drill.title} description={`${R.plural(cs.length, 'case')}${drill.note ? ` · ${drill.note}` : ''}`}>
      <div className="overflow-x-auto" id="drill">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-nw-border text-left text-xs text-nw-text-3">
              <th className="px-2 py-2 font-semibold">Case</th>
              <th className="px-2 py-2 font-semibold">Truck · driver</th>
              <th className="px-2 py-2 font-semibold">Type</th>
              <th className="px-2 py-2 font-semibold">Severity</th>
              <th className="px-2 py-2 font-semibold">Preventable</th>
              <th className="px-2 py-2 text-right font-semibold">Net cost</th>
            </tr>
          </thead>
          <tbody>
            {cs.map((c) => (
              <tr key={c.id} className="cursor-pointer border-b border-nw-border last:border-0 hover:bg-nw-hover" onClick={() => { onClose(); void navigate({ to: '/safety/accidents/$accidentId', params: { accidentId: c.id } }); }}>
                <td className="px-2 py-2"><b className="text-nw-accent-ink">{c.number}</b><div className="text-xs text-nw-text-3">{R.fmtShort(c.occurredAt, c.tz, nowMs())}</div></td>
                <td className="px-2 py-2">{c.truckUnit ? `Truck ${c.truckUnit}` : '—'}<div className="text-xs text-nw-text-3">{c.driverName ?? ''}</div></td>
                <td className="max-w-48 truncate px-2 py-2">{c.type}</td>
                <td className="px-2 py-2"><SevBadge sev={c.severity} /></td>
                <td className="px-2 py-2">{PREVENT_LABEL[c.preventability]}</td>
                <td className="px-2 py-2 text-right tabular-nums">{c.netCostCents === null ? '—' : money(c.netCostCents)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Drawer>
  );
}
