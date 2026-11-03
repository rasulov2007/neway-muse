// Accident analytics (SPEC §1.6 and §7.14, API.md §6; prototype screens/Analytics.tsx). One pure function so the
// Analytics tab, profile sections and the executive dashboard read the same numbers (SPEC §6.7). Every bucket carries
// the case ids behind it so each chart mark and each insight drills down to exactly those cases (ACCEPTANCE M5).
import type { DateRange } from './board.js';
import { claimMoney, dotRecordable, downtimeFor, financials, visibleClaims, type ViewerOptions } from './rules.js';
import { resolveSettings } from './settings.js';
import { DAY, EASTERN, rulesNow } from './time.js';
import type { AccidentCase, SafetyRulesState, Severity } from './types.js';
import { money, pct, plural } from './format.js';

export interface AnalyticsOptions extends ViewerOptions {
  /** Business-date zone for month buckets (the product passes US Eastern). */
  zone?: string;
  /** false for a role that may not see repair costs: every money figure comes back null. */
  seeMoney?: boolean;
  /** Below this many cases the small-sample banner shows (SPEC §1.6: 12). */
  smallSampleBelow?: number;
}

export interface AnalyticsInsight {
  id: string;
  tone: 'warning' | 'info';
  text: string;
  caseIds: string[];
}

export interface AnalyticsResult {
  from: string;
  to: string;
  months: string[];
  sample: { cases: number; smallSample: boolean };
  kpis: {
    accidents: number;
    dotRecordable: number;
    caseIds: string[];
    ratePerMillionMiles: { value: number; dotValue: number; qualifyingMonths: number; totalMonths: number } | { value: null; reason: string; qualifyingMonths: number; totalMonths: number };
    preventableShare: { value: number | null; preventable: number; decided: number; notDecided: number; caseIds: string[] };
    investigationDays: { median: number | null; within14: number; count: number };
    netCostCents: number | null;
    spentCents: number | null;
    recoveredCents: number | null;
    downtime: { truckDays: number; lostRevenueCents: number | null };
  };
  insights: AnalyticsInsight[];
  byMonth: { month: string; minor: number; moderate: number; serious: number; critical: number; caseIds: string[] }[];
  ratePerMonth: { month: string; value: number | null; coverage: number | null; cases: number; miles: number | null; note: string; caseIds: string[] }[];
  byType: { type: string; count: number; caseIds: string[] }[];
  preventability: { outcome: 'preventable' | 'non_preventable' | 'not_determined'; count: number; caseIds: string[] }[];
  cashByMonth: { month: string; spentCents: number; recoveredCents: number; caseIds: string[] }[] | null;
  estimateVsFinal: { accidentId: string; number: string; estimateCents: number; finalCents: number }[] | null;
  estimateBias: { pct: number; direction: 'low' | 'high' } | null;
  downtimeByTruck: { truckId: string; unit: string; truckDays: number; caseIds: string[] }[];
  whereByCorridor: { label: string; count: number; caseIds: string[] }[];
  repeatInvolvement: { kind: 'driver' | 'truck'; id: string; label: string; cases: number; preventable: number; caseIds: string[]; numbers: string[] }[];
  followThrough: {
    correctiveActions: { total: number; done: number; onTime: number; overdue: number };
    ownDamageReceivedCents: number | null;
    ownDamageExpectedCents: number | null;
    recoveriesCents: number | null;
    recoveriesPursuedCents: number | null;
    medianDaysToSettle: number | null;
    settled: number;
    cpdp: { submitted: number; notPreventable: number; eligibleNotSubmitted: number };
  };
}

/** YYYY-MM of an instant in `zone`. */
export function zonedMonth(iso: string, zone: string = EASTERN): string {
  const p = new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric', month: '2-digit' }).formatToParts(new Date(iso));
  return `${p.find((x) => x.type === 'year')?.value}-${p.find((x) => x.type === 'month')?.value}`;
}

/** Every month touched by the range, in `zone`, oldest first. */
export function monthsOf(from: string, to: string, zone: string = EASTERN): string[] {
  const first = zonedMonth(from, zone);
  const last = zonedMonth(to, zone);
  const out: string[] = [];
  let [y, m] = first.split('-').map(Number) as [number, number];
  for (let i = 0; i < 240; i += 1) {
    const k = `${y}-${String(m).padStart(2, '0')}`;
    out.push(k);
    if (k >= last) break;
    m += 1;
    if (m > 12) {
      m = 1;
      y += 1;
    }
  }
  return out;
}

export function median(a: number[]): number | null {
  if (!a.length) return null;
  const b = [...a].sort((x, y) => x - y);
  const m = Math.floor(b.length / 2);
  return b.length % 2 ? (b[m] as number) : ((b[m - 1] as number) + (b[m] as number)) / 2;
}

const BACKING_TYPES = ['Backing', 'Parking / struck fixed object'];
const INTERSTATE = /\b(I-\d+)\b/;

/** Analytics for the cases that occurred in `range` (drafts and test records excluded). */
export function analytics(s: SafetyRulesState, range: DateRange, opts: AnalyticsOptions): AnalyticsResult {
  const zone = opts.zone ?? EASTERN;
  const nowMs = rulesNow(opts.now);
  const o: ViewerOptions = { ...opts, now: nowMs };
  const set = resolveSettings(opts.settings);
  const seeMoney = opts.seeMoney !== false;
  const live = s.cases.filter((c) => c.stage !== 'draft' && !c.isTest);
  const cases = live.filter((c) => c.occurredAt >= range.from && c.occurredAt <= range.to);
  const ids = (cs: AccidentCase[]) => cs.map((c) => c.id);
  const months = monthsOf(range.from, range.to, zone);
  const monthOf = new Map(cases.map((c) => [c.id, zonedMonth(c.occurredAt, zone)] as const));
  const inMonth = (m: string) => cases.filter((c) => monthOf.get(c.id) === m);
  const fin = new Map(cases.map((c) => [c.id, financials(s, c, o)] as const));
  const dot = cases.filter((c) => dotRecordable(c).value === 'yes');

  // ---------------------------------------------------------------- by month (severity)
  const byMonth = months.map((m) => {
    const cs = inMonth(m);
    const v: Record<Severity, number> = { minor: 0, moderate: 0, serious: 0, critical: 0 };
    for (const c of cs) v[c.severity] += 1;
    return { month: m, ...v, caseIds: ids(cs) };
  });

  // ---------------------------------------------------------------- rate per 1M miles (coverage rule)
  const mil = new Map(s.mileage.map((x) => [x.month, x] as const));
  const threshold = set.mileageCoverageThreshold;
  const ratePerMonth = months.map((m) => {
    const cs = inMonth(m);
    const mm = mil.get(m);
    if (!mm) return { month: m, value: null, coverage: null, cases: cs.length, miles: null, note: 'No mileage data', caseIds: ids(cs) };
    if (mm.coverage < threshold || mm.miles <= 0)
      return { month: m, value: null, coverage: mm.coverage, cases: cs.length, miles: mm.miles, note: `Odometer coverage ${pct(mm.coverage)} — below ${pct(threshold)}`, caseIds: ids(cs) };
    return { month: m, value: cs.length / (mm.miles / 1e6), coverage: mm.coverage, cases: cs.length, miles: mm.miles, note: `${plural(cs.length, 'case')} · ${(mm.miles / 1e6).toFixed(2)}M mi · coverage ${pct(mm.coverage)}`, caseIds: ids(cs) };
  });
  const okMonths = ratePerMonth.filter((r) => r.value !== null).map((r) => r.month);
  const okMiles = okMonths.reduce((a, m) => a + (mil.get(m)?.miles ?? 0), 0);
  const okCases = cases.filter((c) => okMonths.includes(monthOf.get(c.id) ?? ''));
  const ratePerMillionMiles: AnalyticsResult['kpis']['ratePerMillionMiles'] =
    okMiles > 0
      ? { value: okCases.length / (okMiles / 1e6), dotValue: okCases.filter((c) => dotRecordable(c).value === 'yes').length / (okMiles / 1e6), qualifyingMonths: okMonths.length, totalMonths: months.length }
      : { value: null, reason: s.mileage.length ? `Odometer coverage below ${pct(threshold)} in every month` : 'No mileage data', qualifyingMonths: 0, totalMonths: months.length };

  // ---------------------------------------------------------------- types, preventability
  const typeMap = new Map<string, AccidentCase[]>();
  for (const c of cases) typeMap.set(c.type, [...(typeMap.get(c.type) ?? []), c]);
  const byType = [...typeMap.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).map(([type, cs]) => ({ type, count: cs.length, caseIds: ids(cs) }));
  const preventability = (['preventable', 'non_preventable', 'not_determined'] as const).map((k) => {
    const cs = cases.filter((c) => c.determinations.preventability.value === k);
    return { outcome: k, count: cs.length, caseIds: ids(cs) };
  });
  const [prev, nonPrev, undecided] = preventability as [(typeof preventability)[number], (typeof preventability)[number], (typeof preventability)[number]];
  const decided = prev.count + nonPrev.count;

  // ---------------------------------------------------------------- investigation time
  const invDays = cases.filter((c) => c.investigation.status === 'complete' && c.investigation.completedAt && c.submittedAt).map((c) => (Date.parse(c.investigation.completedAt!) - Date.parse(c.submittedAt!)) / DAY);

  // ---------------------------------------------------------------- money
  const sum = (f: (c: AccidentCase) => number) => cases.reduce((a, c) => a + f(c), 0);
  const cashByMonth = months.map((m) => {
    const cs = inMonth(m);
    return { month: m, spentCents: cs.reduce((a, c) => a + fin.get(c.id)!.actualCents, 0), recoveredCents: cs.reduce((a, c) => a + fin.get(c.id)!.recoveredCents, 0), caseIds: ids(cs) };
  });
  const closed = cases.filter((c) => c.stage === 'closed' && (c.initialEstimateCents ?? 0) > 0).sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
  const estSum = closed.reduce((a, c) => a + (c.initialEstimateCents ?? 0), 0);
  const actSum = closed.reduce((a, c) => a + fin.get(c.id)!.actualCents, 0);

  // ---------------------------------------------------------------- downtime by truck
  const dt = new Map<string, { days: number; cs: AccidentCase[] }>();
  let totalDown = 0;
  for (const c of cases) {
    const d = downtimeFor(s, c, o);
    totalDown += d.truckDays;
    if (d.truckDays > 0 && c.truckId) {
      const cur = dt.get(c.truckId) ?? { days: 0, cs: [] };
      cur.days += d.truckDays;
      cur.cs.push(c);
      dt.set(c.truckId, cur);
    }
  }
  const downtimeByTruck = [...dt.entries()]
    .sort((a, b) => b[1].days - a[1].days)
    .slice(0, 8)
    .map(([truckId, v]) => ({ truckId, unit: s.trucks.find((t) => t.id === truckId)?.unit ?? truckId, truckDays: Math.round(v.days * 10) / 10, caseIds: ids(v.cs) }));

  // ---------------------------------------------------------------- where
  const where = new Map<string, AccidentCase[]>();
  for (const c of cases) {
    const road = (c.location.road ?? '').match(/\b(I-\d+|US-\d+)\b/)?.[1];
    const k = road ? `${road} · ${c.location.state}` : `${c.location.state || 'State unknown'} · ${c.location.publicRoad === 'no' ? 'yards, docks & lots' : 'local roads'}`;
    where.set(k, [...(where.get(k) ?? []), c]);
  }
  const whereByCorridor = [...where.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0])).slice(0, 8).map(([label, cs]) => ({ label, count: cs.length, caseIds: ids(cs) }));

  // ---------------------------------------------------------------- repeat involvement (12 months before range end)
  const yearFrom = Date.parse(range.to) - 365 * DAY;
  const year = live.filter((c) => Date.parse(c.occurredAt) > yearFrom && c.occurredAt <= range.to);
  const group = (key: 'driverId' | 'truckId') => {
    const g = new Map<string, AccidentCase[]>();
    for (const c of year) {
      const k = c[key];
      if (k) g.set(k, [...(g.get(k) ?? []), c]);
    }
    return [...g.entries()].filter(([, v]) => v.length >= 2).sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]));
  };
  const repDrivers = group('driverId');
  const repTrucks = group('truckId');
  const repeatRow = (kind: 'driver' | 'truck', id: string, cs: AccidentCase[]) => {
    const sorted = [...cs].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt));
    return {
      kind,
      id,
      label: kind === 'driver' ? (s.drivers.find((d) => d.id === id)?.name ?? id) : `Truck ${s.trucks.find((t) => t.id === id)?.unit ?? id}`,
      cases: cs.length,
      preventable: cs.filter((c) => c.determinations.preventability.value === 'preventable').length,
      caseIds: ids(sorted),
      numbers: sorted.map((c) => c.number),
    };
  };
  const repeatInvolvement = [...repDrivers.map(([id, cs]) => repeatRow('driver', id, cs)), ...repTrucks.map(([id, cs]) => repeatRow('truck', id, cs))];

  // ---------------------------------------------------------------- follow-through
  const cas = cases.flatMap((c) => c.correctiveActions);
  const caDone = cas.filter((a) => a.status === 'Completed');
  const caOnTime = caDone.filter((a) => a.completedAt && Date.parse(a.completedAt) <= Date.parse(a.due));
  const caOverdue = cas.filter((a) => (a.status === 'Open' || a.status === 'In progress') && Date.parse(a.due) < nowMs);
  const caseSet = new Set(ids(cases));
  const ks = visibleClaims(
    s.claims.filter((k) => k.caseId && caseSet.has(k.caseId) && k.status !== 'Draft'),
    opts.canSeeRestricted,
  );
  const pd = ks.filter((k) => k.type === 'physical_damage');
  const rec = ks.filter((k) => k.type === 'recovery');
  const settled = ks.filter((k) => k.closedAt);
  const settleDays = median(settled.map((k) => (Date.parse(k.closedAt!) - Date.parse(k.openedAt)) / DAY));

  // ---------------------------------------------------------------- insights (SPEC §7.14 — conservative wording, with counts)
  const insights: AnalyticsInsight[] = [];
  const prevCases = cases.filter((c) => c.determinations.preventability.value === 'preventable');
  const backPrev = prevCases.filter((c) => BACKING_TYPES.includes(c.type));
  if (backPrev.length >= 2)
    insights.push({
      id: 'backing',
      tone: 'warning',
      text: `Low-speed backing and parking incidents: ${backPrev.length} of ${prevCases.length} preventable cases.${seeMoney ? ` They are cheap individually (${money(backPrev.reduce((a, c) => a + fin.get(c.id)!.actualCents, 0), { compact: true })} total) but frequent` : ' They are frequent'} — a fleet-wide walk-around (G.O.A.L.) refresher targets the largest preventable group.`,
      caseIds: ids(backPrev),
    });
  for (const [did, all] of repDrivers) {
    // Driver insights count only cases that are not non-preventable (SPEC §7.14).
    const v = all.filter((c) => c.determinations.preventability.value !== 'non_preventable');
    if (v.length < 2) continue;
    const byT = new Map<string, AccidentCase[]>();
    for (const c of v) byT.set(c.type, [...(byT.get(c.type) ?? []), c]);
    for (const [type, same] of byT) {
      if (same.length < 2) continue;
      insights.push({
        id: `driver:${did}:${type}`,
        tone: 'warning',
        text: `${s.drivers.find((d) => d.id === did)?.name ?? 'A driver'}: ${same.length} cases of the same type (“${type}”) within 12 months (non-preventable cases excluded). Review suggested; this is a pattern to check, not a finding of fault.`,
        caseIds: ids(same),
      });
    }
  }
  const corridors = new Map<string, AccidentCase[]>();
  for (const c of cases) {
    const road = (c.location.road ?? '').match(INTERSTATE)?.[1];
    if (road) corridors.set(road, [...(corridors.get(road) ?? []), c]);
  }
  const top = [...corridors.entries()].sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0]))[0];
  if (top && top[1].length >= 3) {
    const states = [...new Set(top[1].map((c) => c.location.state).filter(Boolean))].sort();
    insights.push({
      id: `corridor:${top[0]}`,
      tone: 'info',
      text: `${top[0]}${states.length ? ` in ${states.join('/')}` : ''}: ${top[1].length} cases, ${top[1].filter((c) => c.determinations.preventability.value === 'non_preventable').length} non-preventable. A recurring exposure on one corridor; trip planning around peak hours may help.`,
      caseIds: ids(top[1]),
    });
  }
  if (totalDown > 0 && downtimeByTruck.length > 1) {
    const topDown = downtimeByTruck.slice(0, 2).reduce((a, r) => a + r.truckDays, 0);
    insights.push({
      id: 'downtime',
      tone: 'info',
      text: `Two units account for ${pct(Math.min(1, topDown / totalDown))} of accident downtime in this range (${topDown.toFixed(0)} of ${totalDown.toFixed(0)} truck-days). Repair approval speed is the main lever.`,
      caseIds: downtimeByTruck.slice(0, 2).flatMap((r) => r.caseIds),
    });
  }

  const m = <T>(v: T): T | null => (seeMoney ? v : null);
  return {
    from: range.from,
    to: range.to,
    months,
    sample: { cases: cases.length, smallSample: cases.length < (opts.smallSampleBelow ?? 12) },
    kpis: {
      accidents: cases.length,
      dotRecordable: dot.length,
      caseIds: ids(cases),
      ratePerMillionMiles,
      preventableShare: { value: decided ? prev.count / decided : null, preventable: prev.count, decided, notDecided: undecided.count, caseIds: prev.caseIds },
      investigationDays: { median: median(invDays), within14: invDays.filter((d) => d <= 14).length, count: invDays.length },
      netCostCents: m(sum((c) => fin.get(c.id)!.projectedNetCents)),
      spentCents: m(sum((c) => fin.get(c.id)!.actualCents)),
      recoveredCents: m(sum((c) => fin.get(c.id)!.recoveredCents)),
      downtime: { truckDays: totalDown, lostRevenueCents: m(sum((c) => fin.get(c.id)!.lostRevenue.amountCents)) },
    },
    insights,
    byMonth,
    ratePerMonth,
    byType,
    preventability,
    cashByMonth: m(cashByMonth),
    estimateVsFinal: m(closed.map((c) => ({ accidentId: c.id, number: c.number, estimateCents: c.initialEstimateCents ?? 0, finalCents: fin.get(c.id)!.actualCents }))),
    estimateBias: seeMoney && closed.length ? { pct: Math.abs(actSum - estSum) / Math.max(1, estSum), direction: actSum >= estSum ? 'low' : 'high' } : null,
    downtimeByTruck,
    whereByCorridor,
    repeatInvolvement,
    followThrough: {
      correctiveActions: { total: cas.length, done: caDone.length, onTime: caOnTime.length, overdue: caOverdue.length },
      ownDamageReceivedCents: m(pd.reduce((a, k) => a + claimMoney(k).toUsCents, 0)),
      ownDamageExpectedCents: m(pd.reduce((a, k) => a + Math.max(0, (k.claimedCents ?? 0) - (k.deductibleCents ?? 0)), 0)),
      recoveriesCents: m(rec.reduce((a, k) => a + claimMoney(k).toUsCents, 0)),
      recoveriesPursuedCents: m(rec.reduce((a, k) => a + (k.claimedCents ?? 0), 0)),
      medianDaysToSettle: settleDays,
      settled: settled.length,
      cpdp: {
        submitted: cases.filter((c) => ['submitted', 'not_preventable', 'preventable', 'undecided'].includes(c.determinations.cpdp.value)).length,
        notPreventable: cases.filter((c) => c.determinations.cpdp.value === 'not_preventable').length,
        eligibleNotSubmitted: cases.filter((c) => c.determinations.cpdp.value === 'eligible_not_submitted').length,
      },
    },
  };
}
