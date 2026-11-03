// The five showcase cases (ACCEPTANCE §1) against the fixture JSON at the fixture clock:
// DOT, testing, severity, blockers (E), tracks, next action, expected evidence, money + ledger (H1–H5),
// summary parts (N), repeat signals; claim money (G-M); restricted claims for a viewer without
// `safety.restricted` (H5-R, SPEC §7.13 rule 7). Money: prototype dollars × 100 = cents.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  advanceBlockers,
  caseClaims,
  claimMoney,
  closeBlockers,
  dotRecordable,
  downtimeFor,
  downtimeLabel,
  expectedEvidence,
  financials,
  nextAction,
  personName,
  repeatSignals,
  suggestedSeverity,
  summary,
  testing,
  tracks,
} from './rules.js';
import { DAY, resetRulesClock, setRulesClock } from './time.js';
import { EXPECTED, FIXTURE_CLOCK } from './test-fixtures/helpers.js';
import { seedState } from './test-fixtures/seed.js';
import type { AccidentCase, SafetyRulesState } from './types.js';

const plain = <T>(x: T): T => JSON.parse(JSON.stringify(x)) as T;
const c100 = (n: number | null | undefined) => (n === null || n === undefined ? n : Math.round(n * 100));

let s: SafetyRulesState;
beforeAll(() => {
  setRulesClock(() => FIXTURE_CLOCK);
  s = seedState();
});
afterAll(() => resetRulesClock());

const caseByNumber = (n: string): AccidentCase => {
  const c = s.cases.find((x) => x.number === n);
  if (!c) throw new Error(`fixture case ${n} missing`);
  return c;
};

const SHOWCASE: [string, string][] = [
  ['ACC-2026-008', 'H1 · showcase 5 fully resolved'],
  ['ACC-2026-015', 'H2 · showcase 3 cargo + 3 claims'],
  ['ACC-2026-016', 'H3 · showcase 2 serious collision'],
  ['ACC-2026-017', 'H4 · showcase 1 minor accident'],
  ['ACC-2026-018', 'H5 · showcase 4 third-party injury, restricted'],
];

describe.each(SHOWCASE)('%s (%s)', (number) => {
  const exp = () => EXPECTED.cases[number];
  const c = () => caseByNumber(number);

  it('stage, DOT recordable, suggested severity', () => {
    expect(c().stage).toBe(exp().stage);
    expect(c().severity).toBe(exp().severity);
    expect(dotRecordable(c())).toEqual(exp().dot);
    expect(suggestedSeverity(c())).toEqual(exp().suggested);
  });

  it('C post-accident testing (required / reason / documented / deadline)', () => {
    const t = testing(c());
    for (const sub of ['alcohol', 'drug'] as const)
      expect({ required: t[sub].required, reason: t[sub].reason, documented: t[sub].documented, deadline: t[sub].deadline }).toEqual(exp().testing[sub]);
  });

  it('E stage blockers (advance and close)', () => {
    expect(advanceBlockers(s, c()).map((b) => b.text)).toEqual(exp().advanceBlockers);
    expect(closeBlockers(s, c()).map((b) => b.text)).toEqual(exp().closeBlockers);
  });

  it('status by track, next action, expected evidence, repeat signals, linked claims', () => {
    expect(plain(tracks(s, c(), { canSeeRestricted: true }).map((x) => ({ label: x.label, status: x.status, tone: x.tone, detail: x.detail })))).toEqual(exp().tracks);
    const na = nextAction(s, c());
    expect(na ? { title: na.title, dept: na.dept, assignee: personName(s, na.assigneeId), due: na.due } : null).toEqual(exp().nextAction);
    expect(expectedEvidence(s, c()).map((e) => ({ label: e.label, ok: e.ok }))).toEqual(exp().expectedEvidence);
    const rs = repeatSignals(s, c());
    expect({ sameDriver: rs.sameDriver.map((x) => x.number), sameTruck: rs.sameTruck.map((x) => x.number) }).toEqual(exp().repeatSignals);
    expect(caseClaims(s, c()).map((k) => k.number)).toEqual(exp().claims);
  });

  it('downtime', () => {
    const d = downtimeFor(s, c());
    expect({
      truckDays: +(d.truckMs / DAY).toFixed(2),
      trailerDays: +(d.trailerMs / DAY).toFixed(2),
      truckOngoing: d.ongoing,
      truckLabel: downtimeLabel(d.truckMs),
      trailerLabel: downtimeLabel(d.trailerMs),
    }).toEqual(exp().downtime);
  });

  it('H money in cents and every ledger line (authorized viewer)', () => {
    const f = financials(s, c(), { canSeeRestricted: true });
    const m = exp().money;
    expect({
      actual: f.actualCents, recovered: f.recoveredCents, netToDate: f.netToDateCents, estimate: f.estimateCents,
      expected: f.expectedCents, projectedNet: f.projectedNetCents, exposure: f.exposureCents, finalized: f.finalized,
    }).toEqual({
      actual: c100(m.actual), recovered: c100(m.recovered), netToDate: c100(m.netToDate), estimate: c100(m.estimate),
      expected: c100(m.expected), projectedNet: c100(m.projectedNet), exposure: c100(m.exposure), finalized: m.finalized,
    });
    // Lost revenue: days compare at 2 decimals; the amount is whole dollars, then cents (ACCEPTANCE §0)
    expect(f.lostRevenue.days.toFixed(2)).toBe(m.lostRevenue.days.toFixed(2));
    expect(f.lostRevenue.perDayCents).toBe(c100(m.lostRevenue.perDay));
    expect(f.lostRevenue.amountCents).toBe(c100(m.lostRevenue.amount));
    expect(f.lostRevenue.amountCents % 100).toBe(0);
    expect(f.restrictedClaimsExcluded).toBe(0);
    expect(f.lines.map((l) => ({ group: l.group, category: l.category, amount: l.amountCents, label: l.label, source: l.source }))).toEqual(
      exp().ledger.map((l: { amount: number }) => ({ ...l, amount: c100(l.amount) })),
    );
  });

  it('N summary parts for an authorized viewer, restricted sentence for others', () => {
    expect(summary(s, c(), true).map((p) => ({ prov: p.prov, restricted: !!p.restricted, text: p.text }))).toEqual(exp().summaryForAuthorized);
    expect(summary(s, c(), false).filter((p) => p.restricted).map((p) => p.text)).toEqual(exp().summaryRestrictedSentenceForOthers);
  });
});

describe('ACCEPTANCE spot checks (exact texts)', () => {
  it('E3 ACC-2026-016 blocker to Resolution', () => {
    expect(advanceBlockers(s, caseByNumber('ACC-2026-016')).map((b) => b.text)).toEqual(['Investigation is not complete and approved']);
  });
  it('E4 ACC-2026-017 close blockers exactly', () => {
    expect(closeBlockers(s, caseByNumber('ACC-2026-017')).map((b) => b.text)).toEqual(['1 corrective action still open', '1 task still open']);
  });
  it('E5 ACC-2026-016 close blockers', () => {
    expect(closeBlockers(s, caseByNumber('ACC-2026-016')).map((b) => b.text)).toEqual([
      'Investigation is not complete and approved', 'Driver fault is not determined', 'Preventability is not determined',
      'Tractor has not returned to service', '5 tasks still open', '1 work order not completed/invoiced',
    ]);
  });
  it('E6 ACC-2026-018 close blockers', () => {
    expect(closeBlockers(s, caseByNumber('ACC-2026-018')).map((b) => b.text)).toEqual([
      'Investigation is not complete and approved', 'Driver fault is not determined', 'Preventability is not determined',
      '6 tasks still open', '1 work order not completed/invoiced', 'Police report is not on file',
    ]);
  });
  it('E9 ACC-2026-015 is closed with 2 open claims; claims never block closing', () => {
    const c = caseByNumber('ACC-2026-015');
    expect(c.stage).toBe('closed');
    expect(caseClaims(s, c).filter((k) => !['Settled', 'Denied', 'Closed'].includes(k.status))).toHaveLength(2);
    expect(closeBlockers(s, c)).toEqual([]);
  });
  it('H4 no-claim decision text prints dollars exactly', () => {
    expect(summary(s, caseByNumber('ACC-2026-017'), true).map((p) => p.text)).toContain(
      'No insurance claim was filed: repair ($1,840) is below the $5,000 physical damage deductible — company paid.',
    );
  });
  it('N ACC-2026-016 first, investigation and next-action sentences', () => {
    const parts = summary(s, caseByNumber('ACC-2026-016'), true);
    expect(parts[0]).toEqual({ prov: 'verified', text: 'On Oct 2, 2026 at 3:45 PM CDT, Truck 118 (driver Andre Lewis, trailer T-5310, load L-47982) struck the rear of the vehicle ahead on I-80 EB near MM 127 (Houbolt Rd) near Channahon, IL.' });
    expect(parts).toContainEqual({ prov: 'unresolved', text: 'Investigation is in progress; fault and preventability are not yet determined.' });
    expect(parts[parts.length - 1]).toEqual({ prov: 'system', text: 'Next: Request ECM / engine data download from Prairie State — Fleet, Dmitri Volkov, due Oct 16.' });
  });
  it('N ACC-2026-015 ends with the claims and the closure', () => {
    const t = summary(s, caseByNumber('ACC-2026-015'), true).map((p) => p.text);
    expect(t.slice(-3, -2)).toEqual(['3 claims are linked: physical damage (settled), cargo (negotiating), auto liability (awaiting documents) — the accident is closed while these claims continue.']);
    expect(t[t.length - 1]).toBe('Case closed Oct 12 by Rachel Moore.');
  });
  it('N/K6 ACC-2026-018 for a viewer without safety.restricted: medical sentence replaced, no seeded medical text', () => {
    const parts = summary(s, caseByNumber('ACC-2026-018'), false);
    expect(parts.filter((p) => p.restricted).map((p) => p.text)).toEqual(['Medical details are restricted.']);
    expect(JSON.stringify(parts)).not.toContain('neck pain');
  });
});

describe('G-M claim money (cents)', () => {
  const ids = Object.keys(EXPECTED.claims);
  it.each(ids)('G5 %s', (number) => {
    const k = s.claims.find((x) => x.number === number);
    expect(k).toBeDefined();
    const e = EXPECTED.claims[number];
    const m = claimMoney(k!);
    expect({ type: k!.type, status: k!.status, claimed: k!.claimedCents ?? null, reserve: k!.reserveCents ?? null, deductible: k!.deductibleCents ?? null, settlement: k!.settlementCents ?? null }).toEqual({
      type: e.type, status: e.status, claimed: c100(e.claimed), reserve: c100(e.reserve), deductible: c100(e.deductible), settlement: c100(e.settlement),
    });
    expect(m).toEqual({
      toUsCents: c100(e.toUs), insurerPaidCents: c100(e.insurerPaid), byUsCents: c100(e.byUs), expectedRecoveryCents: c100(e.expectedRecovery),
      companyEstimateCents: c100(e.companyEstimate), insurerReserveCents: c100(e.insurerReserve), open: e.open,
    });
  });
});

describe('H5-R restricted claims for a viewer without safety.restricted (SPEC §7.13 rule 7)', () => {
  it('H5-R ACC-2026-018 as Dispatch: CLM-2026-0044 removed from lines and totals', () => {
    const f = financials(s, caseByNumber('ACC-2026-018'), { canSeeRestricted: false });
    expect(f.lines.some((l) => l.source.includes('CLM-2026-0044'))).toBe(false);
    expect(f.lines.map((l) => ({ group: l.group, category: l.category, amount: l.amountCents, source: l.source }))).toEqual([
      { group: 'estimate', category: 'Tractor repair', amount: 3_900_00, source: 'Work order RO-2026-9152' },
    ]);
    expect({ estimate: f.estimateCents, projected: f.projectedNetCents, exposure: f.exposureCents, actual: f.actualCents }).toEqual({
      estimate: 3_900_00, projected: 3_900_00, exposure: 0, actual: 0,
    });
    expect(f.restrictedClaimsExcluded).toBe(1); // "Excludes 1 restricted claim"
  });
  it('H5-R the same case for an authorized viewer still counts the claim (H5)', () => {
    const f = financials(s, caseByNumber('ACC-2026-018'), { canSeeRestricted: true });
    expect({ estimate: f.estimateCents, projected: f.projectedNetCents, exposure: f.exposureCents }).toEqual({ estimate: 6_400_00, projected: 6_400_00, exposure: 82_500_00 });
  });
  it('H5-R Costs track for Dispatch shows the redacted totals', () => {
    const costs = tracks(s, caseByNumber('ACC-2026-018'), { canSeeRestricted: false }).find((t) => t.key === 'costs');
    expect(costs?.detail).toBe('$0 actual · $3.9K projected net');
  });
});
