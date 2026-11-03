// Board aggregates (KPI tiles, DOT register list) — the same computation the prototype's Accidents screen does
// and docs/accidents/prototype/tools/dump-fixtures.ts records as the expected values (ACCEPTANCE F1–F3).
// One function so the board, the executive dashboard and analytics agree (SPEC §6.7).
import { claimMoney, byId, dotRecordable, financials, isOpenCase, needsAttention, visibleClaims, type Attention, type ViewerOptions } from './rules.js';
import { OPEN_CLAIM } from './format.js';
import { DAY, localToUtc, rulesNow } from './time.js';
import type { SafetyRulesState } from './types.js';

export type RangeKey = '30d' | '90d' | '12m' | 'ytd';
export interface DateRange {
  key: RangeKey | 'custom';
  from: string;
  to: string;
}

/**
 * Range presets ending at now (same as the prototype's makeRange). YTD starts Jan 1 00:00 of now's year in `zone`;
 * without a zone it is UTC, as in the prototype and the P0 fixtures. The product passes US Eastern (CLAUDE.md:
 * every business date is Eastern) — P1 decision on the P0 note (IMPLEMENTATION-PLAN §11 / P1 report).
 */
export function makeRange(key: RangeKey, now?: number, zone?: string): DateRange {
  const n = rulesNow(now);
  const end = new Date(n).toISOString();
  if (key === 'ytd') {
    if (!zone) return { key, from: new Date(Date.UTC(new Date(n).getUTCFullYear(), 0, 1)).toISOString(), to: end };
    const year = Number(new Intl.DateTimeFormat('en-US', { timeZone: zone, year: 'numeric' }).format(new Date(n)));
    const jan1 = localToUtc(`${year}-01-01T00:00`, zone);
    return { key, from: jan1.ok ? jan1.iso : new Date(Date.UTC(year, 0, 1)).toISOString(), to: end };
  }
  const days = key === '30d' ? 30 : key === '90d' ? 90 : 365;
  return { key, from: new Date(n - days * DAY).toISOString(), to: end };
}

const inRange = (iso: string, r: DateRange) => iso >= r.from && iso <= r.to;

export interface BoardSummary {
  from: string;
  to: string;
  openCases: number;
  serious: number;
  awaitingInvestigation: number;
  reported: number;
  priorPeriod: number;
  trucksDownNow: number;
  /** Truck-days down overlapping the range, unrounded. */
  truckDaysInRange: number;
  needsAttention: number;
  overdueTasks: number;
  urgent: number;
  openClaims: number;
  ourCostToComeCents: number;
  insurerReservesCents: number;
  netCostCents: number;
  spentCents: number;
  recoveredCents: number;
  lostRevenueNotCashCents: number;
  /** DOT-recordable cases occurred in range, newest first (case numbers). */
  dotRegister: string[];
  /** Restricted claims left out of the money for this viewer (SPEC §7.13 rule 7). */
  restrictedClaimsExcluded: number;
  attention: Attention[];
}

/**
 * KPI tiles for a range. Drafts are excluded everywhere; open work (open cases, trucks down, attention, open claims)
 * does not depend on the range. Money from restricted claims is removed for a viewer without `safety.restricted`;
 * the open-claims COUNT still includes them (number/type/status are not restricted — API.md §4).
 */
export function boardSummary(s: SafetyRulesState, range: DateRange, opts: ViewerOptions): BoardSummary {
  const nowMs = rulesNow(opts.now);
  const o: ViewerOptions = { ...opts, now: nowMs };
  const live = s.cases.filter((c) => c.stage !== 'draft');
  const open = live.filter(isOpenCase);
  const inR = live.filter((c) => inRange(c.occurredAt, range));
  const span = Date.parse(range.to) - Date.parse(range.from);
  const prevR: DateRange = { ...range, from: new Date(Date.parse(range.from) - span).toISOString(), to: range.from };
  const downNow = new Set(
    s.downtime.filter((d) => !d.end && d.unitKind === 'truck' && byId(s.cases, d.caseId)?.stage !== 'draft').map((d) => d.unitId),
  );
  const truckDays = s.downtime
    .filter((d) => d.unitKind === 'truck')
    .reduce((a, d) => {
      const st = Math.max(Date.parse(d.start), Date.parse(range.from));
      const en = Math.min(d.end ? Date.parse(d.end) : nowMs, Date.parse(range.to));
      return a + Math.max(0, en - st) / DAY;
    }, 0);
  const openClaimsAll = s.claims.filter((k) => OPEN_CLAIM(k.status) && k.status !== 'Draft');
  const openClaims = visibleClaims(openClaimsAll, opts.canSeeRestricted);
  const cm = openClaims.map((k) => claimMoney(k));
  const costR = inR.map((c) => financials(s, c, o));
  const attention = needsAttention(s, o);
  const restrictedHidden = openClaimsAll.length - openClaims.length;
  return {
    from: range.from,
    to: range.to,
    openCases: open.length,
    serious: open.filter((c) => c.severity === 'serious' || c.severity === 'critical').length,
    awaitingInvestigation: open.filter((c) => c.investigation.status === 'not_started' || c.investigation.status === 'in_review').length,
    reported: inR.length,
    priorPeriod: live.filter((c) => inRange(c.occurredAt, prevR)).length,
    trucksDownNow: downNow.size,
    truckDaysInRange: truckDays,
    needsAttention: attention.length,
    overdueTasks: attention.filter((a) => a.reason === 'Overdue task').length,
    urgent: attention.filter((a) => a.tone === 'urgent').length,
    openClaims: openClaimsAll.length,
    ourCostToComeCents:
      cm.reduce((a, m) => a + m.companyEstimateCents - m.expectedRecoveryCents, 0) +
      open.reduce(
        (a, c) =>
          a + financials(s, c, o).lines.filter((l) => l.group === 'estimate' && !l.id.startsWith('ce')).reduce((x, l) => x + l.amountCents, 0),
        0,
      ),
    insurerReservesCents: cm.reduce((a, m) => a + m.insurerReserveCents, 0),
    netCostCents: costR.reduce((a, x) => a + x.projectedNetCents, 0),
    spentCents: costR.reduce((a, x) => a + x.actualCents, 0),
    recoveredCents: costR.reduce((a, x) => a + x.recoveredCents, 0),
    lostRevenueNotCashCents: costR.reduce((a, x) => a + x.lostRevenue.amountCents, 0),
    dotRegister: inR.filter((c) => dotRecordable(c).value === 'yes').map((c) => c.number),
    restrictedClaimsExcluded: restrictedHidden,
    attention,
  };
}
