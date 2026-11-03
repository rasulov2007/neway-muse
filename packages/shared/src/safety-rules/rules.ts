// Accident & Claims v2 business rules — pure functions over `SafetyRulesState`.
// Ported faithfully from docs/accidents/prototype/src/lib/rules.ts (the reference implementation; SPEC §7 is
// authoritative). Differences, all required by SPEC:
//   - money is integer cents (SPEC §3.1); texts still print dollars exactly as the prototype did;
//   - "now" comes from `opts.now` or the injected rules clock (time.ts), never the system clock directly;
//   - thresholds come from `SafetyRuleSettings` (SPEC §12, shortcut 4) instead of literals;
//   - lost revenue = round(days × $/day) whole dollars, then cents (ACCEPTANCE §0); a truck without its own
//     contribution uses the settings fallback (SPEC §7.13 rule 6);
//   - restricted claims are removed from the ledger lines AND totals for a viewer without `safety.restricted`
//     (SPEC §7.13 rule 7 — the prototype did not implement this, shortcut 8);
//   - stage `response` is `initial_response`.
import {
  CARGO_PLAN_LABEL,
  CLAIM_TYPE_LABEL,
  EQUIP_STATUS_LABEL,
  FAULT_LABEL,
  OPEN_CLAIM,
  PREVENT_LABEL,
  money,
  plural,
} from './format.js';
import { resolveSettings, type SafetyRuleSettings } from './settings.js';
import { DAY, HOUR, addHours, durationLabel, fmtDate, fmtShort, fmtShortDateTime, fmtTime, rulesNow } from './time.js';
import type {
  AccidentCase,
  Claim,
  ClaimType,
  Load,
  Person,
  SafetyRulesState,
  Severity,
  Task,
  Tri,
  WorkOrder,
} from './types.js';

export type Tone = 'urgent' | 'warning' | 'done' | 'moving' | 'neutral' | 'accent';

/** Clock + settings every rule may read. Omitted → injected rules clock and SPEC §12 defaults. */
export interface RuleOptions {
  now?: number;
  settings?: Partial<SafetyRuleSettings>;
}
/** Rules that show money must know whether the viewer holds `safety.restricted` (SPEC §7.13 rule 7). */
export interface ViewerOptions extends RuleOptions {
  canSeeRestricted: boolean;
}

/* ------------------------------------------------------------------ lookups */
export const byId = <T extends { id: string }>(arr: T[], id?: string): T | undefined => (id ? arr.find((x) => x.id === id) : undefined);
export const truckOf = (s: SafetyRulesState, c: AccidentCase) => byId(s.trucks, c.truckId);
export const trailerOf = (s: SafetyRulesState, c: AccidentCase) => byId(s.trailers, c.trailerId);
export const driverOf = (s: SafetyRulesState, c: AccidentCase) => byId(s.drivers, c.driverId);
export const loadOf = (s: SafetyRulesState, c: AccidentCase) => byId(s.loads, c.loadId);
export const personName = (s: SafetyRulesState, id?: string): string => byId(s.people, id)?.name || 'Unassigned';
export const caseClaims = (s: SafetyRulesState, c: AccidentCase) => s.claims.filter((k) => k.caseId === c.id);
export const caseTasks = (s: SafetyRulesState, c: AccidentCase) => s.tasks.filter((t) => t.caseId === c.id);
export const caseWOs = (s: SafetyRulesState, c: AccidentCase) => s.workOrders.filter((w) => w.caseId === c.id);
export const openTask = (t: Task): boolean => t.status !== 'done' && t.status !== 'cancelled';
export const isOpenCase = (c: AccidentCase): boolean => c.stage !== 'closed' && c.stage !== 'draft';

/* ------------------------------------------------------------------ DOT recordability: 49 CFR 390.5T */
export interface Determ {
  value: 'yes' | 'no' | 'pending';
  reasons: string[];
  missing: string[];
}

export function dotRecordable(c: AccidentCase): Determ {
  const reasons: string[] = [];
  const missing: string[] = [];
  if (c.excludedOccurrence === 'boarding_alighting')
    return { value: 'no', reasons: ['Only boarding or alighting a stationary vehicle — excluded by definition'], missing };
  if (c.excludedOccurrence === 'loading_unloading')
    return { value: 'no', reasons: ['Only loading or unloading cargo — excluded by definition'], missing };
  const fat = c.injuries.fatalities ?? null;
  const away = c.injuries.status === 'no' ? 0 : c.injuries.treatedAway;
  if (fat && fat > 0) reasons.push(`${plural(fat, 'fatality', 'fatalities')}`);
  if (away && away > 0) reasons.push(`${plural(away, 'person', 'people')} treated away from the scene`);
  if (c.towAway === 'yes') reasons.push('A vehicle was towed away with disabling damage');
  // "Highway" (49 CFR 390.5) = any road, street or way, public or private, open to public travel.
  if (reasons.length) {
    if (c.location.publicRoad === 'no') return { value: 'no', reasons: ['Not on a road open to public travel'], missing };
    if (c.location.publicRoad !== 'yes') return { value: 'pending', reasons, missing: ['Confirm it happened on a road open to public travel'] };
    return { value: 'yes', reasons, missing };
  }
  if (c.location.publicRoad === 'no') return { value: 'no', reasons: ['Not on a road open to public travel'], missing };
  if (c.injuries.status === null || c.injuries.status === 'unknown') missing.push('Injury status');
  else if (c.injuries.status === 'yes' && (away === null || away === undefined)) missing.push('Whether anyone was treated away from the scene');
  if (fat === null && c.injuries.status !== 'no') missing.push('Fatalities');
  if (c.towAway === null || c.towAway === 'unknown') missing.push('Whether any vehicle was towed with disabling damage');
  if (missing.length) return { value: 'pending', reasons: [], missing };
  return { value: 'no', reasons: ['No fatality, no injury treated away from the scene, no disabling-damage tow-away'], missing };
}

/* ------------------------------------------------------------------ post-accident testing: 49 CFR 382.303 */
export interface TestDet {
  substance: 'alcohol' | 'drug';
  required: 'yes' | 'no' | 'pending';
  reason: string;
  deadline: string;
  promptBy?: string;
  windowOpen: boolean;
  administered: boolean;
  documented: boolean;
  overrideNote?: string;
  /** What is still missing for the record to count as documented (late alcohol test, test time past the limit). */
  docNote?: string;
}

const list = (xs: string[]): string => (xs.length <= 1 ? xs.join('') : `${xs.slice(0, -1).join(', ')} and ${xs[xs.length - 1]}`);

/** 49 CFR 382.303 applies to an occurrence involving a CMV operating on a public road in commerce: a fatality → test;
 *  injury treated away or disabling-damage tow-away → test only if our driver is cited within 8 h (alcohol) / 32 h (drug).
 *  Unknown facts never resolve to "not required" while a test could still be required. */
export function testing(c: AccidentCase, opts: RuleOptions = {}): { alcohol: TestDet; drug: TestDet } {
  const set = resolveSettings(opts.settings);
  const nowMs = rulesNow(opts.now);
  const mk = (sub: 'alcohol' | 'drug'): TestDet => {
    const limitH = sub === 'alcohol' ? set.alcoholWindowHours : set.drugWindowHours;
    const occ = Date.parse(c.occurredAt);
    const deadline = addHours(c.occurredAt, limitH);
    const promptBy = sub === 'alcohol' ? addHours(c.occurredAt, set.alcoholPromptHours) : undefined;
    const windowOpen = nowMs < Date.parse(deadline);
    const rec = c.testing[sub];
    // documentation
    const givenAfterMs = rec.administeredAt ? Date.parse(rec.administeredAt) - occ : null;
    const administered = givenAfterMs !== null && givenAfterMs <= limitH * HOUR; // after the limit it is not a valid post-accident test
    const pastLimit = givenAfterMs !== null && givenAfterMs > limitH * HOUR;
    const needsDelayReason =
      sub === 'alcohol' && administered && (givenAfterMs as number) > set.alcoholPromptHours * HOUR && !rec.delayReason?.trim();
    const documented = !!rec.notAdministeredReason?.trim() || (administered && !needsDelayReason);
    const docNote = rec.notAdministeredReason?.trim()
      ? undefined
      : pastLimit
        ? `Recorded test time is after the ${limitH}-hour limit — record why the test was not given instead`
        : needsDelayReason
          ? `Given more than ${set.alcoholPromptHours} hours after the accident — record why it was not given sooner (382.303(d)(1))`
          : undefined;
    // facts
    const st = c.injuries.status;
    const fat = st === 'no' ? 0 : c.injuries.fatalities;
    const away = st === 'no' ? 0 : c.injuries.treatedAway;
    const tow = c.towAway;
    const missing: string[] = [];
    if (st === null || st === 'unknown') missing.push('injury status');
    else if (st === 'yes') {
      if (fat === null || fat === undefined) missing.push('fatalities');
      if (away === null || away === undefined) missing.push('people treated away');
    }
    if (tow === null || tow === 'unknown') missing.push('tow-away');
    const prong = (away ?? 0) > 0 || tow === 'yes';
    const prongPossible =
      !prong &&
      (st === null || st === 'unknown' || (st === 'yes' && (away === null || away === undefined)) || tow === null || tow === 'unknown');
    const fatalityPossible = st === null || st === 'unknown' || (st === 'yes' && (fat === null || fat === undefined));
    const cit = c.citation.status;
    const citedInWindow = cit === 'yes' && (!c.citation.issuedAt || Date.parse(c.citation.issuedAt) - occ <= limitH * HOUR);
    const road = c.location.publicRoad;
    let required: TestDet['required'] = 'no';
    let reason = '';
    const pending = (open: string, closed: string) => {
      required = windowOpen ? 'pending' : 'no';
      reason = windowOpen ? open : closed;
    };
    const confirmRoad = (why: string) =>
      pending(
        `${why} — required if it happened on a road open to public travel; confirm the location`,
        `${why}, but the location was not confirmed before the ${limitH}-hour limit — document why`,
      );
    const what = (away ?? 0) > 0 ? 'Injury treated away from the scene' : 'Disabling-damage tow-away';
    if (road === 'no') {
      required = 'no';
      reason = 'Not on a road open to public travel — 382.303 does not apply (company policy may still call for a test)';
    } else if ((fat ?? 0) > 0) {
      if (road === 'yes') {
        required = 'yes';
        reason = 'Fatality — test required whether or not a citation is issued';
      } else confirmRoad('Fatality');
    } else if (prong && citedInWindow) {
      if (road === 'yes') {
        required = 'yes';
        reason = `${what} and our driver was cited within ${limitH} hours`;
      } else confirmRoad(`${what} and a citation`);
    } else if (fatalityPossible)
      pending(
        `Waiting on ${list(missing)} — required if anyone died${cit !== 'no' ? `, or if it qualifies and our driver is cited within ${limitH} hours` : ''}`,
        `The ${limitH}-hour limit passed before ${list(missing)} ${missing.length > 1 ? 'were' : 'was'} confirmed — document why`,
      );
    else if (prongPossible && cit !== 'no' && !(cit === 'yes' && !citedInWindow))
      pending(
        `Waiting on ${list(missing)} — required if it qualifies and our driver is cited within ${limitH} hours`,
        `The ${limitH}-hour limit passed before ${list(missing)} ${missing.length > 1 ? 'were' : 'was'} confirmed — document why`,
      );
    else if (prong && cit === 'yes') {
      required = 'no';
      reason = `Citation issued after the ${limitH}-hour window`;
    } else if (prong && cit === 'no') {
      required = 'no';
      reason = `${(away ?? 0) > 0 ? 'Injury treated away' : 'Tow-away'}, but our driver was not cited`;
    } else if (prong)
      pending(
        `Required only if our driver is cited within ${limitH} hours — confirm citation status`,
        `No citation recorded within ${limitH} hours — confirm none was issued`,
      );
    else if (prongPossible) {
      required = 'no';
      reason = cit === 'no' ? 'No fatality and our driver was not cited' : `No fatality and the citation came after the ${limitH}-hour window`;
    } else {
      required = 'no';
      reason = 'No fatality, no injury treated away from the scene and no disabling-damage tow';
    }
    let overrideNote: string | undefined;
    if (rec.decision === 'required' && required !== 'yes') {
      overrideNote = 'Marked required by Safety (company policy)';
      required = 'yes';
    }
    return { substance: sub, required, reason, deadline, promptBy, windowOpen, administered, documented, overrideNote, docNote };
  };
  return { alcohol: mk('alcohol'), drug: mk('drug') };
}

/* ------------------------------------------------------------------ severity (suggested from facts) */
export function suggestedSeverity(c: AccidentCase, opts: RuleOptions = {}): { value: Severity; why: string } {
  const set = resolveSettings(opts.settings);
  const est = c.initialEstimateCents ?? 0;
  const fat = c.injuries.fatalities ?? 0;
  if (fat > 0) return { value: 'critical', why: 'Fatality' };
  if (c.hazmat === 'yes') return { value: 'critical', why: 'Hazardous material released' };
  const away = c.injuries.status === 'no' ? 0 : (c.injuries.treatedAway ?? 0);
  if (away > 0) return { value: 'serious', why: 'Injury treated away from the scene' };
  if (c.towAway === 'yes') return { value: 'serious', why: 'Disabling damage — tow-away' };
  if (c.citation.status === 'yes') return { value: 'serious', why: 'Our driver was cited' };
  if (c.cargo.status === 'loss') return { value: 'serious', why: 'Cargo loss' };
  if (est >= set.severitySeriousEstimateCents)
    return { value: 'serious', why: `Estimated damage ${money(set.severitySeriousEstimateCents)} or more` };
  if (c.injuries.status === null || c.injuries.status === 'unknown') return { value: 'moderate', why: 'Injury status not confirmed yet' };
  if (c.injuries.status === 'yes' && (c.injuries.treatedAway === null || c.injuries.fatalities === null))
    return { value: 'moderate', why: 'Injuries reported — treatment and fatality details not confirmed yet' };
  if (est >= set.severityModerateEstimateCents || c.cargo.status === 'damaged')
    return {
      value: 'moderate',
      why: c.cargo.status === 'damaged' ? 'Cargo damaged' : `Estimated damage ${money(set.severityModerateEstimateCents)} or more`,
    };
  if (c.equipment.truck.condition === 'not_drivable') return { value: 'moderate', why: 'Truck not drivable' };
  return { value: 'minor', why: 'No injuries, no tow-away, low damage' };
}

/* ------------------------------------------------------------------ report prefill (SPEC §1.3 / §11 shortcut 9) */
/** Hazmat-released prefill: only when the load record explicitly says non-hazmat and nobody has answered yet.
 *  It is a suggestion with its source shown; the user can change it. */
export function hazmatPrefill(load: Load | undefined, current: Tri): { value: 'no'; hint: string } | null {
  if (current !== null || !load || load.hazmat !== false) return null;
  return { value: 'no', hint: `Load ${load.number} is not a hazmat load (load record)` };
}

/* ------------------------------------------------------------------ claim / work-order defaults (SPEC §12) */
export function defaultDeductibleCents(type: ClaimType, settings?: Partial<SafetyRuleSettings>): number | undefined {
  const set = resolveSettings(settings);
  if (type === 'physical_damage') return set.physicalDamageDeductibleCents;
  if (type === 'recovery') return undefined;
  if (type === 'cargo') return set.cargoDeductibleCents;
  return set.autoLiabilityDeductibleCents;
}

/** Estimates required on a work order: never lowered; any estimate above the threshold → `estimatesRequired`. */
export function estimatesRequiredFor(w: Pick<WorkOrder, 'estimates' | 'estimatesRequired'>, settings?: Partial<SafetyRuleSettings>): number {
  const set = resolveSettings(settings);
  const max = w.estimates.reduce((a, e) => Math.max(a, e.amountCents), 0);
  return Math.max(w.estimatesRequired, max > set.estimatesRequiredThresholdCents ? set.estimatesRequired : 1);
}

/* ------------------------------------------------------------------ downtime (from verified out-of-service periods) */
export function downtimeFor(s: SafetyRulesState, c: AccidentCase, opts: RuleOptions = {}) {
  const nowMs = rulesNow(opts.now);
  const periods = s.downtime
    .filter((d) => d.caseId === c.id)
    .map((d) => {
      const ms = (d.end ? Date.parse(d.end) : nowMs) - Date.parse(d.start);
      return { ...d, ms, ongoing: !d.end };
    });
  const truckMs = periods.filter((p) => p.unitKind === 'truck').reduce((a, p) => a + p.ms, 0);
  const trailerMs = periods.filter((p) => p.unitKind === 'trailer').reduce((a, p) => a + p.ms, 0);
  return {
    periods,
    truckMs,
    trailerMs,
    truckDays: truckMs / DAY,
    trailerDays: trailerMs / DAY,
    ongoing: periods.some((p) => p.ongoing && p.unitKind === 'truck'),
  };
}

export function downtimeLabel(ms: number): string {
  if (ms <= 0) return 'None';
  if (ms < DAY) return durationLabel(ms);
  const d = ms / DAY;
  return `${d >= 10 ? Math.round(d) : d.toFixed(1).replace(/\.0$/, '')} days`;
}

/* ------------------------------------------------------------------ claim money */
export interface ClaimMoney {
  toUsCents: number;
  insurerPaidCents: number;
  byUsCents: number;
  expectedRecoveryCents: number;
  companyEstimateCents: number;
  insurerReserveCents: number;
  open: boolean;
}

const isSelfHandled = (k: Claim) => /self-handled/i.test(k.insurer);

export function claimMoney(k: Claim): ClaimMoney {
  const sum = (dir: Claim['payments'][number]['direction']) =>
    k.payments.filter((p) => p.direction === dir).reduce((a, p) => a + p.amountCents, 0);
  const toUs = sum('to_us');
  const insurerPaid = sum('by_insurer_to_claimant');
  const byUs = sum('by_us');
  const open = OPEN_CLAIM(k.status);
  const ded = k.deductibleCents ?? 0;
  let expectedRecovery = 0;
  let companyEstimate = 0;
  let insurerReserve = 0;
  if (k.type === 'physical_damage') {
    expectedRecovery = open ? Math.max(0, Math.max(0, (k.claimedCents ?? 0) - ded) - toUs) : 0;
  } else if (k.type === 'recovery') {
    expectedRecovery = open ? Math.max(0, (k.claimedCents ?? 0) - toUs) : 0;
  } else if (isSelfHandled(k)) {
    const basis = k.settlementCents ?? k.reserveCents ?? k.claimedCents ?? 0;
    companyEstimate = Math.max(0, basis - byUs);
    if (!open && k.settlementCents === undefined) companyEstimate = 0;
  } else {
    const basis =
      k.status === 'Settled' && k.settlementCents !== undefined ? k.settlementCents : (k.reserveCents ?? k.claimedCents ?? (open ? ded : 0));
    const retained = Math.min(ded, basis);
    companyEstimate = Math.max(0, retained - byUs);
    if (k.status === 'Denied' || (k.status === 'Closed' && byUs >= retained)) companyEstimate = 0;
    insurerReserve = open ? Math.max(0, (k.reserveCents ?? 0) - insurerPaid - retained) : 0;
  }
  return {
    toUsCents: toUs,
    insurerPaidCents: insurerPaid,
    byUsCents: byUs,
    expectedRecoveryCents: expectedRecovery,
    companyEstimateCents: companyEstimate,
    insurerReserveCents: insurerReserve,
    open,
  };
}

/** Claims the viewer may count: restricted claims drop out for a viewer without `safety.restricted` (SPEC §7.13 rule 7). */
export const visibleClaims = (claims: Claim[], canSeeRestricted: boolean): Claim[] =>
  canSeeRestricted ? claims : claims.filter((k) => !k.restricted);

/* ------------------------------------------------------------------ case financials: one ledger, every line sourced */
export type FinGroup = 'actual' | 'estimate' | 'recovered' | 'expected' | 'exposure';
export interface FinLine {
  id: string;
  group: FinGroup;
  category: string;
  label: string;
  amountCents: number;
  source: string;
  nav?: { name: string; id?: string };
  note?: string;
}

function woEstimate(w: WorkOrder): { amountCents: number; note: string } | null {
  if (w.approvedAmountCents) return { amountCents: w.approvedAmountCents, note: 'Approved estimate' };
  const sel = w.estimates.find((e) => e.selected);
  if (sel) return { amountCents: sel.amountCents, note: `Selected estimate (${sel.vendor})` };
  const first = w.estimates[0];
  if (first) {
    const lo = w.estimates.reduce((a, b) => (b.amountCents < a.amountCents ? b : a), first);
    return { amountCents: lo.amountCents, note: `Lowest of ${w.estimates.length} estimate${w.estimates.length > 1 ? 's' : ''}` };
  }
  return null;
}

export interface Financials {
  lines: FinLine[];
  actualCents: number;
  estimateCents: number;
  recoveredCents: number;
  expectedCents: number;
  exposureCents: number;
  netToDateCents: number;
  projectedNetCents: number;
  /** Not cash, never part of net cost. `amountCents` is whole dollars (ACCEPTANCE §0). */
  lostRevenue: { days: number; perDayCents: number; amountCents: number };
  finalized: boolean;
  /** Restricted claims left out for this viewer ("Excludes N restricted claim(s)"). */
  restrictedClaimsExcluded: number;
}

export function financials(s: SafetyRulesState, c: AccidentCase, opts: ViewerOptions): Financials {
  const set = resolveSettings(opts.settings);
  const nowMs = rulesNow(opts.now);
  const lines: FinLine[] = [];
  const truck = truckOf(s, c);
  const allClaims = caseClaims(s, c);
  const claims = visibleClaims(allClaims, opts.canSeeRestricted);
  const hiddenClaimIds = new Set(allClaims.filter((k) => !claims.includes(k)).map((k) => k.id));
  // 1) Accounts payable bills linked to the case (bills linked to a claim are counted through that claim)
  for (const b of s.bills.filter((b) => b.caseId === c.id && !b.claimId)) {
    lines.push({
      id: 'b' + b.id,
      group: 'actual',
      category: b.category,
      label: `${b.vendor} — ${b.memo}`,
      amountCents: b.amountCents,
      source: `AP bill ${b.number}${b.woId ? ' · ' + (byId(s.workOrders, b.woId)?.number || '') : ''}`,
      nav: { name: 'payables', id: b.id },
    });
  }
  // 2) Work orders not yet invoiced → estimate (drops out the moment the invoice/bill exists)
  for (const w of caseWOs(s, c)) {
    if (w.billId || w.status === 'Completed') continue;
    const e = woEstimate(w);
    const unit = w.unitKind === 'truck' ? `Tractor ${byId(s.trucks, w.unitId)?.unit}` : `Trailer ${byId(s.trailers, w.unitId)?.unit}`;
    const category = w.unitKind === 'truck' ? 'Tractor repair' : 'Trailer repair';
    if (e)
      lines.push({ id: 'w' + w.id, group: 'estimate', category, label: `${unit} repair — ${w.shop}`, amountCents: e.amountCents, source: `Work order ${w.number}`, note: e.note, nav: { name: 'workorder', id: w.id } });
    else
      lines.push({ id: 'w' + w.id, group: 'estimate', category, label: `${unit} repair — awaiting estimate`, amountCents: 0, source: `Work order ${w.number}`, note: 'No estimate received yet', nav: { name: 'workorder', id: w.id } });
  }
  // 3) Storage accruing (towed to a storage yard, not billed yet)
  for (const [kind, eq] of [['Tractor', c.equipment.truck], ['Trailer', c.equipment.trailer]] as const) {
    if (eq && eq.status === 'towed_storage' && eq.storageRatePerDayCents && eq.storageSince) {
      const days = Math.max(1, Math.ceil((nowMs - Date.parse(eq.storageSince)) / DAY));
      lines.push({
        id: 'st' + kind,
        group: 'estimate',
        category: 'Storage',
        label: `${kind} storage at ${eq.towedTo || 'tow yard'} — accruing`,
        amountCents: days * eq.storageRatePerDayCents,
        source: `${days} days × ${money(eq.storageRatePerDayCents)}/day`,
        note: 'Accrues daily until the unit is moved',
      });
    }
  }
  // 4) Claims
  const repairBasis = lines
    .filter((l) => (l.category === 'Tractor repair' || l.category === 'Trailer repair') && (l.group === 'actual' || l.group === 'estimate'))
    .reduce((a, l) => a + l.amountCents, 0);
  for (const k of claims) {
    const m = claimMoney(k);
    const tl = CLAIM_TYPE_LABEL[k.type];
    if (k.type === 'physical_damage' && repairBasis === 0 && (k.claimedCents ?? 0) > 0)
      lines.push({ id: 'pdb' + k.id, group: 'estimate', category: 'Tractor repair', label: `Damage estimate from ${k.number} — no work order yet`, amountCents: k.claimedCents ?? 0, source: `Claim ${k.number}`, note: 'Replaced by the work-order estimate or invoice once Fleet links one', nav: { name: 'claim', id: k.id } });
    for (const p of k.payments) {
      if (p.direction === 'to_us')
        lines.push({ id: 'p' + p.id, group: 'recovered', category: k.type === 'recovery' ? 'Recovery' : 'Insurance payment', label: `${p.party} — ${tl}`, amountCents: p.amountCents, source: `Claim ${k.number} · ${fmtShort(p.at, undefined, nowMs)}`, nav: { name: 'claim', id: k.id } });
      if (p.direction === 'by_us')
        lines.push({ id: 'p' + p.id, group: 'actual', category: /deductible/i.test(p.note || '') ? 'Deductible' : 'Third-party / claim payment', label: `${p.note || 'Payment'} — ${tl}`, amountCents: p.amountCents, source: `Claim ${k.number} · ${fmtShort(p.at, undefined, nowMs)}`, nav: { name: 'claim', id: k.id } });
    }
    if (m.expectedRecoveryCents > 0)
      lines.push({ id: 'er' + k.id, group: 'expected', category: k.type === 'recovery' ? 'Recovery' : 'Insurance payment', label: `${k.insurer} — ${tl}${k.type === 'physical_damage' ? ` (claimed ${money(k.claimedCents)} less ${money(k.deductibleCents)} deductible)` : ''}`, amountCents: m.expectedRecoveryCents, source: `Claim ${k.number} · ${k.status}`, nav: { name: 'claim', id: k.id } });
    if (m.companyEstimateCents > 0)
      lines.push({ id: 'ce' + k.id, group: 'estimate', category: isSelfHandled(k) ? 'Third-party / claim payment' : 'Deductible', label: isSelfHandled(k) ? `Direct settlement — ${tl}` : `Our deductible — ${tl}`, amountCents: m.companyEstimateCents, source: `Claim ${k.number} · ${k.status}`, note: isSelfHandled(k) ? 'Company pays directly' : `Lower of ${money(k.deductibleCents)} deductible and the claim's value`, nav: { name: 'claim', id: k.id } });
    if (m.insurerReserveCents > 0)
      lines.push({ id: 'ir' + k.id, group: 'exposure', category: 'Insurer reserve', label: `${k.insurer} reserve above our deductible — ${tl}`, amountCents: m.insurerReserveCents, source: `Claim ${k.number}`, note: 'Paid by the insurer unless limits are exceeded', nav: { name: 'claim', id: k.id } });
  }
  const sum = (g: FinGroup) => lines.filter((l) => l.group === g).reduce((a, l) => a + l.amountCents, 0);
  const actual = sum('actual'), estimate = sum('estimate'), recovered = sum('recovered'), expected = sum('expected'), exposure = sum('exposure');
  const dt = downtimeFor(s, c, { now: nowMs });
  const perDayCents = truck?.dailyContributionCents ?? set.fallbackDailyContributionCents;
  const lostRevenue = { days: dt.truckDays, perDayCents, amountCents: Math.round((dt.truckDays * perDayCents) / 100) * 100 };
  return {
    lines,
    actualCents: actual,
    estimateCents: estimate,
    recoveredCents: recovered,
    expectedCents: expected,
    exposureCents: exposure,
    netToDateCents: actual - recovered,
    projectedNetCents: actual + estimate - recovered - expected,
    lostRevenue,
    finalized: estimate === 0 && expected === 0 && exposure === 0,
    restrictedClaimsExcluded: hiddenClaimIds.size,
  };
}

/* ------------------------------------------------------------------ next action, tasks */
export function sortTasks(ts: Task[]): Task[] {
  return [...ts].sort((a, b) => (a.priority === b.priority ? 0 : a.priority === 'high' ? -1 : 1) || Date.parse(a.due) - Date.parse(b.due));
}
export function nextAction(s: SafetyRulesState, c: AccidentCase): Task | null {
  const open = s.tasks.filter((t) => t.caseId === c.id && openTask(t));
  if (!open.length) return null;
  return [...open].sort((a, b) => Date.parse(a.due) - Date.parse(b.due) || (a.priority === 'high' ? -1 : 1))[0] ?? null;
}
export const isOverdue = (t: Task, now?: number): boolean => openTask(t) && Date.parse(t.due) < rulesNow(now);

/* ------------------------------------------------------------------ stage gates */
export interface Blocker {
  text: string;
  tab?: string;
}

export function advanceBlockers(s: SafetyRulesState, c: AccidentCase, opts: RuleOptions = {}): Blocker[] {
  const b: Blocker[] = [];
  if (c.stage === 'initial_response') {
    if (c.injuries.status === null || c.injuries.status === 'unknown') b.push({ text: 'Injury status is not confirmed', tab: 'incident' });
    if (c.towAway === null || c.towAway === 'unknown') b.push({ text: 'Tow-away status is not confirmed', tab: 'incident' });
    if (c.equipment.truck.condition === 'unknown') b.push({ text: 'Truck condition is unknown', tab: 'equipment' });
    if (c.cargo.status === 'unknown') b.push({ text: 'Cargo status is unknown', tab: 'equipment' });
    const t = testing(c, opts);
    for (const x of [t.alcohol, t.drug])
      if (x.required === 'pending' && x.windowOpen) b.push({ text: `Post-accident ${x.substance} test decision is pending`, tab: 'incident' });
  }
  if (c.stage === 'investigation') {
    if (c.investigation.status !== 'complete') b.push({ text: 'Investigation is not complete and approved', tab: 'investigation' });
  }
  if (c.stage === 'resolution') return closeBlockers(s, c, opts);
  return b;
}

export function closeBlockers(s: SafetyRulesState, c: AccidentCase, opts: RuleOptions = {}): Blocker[] {
  const b: Blocker[] = [];
  if (c.investigation.status !== 'complete') b.push({ text: 'Investigation is not complete and approved', tab: 'investigation' });
  if (c.determinations.fault.value === 'not_determined') b.push({ text: 'Driver fault is not determined', tab: 'investigation' });
  if (c.determinations.preventability.value === 'not_determined') b.push({ text: 'Preventability is not determined', tab: 'investigation' });
  for (const [label, eq] of [['Tractor', c.equipment.truck], ['Trailer', c.equipment.trailer]] as const) {
    if (eq && !['operational', 'returned', 'total_loss', 'not_involved'].includes(eq.status))
      b.push({ text: `${label} has not returned to service`, tab: 'equipment' });
  }
  const openCA = c.correctiveActions.filter((a) => a.status === 'Open' || a.status === 'In progress');
  if (openCA.length) b.push({ text: `${plural(openCA.length, 'corrective action')} still open`, tab: 'investigation' });
  const ot = s.tasks.filter((t) => t.caseId === c.id && openTask(t));
  if (ot.length) b.push({ text: `${plural(ot.length, 'task')} still open`, tab: 'tasks' });
  const notInvoiced = caseWOs(s, c).filter((w) => w.status !== 'Completed');
  if (notInvoiced.length) b.push({ text: `${plural(notInvoiced.length, 'work order')} not completed/invoiced`, tab: 'equipment' });
  const t = testing(c, opts);
  for (const x of [t.alcohol, t.drug])
    if (x.required === 'yes' && !x.documented) b.push({ text: `Post-accident ${x.substance} test is not documented`, tab: 'incident' });
  if (c.police.responded === 'yes' && !s.evidence.some((e) => e.caseId === c.id && e.category === 'Police report' && !e.removed))
    b.push({ text: 'Police report is not on file', tab: 'evidence' });
  const dot = dotRecordable(c);
  if (dot.value === 'pending') b.push({ text: 'DOT recordability is not determined', tab: 'incident' });
  if (dot.value === 'yes' && (c.hazmat === null || c.hazmat === 'unknown'))
    b.push({ text: 'Hazmat release (DOT register field) is not answered', tab: 'incident' });
  return b;
}

/* ------------------------------------------------------------------ status by track */
export interface Track {
  key: string;
  label: string;
  status: string;
  tone: Tone;
  detail?: string;
  tab: string;
}

export function tracks(s: SafetyRulesState, c: AccidentCase, opts: ViewerOptions): Track[] {
  const nowMs = rulesNow(opts.now);
  const o: ViewerOptions = { ...opts, now: nowMs };
  const out: Track[] = [];
  const inv = c.investigation;
  const invLabel = { not_started: 'Not started', in_progress: 'In progress', in_review: 'Awaiting approval', complete: 'Complete' }[inv.status];
  const openQ = inv.questions.filter((q) => !q.resolvedAt).length;
  out.push({
    key: 'inv',
    label: 'Investigation',
    status: invLabel,
    tone: inv.status === 'complete' ? 'done' : inv.status === 'not_started' ? 'warning' : 'moving',
    detail: inv.status === 'complete' ? `Approved ${fmtShort(inv.completedAt, undefined, nowMs)}` : `${personName(s, inv.ownerId)}${openQ ? ` · ${plural(openQ, 'open question')}` : ''}`,
    tab: 'investigation',
  });
  const dt = downtimeFor(s, c, o);
  const eqTrack = (label: string, eq: AccidentCase['equipment']['truck'] | undefined, kind: 'truck' | 'trailer') => {
    if (!eq || eq.status === 'not_involved') return;
    const ms = kind === 'truck' ? dt.truckMs : dt.trailerMs;
    const ok = ['operational', 'returned'].includes(eq.status);
    out.push({
      key: kind,
      label,
      status: EQUIP_STATUS_LABEL[eq.status],
      tone: ok ? 'done' : eq.status === 'total_loss' ? 'neutral' : eq.status === 'unknown' ? 'warning' : 'urgent',
      detail: ms > 0 ? `Out of service ${downtimeLabel(ms)}${ok ? '' : ' so far'}` : eq.condition === 'drivable' ? 'Drivable' : undefined,
      tab: 'equipment',
    });
  };
  const tr = truckOf(s, c), tl = trailerOf(s, c);
  eqTrack(`Tractor ${tr?.unit ?? ''}`, c.equipment.truck, 'truck');
  if (c.equipment.trailer) eqTrack(`Trailer ${tl?.unit ?? ''}`, c.equipment.trailer, 'trailer');
  const cg = c.cargo;
  if (cg.status !== 'na')
    out.push({
      key: 'cargo',
      label: 'Cargo',
      status: cg.status === 'unknown' ? 'Unknown' : cg.status === 'no_damage' ? 'No damage' : cg.status === 'damaged' ? 'Damaged' : 'Loss',
      tone: cg.status === 'unknown' ? 'warning' : cg.status === 'no_damage' ? 'done' : 'urgent',
      detail: cg.plan ? CARGO_PLAN_LABEL[cg.plan] : undefined,
      tab: 'equipment',
    });
  const ks = caseClaims(s, c);
  const openK = ks.filter((k) => OPEN_CLAIM(k.status));
  out.push({
    key: 'claims',
    label: 'Claims',
    status: ks.length === 0 ? (c.claimDecision ? 'None filed' : 'None yet') : openK.length ? `${openK.length} open` : 'All settled',
    tone: ks.length === 0 ? 'neutral' : openK.length ? 'moving' : 'done',
    detail: ks.length ? ks.map((k) => `${CLAIM_TYPE_LABEL[k.type].split(' ')[0]}: ${k.status}`).join(' · ') : c.claimDecision?.text,
    tab: 'claims',
  });
  const ca = c.correctiveActions;
  const openCA = ca.filter((a) => a.status === 'Open' || a.status === 'In progress');
  const firstOpen = openCA[0];
  out.push({
    key: 'driver',
    label: 'Driver follow-up',
    status: ca.length === 0 ? (inv.status === 'complete' ? 'None required' : 'Pending investigation') : openCA.length ? `${openCA.length} open` : 'Completed',
    tone: ca.length === 0 ? 'neutral' : openCA.length ? 'moving' : 'done',
    detail: firstOpen ? `${firstOpen.kind} · due ${fmtShort(firstOpen.due, undefined, nowMs)}` : undefined,
    tab: 'investigation',
  });
  const dot = dotRecordable(c);
  const t = testing(c, o);
  const testNeeded = [t.alcohol, t.drug].filter((x) => x.required === 'yes');
  const testPending = [t.alcohol, t.drug].some((x) => x.required === 'pending');
  out.push({
    key: 'dot',
    label: 'DOT & testing',
    status: dot.value === 'yes' ? 'DOT recordable' : dot.value === 'no' ? 'Not recordable' : 'To be determined',
    tone: dot.value === 'pending' || testPending ? 'warning' : testNeeded.some((x) => !x.documented) ? 'urgent' : 'done',
    detail: testNeeded.length
      ? testNeeded.every((x) => x.documented)
        ? 'Tests documented'
        : 'Test documentation missing'
      : testPending
        ? 'Testing decision pending'
        : 'Testing not required',
    tab: 'incident',
  });
  const f = financials(s, c, o);
  out.push({
    key: 'costs',
    label: 'Costs',
    status: f.finalized ? 'Final' : f.actualCents > 0 ? 'Partly invoiced' : 'Estimates only',
    tone: f.finalized ? 'done' : 'neutral',
    detail: `${money(f.actualCents, { compact: true })} actual · ${money(f.projectedNetCents, { compact: true })} projected net`,
    tab: 'claims',
  });
  return out;
}

/* ------------------------------------------------------------------ evidence expectations */
export function expectedEvidence(s: SafetyRulesState, c: AccidentCase): { label: string; ok: boolean; why: string }[] {
  const has = (cat: string) => s.evidence.some((e) => e.caseId === c.id && e.category === cat && !e.removed);
  const wos = caseWOs(s, c);
  const items: { label: string; ok: boolean; why: string }[] = [];
  items.push({ label: 'Scene or damage photos', ok: has('Scene photo') || has('Damage photo'), why: 'Every case' });
  items.push({ label: 'Driver statement', ok: has('Driver statement') || c.investigation.statements.some((x) => x.kind === 'Driver'), why: 'Every case' });
  if (c.police.responded === 'yes') items.push({ label: 'Police report', ok: has('Police report'), why: 'Police responded — keep a copy (49 CFR 390.15)' });
  if (c.injuries.status !== 'no' || c.towAway === 'yes') items.push({ label: 'Dashcam / video', ok: has('Dashcam / video'), why: 'Injury or tow-away — preserve video' });
  if (wos.length) items.push({ label: 'Repair estimate', ok: has('Repair estimate') || wos.some((w) => w.estimates.length > 0), why: 'Repair work order linked' });
  if (c.equipment.truck.towCompany || c.equipment.trailer?.towCompany)
    items.push({ label: 'Towing invoice', ok: has('Invoice') || s.bills.some((b) => b.caseId === c.id && b.category === 'Towing'), why: 'Unit was towed' });
  if (c.witnesses.length)
    items.push({ label: 'Witness statement', ok: has('Witness statement'), why: `${plural(c.witnesses.length, 'witness', 'witnesses')} listed` });
  return items;
}

/* ------------------------------------------------------------------ repeat involvement (review signal, not a ranking) */
export function repeatSignals(s: SafetyRulesState, c: AccidentCase): { sameDriver: AccidentCase[]; sameTruck: AccidentCase[] } {
  const yearAgo = Date.parse(c.occurredAt) - 365 * DAY;
  const near = s.cases.filter(
    (x) => x.id !== c.id && x.stage !== 'draft' && Date.parse(x.occurredAt) >= yearAgo && Date.parse(x.occurredAt) <= Date.parse(c.occurredAt) + 365 * DAY,
  );
  const sameDriver = c.driverId ? near.filter((x) => x.driverId === c.driverId) : [];
  const sameTruck = c.truckId ? near.filter((x) => x.truckId === c.truckId) : [];
  return { sameDriver, sameTruck };
}

/* ------------------------------------------------------------------ needs attention */
export interface Attention {
  id: string;
  tone: 'urgent' | 'warning' | 'info';
  reason: string;
  title: string;
  caseId?: string;
  claimId?: string;
  dept?: string;
  assigneeId?: string;
  due?: string;
  tab?: string;
  woId?: string;
}

export function needsAttention(s: SafetyRulesState, opts: RuleOptions = {}): Attention[] {
  const set = resolveSettings(opts.settings);
  const nowMs = rulesNow(opts.now);
  const o: RuleOptions = { ...opts, now: nowMs };
  const out: Attention[] = [];
  for (const c of s.cases) {
    if (c.stage === 'draft') {
      if (nowMs - Date.parse(c.createdAt) > set.draftReminderHours * HOUR)
        out.push({ id: 'dr' + c.id, tone: 'warning', reason: 'Draft not submitted', title: `Report started ${fmtShortDateTime(c.createdAt, undefined, nowMs)} is still a draft`, caseId: c.id, assigneeId: c.createdBy });
      continue;
    }
    if (c.stage === 'closed') continue;
    for (const t of s.tasks.filter((t) => t.caseId === c.id && openTask(t))) {
      if (Date.parse(t.due) < nowMs)
        out.push({ id: 'ot' + t.id, tone: 'urgent', reason: 'Overdue task', title: t.title, caseId: c.id, dept: t.dept, assigneeId: t.assigneeId, due: t.due, tab: 'tasks' });
    }
    const tt = testing(c, o);
    for (const x of [tt.alcohol, tt.drug]) {
      if (x.windowOpen && (x.required === 'pending' || (x.required === 'yes' && !x.documented))) {
        const Sub = x.substance === 'alcohol' ? 'Alcohol' : 'Drug';
        out.push({
          id: 'te' + c.id + x.substance,
          tone: 'urgent',
          reason: x.required === 'yes' ? `${Sub} test not documented` : 'Testing decision needed',
          title: `${Sub} test window closes ${fmtTime(x.deadline, c.tz)} (${durationLabel(Date.parse(x.deadline) - nowMs)} left)`,
          caseId: c.id,
          dept: 'Safety',
          due: x.deadline,
          tab: 'incident',
        });
      }
    }
    if (c.investigation.status === 'not_started' && c.submittedAt && nowMs - Date.parse(c.submittedAt) > 2 * DAY)
      out.push({ id: 'in' + c.id, tone: 'warning', reason: 'Investigation not started', title: `Reported ${fmtShort(c.submittedAt, undefined, nowMs)} — no investigator assigned`, caseId: c.id, dept: 'Safety', tab: 'investigation' });
    if (c.investigation.status === 'in_review')
      out.push({ id: 'ir' + c.id, tone: 'warning', reason: 'Awaiting approval', title: 'Investigation submitted for management approval', caseId: c.id, dept: 'Management', tab: 'investigation' });
    if (c.police.responded === 'yes' && !s.evidence.some((e) => e.caseId === c.id && e.category === 'Police report' && !e.removed) && nowMs - Date.parse(c.occurredAt) > 3 * DAY)
      out.push({ id: 'pr' + c.id, tone: 'warning', reason: 'Missing document', title: `Police report not on file${c.police.dept ? ` (${c.police.dept})` : ''}`, caseId: c.id, dept: 'Safety', tab: 'evidence' });
    for (const w of caseWOs(s, c)) {
      if (w.status === 'Waiting for approval' || w.status === 'Awaiting estimate') {
        const short = w.estimates.length < w.estimatesRequired;
        out.push({
          id: 'wo' + w.id,
          tone: 'warning',
          reason: short ? 'Repair approval blocked' : 'Repair approval pending',
          title: short
            ? `${w.number}: ${w.estimates.length} of ${w.estimatesRequired} required estimates received`
            : `${w.number}: ${money(woEstimate(w)?.amountCents)} estimate awaiting Fleet approval`,
          caseId: c.id,
          dept: 'Fleet',
          tab: 'equipment',
        });
      }
    }
    for (const [label, eq] of [['Tractor', c.equipment.truck], ['Trailer', c.equipment.trailer]] as const) {
      if (eq && eq.status === 'towed_storage' && eq.storageSince && nowMs - Date.parse(eq.storageSince) > 2 * DAY)
        out.push({ id: 'sg' + c.id + label, tone: 'warning', reason: 'Storage fees accruing', title: `${label} in storage at ${eq.towedTo || 'tow yard'} since ${fmtShort(eq.storageSince, undefined, nowMs)}`, caseId: c.id, dept: 'Fleet', tab: 'equipment' });
      if (eq && eq.status === 'at_scene' && nowMs - Date.parse(c.occurredAt) > 4 * HOUR)
        out.push({ id: 'rc' + c.id + label, tone: 'urgent', reason: 'Recovery unresolved', title: `${label} still at the scene — no tow recorded`, caseId: c.id, dept: 'Fleet', tab: 'equipment' });
    }
    if (set.managementReviewSeverities.includes(c.severity) && !s.tasks.some((t) => t.caseId === c.id && /management review/i.test(t.title)))
      out.push({ id: 'mr' + c.id, tone: 'warning', reason: 'Serious incident', title: 'No management review task yet', caseId: c.id, dept: 'Management', tab: 'tasks' });
  }
  // Overdue tasks on open claims that are not already covered by an open case (standalone claims, or claims
  // that continue after their accident was closed).
  for (const t of s.tasks) {
    if (!t.claimId || !openTask(t) || Date.parse(t.due) >= nowMs) continue;
    const kc = t.caseId ? byId(s.cases, t.caseId) : undefined;
    if (kc && isOpenCase(kc)) continue;
    const k = byId(s.claims, t.claimId);
    if (!k || !OPEN_CLAIM(k.status)) continue;
    out.push({ id: 'ot' + t.id, tone: 'urgent', reason: 'Overdue task', title: `${k.number}: ${t.title}`, claimId: k.id, caseId: k.caseId, dept: t.dept, assigneeId: t.assigneeId, due: t.due });
  }
  for (const w of s.workOrders) {
    if (w.type === 'Accident repair' && !w.caseId) {
      const unit = w.unitKind === 'truck' ? `Truck ${byId(s.trucks, w.unitId)?.unit}` : `Trailer ${byId(s.trailers, w.unitId)?.unit}`;
      out.push({ id: 'ow' + w.id, tone: 'warning', reason: 'Accident repair with no case', title: `${w.number}: ${unit} repaired at ${w.shop} — no accident reported to Safety`, dept: 'Safety', woId: w.id });
    }
  }
  for (const k of s.claims) {
    if (!OPEN_CLAIM(k.status) || k.status === 'Draft') continue;
    if (k.nextFollowUp && Date.parse(k.nextFollowUp.at) < nowMs)
      out.push({ id: 'fu' + k.id, tone: 'urgent', reason: 'Follow-up overdue', title: `${k.number}: ${k.nextFollowUp.what}`, claimId: k.id, caseId: k.caseId, dept: 'Claims', assigneeId: k.nextFollowUp.assigneeId, due: k.nextFollowUp.at });
    else if (nowMs - Date.parse(k.lastUpdateAt) >= set.claimNoUpdateDays * DAY)
      out.push({ id: 'nu' + k.id, tone: 'warning', reason: `No update ≥ ${set.claimNoUpdateDays} days`, title: `${k.number} (${CLAIM_TYPE_LABEL[k.type]}) — last update ${fmtShort(k.lastUpdateAt, undefined, nowMs)}`, claimId: k.id, caseId: k.caseId, dept: 'Claims', assigneeId: k.ownerId });
  }
  const rank = { urgent: 0, warning: 1, info: 2 } as const;
  return out.sort(
    (a, b) => rank[a.tone] - rank[b.tone] || (a.due ? Date.parse(a.due) : Infinity) - (b.due ? Date.parse(b.due) : Infinity),
  );
}

/* ------------------------------------------------------------------ narrative summary */
export interface SummaryPart {
  text: string;
  prov: 'verified' | 'driver' | 'preliminary' | 'unresolved' | 'system';
  restricted?: boolean;
}

export const TYPE_PHRASE: Record<string, string> = {
  'Rear-end — we struck the vehicle ahead': 'struck the rear of the vehicle ahead',
  'Rear-end — struck by another vehicle': 'was struck from behind by another vehicle',
  'Sideswipe / lane change': 'was involved in a sideswipe collision during a lane change',
  'Intersection / turning': 'was involved in an intersection collision',
  Backing: 'was involved in a backing incident',
  'Parking / struck fixed object': 'struck a fixed object while parking',
  'Struck while parked or stopped': 'was struck while parked',
  'Struck fixed object on roadway': 'struck a fixed object',
  'Run off road / rollover': 'ran off the road',
  'Jackknife / loss of control': 'lost control and jackknifed',
  'Animal strike': 'struck an animal',
  'Road debris / tire debris': 'struck road debris',
  'Cargo shift (no collision)': 'had a cargo shift',
  Other: 'was involved in an incident',
};

export function factsHash(c: AccidentCase): string {
  return [
    c.occurredAt,
    c.type,
    c.injuries.status,
    c.injuries.treatedAway,
    c.towAway,
    c.equipment.truck.status,
    c.equipment.trailer?.status,
    c.cargo.status,
    c.investigation.status,
    c.determinations.fault.value,
    c.determinations.preventability.value,
    c.stage,
  ].join('|');
}

export function summary(s: SafetyRulesState, c: AccidentCase, canSeeRestricted: boolean, opts: RuleOptions = {}): SummaryPart[] {
  const nowMs = rulesNow(opts.now);
  const o: RuleOptions = { ...opts, now: nowMs };
  const p: SummaryPart[] = [];
  const tr = truckOf(s, c), tl = trailerOf(s, c), dr = driverOf(s, c), ld = loadOf(s, c);
  const where = [c.location.road, c.location.detail].filter(Boolean).join(' ');
  const place = `${where ? where + ' near ' : ''}${c.location.city}, ${c.location.state}`;
  const who = [dr ? `driver ${dr.name}` : 'driver not recorded', tl ? `trailer ${tl.unit}` : null, ld ? `load ${ld.number}` : null].filter(Boolean).join(', ');
  const prov1: SummaryPart['prov'] =
    c.timeProvenance === 'verified' && c.locationProvenance === 'verified'
      ? 'verified'
      : c.timeProvenance === 'driver' || c.locationProvenance === 'driver'
        ? 'driver'
        : 'preliminary';
  p.push({
    text: `On ${fmtDate(c.occurredAt, c.tz)} at ${fmtTime(c.occurredAt, c.tz)}, Truck ${tr?.unit ?? '(unit not recorded)'} (${who}) ${TYPE_PHRASE[c.type] || 'was involved in an incident'} on ${place}.`,
    prov: prov1,
  });
  const eqDesc = (label: string, eq?: AccidentCase['equipment']['truck']) =>
    !eq || eq.status === 'not_involved' ? null : eq.damage ? `the ${label} ${eq.damage}` : `damage to the ${label} has not been described yet`;
  const d1 = eqDesc('tractor', c.equipment.truck),
    d2 = c.equipment.trailer && c.equipment.trailer.damage ? eqDesc('trailer', c.equipment.trailer) : null;
  if (d1 || d2) {
    const t = [d1, d2].filter(Boolean).join('; ');
    p.push({ text: t.charAt(0).toUpperCase() + t.slice(1) + '.', prov: c.equipment.truck.damage ? 'preliminary' : 'unresolved' });
  }
  const inj = c.injuries;
  if (inj.status === 'no') p.push({ text: 'No injuries were reported.', prov: inj.provenance });
  else if (inj.status === 'yes') {
    const n = inj.treatedAway, f = inj.fatalities;
    const bits: string[] = [];
    if ((f ?? 0) > 0) bits.push(plural(f as number, 'fatality', 'fatalities'));
    bits.push(
      n === null || n === undefined
        ? 'injuries reported (whether anyone was treated away from the scene is not confirmed yet)'
        : n > 0
          ? `${plural(n, 'person', 'people')} treated away from the scene`
          : 'injuries reported; nobody was treated away from the scene',
    );
    if (f === null || f === undefined) bits.push('fatalities not confirmed yet');
    const unresolved = n === null || n === undefined || f === null || f === undefined;
    p.push({
      text: `${bits.join('; ')}${inj.ourDriver === 'no' ? '; our driver was not injured' : inj.ourDriver === 'yes' ? '; our driver was injured' : ''}.`.replace(/^./, (m) => m.toUpperCase()),
      prov: unresolved ? 'unresolved' : inj.provenance,
    });
    if (inj.detailsRestricted)
      p.push({ text: canSeeRestricted ? `Medical detail: ${inj.detailsRestricted}` : 'Medical details are restricted.', prov: 'system', restricted: true });
  } else p.push({ text: inj.status === 'unknown' ? 'Injury status is still unknown.' : 'Injury status has not been reported yet.', prov: 'unresolved' });
  if (c.citation.status === 'yes') {
    const tt = testing(c, o);
    const req = [tt.alcohol, tt.drug].filter((x) => x.required === 'yes');
    p.push({
      text: `Our driver was cited${c.citation.note ? ` (${c.citation.note.toLowerCase()})` : ''}${req.length ? `; post-accident tests were ${req.every((x) => x.documented) ? 'completed and documented' : 'required but are not documented yet'}` : ''}.`,
      prov: 'verified',
    });
  }
  const dt = downtimeFor(s, c, o);
  const eqSentence = (label: string, eq: AccidentCase['equipment']['truck'] | undefined, ms: number) => {
    if (!eq || eq.status === 'not_involved') return null;
    const tow = eq.towCompany
      ? `was towed by ${eq.towCompany}${eq.towedTo ? ` to ${eq.towedTo}` : ''}`
      : eq.condition === 'drivable'
        ? 'remained drivable'
        : eq.condition === 'not_drivable'
          ? 'could not be driven'
          : null;
    let st = '';
    if (eq.status === 'returned') st = `returned to service ${fmtShort(eq.rtsAt, undefined, nowMs)}${ms > 0 ? ` after ${downtimeLabel(ms)} out of service` : ''}`;
    else if (eq.status === 'operational') st = ms > 0 ? `is back in operation (${downtimeLabel(ms)} out of service)` : 'stayed in service';
    else if (eq.status === 'total_loss') st = 'was declared a total loss';
    else if (eq.status === 'unknown') st = ms > 0 ? `is out of service (${downtimeLabel(ms)} so far); its status is not confirmed` : 'status is not confirmed yet';
    else st = `remains out of service (${downtimeLabel(ms)} so far)`;
    return `The ${label} ${tow ? tow + ' and ' : ''}${st}`;
  };
  const e1 = eqSentence('tractor', c.equipment.truck, dt.truckMs);
  const e2 =
    c.equipment.trailer && !['operational', 'unknown'].includes(c.equipment.trailer.status)
      ? eqSentence('trailer', c.equipment.trailer, dt.trailerMs)
      : null;
  if (e1)
    p.push({
      text: e1 + (e2 ? '; ' + e2.charAt(0).toLowerCase() + e2.slice(1) : '') + '.',
      prov: c.equipment.truck.status === 'unknown' ? 'unresolved' : 'verified',
    });
  const cg = c.cargo;
  if (cg.status !== 'na') {
    const plan = cg.plan ? CARGO_PLAN_LABEL[cg.plan].toLowerCase() : '';
    const t =
      cg.status === 'unknown'
        ? `Cargo condition on ${ld ? 'load ' + ld.number : 'the load'} is not confirmed yet.`
        : cg.status === 'no_damage'
          ? `Cargo${ld ? ' on load ' + ld.number : ''} was not damaged${cg.deliveryImpact ? `; ${cg.deliveryImpact}` : plan ? `; ${plan}` : ''}.`
          : `Cargo${ld ? ' on load ' + ld.number : ''} was ${cg.status === 'loss' ? 'lost' : 'damaged'}${cg.notes ? ` (${cg.notes})` : ''}${cg.deliveryImpact ? `; ${cg.deliveryImpact}` : ''}.`;
    p.push({ text: t, prov: cg.status === 'unknown' ? 'unresolved' : 'verified' });
  }
  const ks = caseClaims(s, c);
  if (ks.length) {
    const open = ks.filter((k) => OPEN_CLAIM(k.status));
    p.push({
      text: `${plural(ks.length, 'claim')} ${ks.length === 1 ? 'is' : 'are'} linked: ${ks.map((k) => `${CLAIM_TYPE_LABEL[k.type].toLowerCase()} (${k.status.toLowerCase()})`).join(', ')}${open.length && c.stage === 'closed' ? ' — the accident is closed while these claims continue' : ''}.`,
      prov: 'system',
    });
  } else
    p.push({
      text: c.claimDecision
        ? `No insurance claim was filed: ${c.claimDecision.text.charAt(0).toLowerCase() + c.claimDecision.text.slice(1)}.`
        : 'No insurance claim has been opened yet.',
      prov: c.claimDecision ? 'verified' : 'unresolved',
    });
  const det = c.determinations;
  if (c.investigation.status === 'complete')
    p.push({
      text: `Investigation complete (${fmtShort(c.investigation.completedAt, undefined, nowMs)}): ${FAULT_LABEL[det.fault.value].toLowerCase()}, ${PREVENT_LABEL[det.preventability.value].toLowerCase()}.`,
      prov: 'verified',
    });
  else
    p.push({
      text: `Investigation ${c.investigation.status === 'not_started' ? 'has not started' : c.investigation.status === 'in_review' ? 'is awaiting management approval' : 'is in progress'}; fault and preventability are ${det.fault.value === 'not_determined' && det.preventability.value === 'not_determined' ? 'not yet determined' : `preliminarily ${FAULT_LABEL[det.fault.value].toLowerCase()} / ${PREVENT_LABEL[det.preventability.value].toLowerCase()}`}.`,
      prov: 'unresolved',
    });
  if (c.stage === 'closed' && c.closure) {
    p.push({ text: `Case closed ${fmtShort(c.closure.at, undefined, nowMs)} by ${personName(s, c.closure.by)}${c.closure.override ? ' with an authorized override' : ''}.`, prov: 'verified' });
  } else {
    const na = nextAction(s, c);
    if (na) p.push({ text: `Next: ${na.title} — ${na.dept}, ${personName(s, na.assigneeId)}, due ${fmtShort(na.due, c.tz, nowMs)}.`, prov: 'system' });
  }
  return p;
}

/* ------------------------------------------------------------------ permissions (prototype role defaults, SPEC §8.3) */
// The server maps its own RBAC onto these capabilities; this table is the prototype's default matrix.
export const ROLE_LABEL: Record<string, string> = {
  safety_manager: 'Safety Manager',
  safety_specialist: 'Safety Specialist',
  claims: 'Claims Specialist',
  fleet: 'Fleet Manager',
  dispatch: 'Dispatch Lead',
  accounting: 'Accounting',
  ops_manager: 'Operations Manager',
  owner: 'Owner',
};
export type RulesPermission = 'restricted' | 'legal' | 'approve' | 'override' | 'discipline' | 'claimMoney' | 'fleet';
export function can(p: Person | undefined, perm: RulesPermission): boolean {
  const r = p?.role;
  switch (perm) {
    case 'restricted':
      return r === 'safety_manager' || r === 'owner' || r === 'claims';
    case 'legal':
      return r === 'safety_manager' || r === 'owner' || r === 'claims';
    case 'approve':
      // Go-live (IMPLEMENTATION-PLAN §17): Safety Manager and owner; not the Operations Manager.
      return r === 'safety_manager' || r === 'owner';
    case 'override':
      return r === 'safety_manager' || r === 'owner';
    case 'discipline':
      return r === 'safety_manager' || r === 'owner';
    case 'claimMoney':
      return r === 'claims' || r === 'safety_manager' || r === 'owner' || r === 'accounting';
    case 'fleet':
      return r === 'fleet' || r === 'safety_manager' || r === 'owner' || r === 'ops_manager';
  }
  return false;
}

export function triTone(t: Tri, positiveIsBad = true): Tone {
  if (t === 'yes') return positiveIsBad ? 'urgent' : 'done';
  if (t === 'no') return positiveIsBad ? 'done' : 'urgent';
  if (t === 'na') return 'neutral';
  return 'warning';
}
