import { useQuery } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { Download, Plus } from 'lucide-react';
import { useState, type ReactNode } from 'react';
import {
  TIRE_ACTION_LABEL,
  TIRE_GROUP_LABEL,
  TIRE_POSITIONS,
  TIRE_WINDOWS,
  TIRE_WINDOW_LABEL,
  UNASSIGNED_TIRE,
  tirePositionChip,
  tirePositionLabel,
  type FleetSpendEvent,
  type TireEvent,
  type TirePositionKey,
  type TireWindow,
} from '@neway/shared';
import { Button, Select, cn } from '@/design-system';
import { apiGet } from '@/lib/api-client';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { TireTruckSvg, heat } from './TireTruckSvg';
import { brandsTable, groupStats, isReplacement, kpis, milesSinceLast, positionStats, reasonsTable, rowsOf, unitsTable, valueOf, type ColorBy, type TireRecordInfo, type TireRow } from './tire-analytics';

/**
 * The Tires page (owner mockup, 2026-10-14; Patterns to investigate left out on purpose): where
 * tire money goes and which positions keep failing - cards, the map coloured by replacements,
 * spend or repairs, the chosen position's history, the costliest positions, and tabs for units,
 * brands, reasons, every tire event, data quality and the records themselves.
 */

const usd = (cents: number) => `$${Math.round(cents / 100).toLocaleString('en-US')}`;
const short = (cents: number) => (cents >= 100_000 ? `$${(cents / 100_000).toFixed(1)}k` : `$${Math.round(cents / 100)}`);
const miles = (m: number | null) => (m === null ? '—' : `${m.toLocaleString('en-US')} mi`);

type Tab = 'units' | 'brands' | 'reasons' | 'events' | 'quality' | 'records';

export function TiresAnalytics({
  records,
  events,
  loading,
  window,
  onWindow,
  periodLabel,
  onExport,
  onTagUnassigned,
  recordsTable,
}: {
  records: FleetSpendEvent[];
  events: TireEvent[] | undefined;
  loading: boolean;
  window: TireWindow;
  onWindow: (w: TireWindow) => void;
  periodLabel: string | null;
  onExport: () => void;
  onTagUnassigned: () => void;
  recordsTable: ReactNode;
}) {
  const [colorBy, setColorBy] = useState<ColorBy>('count');
  const [unitType, setUnitType] = useState<'all' | 'truck' | 'trailer'>('all');
  const [unit, setUnit] = useState('');
  const [selected, setSelected] = useState<TirePositionKey | null>(null);
  const [tab, setTab] = useState<Tab>('units');
  const units = useQuery({
    queryKey: ['fleet', 'units', 'both'],
    queryFn: async () => {
      const [trucks, trailers] = await Promise.all([apiGet<{ data: { id: string; unitNumber: string }[] }>('/fleet/units', { assetType: 'truck' }), apiGet<{ data: { id: string; unitNumber: string }[] }>('/fleet/units', { assetType: 'trailer' })]);
      return { trucks: trucks.data, trailers: trailers.data };
    },
    staleTime: 5 * 60_000,
  });
  const unitName = (id: string, kind: 'truck' | 'trailer') => (kind === 'trailer' ? units.data?.trailers : units.data?.trucks)?.find((u) => u.id === id)?.unitNumber ?? id;

  const recordMap = new Map<string, TireRecordInfo>(
    records.map((r) => [`${r.kind}:${r.id}`, { key: `${r.kind}:${r.id}`, id: r.id, reference: r.reference, date: r.date, unitId: r.truckId, unitNumber: r.unitNumber, vendorName: r.vendorName }]),
  );
  const all = rowsOf(events ?? [], recordMap, unitName);
  const scoped = all.filter((r) => (unitType === 'all' || r.ownerKind === unitType) && (!unit || r.owner === unit));
  const unitOptions = [...new Map(all.map((r) => [r.owner, { value: r.owner, label: `${r.ownerKind === 'trailer' ? 'Trailer' : 'Unit'} ${r.ownerNumber}` }])).values()].sort((a, b) => a.label.localeCompare(b.label));
  const k = kpis(scoped);
  const stats = Object.fromEntries(TIRE_POSITIONS.map((p) => [p.id, positionStats(scoped, p.id)])) as Record<TirePositionKey, ReturnType<typeof positionStats>>;
  const values = Object.fromEntries(TIRE_POSITIONS.map((p) => [p.id, valueOf(stats[p.id], colorBy)]));
  const max = Math.max(0, ...Object.values(values));
  const groups = groupStats(scoped);
  const gmax = Math.max(1, ...groups.map((g) => g.spendCents));
  const costliest = TIRE_POSITIONS.map((p) => stats[p.id]).filter((s) => s.spendCents > 0).sort((a, b) => b.spendCents - a.spendCents).slice(0, 7);
  const sel = selected ? stats[selected] : null;
  const toggle = (id: TirePositionKey) => setSelected((s) => (s === id ? null : id));

  return (
    <div className="flex flex-col gap-4" data-testid="tires-analytics">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[26px] font-extrabold tracking-[-.02em] text-nw-text">Tires</h1>
          <p className="text-sm text-nw-text-2">Where tire money goes and which positions keep failing.</p>
        </div>
        <div className="flex gap-2">
          <Button variant="outline" icon={<Download />} onClick={onExport}>
            Export
          </Button>
          <Button variant="primary" icon={<Plus />} asChild>
            <Link to="/fleet/maintenance" search={{ create: 'tires' } as never}>Tire work order</Link>
          </Button>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2 rounded-[12px] border border-nw-border bg-nw-panel px-3 py-2">
        <Segments value={window} onChange={onWindow} options={TIRE_WINDOWS.map((w) => ({ value: w, label: TIRE_WINDOW_LABEL[w] }))} label="Period" />
        <Segments value={unitType} onChange={(v) => { setUnitType(v); setUnit(''); }} options={[{ value: 'all', label: 'Trucks + trailers' }, { value: 'truck', label: 'Trucks' }, { value: 'trailer', label: 'Trailers' }]} label="Units" />
        <Select size="sm" aria-label="Unit" value={unit} onValueChange={setUnit} placeholder="Whole fleet" className="w-44" options={[{ value: '', label: 'Whole fleet' }, ...unitOptions.filter((o) => unitType === 'all' || all.find((r) => r.owner === o.value)?.ownerKind === unitType)]} />
        {periodLabel ? <span className="ml-auto text-xs text-nw-text-3">{periodLabel}</span> : null}
      </div>

      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
        <Card label="Tire spend (tire lines only)" value={loading ? '…' : usd(k.spendCents)} sub="Tire lines and their labor; brakes and fees on the same orders are not counted" />
        <Card label="Tires replaced" value={loading ? '…' : String(k.replaced)} sub={`${k.usedCount} used casings · ${k.newCount} new${k.replaced - k.usedCount - k.newCount > 0 ? ` · ${k.replaced - k.usedCount - k.newCount} not said` : ''}`} />
        <Card label="Repairs (patch, valve)" value={loading ? '…' : String(k.repairs)} sub={`${usd(k.repairCents)} · kept tires in service`} />
        <Card label="Avg new tire price" value={loading ? '…' : k.avgNewCents === null ? '—' : usd(k.avgNewCents)} sub="Tire only, before labor" />
        <Card label="Records without a position" value={loading ? '…' : String(k.unassignedRecords)} sub={`${k.unassignedTires} tires · tag them`} tone={k.unassignedRecords > 0 ? 'warning' : 'plain'} onClick={k.unassignedRecords > 0 ? onTagUnassigned : undefined} />
      </div>

      <section className="overflow-hidden rounded-[12px] border border-nw-border bg-nw-panel" aria-label="Tire position map">
        <header className="flex flex-wrap items-center gap-2 border-b border-nw-border px-4 py-3">
          <h2 className="text-[15px] font-bold text-nw-text">Tire position map</h2>
          <span className="ml-auto text-xs text-nw-text-3">Color by</span>
          <Segments value={colorBy} onChange={setColorBy} options={[{ value: 'count', label: 'Replacements' }, { value: 'spend', label: 'Spend' }, { value: 'repairs', label: 'Repairs' }]} label="Color by" />
        </header>
        <div className="p-4">
          <div className="overflow-x-auto rounded-[10px] border border-nw-border" data-theme="light">
            <div className="min-w-[560px] bg-nw-subtle px-3 pt-3 pb-2" data-testid="tire-map">
              {loading ? (
                <div className="flex aspect-[1000/392] items-center justify-center text-sm text-nw-text-3">Loading…</div>
              ) : (
                <TireTruckSvg counts={values} max={max} format={colorBy === 'spend' ? short : String} selected={new Set(selected ? [selected] : [])} onSelect={toggle} className="mx-auto block h-auto w-full max-w-[1000px]" />
              )}
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-nw-text-3">
                <span className="flex items-center gap-2">
                  Fewer
                  <span className="h-2 w-28 rounded-full" style={{ background: 'linear-gradient(90deg, color-mix(in oklab, var(--nw-urgent-icon) 15%, var(--nw-warning-bg)), var(--nw-urgent-icon))' }} aria-hidden />
                  More
                </span>
                <span className="flex items-center gap-2">
                  Click a tire for its history
                  {selected ? (
                    <Button size="sm" variant="outline" onClick={() => setSelected(null)}>
                      Clear selection
                    </Button>
                  ) : null}
                </span>
              </div>
            </div>
          </div>
          <div className="mt-3 grid gap-3 sm:grid-cols-3">
            {groups.map((g) => (
              <div key={g.group} className="rounded-[10px] border border-nw-border bg-nw-panel px-4 py-3">
                <div className="text-[11px] font-bold tracking-[.06em] text-nw-text-3 uppercase">
                  {TIRE_GROUP_LABEL[g.group]} · {g.tires} tires
                </div>
                <div className="tabular mt-0.5 text-2xl font-extrabold text-nw-text">{usd(g.spendCents)}</div>
                <div className="text-xs text-nw-text-3">
                  {g.replaced} replaced · {g.perPosition.toFixed(1)} per position
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-nw-track">
                  <div className="h-full rounded-full" style={{ width: `${(g.spendCents / gmax) * 100}%`, background: heat(g.spendCents, gmax)?.fill ?? 'transparent' }} />
                </div>
              </div>
            ))}
          </div>
        </div>
      </section>

      <div className="grid gap-4 lg:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
        <section className="overflow-hidden rounded-[12px] border border-nw-border bg-nw-panel" aria-label="Position history" data-testid="position-panel">
          <header className="flex items-center justify-between border-b border-nw-border px-4 py-3">
            <h2 className="text-[15px] font-bold text-nw-text">{sel ? tirePositionLabel(sel.id) : 'Pick a tire'}</h2>
            {sel ? <span className="rounded-full bg-nw-subtle px-2 py-0.5 text-xs font-semibold text-nw-text-2">{sel.id}</span> : null}
          </header>
          {!sel ? (
            <p className="px-4 py-8 text-center text-sm text-nw-text-3">Click a tire on the map, or a row in Costliest positions, to see that position’s full history.</p>
          ) : (
            <div className="flex flex-col gap-3 p-4">
              <div className="grid grid-cols-2 overflow-hidden rounded-[10px] border border-nw-border">
                <Fig label="Replacements" value={String(sel.replaced)} />
                <Fig label="Total spent" value={usd(sel.spendCents)} />
                <Fig label="Last replaced" value={sel.lastReplaced ? formatIsoDate(sel.lastReplaced) : '—'} />
                <Fig label="Avg miles between" value={miles(sel.avgMilesBetween)} />
              </div>
              <dl className="grid grid-cols-[150px_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
                <dt className="text-nw-text-3">Brands / models</dt>
                <dd className="text-nw-text">{sel.brands.join(', ') || 'Not recorded'}</dd>
                <dt className="text-nw-text-3">Reasons</dt>
                <dd className="text-nw-text">{sel.reasons.map((r) => `${r.reason} ×${r.n}`).join(', ') || 'Not recorded'}</dd>
                <dt className="text-nw-text-3">Most replaced on</dt>
                <dd className="text-nw-text">{sel.topUnit ? `${sel.topUnit.number} (${sel.topUnit.n}×)` : '—'}</dd>
                <dt className="text-nw-text-3">Repairs</dt>
                <dd className="text-nw-text">{sel.repaired}</dd>
              </dl>
              <div className="overflow-x-auto rounded-[10px] border border-nw-border">
                <table className="w-full min-w-[560px] border-collapse text-[13px]">
                  <thead className="bg-nw-subtle text-left text-xs font-semibold text-nw-text-2">
                    <tr>
                      <th className="px-3 py-2">Date</th>
                      <th className="px-3 py-2">Unit</th>
                      <th className="px-3 py-2">Event</th>
                      <th className="px-3 py-2 text-right">Miles since last</th>
                      <th className="px-3 py-2 text-right">Cost</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-nw-border">
                    {sel.history.length === 0 ? (
                      <tr>
                        <td colSpan={5} className="px-3 py-4 text-center text-nw-text-3">
                          Nothing at this position in the period.
                        </td>
                      </tr>
                    ) : (
                      sel.history.map((r) => {
                        const m = milesSinceLast(scoped, r);
                        return (
                          <tr key={r.id} className={cn(isReplacement(r) && m !== null && m < 25_000 && 'bg-nw-urgent-bg')}>
                            <td className="px-3 py-2 whitespace-nowrap">
                              {formatIsoDate(r.date)}
                              <span className="block text-xs text-nw-text-3">{r.record.reference}</span>
                            </td>
                            <td className="px-3 py-2">
                              {r.ownerKind === 'trailer' ? 'Trailer' : 'Unit'} {r.ownerNumber}
                              <span className="block text-xs text-nw-text-3">{r.vendorName ?? r.record.vendorName ?? ''}</span>
                            </td>
                            <td className="px-3 py-2">
                              {r.action ? TIRE_ACTION_LABEL[r.action] : r.eventType === 'repaired' ? 'Repaired' : r.eventType === 'blowout' ? 'Blowout' : 'Replaced'}
                              <span className="block text-xs text-nw-text-3">{[r.brand, r.reason].filter(Boolean).join(' · ') || ' '}</span>
                            </td>
                            <td className="px-3 py-2 text-right">{m === null ? (isReplacement(r) ? 'first on file' : '—') : miles(m)}</td>
                            <td className="tabular px-3 py-2 text-right">{usd(r.costCents)}</td>
                          </tr>
                        );
                      })
                    )}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>
        <section className="overflow-hidden rounded-[12px] border border-nw-border bg-nw-panel" aria-label="Costliest positions">
          <header className="flex items-center justify-between border-b border-nw-border px-4 py-3">
            <h2 className="text-[15px] font-bold text-nw-text">Costliest positions</h2>
            <span className="text-xs text-nw-text-3">Select a tire for its full history</span>
          </header>
          {costliest.length === 0 ? (
            <p className="px-4 py-8 text-center text-sm text-nw-text-3">No tire spend on a known position in this period.</p>
          ) : (
            <ol className="flex flex-col p-2">
              {costliest.map((s, i) => (
                <li key={s.id}>
                  <button type="button" onClick={() => toggle(s.id)} className={cn('grid w-full grid-cols-[minmax(0,1fr)_minmax(0,1fr)_auto] items-center gap-3 rounded-md px-2 py-2 text-left hover:bg-nw-hover', selected === s.id && 'bg-nw-accent-tint')}>
                    <span className="min-w-0">
                      <span className="block truncate text-sm font-semibold text-nw-text">
                        {i + 1}. {tirePositionLabel(s.id)}
                      </span>
                      <span className="block text-[11px] text-nw-text-3">
                        {s.replaced} replaced · {s.repaired} repaired
                      </span>
                    </span>
                    <span className="h-2 overflow-hidden rounded-full bg-nw-track">
                      <span className="block h-full rounded-full" style={{ width: `${(s.spendCents / costliest[0]!.spendCents) * 100}%`, background: heat(s.spendCents, costliest[0]!.spendCents)?.fill }} />
                    </span>
                    <span className="tabular text-sm font-bold text-nw-text">{usd(s.spendCents)}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
          <p className="mx-4 mb-4 rounded-[10px] border border-nw-border bg-nw-subtle px-3 py-2 text-xs text-nw-text-3">The map shows where money goes. The Units tab shows which units caused it.</p>
        </section>
      </div>

      <section className="overflow-hidden rounded-[12px] border border-nw-border bg-nw-panel">
        <nav role="tablist" aria-label="Tire tables" className="flex gap-1 overflow-x-auto border-b border-nw-border px-3">
          {(
            [
              ['units', 'Units'],
              ['brands', 'Brands & life'],
              ['reasons', 'Reasons'],
              ['events', 'All tire events'],
              ['quality', 'Data quality'],
              ['records', 'Records'],
            ] as const
          ).map(([v, l]) => (
            <button key={v} type="button" role="tab" aria-selected={tab === v} onClick={() => setTab(v)} className={cn('-mb-px border-b-2 px-3 py-3 text-sm font-semibold whitespace-nowrap', tab === v ? 'border-nw-accent text-nw-text' : 'border-transparent text-nw-text-3 hover:text-nw-text')} data-testid={`tires-tab-${v}`}>
              {l}
            </button>
          ))}
        </nav>
        {tab === 'units' ? <UnitsTab rows={scoped} /> : null}
        {tab === 'brands' ? <BrandsTab rows={scoped} /> : null}
        {tab === 'reasons' ? <ReasonsTab rows={scoped} /> : null}
        {tab === 'events' ? <EventsTab rows={scoped} /> : null}
        {tab === 'quality' ? <QualityTab rows={all} onTag={onTagUnassigned} /> : null}
        {tab === 'records' ? <div>{recordsTable}</div> : null}
      </section>
    </div>
  );
}

function Segments<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-lg bg-nw-segment p-0.5">
      {options.map((o) => (
        <button key={o.value} type="button" role="radio" aria-checked={value === o.value} onClick={() => onChange(o.value)} className={cn('h-8 rounded-md px-3 text-[12.5px] font-semibold whitespace-nowrap text-nw-text-2', value === o.value && 'bg-nw-panel text-nw-text shadow-(--nw-shadow-segment)')}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

function Card({ label, value, sub, tone = 'plain', onClick }: { label: string; value: string; sub: string; tone?: 'plain' | 'warning'; onClick?: () => void }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag type={onClick ? 'button' : undefined} onClick={onClick} className={cn('flex flex-col rounded-[12px] border px-4 py-3 text-left shadow-(--nw-shadow-card)', tone === 'warning' ? 'border-nw-warning-border bg-[linear-gradient(180deg,var(--nw-warning-bg),var(--nw-panel)_70%)]' : 'border-nw-border bg-nw-panel', onClick && 'cursor-pointer hover:border-nw-accent')}>
      <span className="text-[12.5px] font-semibold text-nw-text-2">{label}</span>
      <span className={cn('tabular mt-1 text-[24px] font-extrabold', tone === 'warning' ? 'text-nw-warning-text' : 'text-nw-text')}>{value}</span>
      <span className="mt-1 text-[11.5px] text-nw-text-3">{sub}</span>
    </Tag>
  );
}

function Fig({ label, value }: { label: string; value: string }) {
  return (
    <div className="border-r border-b border-nw-border px-4 py-3 [&:nth-child(2n)]:border-r-0 [&:nth-child(n+3)]:border-b-0">
      <div className="text-xs text-nw-text-2">{label}</div>
      <div className="tabular mt-2 text-[18px] font-extrabold text-nw-text">{value}</div>
    </div>
  );
}

const th = 'px-3 py-2 text-left text-xs font-semibold text-nw-text-2 whitespace-nowrap';
const td = 'px-3 py-2 text-[13px] text-nw-text';

function UnitsTab({ rows }: { rows: TireRow[] }) {
  const list = unitsTable(rows);
  const top = Math.max(1, ...list.map((u) => u.spendCents));
  if (list.length === 0) return <p className="px-4 py-8 text-center text-sm text-nw-text-3">No tire records for this period.</p>;
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[900px] border-collapse">
        <thead className="bg-nw-subtle">
          <tr>
            <th className={th}>Unit</th>
            <th className={th}>Type</th>
            <th className={th}>Tire spend</th>
            <th className={th} />
            <th className={cn(th, 'text-right')}>vs median</th>
            <th className={cn(th, 'text-right')}>Replaced</th>
            <th className={cn(th, 'text-right')}>Repaired</th>
            <th className={cn(th, 'text-right')}>Avg miles / tire</th>
            <th className={th} />
          </tr>
        </thead>
        <tbody className="divide-y divide-nw-border">
          {list.map((u) => (
            <tr key={u.id} className={cn((u.vsMedian ?? 0) >= 2 && 'bg-nw-urgent-bg')}>
              <td className={cn(td, 'font-bold')}>
                {u.kind === 'trailer' ? 'Trailer' : 'Unit'} {u.number}
              </td>
              <td className={cn(td, 'text-nw-text-2')}>{u.kind}</td>
              <td className={cn(td, 'tabular font-semibold')}>{usd(u.spendCents)}</td>
              <td className={cn(td, 'w-[24%]')}>
                <span className="block h-2 overflow-hidden rounded-full bg-nw-track">
                  <span className={cn('block h-full rounded-full', (u.vsMedian ?? 0) >= 2 ? 'bg-nw-urgent-icon' : 'bg-nw-accent')} style={{ width: `${(u.spendCents / top) * 100}%` }} />
                </span>
              </td>
              <td className={cn(td, 'tabular text-right', (u.vsMedian ?? 0) >= 2 && 'font-bold text-nw-urgent-text')}>{u.vsMedian === null ? '—' : `${u.vsMedian.toFixed(1)}×`}</td>
              <td className={cn(td, 'tabular text-right')}>{u.replaced}</td>
              <td className={cn(td, 'tabular text-right')}>{u.repaired}</td>
              <td className={cn(td, 'tabular text-right')}>{miles(u.avgMiles)}</td>
              <td className={cn(td, 'text-right')}>
                {u.kind === 'truck' ? (
                  <Button size="sm" variant="outline" asChild>
                    <Link to="/fleet/trucks/$truckId" params={{ truckId: u.id }}>
                      Open
                    </Link>
                  </Button>
                ) : (
                  <Button size="sm" variant="outline" asChild>
                    <Link to="/fleet/trailers/$trailerId" params={{ trailerId: u.id }}>
                      Open
                    </Link>
                  </Button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <p className="border-t border-nw-border px-4 py-2 text-xs text-nw-text-3">Median compares trucks with trucks and trailers with trailers. Miles need the odometer on the tire work orders.</p>
    </div>
  );
}

function BrandsTab({ rows }: { rows: TireRow[] }) {
  const list = brandsTable(rows);
  return (
    <div>
      <p className="mx-4 mt-3 rounded-[10px] border border-nw-border bg-nw-subtle px-3 py-2 text-xs text-nw-text-3">Tire life = miles from install to removal at the same position, for tires whose install is on file. The cheapest tire is not always the cheapest per mile.</p>
      {list.length === 0 ? (
        <p className="px-4 py-8 text-center text-sm text-nw-text-3">No brands recorded yet. Brand comparison and tire life start working once tire work orders capture them.</p>
      ) : (
        <div className="overflow-x-auto">
          <table className="mt-3 w-full min-w-[760px] border-collapse">
            <thead className="bg-nw-subtle">
              <tr>
                <th className={th}>Brand · model</th>
                <th className={th}>Position</th>
                <th className={cn(th, 'text-right')}>Removed</th>
                <th className={cn(th, 'text-right')}>Avg price</th>
                <th className={cn(th, 'text-right')}>Avg life</th>
                <th className={cn(th, 'text-right')}>Cost / 1,000 mi</th>
                <th className={cn(th, 'text-right')}>Removed early</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-nw-border">
              {list.map((b) => (
                <tr key={`${b.brand}|${b.group}`} className={cn(b.lives.length > 0 && b.early / b.lives.length > 0.4 && 'bg-nw-urgent-bg')}>
                  <td className={cn(td, 'font-semibold')}>{b.brand}</td>
                  <td className={td}>{b.group}</td>
                  <td className={cn(td, 'tabular text-right')}>{b.removed}</td>
                  <td className={cn(td, 'tabular text-right')}>{b.avgPrice === null ? '—' : usd(b.avgPrice)}</td>
                  <td className={cn(td, 'tabular text-right')}>{b.avgLife === null ? '—' : miles(Math.round(b.avgLife))}</td>
                  <td className={cn(td, 'tabular text-right font-semibold')}>{b.per1000 === null ? '—' : formatMoney(b.per1000 / 100)}</td>
                  <td className={cn(td, 'tabular text-right')}>{b.lives.length ? `${b.early} of ${b.lives.length}` : '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

function ReasonsTab({ rows }: { rows: TireRow[] }) {
  const list = reasonsTable(rows);
  const top = Math.max(1, ...list.map((r) => r.spendCents));
  return (
    <div className="flex flex-col gap-2 p-4">
      {list.map((r) => (
        <div key={r.reason} className="grid grid-cols-[minmax(0,180px)_minmax(0,1fr)_auto_auto] items-center gap-3 text-sm">
          <span className="font-semibold text-nw-text">{r.reason}</span>
          <span className="h-2.5 overflow-hidden rounded-full bg-nw-track">
            <span className={cn('block h-full rounded-full', r.damage ? 'bg-nw-urgent-icon' : r.reason === 'Not recorded' ? 'bg-nw-neutral-icon' : 'bg-nw-accent')} style={{ width: `${(r.spendCents / top) * 100}%` }} />
          </span>
          <span className="text-xs text-nw-text-3">{r.n} events</span>
          <span className="tabular w-20 text-right font-semibold">{usd(r.spendCents)}</span>
        </div>
      ))}
      <p className="mt-2 rounded-[10px] border border-nw-border bg-nw-subtle px-3 py-2 text-xs text-nw-text-3">Damage reasons (red) point at routes, docks and driving. Wear reasons point at alignment, pressure and tire choice. The reason is picked per tire on the tire work order.</p>
    </div>
  );
}

function EventsTab({ rows }: { rows: TireRow[] }) {
  const list = [...rows].reverse();
  return (
    <div className="max-h-[560px] overflow-auto">
      <table className="w-full min-w-[1200px] border-collapse">
        <thead className="sticky top-0 bg-nw-subtle">
          <tr>
            <th className={th}>Date</th>
            <th className={th}>Work order</th>
            <th className={th}>Unit</th>
            <th className={th}>Position</th>
            <th className={th}>Event</th>
            <th className={th}>Brand · model</th>
            <th className={th}>Reason</th>
            <th className={cn(th, 'text-right')}>Odometer</th>
            <th className={cn(th, 'text-right')}>Miles since last</th>
            <th className={th}>Vendor</th>
            <th className={cn(th, 'text-right')}>Tire</th>
            <th className={cn(th, 'text-right')}>Labor</th>
          </tr>
        </thead>
        <tbody className="divide-y divide-nw-border">
          {list.map((r) => {
            const m = milesSinceLast(rows, r);
            return (
              <tr key={r.id} className={cn(m !== null && m < 25_000 && 'bg-nw-urgent-bg')}>
                <td className={cn(td, 'whitespace-nowrap')}>{formatIsoDate(r.date)}</td>
                <td className={cn(td, 'whitespace-nowrap')}>
                  {r.recordKind === 'work_order' ? (
                    <Link to="/fleet/shop/$orderId" params={{ orderId: r.recordId }} className="font-semibold text-nw-accent-ink hover:underline">
                      {r.record.reference}
                    </Link>
                  ) : (
                    r.record.reference
                  )}
                  {r.recordedOnUnitId ? <span className="block text-xs text-nw-text-3">on {r.record.unitNumber}’s order</span> : null}
                </td>
                <td className={cn(td, 'font-semibold whitespace-nowrap')}>
                  {r.ownerKind === 'trailer' ? 'Trailer' : 'Unit'} {r.ownerNumber}
                </td>
                <td className={cn(td, 'whitespace-nowrap')}>{r.positionId === UNASSIGNED_TIRE ? <span className="text-nw-warning-text">Unassigned</span> : tirePositionChip(r.positionId)}</td>
                <td className={cn(td, 'whitespace-nowrap')}>{r.action ? TIRE_ACTION_LABEL[r.action] : r.eventType}</td>
                <td className={td}>{r.brand ?? '—'}</td>
                <td className={td}>{r.reason ?? '—'}</td>
                <td className={cn(td, 'tabular text-right')}>{miles(r.odometer ?? null)}</td>
                <td className={cn(td, 'tabular text-right')}>{miles(m)}</td>
                <td className={td}>{r.vendorName ?? r.record.vendorName ?? '—'}</td>
                <td className={cn(td, 'tabular text-right')}>{typeof r.tireCostCents === 'number' ? usd(r.tireCostCents) : usd(r.costCents)}</td>
                <td className={cn(td, 'tabular text-right')}>{typeof r.laborCents === 'number' ? usd(r.laborCents) : '—'}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

function QualityTab({ rows, onTag }: { rows: TireRow[]; onTag: () => void }) {
  const unassigned = rows.filter((r) => r.positionId === UNASSIGNED_TIRE);
  const unRecords = new Set(unassigned.map((r) => r.record.key)).size;
  const trailerOnTruck = rows.filter((r) => (r.note ?? '').includes('trailer tire written on a truck record')).length;
  const noDetails = rows.filter((r) => !r.brand || !r.reason).length;
  const noOdo = rows.filter((r) => r.ownerKind === 'truck' && isReplacement(r) && typeof r.odometer !== 'number').length;
  const first = rows[0]?.date ?? null;
  const items: { title: string; body: string; action?: ReactNode }[] = [
    { title: `${unRecords} records / ${unassigned.reduce((s, r) => s + r.quantity, 0)} tires have no position.`, body: 'The rules could not read them from the description.', action: unRecords > 0 ? <Button size="sm" variant="outline" onClick={onTag}>Tag positions</Button> : undefined },
    { title: `${trailerOnTruck} trailer tires written on truck work orders.`, body: 'They stay unassigned until tagged; new tire work orders file trailer tires to the trailer automatically.' },
    { title: `${noDetails} tire events without a brand or reason.`, body: 'Older records only had a description. Brand comparison and tire life start working once tire work orders capture them.' },
    { title: `${noOdo} truck tire replacements without an odometer.`, body: 'Miles between replacements and cost per mile need the odometer on the order (filled from the truck record on a tire work order).' },
    { title: first ? `History starts ${formatIsoDate(first)}.` : 'No tire history yet.', body: 'A long period means little until history builds up; older invoices can be back-entered for the worst units.' },
  ];
  return (
    <ul className="divide-y divide-nw-border">
      {items.map((i) => (
        <li key={i.title} className="flex flex-wrap items-center gap-3 px-4 py-3">
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-semibold text-nw-text">{i.title}</span>
            <span className="block text-xs text-nw-text-3">{i.body}</span>
          </span>
          {i.action}
        </li>
      ))}
    </ul>
  );
}
