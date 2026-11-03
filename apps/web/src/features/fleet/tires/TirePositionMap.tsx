import { useMutation, useQuery, useQueryClient, type UseQueryResult } from '@tanstack/react-query';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import {
  TIRE_EVENT_TYPES,
  TIRE_EVENT_TYPE_LABEL,
  TIRE_GROUP_LABEL,
  TIRE_POSITIONS,
  TIRE_WINDOWS,
  TIRE_WINDOW_LABEL,
  UNASSIGNED_TIRE,
  summarizeTirePositions,
  tirePositionChip,
  tirePositionLabel,
  type FleetSpendEvent,
  type FleetUnitTypeFilter,
  type TireEvent,
  type TireEventType,
  type TirePositionKey,
  type TirePositionSummary,
  type TireWindow,
} from '@neway/shared';
import { Button, Card, Modal, Skeleton, StatusSymbol, cn, useToast } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet, apiPut } from '@/lib/api-client';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { TIRE_GEOMETRY, TireTruckSvg, VIEW_H, VIEW_W, heat } from './TireTruckSvg';

export const recordKey = (e: Pick<FleetSpendEvent, 'kind' | 'id'>) => `${e.kind}:${e.id}`;

export interface TireQuery {
  period: string;
  units: string[];
  unitType: FleetUnitTypeFilter;
  scope?: 'maintenance' | 'all';
  window: TireWindow;
}

/** The tire events for the page's own records; under `fleet` so every fleet write refreshes it. */
export function useTirePositions(q: TireQuery, enabled: boolean): UseQueryResult<{ events: TireEvent[] }> {
  const account = useAccount();
  return useQuery({
    queryKey: ['fleet', 'tire-positions', account?.companyId ?? null, q.period, q.unitType, [...q.units].sort().join(','), q.scope ?? 'maintenance', q.window],
    queryFn: () =>
      apiGet<{ events: TireEvent[] }>('/fleet/tire-positions', {
        period: q.period,
        unitType: q.unitType,
        units: q.units.length > 0 ? q.units.join(',') : undefined,
        scope: q.scope === 'all' ? 'all' : undefined,
        window: q.window,
      }),
    enabled: enabled && account !== null,
    placeholderData: (previous) => previous,
    staleTime: 15_000,
  });
}

export function useCanTag(): boolean {
  const account = useAccount();
  return Boolean(account && (account.isOwner || account.permissions.includes('maintenance.edit')));
}

const PCT = (n: number) => `${n.toFixed(0)}%`;

/**
 * The Tire position map (owner brief, 2026-10-13): counts on every tire, heat relative to the
 * busiest position in view, a tooltip, rankings, group cards and insights - all from
 * `summarizeTirePositions` over the same records the table below lists.
 */
export function TirePositionMap({
  rows,
  events,
  loading,
  metric,
  onMetric,
  window,
  onWindow,
  selected,
  onSelect,
  onTag,
}: {
  rows: FleetSpendEvent[];
  events: TireEvent[] | undefined;
  loading: boolean;
  metric: TireEventType;
  onMetric: (m: TireEventType) => void;
  window: TireWindow;
  onWindow: (w: TireWindow) => void;
  selected: TirePositionKey | null;
  onSelect: (id: TirePositionKey | null) => void;
  onTag: (row: FleetSpendEvent) => void;
}) {
  const [hover, setHover] = useState<TirePositionKey | null>(null);
  const [showUnassigned, setShowUnassigned] = useState(false);
  const summary = useMemo<TirePositionSummary>(
    () =>
      summarizeTirePositions(
        rows.map((r) => ({ key: recordKey(r), date: r.date, unitId: r.truckId, unitNumber: r.unitNumber })),
        (events ?? []).map((e) => ({ ...e, recordKey: `${e.recordKind}:${e.recordId}` })),
        metric,
      ),
    [rows, events, metric],
  );
  const counts = Object.fromEntries(TIRE_POSITIONS.map((p) => [p.id, summary.positions[p.id].count]));
  const toggle = (id: TirePositionKey) => onSelect(selected === id ? null : id);
  const selectedSet = useMemo(() => new Set(selected ? [selected] : []), [selected]);
  const unassignedRows = rows.filter((r) => summary.unassigned.recordKeys.includes(recordKey(r)));
  const verb = metric === 'replaced' ? 'replaced' : metric === 'blowout' ? 'blowouts' : 'patched / repaired';

  return (
    <Card padding="none" className="overflow-hidden" aria-label="Tire position map">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-nw-border px-4 py-3">
        <h2 className="text-[15px] font-bold text-nw-text">Tire position map</h2>
        <span className="text-xs text-nw-text-3">Which wheel positions fail most across the fleet</span>
        <div className="ml-auto flex flex-wrap gap-2">
          <Segments value={metric} options={TIRE_EVENT_TYPES.map((t) => ({ value: t, label: TIRE_EVENT_TYPE_LABEL[t] }))} onChange={onMetric} label="Event" />
          <Segments value={window} options={TIRE_WINDOWS.map((w) => ({ value: w, label: TIRE_WINDOW_LABEL[w] }))} onChange={onWindow} label="Period" />
        </div>
      </div>

      <div className="grid gap-4 p-4 xl:grid-cols-[minmax(0,1fr)_300px]">
        <div className="flex min-w-0 flex-col gap-3">
          {/* The drawing keeps a light frame in both modes, as documents do. */}
          <div className="overflow-x-auto rounded-[10px] border border-nw-border" data-theme="light">
            <div className="relative min-w-[560px] bg-nw-subtle px-3 pt-3 pb-2" data-testid="tire-map">
              {loading ? (
                <div className="flex aspect-[1000/392] items-center justify-center text-sm text-nw-text-3">Loading…</div>
              ) : (
                <TireTruckSvg counts={counts} max={summary.max} selected={selectedSet} onSelect={toggle} onHover={setHover} className="mx-auto block h-auto w-full max-w-[1000px]" />
              )}
              {hover && !loading ? <TireTooltip id={hover} summary={summary} metric={verb} /> : null}
              <div className="mt-1 flex flex-wrap items-center justify-between gap-2 text-[11px] text-nw-text-3">
                <span className="flex items-center gap-2">
                  Fewer
                  <span
                    className="h-2 w-28 rounded-full"
                    style={{ background: 'linear-gradient(90deg, color-mix(in oklab, var(--nw-urgent-icon) 15%, var(--nw-warning-bg)), var(--nw-urgent-icon))' }}
                    aria-hidden
                  />
                  More
                </span>
                <span>Front of truck ← · Top view · Click a tire to filter the records</span>
              </div>
            </div>
          </div>

          <div className="grid gap-3 sm:grid-cols-3">
            {summary.groups.map((g) => (
              <div key={g.group} className="rounded-[10px] border border-nw-border bg-nw-panel px-4 py-3">
                <div className="text-[11px] font-bold tracking-[.06em] text-nw-text-3 uppercase">
                  {TIRE_GROUP_LABEL[g.group]} · {g.tires} tires
                </div>
                <div className="tabular mt-0.5 text-2xl font-extrabold text-nw-text">{loading ? '…' : g.count}</div>
                <div className="text-xs text-nw-text-3">
                  {PCT(g.sharePct)} of all · {g.perTire.toFixed(1)} per tire
                </div>
                <div className="mt-2 h-1.5 overflow-hidden rounded-full bg-nw-track">
                  <div className="h-full rounded-full" style={{ width: `${g.sharePct}%`, background: heat(g.count, Math.max(...summary.groups.map((x) => x.count), 1))?.fill ?? 'transparent' }} />
                </div>
              </div>
            ))}
          </div>
        </div>

        <aside className="flex min-w-0 flex-col gap-3">
          <div>
            <h3 className="mb-1 text-sm font-bold text-nw-text">Most {verb} positions</h3>
            {loading ? (
              <Skeleton variant="text" lines={6} />
            ) : summary.ranking.length === 0 ? (
              <p className="py-3 text-sm text-nw-text-3">No tire records for this period.</p>
            ) : (
              <ol className="flex flex-col">
                {summary.ranking.slice(0, 6).map((s, i) => {
                  const p = TIRE_POSITIONS.find((x) => x.id === s.id)!;
                  return (
                    <li key={s.id}>
                      <button
                        type="button"
                        onClick={() => toggle(s.id)}
                        className={cn('grid w-full grid-cols-[18px_minmax(0,1fr)_auto] items-center gap-x-2 rounded-md px-2 py-1.5 text-left hover:bg-nw-hover', selected === s.id && 'bg-nw-accent-tint')}
                        data-testid={`rank-${s.id}`}
                      >
                        <span className="text-xs font-bold text-nw-text-3">{i + 1}</span>
                        <span className="min-w-0">
                          <span className="block truncate text-sm font-semibold text-nw-text">{tirePositionLabel(s.id).replace(' · ', ' - ')}</span>
                          <span className="block text-[11px] text-nw-text-3">
                            {TIRE_GROUP_LABEL[p.group]} · {PCT(s.sharePct)} of {verb}
                          </span>
                        </span>
                        <span className="tabular text-sm font-bold text-nw-text">{s.count}</span>
                        <span className="col-span-2 col-start-2 mt-1 h-1 overflow-hidden rounded-full bg-nw-track">
                          <span className="block h-full rounded-full" style={{ width: `${(s.count / summary.max) * 100}%`, background: heat(s.count, summary.max)?.fill }} />
                        </span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            )}
          </div>

          {!loading && summary.total > 0 ? <Insights summary={summary} verb={verb} /> : null}

          {!loading && summary.unassigned.count > 0 ? (
            <button
              type="button"
              onClick={() => setShowUnassigned(true)}
              className="flex items-center gap-2 rounded-[10px] border border-nw-warning-border bg-nw-warning-bg px-3 py-2 text-left text-sm text-nw-warning-text hover:brightness-[.98]"
              data-testid="tire-unassigned"
            >
              <StatusSymbol family="warning" size={16} className="shrink-0 text-nw-warning-icon" />
              <span className="min-w-0 flex-1">
                <span className="block font-bold">
                  Unassigned: {unassignedRows.length} record{unassignedRows.length === 1 ? '' : 's'}
                </span>
                <span className="block text-xs">{summary.unassigned.count} tire{summary.unassigned.count === 1 ? '' : 's'} without a position · tag them</span>
              </span>
            </button>
          ) : null}
        </aside>
      </div>

      {showUnassigned ? (
        <Modal open onOpenChange={(o) => !o && setShowUnassigned(false)} size="lg" title="Unassigned tire records" description="The rules could not tell the axle, side or dual from the description. Tag the positions by hand; a tag replaces what was read.">
          <ul className="divide-y divide-nw-border" data-testid="unassigned-list">
            {unassignedRows.map((r) => {
              const note = (events ?? []).find((e) => e.recordId === r.id && e.positionId === UNASSIGNED_TIRE)?.note;
              return (
                <li key={recordKey(r)} className="flex items-center gap-3 py-2 text-sm">
                  <span className="w-24 shrink-0 text-nw-text-2">{formatIsoDate(r.date)}</span>
                  <span className="w-20 shrink-0 font-semibold text-nw-text">{r.unitNumber}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-nw-text" title={r.description ?? ''}>
                      {r.description ?? '—'}
                    </span>
                    {note ? <span className="block truncate text-xs text-nw-text-3">{note}</span> : null}
                  </span>
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      setShowUnassigned(false);
                      onTag(r);
                    }}
                  >
                    Tag
                  </Button>
                </li>
              );
            })}
          </ul>
        </Modal>
      ) : null}
    </Card>
  );
}

function Segments<T extends string>({ value, options, onChange, label }: { value: T; options: { value: T; label: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div role="radiogroup" aria-label={label} className="inline-flex gap-0.5 rounded-lg bg-nw-segment p-0.5">
      {options.map((o) => (
        <button
          key={o.value}
          type="button"
          role="radio"
          aria-checked={value === o.value}
          onClick={() => onChange(o.value)}
          className={cn('h-8 rounded-md px-3 text-[12.5px] font-semibold text-nw-text-2', value === o.value && 'bg-nw-panel text-nw-text shadow-(--nw-shadow-segment)')}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

function TireTooltip({ id, summary, metric }: { id: TirePositionKey; summary: TirePositionSummary; metric: string }) {
  const g = TIRE_GEOMETRY[id];
  const s = summary.positions[id];
  const top = g.y < VIEW_H / 2;
  return (
    <div
      role="tooltip"
      className="pointer-events-none absolute z-10 w-56 -translate-x-1/2 rounded-lg bg-nw-tooltip-bg px-3 py-2 text-xs text-nw-tooltip-text shadow-(--nw-shadow-menu)"
      style={{
        left: `calc(12px + (100% - 24px) * ${(g.x + g.w / 2) / VIEW_W})`,
        top: top ? `${((g.y + g.h + 10) / VIEW_H) * 100}%` : undefined,
        bottom: top ? undefined : `${(1 - (g.y - 10) / VIEW_H) * 100}%`,
      }}
    >
      <div className="text-[13px] font-bold">{tirePositionLabel(id)}</div>
      <div className="mt-1 grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5">
        <span className="opacity-70">Count</span>
        <span className="tabular font-semibold">
          {s.count} {metric} · {PCT(s.sharePct)}
        </span>
        <span className="opacity-70">Cost</span>
        <span className="tabular font-semibold">{formatMoney(s.costCents / 100)}</span>
        <span className="opacity-70">Last</span>
        <span>{s.lastDate ? formatIsoDate(s.lastDate) : '—'}</span>
        <span className="opacity-70">Top units</span>
        <span>{s.topUnits.length ? s.topUnits.map((u) => `${u.unitNumber} (${u.count})`).join(', ') : '—'}</span>
      </div>
    </div>
  );
}

function Insights({ summary, verb }: { summary: TirePositionSummary; verb: string }) {
  const { top, outer, inner, outerHeavy, left, right, repeat } = summary.insights;
  const per = Object.fromEntries(summary.groups.map((g) => [g.group, g.perTire]));
  const lr = left + right > 0 ? Math.abs(left - right) / (left + right) : 0;
  return (
    <div className="rounded-[10px] border border-nw-urgent-border bg-nw-urgent-bg px-3 py-2.5 text-xs leading-relaxed text-nw-text" data-testid="tire-insights">
      {top ? (
        <p>
          <b className="text-nw-urgent-text">{tirePositionLabel(top.id).replace(' · ', ' - ')}</b> is the #1 position ({top.count} {verb}).
        </p>
      ) : null}
      <p>
        Per tire: steer <b>{per.steer?.toFixed(1)}</b>, drive <b>{per.drive?.toFixed(1)}</b>, trailer <b>{per.trailer?.toFixed(1)}</b>.
      </p>
      {outer + inner > 0 ? (
        <p>
          Outer duals <b>{outer}</b> vs inner <b>{inner}</b>
          {outerHeavy ? ' — check curb strikes & alignment.' : '.'}
        </p>
      ) : null}
      {left + right > 0 ? (
        <p>
          Left <b>{left}</b> vs right <b>{right}</b>
          {lr >= 0.25 ? ` — ${left > right ? 'driver' : 'passenger'} side is heavier.` : '.'}
        </p>
      ) : null}
      {repeat.length > 0 ? (
        <p>
          Repeat within 90 days:{' '}
          {repeat.slice(0, 6).map((r, i) => (
            <span key={`${r.unitId}-${r.positionId}`}>
              {i > 0 ? ', ' : ''}
              {r.unitId ? (
                <Link to="/fleet/trucks/$truckId" params={{ truckId: r.unitId }} className="font-bold text-nw-accent-ink hover:underline">
                  {r.unitNumber}
                </Link>
              ) : (
                <b>{r.unitNumber}</b>
              )}{' '}
              {tirePositionChip(r.positionId)} ×{r.times}
            </span>
          ))}
          .
        </p>
      ) : null}
    </div>
  );
}

/** Position chips for one record, as the table shows them. */
export function TireChips({ events, onClick }: { events: TireEvent[]; onClick?: () => void }) {
  if (events.length === 0) return <span className="text-nw-text-3">—</span>;
  const suffix = (t: TireEventType) => (t !== 'replaced' ? ` · ${t === 'blowout' ? 'blowout' : 'patch'}` : '');
  /* A whole group in one record ("8 drive tires") reads as one chip, not eight. */
  const chips: { key: string; label: string; unassigned: boolean; title?: string }[] = [];
  const used = new Set<string>();
  for (const group of ['steer', 'drive', 'trailer'] as const) {
    for (const t of TIRE_EVENT_TYPES) {
      const mine = events.filter((e) => e.eventType === t && e.positionId !== UNASSIGNED_TIRE && TIRE_POSITIONS.find((p) => p.id === e.positionId)?.group === group);
      if (mine.length === TIRE_POSITIONS.filter((p) => p.group === group).length) {
        mine.forEach((e) => used.add(e.id));
        chips.push({ key: `${group}-${t}`, label: `All ${TIRE_GROUP_LABEL[group].toLowerCase()} ×${mine.length}${suffix(t)}`, unassigned: false });
      }
    }
  }
  for (const e of events) {
    if (used.has(e.id)) continue;
    chips.push({
      key: e.id,
      label: `${tirePositionChip(e.positionId)}${e.quantity > 1 ? ` ×${e.quantity}` : ''}${suffix(e.eventType)}`,
      unassigned: e.positionId === UNASSIGNED_TIRE,
      title: e.note ?? undefined,
    });
  }
  const shown = chips.length > 3 ? chips.slice(0, 2) : chips;
  const rest = chips.slice(shown.length);
  const content = (
    <span className="flex flex-wrap gap-1">
      {shown.map((c) => (
        <span
          key={c.key}
          className={cn(
            'inline-flex h-5 items-center rounded px-1.5 text-[11px] font-semibold whitespace-nowrap',
            c.unassigned ? 'bg-nw-warning-bg text-nw-warning-text' : 'bg-nw-accent-tint text-nw-accent-ink',
          )}
          title={c.title}
        >
          {c.label}
        </span>
      ))}
      {rest.length > 0 ? (
        <span className="inline-flex h-5 items-center rounded bg-nw-subtle px-1.5 text-[11px] font-semibold whitespace-nowrap text-nw-text-2" title={rest.map((c) => c.label).join(', ')}>
          +{rest.length} more
        </span>
      ) : null}
    </span>
  );
  return onClick ? (
    <button type="button" onClick={onClick} className="cursor-pointer text-left" title="Edit the tire positions" data-testid="tire-chips">
      {content}
    </button>
  ) : (
    content
  );
}

/** Tag a record's positions by hand on a mini map; replaces what the rules read. */
export function TireTagDialog({ row, current, onClose }: { row: FleetSpendEvent; current: TireEvent[]; onClose: () => void }) {
  const toast = useToast();
  const qc = useQueryClient();
  const known = current.filter((e) => e.positionId !== UNASSIGNED_TIRE);
  const [picked, setPicked] = useState<Set<TirePositionKey>>(() => new Set(known.map((e) => e.positionId as TirePositionKey)));
  const [eventType, setEventType] = useState<TireEventType>(current[0]?.eventType ?? 'replaced');
  const save = useMutation({
    mutationFn: () =>
      apiPut(`/fleet/tire-positions/${row.kind}/${encodeURIComponent(row.id)}`, {
        basis: current.map((e) => e.id),
        unitId: row.truckId,
        unitKind: row.unitKind,
        events: [...picked].map((positionId) => ({ positionId, eventType, quantity: 1 })),
      }),
    onSuccess: () => {
      toast.toast({ tone: 'success', title: 'Tire positions saved' });
      void qc.invalidateQueries({ queryKey: ['fleet', 'tire-positions'] });
      onClose();
    },
    onError: (e: Error) => toast.toast({ tone: 'danger', title: 'Not saved', description: e.message }),
  });
  const toggle = (id: TirePositionKey) =>
    setPicked((s) => {
      const n = new Set(s);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });
  return (
    <Modal
      open
      onOpenChange={(o) => !o && onClose()}
      size="lg"
      title={`Tire positions · ${row.unitNumber} · ${row.reference}`}
      description={row.description ?? undefined}
      footer={
        <div className="flex w-full items-center justify-between gap-2">
          <span className="text-xs text-nw-text-3">{picked.size} position{picked.size === 1 ? '' : 's'} picked</span>
          <span className="flex gap-2">
            <Button variant="secondary" onClick={onClose}>
              Cancel
            </Button>
            <Button variant="primary" disabled={picked.size === 0} loading={save.isPending} onClick={() => save.mutate()} data-testid="tire-tag-save">
              Save positions
            </Button>
          </span>
        </div>
      }
    >
      <div className="flex flex-col gap-3" data-testid="tire-tag-dialog">
        <Segments value={eventType} options={TIRE_EVENT_TYPES.map((t) => ({ value: t, label: TIRE_EVENT_TYPE_LABEL[t] }))} onChange={setEventType} label="What happened" />
        <div className="overflow-x-auto rounded-[10px] border border-nw-border" data-theme="light">
          <div className="min-w-[560px] bg-nw-subtle p-2">
            <TireTruckSvg badges={false} selected={picked} onSelect={toggle} className="mx-auto block h-auto w-full max-w-[1000px]" />
          </div>
        </div>
        <div className="flex min-h-6 flex-wrap gap-1">
          {[...picked].map((id) => (
            <span key={id} className="inline-flex h-6 items-center rounded bg-nw-accent-tint px-2 text-xs font-semibold text-nw-accent-ink">
              {tirePositionLabel(id)}
            </span>
          ))}
        </div>
      </div>
    </Modal>
  );
}

/** Records whose tires the rules could not place, each with a Tag button (the tagging queue). */
export function UnassignedDialog({ rows, events, onClose, onTag }: { rows: FleetSpendEvent[]; events: TireEvent[]; onClose: () => void; onTag: (r: FleetSpendEvent) => void }) {
  const keys = new Set(events.filter((e) => e.positionId === UNASSIGNED_TIRE).map((e) => `${e.recordKind}:${e.recordId}`));
  const list = rows.filter((r) => keys.has(recordKey(r)));
  return (
    <Modal open onOpenChange={(o) => !o && onClose()} size="lg" title="Unassigned tire records" description="The rules could not tell the axle, side or dual from the description. Tag the positions by hand; a tag replaces what was read.">
      {list.length === 0 ? (
        <p className="text-sm text-nw-text-3">Every tire record has a position.</p>
      ) : (
        <ul className="divide-y divide-nw-border" data-testid="unassigned-list">
          {list.map((r) => {
            const note = events.find((e) => e.recordId === r.id && e.positionId === UNASSIGNED_TIRE)?.note;
            return (
              <li key={recordKey(r)} className="flex items-center gap-3 py-2 text-sm">
                <span className="w-24 shrink-0 text-nw-text-2">{formatIsoDate(r.date)}</span>
                <span className="w-20 shrink-0 font-semibold text-nw-text">{r.unitNumber}</span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-nw-text" title={r.description ?? ''}>
                    {r.description ?? '—'}
                  </span>
                  {note ? <span className="block truncate text-xs text-nw-text-3">{note}</span> : null}
                </span>
                <Button size="sm" variant="outline" onClick={() => onTag(r)}>
                  Tag
                </Button>
              </li>
            );
          })}
        </ul>
      )}
    </Modal>
  );
}
