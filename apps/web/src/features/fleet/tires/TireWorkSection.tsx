import { useQuery } from '@tanstack/react-query';
import { Copy, Plus } from 'lucide-react';
import { useEffect, useMemo, useState } from 'react';
import {
  TIRE_ACTIONS,
  TIRE_ACTION_LABEL,
  TIRE_CATALOG,
  TIRE_POSITIONS,
  TIRE_REASONS,
  actionEventType,
  tirePositionLabel,
  type CreateWorkOrderRequest,
  type TireAction,
  type TireEvent,
  type TireGroup,
  type TirePositionKey,
} from '@neway/shared';
import { Alert, Button, FormField, Input, Select } from '@/design-system';
import { useAccount } from '@/features/auth/auth-context';
import { apiGet } from '@/lib/api-client';
import { formatIsoDate, formatMoney } from '@/lib/format';
import { TireTruckSvg } from './TireTruckSvg';

/**
 * The tire part of Create work order (owner, 2026-10-15: the Tire work order folded into Create
 * work order). Pick the positions on the map; each tire gets its own row - the work, brand and
 * model, the reason, tread at removal, its price. Labor splits across the tires; fees stay on their
 * own line. The order's unit, shop, dates, invoice and who pays stay the order's own fields.
 * Nothing is priced for the user: a cost is what they type.
 */

export interface TireWorkResult {
  count: number;
  tiresCents: number;
  laborCents: number;
  feesCents: number;
  totalCents: number;
  lines: CreateWorkOrderRequest['lines'];
  tirePositions: NonNullable<CreateWorkOrderRequest['tirePositions']>;
  /** "Tire replacement · 2 tires", for a title left blank. */
  summary: string;
}

interface Row {
  action: TireAction;
  brand: string;
  /** Typing a brand that is not on the list. */
  custom: boolean;
  reason: string;
  tread: string;
  cost: string;
}

const ADD_BRAND = '__add_brand';
const groupOf = (id: TirePositionKey) => TIRE_POSITIONS.find((p) => p.id === id)!.group;
const isService = (a: TireAction) => a === 'repair' || a === 'valve' || a === 'rotate';
const blankRow = (): Row => ({ action: 'new', brand: '', custom: false, reason: 'Worn tread', tread: '', cost: '' });
const cents = (s: string) => {
  const n = Number(String(s).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) && n >= 0 ? Math.round(n * 100) : 0;
};

const QUICK: { label: string; ids: () => TirePositionKey[] }[] = [
  { label: 'Both steers', ids: () => ['S-L', 'S-R'] },
  { label: 'All drive', ids: () => TIRE_POSITIONS.filter((p) => p.group === 'drive').map((p) => p.id) },
  { label: 'Drive axle 1', ids: () => TIRE_POSITIONS.filter((p) => p.axle === 'D1').map((p) => p.id) },
  { label: 'Drive axle 2', ids: () => TIRE_POSITIONS.filter((p) => p.axle === 'D2').map((p) => p.id) },
  { label: 'All trailer', ids: () => TIRE_POSITIONS.filter((p) => p.group === 'trailer').map((p) => p.id) },
  { label: 'Trailer axle 1', ids: () => TIRE_POSITIONS.filter((p) => p.axle === 'T1').map((p) => p.id) },
  { label: 'Trailer axle 2', ids: () => TIRE_POSITIONS.filter((p) => p.axle === 'T2').map((p) => p.id) },
];

export function TireWorkSection({
  unit,
  unitNumber,
  trailers,
  serviceDate,
  onChange,
}: {
  unit: { kind: 'truck' | 'trailer'; id: string } | null;
  unitNumber: string;
  trailers: { id: string; unitNumber: string }[];
  /** The back-in-service day (YYYY-MM-DD), for the "replaced lately" warning. */
  serviceDate: string;
  onChange: (result: TireWorkResult) => void;
}) {
  const account = useAccount();
  const kind = unit?.kind ?? null;
  const unitId = unit?.id ?? '';
  const [withTrailer, setWithTrailer] = useState(true);
  const [trailerPick, setTrailerPick] = useState<string | null>(null);
  const [sel, setSel] = useState<TirePositionKey[]>([]);
  const [rows, setRows] = useState<Partial<Record<TirePositionKey, Row>>>({});
  const [labor, setLabor] = useState('');
  const [fees, setFees] = useState('');

  // A different unit starts the map over.
  const [seenUnit, setSeenUnit] = useState(unitId);
  if (seenUnit !== unitId) {
    setSeenUnit(unitId);
    setSel([]);
    setTrailerPick(null);
  }

  const hooked = useQuery({
    queryKey: ['fleet', 'hooked-trailer', unitId],
    queryFn: () => apiGet<{ trailerId: string | null; trailerNumber: string | null; source: 'truck' | 'load' | null }>(`/fleet/units/${unitId}/hooked-trailer`),
    enabled: kind === 'truck' && Boolean(unitId),
  });
  const trailerId = kind === 'truck' ? (trailerPick ?? hooked.data?.trailerId ?? null) : null;
  const trailerNumber = trailerId ? (trailers.find((t) => t.id === trailerId)?.unitNumber ?? hooked.data?.trailerNumber ?? '') : '';
  const canCost = Boolean(account && (account.isOwner || account.permissions.includes('maintenance_costs.view')));

  // What was done at these positions lately (the warning), and every brand the company has used.
  const history = useQuery({
    queryKey: ['fleet', 'tire-positions', 'wo-history', unitId, trailerId],
    queryFn: () => apiGet<{ events: TireEvent[] }>('/fleet/tire-positions', { window: '12m', scope: 'all', units: [unitId, trailerId].filter(Boolean).join(',') }),
    enabled: Boolean(unitId) && canCost,
  });
  const used = useQuery({
    queryKey: ['fleet', 'tire-positions', 'brands'],
    queryFn: () => apiGet<{ events: TireEvent[] }>('/fleet/tire-positions', { window: '12m', scope: 'all' }),
    enabled: canCost,
    staleTime: 5 * 60_000,
  });
  const companyBrands = useMemo(() => {
    const set = new Set<string>();
    for (const e of used.data?.events ?? []) if (e.brand?.trim()) set.add(e.brand.trim());
    return set;
  }, [used.data]);

  const trailerAllowed = kind === 'trailer' || (kind === 'truck' && withTrailer && Boolean(trailerId));
  const disabled = useMemo(
    () => new Set<TirePositionKey>(TIRE_POSITIONS.filter((p) => (p.group === 'trailer' ? !trailerAllowed : kind === 'trailer')).map((p) => p.id)),
    [trailerAllowed, kind],
  );
  const activeSel = sel.filter((id) => !disabled.has(id));
  const rowOf = (id: TirePositionKey): Row => rows[id] ?? blankRow();
  const setRow = (id: TirePositionKey, patch: Partial<Row>) => setRows((r) => ({ ...r, [id]: { ...rowOf(id), ...patch } }));
  const toggle = (id: TirePositionKey) => setSel((s) => (s.includes(id) ? s.filter((x) => x !== id) : [...s, id]));
  const laborCents = cents(labor);
  const feesCents = cents(fees);
  const tiresCents = activeSel.reduce((s, id) => s + cents(rowOf(id).cost), 0);
  const totalCents = tiresCents + laborCents + feesCents;
  const laborShare = (i: number) => {
    if (!activeSel.length) return 0;
    const base = Math.floor(laborCents / activeSel.length);
    return i === activeSel.length - 1 ? laborCents - base * (activeSel.length - 1) : base;
  };
  const ownerOf = (id: TirePositionKey) =>
    groupOf(id) === 'trailer' && kind === 'truck'
      ? { id: trailerId as string, kind: 'trailer' as const, label: `Trailer ${trailerNumber}` }
      : { id: unitId, kind: (kind ?? 'truck') as 'truck' | 'trailer', label: `${kind === 'trailer' ? 'Trailer' : 'Unit'} ${unitNumber}` };

  const brandOptions = (g: TireGroup, current: string) => {
    const catalog = TIRE_CATALOG[g].map((b) => `${b.brand} ${b.model}`);
    const extra = [...companyBrands].filter((b) => !catalog.includes(b)).sort();
    const all = [...catalog, ...extra, 'Used casing'];
    if (current && !all.includes(current)) all.push(current);
    return [...all.map((b) => ({ value: b, label: b })), { value: ADD_BRAND, label: '+ Add brand…' }];
  };

  const warnings = activeSel
    .map((id) => {
      const owner = ownerOf(id).id;
      const past = (history.data?.events ?? []).filter((e) => e.positionId === id && e.unitId === owner && e.eventType !== 'repaired' && e.eventOn);
      const recent = past.filter((e) => (Date.parse(`${serviceDate}T12:00:00Z`) - Date.parse(`${e.eventOn}T12:00:00Z`)) / 86_400_000 <= 90);
      if (recent.length === 0) return null;
      const last = recent.sort((a, b) => (a.eventOn! < b.eventOn! ? 1 : -1))[0]!;
      return { id, n: recent.length, last };
    })
    .filter((w): w is NonNullable<typeof w> => w !== null);

  // Report up whenever what would be saved changes.
  const key = JSON.stringify([activeSel, rows, labor, fees, trailerId, unitId]);
  useEffect(() => {
    const lines: CreateWorkOrderRequest['lines'] = activeSel.map((id, i) => {
      const r = rowOf(id);
      return {
        systemCode: 'tires_wheels',
        description: `${tirePositionLabel(id)} · ${TIRE_ACTION_LABEL[r.action]}${r.brand ? ` · ${r.brand}` : ''} · ${r.reason}`.slice(0, 200),
        amount: (cents(r.cost) + laborShare(i)) / 100,
      };
    });
    if (feesCents > 0) lines.push({ systemCode: 'fees', description: 'Fees / shop supplies / tax', amount: feesCents / 100 });
    const replaced = activeSel.filter((id) => !isService(rowOf(id).action)).length;
    const verb = replaced === activeSel.length ? 'Tire replacement' : replaced === 0 ? 'Tire service' : 'Tire work';
    onChange({
      count: activeSel.length,
      tiresCents,
      laborCents,
      feesCents,
      totalCents,
      lines,
      summary: activeSel.length ? `${verb} · ${activeSel.length} tire${activeSel.length === 1 ? '' : 's'}` : '',
      tirePositions: activeSel.map((id, i) => {
        const r = rowOf(id);
        const owner = ownerOf(id);
        return {
          positionId: id,
          eventType: actionEventType(r.action, r.reason),
          quantity: 1,
          action: r.action,
          brand: r.brand.trim() || null,
          reason: r.reason,
          treadRemoved32: r.tread.trim() ? Number(r.tread) : null,
          tireCostCents: cents(r.cost),
          laborCents: laborShare(i),
          ownerUnitId: owner.id,
          ownerUnitKind: owner.kind,
        };
      }),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  return (
    <section className="flex flex-col gap-3 rounded-md border border-nw-border bg-nw-panel p-3" aria-label="Tire positions" data-testid="wo-tire-work">
      <div className="flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-semibold text-ink">Tire positions</h3>
        <span className="text-xs text-muted">{unit ? 'Click each tire worked on' : 'Pick the unit first'}</span>
      </div>
      <div className="flex flex-wrap gap-1.5">
        {QUICK.map((q) => (
          <Button
            key={q.label}
            size="sm"
            variant="outline"
            disabled={!unit}
            onClick={() => setSel((s) => [...new Set([...s, ...q.ids().filter((id) => !disabled.has(id))])])}
          >
            {q.label}
          </Button>
        ))}
      </div>
      {kind === 'truck' ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md border border-nw-border bg-nw-subtle px-3 py-2 text-[13px] text-nw-text-2">
          <input type="checkbox" checked={withTrailer} onChange={(e) => setWithTrailer(e.target.checked)} aria-label="Show trailer" className="size-4 accent-[var(--nw-accent)]" />
          <span>Show trailer</span>
          <Select size="sm" aria-label="Trailer" value={trailerId ?? ''} placeholder="No trailer" className="w-40" onValueChange={(v) => setTrailerPick(v)} options={trailers.map((t) => ({ value: t.id, label: t.unitNumber }))} />
          <span>
            {hooked.data?.source === 'load' && !trailerPick ? 'on its latest load. ' : hooked.data?.source === 'truck' && !trailerPick ? 'hooked per the truck record. ' : ''}
            Trailer tires are saved to the trailer’s own history.
          </span>
        </div>
      ) : null}
      <div className="overflow-x-auto rounded-md border border-nw-border" data-theme="light">
        <div className="min-w-[560px] bg-nw-subtle p-1.5">
          <TireTruckSvg badges={false} codes selected={new Set(activeSel)} disabled={unit ? disabled : new Set(TIRE_POSITIONS.map((p) => p.id))} onSelect={toggle} className="mx-auto block h-auto w-full max-w-[1000px]" />
        </div>
      </div>

      {warnings.map((w) => (
        <Alert key={w.id} tone="warning" title={`${tirePositionLabel(w.id)}: replaced ${w.n} time${w.n === 1 ? '' : 's'} in the last 90 days`}>
          Last on {formatIsoDate(w.last.eventOn!)}
          {w.last.brand ? ` (${w.last.brand}${w.last.reason ? `, ${w.last.reason}` : ''})` : ''}. Check alignment, pressure and the shop before replacing again.
        </Alert>
      ))}

      {activeSel.length === 0 ? (
        <p className="rounded-md border border-nw-border bg-nw-subtle px-3 py-2 text-sm text-nw-text-3">No tires selected. Pick positions on the map, or use the quick buttons (e.g. Both steers).</p>
      ) : (
        <ul className="flex flex-col gap-2" data-testid="tire-rows">
          {activeSel.map((id) => {
            const r = rowOf(id);
            const g = groupOf(id);
            const service = isService(r.action);
            return (
              <li key={id} className="rounded-md border border-nw-border p-2.5" data-testid="tire-row">
                <div className="mb-2 flex flex-wrap items-baseline justify-between gap-2">
                  <p className="text-sm font-semibold text-nw-text">
                    {tirePositionLabel(id)} <span className="text-xs font-normal text-nw-text-3">{id}</span>
                  </p>
                  <div className="flex items-center gap-2">
                    <span className="text-xs text-nw-text-2">Saved to {ownerOf(id).label}</span>
                    {activeSel.length > 1 ? (
                      <Button
                        size="sm"
                        variant="ghost"
                        icon={<Copy />}
                        title="Copy work, brand, reason and cost to all selected tires"
                        onClick={() => setRows((all) => Object.fromEntries(activeSel.map((x) => [x, { ...(all[x] ?? blankRow()), action: r.action, brand: groupOf(x) === g ? r.brand : (all[x]?.brand ?? ''), custom: groupOf(x) === g ? r.custom : (all[x]?.custom ?? false), reason: r.reason, cost: groupOf(x) === g ? r.cost : (all[x]?.cost ?? '') }])))}
                      >
                        Apply to all
                      </Button>
                    ) : null}
                  </div>
                </div>
                <div className="grid grid-cols-2 gap-2 sm:grid-cols-[minmax(0,1fr)_minmax(0,1.6fr)_minmax(0,1.1fr)_minmax(0,.7fr)_minmax(0,.8fr)]">
                  <FormField label="Work">
                    <Select size="sm" aria-label={`Work ${id}`} value={r.action} onValueChange={(v) => setRow(id, { action: v as TireAction, ...(isService(v as TireAction) ? { brand: '', custom: false } : {}) })} options={TIRE_ACTIONS.map((a) => ({ value: a, label: TIRE_ACTION_LABEL[a] }))} />
                  </FormField>
                  <FormField label="Brand · model">
                    {r.custom ? (
                      <div className="flex gap-1">
                        <Input size="sm" autoFocus aria-label={`Brand ${id}`} value={r.brand} placeholder="Brand and model" onChange={(e) => setRow(id, { brand: e.target.value })} />
                        <Button size="sm" variant="ghost" onClick={() => setRow(id, { custom: false, brand: '' })} title="Back to the list">
                          List
                        </Button>
                      </div>
                    ) : (
                      <Select
                        size="sm"
                        aria-label={`Brand ${id}`}
                        value={r.brand}
                        disabled={service}
                        placeholder={service ? '—' : 'Pick the brand…'}
                        onValueChange={(v) => (v === ADD_BRAND ? setRow(id, { custom: true, brand: '' }) : setRow(id, { brand: v }))}
                        options={brandOptions(g, r.brand)}
                      />
                    )}
                  </FormField>
                  <FormField label="Reason">
                    <Select size="sm" aria-label={`Reason ${id}`} value={r.reason} onValueChange={(v) => setRow(id, { reason: v })} options={TIRE_REASONS.map((x) => ({ value: x, label: x }))} />
                  </FormField>
                  <FormField label="Tread (32nds)">
                    <Input size="sm" inputMode="decimal" placeholder="e.g. 3" value={r.tread} onChange={(e) => setRow(id, { tread: e.target.value })} />
                  </FormField>
                  <FormField label="Tire cost ($)">
                    <Input size="sm" inputMode="decimal" placeholder="0.00" aria-label={`Tire cost ${id}`} value={r.cost} onChange={(e) => setRow(id, { cost: e.target.value })} className="text-right" />
                  </FormField>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      <div className="grid gap-3 sm:grid-cols-2">
        <FormField label="Labor (total, $)" description={`Split equally across ${activeSel.length} tire${activeSel.length === 1 ? '' : 's'} on save`}>
          <Input inputMode="decimal" placeholder="0.00" value={labor} onChange={(e) => setLabor(e.target.value)} />
        </FormField>
        <FormField label="Fees / shop supplies / tax ($)" description="Booked under Fees, not Tires">
          <Input inputMode="decimal" placeholder="0.00" value={fees} onChange={(e) => setFees(e.target.value)} />
        </FormField>
      </div>
      <dl className="ml-auto grid w-full max-w-72 grid-cols-[1fr_auto] gap-x-6 gap-y-1 text-sm">
        <dt className="text-nw-text-2">Tires ({activeSel.length})</dt>
        <dd className="tabular text-right">{formatMoney(tiresCents / 100)}</dd>
        <dt className="text-nw-text-2">Labor</dt>
        <dd className="tabular text-right">{formatMoney(laborCents / 100)}</dd>
        <dt className="text-nw-text-2">Fees / tax</dt>
        <dd className="tabular text-right">{formatMoney(feesCents / 100)}</dd>
        <dt className="border-t border-nw-border pt-1 font-bold text-nw-text">Tire work total</dt>
        <dd className="tabular border-t border-nw-border pt-1 text-right font-bold text-nw-text">{formatMoney(totalCents / 100)}</dd>
      </dl>
      <p className="flex items-start gap-1.5 text-xs text-nw-text-3">
        <Plus className="mt-0.5 size-3.5 shrink-0" aria-hidden />
        On save: one Tires &amp; wheels line per tire (with its share of labor), a Fees line, and a tire history record for each tire. Trailer tires go to the trailer.
      </p>
    </section>
  );
}
