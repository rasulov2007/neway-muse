import { TIRE_DAMAGE_REASONS, TIRE_POSITIONS, UNASSIGNED_TIRE, type TireEvent, type TireGroup, type TirePositionKey } from '@neway/shared';

/**
 * The Tires page's numbers (owner mockup, 2026-10-14), from the tire events of the records the
 * page lists - so the map, the cards and the tabs all count the same tires. Pure.
 */

export interface TireRecordInfo {
  key: string;
  id: string;
  reference: string;
  date: string;
  unitId: string;
  unitNumber: string;
  vendorName: string | null;
}

/** One tire event with its record, its owner unit and its date. */
export interface TireRow extends TireEvent {
  record: TireRecordInfo;
  owner: string;
  ownerNumber: string;
  ownerKind: 'truck' | 'trailer';
  date: string;
}

export type ColorBy = 'count' | 'spend' | 'repairs';
export const isReplacement = (e: Pick<TireEvent, 'eventType'>) => e.eventType === 'replaced' || e.eventType === 'blowout';
const median = (xs: number[]) => {
  if (xs.length === 0) return 0;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

export function rowsOf(events: TireEvent[], records: Map<string, TireRecordInfo>, unitName: (id: string, kind: 'truck' | 'trailer') => string): TireRow[] {
  const out: TireRow[] = [];
  for (const e of events) {
    const record = records.get(`${e.recordKind}:${e.recordId}`);
    if (!record) continue;
    const owner = e.unitId || record.unitId;
    const ownerKind = (e.unitKind ?? 'truck') as 'truck' | 'trailer';
    out.push({ ...e, record, owner, ownerKind, ownerNumber: owner === record.unitId ? record.unitNumber : unitName(owner, ownerKind), date: e.eventOn ?? record.date });
  }
  return out.sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
}

export function kpis(rows: TireRow[]) {
  const placed = rows.filter((r) => r.positionId !== UNASSIGNED_TIRE);
  const repl = rows.filter(isReplacement);
  const reps = rows.filter((r) => r.eventType === 'repaired');
  const newTires = rows.filter((r) => r.action === 'new' && typeof r.tireCostCents === 'number');
  const usedCount = repl.filter((r) => r.action === 'used').reduce((s, r) => s + r.quantity, 0);
  const newCount = repl.filter((r) => r.action === 'new').reduce((s, r) => s + r.quantity, 0);
  const unassigned = rows.filter((r) => r.positionId === UNASSIGNED_TIRE);
  return {
    spendCents: rows.reduce((s, r) => s + r.costCents, 0),
    replaced: repl.reduce((s, r) => s + r.quantity, 0),
    usedCount,
    newCount,
    repairs: reps.reduce((s, r) => s + r.quantity, 0),
    repairCents: reps.reduce((s, r) => s + r.costCents, 0),
    avgNewCents: newTires.length ? Math.round(newTires.reduce((s, r) => s + (r.tireCostCents ?? 0), 0) / newTires.length) : null,
    unassignedRecords: new Set(unassigned.map((r) => r.record.key)).size,
    unassignedTires: unassigned.reduce((s, r) => s + r.quantity, 0),
    placedShare: rows.length ? placed.length / rows.length : 0,
  };
}

export interface PositionStats {
  id: TirePositionKey;
  replaced: number;
  repaired: number;
  spendCents: number;
  lastReplaced: string | null;
  avgMilesBetween: number | null;
  brands: string[];
  reasons: { reason: string; n: number }[];
  topUnit: { number: string; n: number } | null;
  history: TireRow[];
}

/** Miles between successive replacements at one position on one unit, where both odometers are on file. */
function milesBetween(rows: TireRow[]): number[] {
  const by = new Map<string, TireRow[]>();
  for (const r of rows.filter(isReplacement)) by.set(`${r.owner}|${r.positionId}`, [...(by.get(`${r.owner}|${r.positionId}`) ?? []), r]);
  const gaps: number[] = [];
  for (const list of by.values()) {
    const withOdo = list.filter((r) => typeof r.odometer === 'number').sort((a, b) => (a.odometer as number) - (b.odometer as number));
    for (let i = 1; i < withOdo.length; i++) gaps.push((withOdo[i]!.odometer as number) - (withOdo[i - 1]!.odometer as number));
  }
  return gaps.filter((g) => g > 0);
}

export function positionStats(rows: TireRow[], id: TirePositionKey): PositionStats {
  const mine = rows.filter((r) => r.positionId === id);
  const repl = mine.filter(isReplacement);
  const gaps = milesBetween(mine);
  const reasons = new Map<string, number>();
  for (const r of mine) if (r.reason) reasons.set(r.reason, (reasons.get(r.reason) ?? 0) + r.quantity);
  const units = new Map<string, number>();
  for (const r of repl) units.set(r.ownerNumber, (units.get(r.ownerNumber) ?? 0) + r.quantity);
  const top = [...units.entries()].sort((a, b) => b[1] - a[1])[0];
  return {
    id,
    replaced: repl.reduce((s, r) => s + r.quantity, 0),
    repaired: mine.filter((r) => r.eventType === 'repaired').reduce((s, r) => s + r.quantity, 0),
    spendCents: mine.reduce((s, r) => s + r.costCents, 0),
    lastReplaced: repl.length ? repl[repl.length - 1]!.date : null,
    avgMilesBetween: gaps.length ? Math.round(gaps.reduce((s, g) => s + g, 0) / gaps.length) : null,
    brands: [...new Set(mine.map((r) => r.brand).filter((b): b is string => Boolean(b)))],
    reasons: [...reasons.entries()].map(([reason, n]) => ({ reason, n })).sort((a, b) => b.n - a.n),
    topUnit: top ? { number: top[0], n: top[1] } : null,
    history: [...mine].reverse(),
  };
}

export function valueOf(s: PositionStats, by: ColorBy) {
  return by === 'count' ? s.replaced : by === 'spend' ? s.spendCents : s.repaired;
}

export function groupStats(rows: TireRow[]) {
  const groups: TireGroup[] = ['steer', 'drive', 'trailer'];
  return groups.map((g) => {
    const ids = TIRE_POSITIONS.filter((p) => p.group === g).map((p) => p.id);
    const mine = rows.filter((r) => ids.includes(r.positionId as TirePositionKey));
    const replaced = mine.filter(isReplacement).reduce((s, r) => s + r.quantity, 0);
    return { group: g, tires: ids.length, spendCents: mine.reduce((s, r) => s + r.costCents, 0), replaced, perPosition: replaced / ids.length };
  });
}

export function unitsTable(rows: TireRow[]) {
  const by = new Map<string, { id: string; number: string; kind: 'truck' | 'trailer'; spendCents: number; replaced: number; repaired: number; gaps: number[] }>();
  for (const r of rows) {
    const u = by.get(r.owner) ?? { id: r.owner, number: r.ownerNumber, kind: r.ownerKind, spendCents: 0, replaced: 0, repaired: 0, gaps: [] };
    u.spendCents += r.costCents;
    if (isReplacement(r)) u.replaced += r.quantity;
    if (r.eventType === 'repaired') u.repaired += r.quantity;
    by.set(r.owner, u);
  }
  for (const u of by.values()) u.gaps = milesBetween(rows.filter((r) => r.owner === u.id));
  const list = [...by.values()];
  const med = { truck: median(list.filter((u) => u.kind === 'truck').map((u) => u.spendCents)), trailer: median(list.filter((u) => u.kind === 'trailer').map((u) => u.spendCents)) };
  return list
    .map((u) => ({ ...u, vsMedian: med[u.kind] > 0 ? u.spendCents / med[u.kind] : null, avgMiles: u.gaps.length ? Math.round(u.gaps.reduce((s, g) => s + g, 0) / u.gaps.length) : null }))
    .sort((a, b) => b.spendCents - a.spendCents);
}

export function brandsTable(rows: TireRow[]) {
  const by = new Map<string, { brand: string; group: string; removed: number; priceSum: number; priced: number; lives: number[]; early: number }>();
  const lifeOf = new Map<string, number>();
  // A tire's life: miles from its install to the next replacement at the same position and unit.
  const chain = new Map<string, TireRow[]>();
  for (const r of rows.filter(isReplacement)) chain.set(`${r.owner}|${r.positionId}`, [...(chain.get(`${r.owner}|${r.positionId}`) ?? []), r]);
  for (const list of chain.values()) {
    const sorted = list.filter((r) => typeof r.odometer === 'number').sort((a, b) => (a.odometer as number) - (b.odometer as number));
    for (let i = 0; i + 1 < sorted.length; i++) lifeOf.set(sorted[i]!.id, (sorted[i + 1]!.odometer as number) - (sorted[i]!.odometer as number));
  }
  for (const r of rows.filter((x) => isReplacement(x) && x.brand)) {
    const group = TIRE_POSITIONS.find((p) => p.id === r.positionId)?.group ?? '—';
    const key = `${r.brand}|${group}`;
    const b = by.get(key) ?? { brand: r.brand as string, group, removed: 0, priceSum: 0, priced: 0, lives: [], early: 0 };
    b.removed += r.quantity;
    if (typeof r.tireCostCents === 'number') {
      b.priceSum += r.tireCostCents;
      b.priced += 1;
    }
    const life = lifeOf.get(r.id);
    if (life && life > 0) {
      b.lives.push(life);
      if (life < 25_000) b.early += 1;
    }
    by.set(key, b);
  }
  return [...by.values()]
    .map((b) => {
      const avgPrice = b.priced ? b.priceSum / b.priced : null;
      const avgLife = b.lives.length ? b.lives.reduce((s, x) => s + x, 0) / b.lives.length : null;
      return { ...b, avgPrice, avgLife, per1000: avgPrice && avgLife ? (avgPrice / avgLife) * 1000 : null };
    })
    .sort((a, b) => b.removed - a.removed);
}

export function reasonsTable(rows: TireRow[]) {
  const by = new Map<string, { n: number; spendCents: number }>();
  for (const r of rows) {
    const k = r.reason ?? 'Not recorded';
    const v = by.get(k) ?? { n: 0, spendCents: 0 };
    v.n += r.quantity;
    v.spendCents += r.costCents;
    by.set(k, v);
  }
  return [...by.entries()].map(([reason, v]) => ({ reason, ...v, damage: TIRE_DAMAGE_REASONS.includes(reason) })).sort((a, b) => b.spendCents - a.spendCents);
}

/** Miles since the last replacement at the same position on the same unit, when both odometers are known. */
export function milesSinceLast(rows: TireRow[], r: TireRow): number | null {
  if (typeof r.odometer !== 'number' || !isReplacement(r)) return null;
  const before = rows.filter((x) => x !== r && isReplacement(x) && x.owner === r.owner && x.positionId === r.positionId && typeof x.odometer === 'number' && (x.odometer as number) < (r.odometer as number));
  if (before.length === 0) return null;
  return (r.odometer as number) - Math.max(...before.map((x) => x.odometer as number));
}
