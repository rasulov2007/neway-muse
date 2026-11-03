// ACCEPTANCE A4, A15–A17 at rule level: the quick report's live check and its "Do now" prompts (SPEC §1.3, §7.10).
// The API e2e (apps/api/test/accidents-v2.e2e.spec.ts) checks the same through POST /report-preview and submit.
import { describe, expect, it } from 'vitest';
import { promptPriority, reportLiveCheck, reportPrompts, standardTasks, type ReportFacts } from './report.js';
import { FIXTURE_CLOCK, HOUR_MS, isoAt } from './test-fixtures/helpers.js';

const now = FIXTURE_CLOCK;
const a4: ReportFacts = {
  occurredAt: isoAt(now - 23 * 60_000),
  tz: 'America/Indiana/Indianapolis',
  publicRoad: 'yes',
  city: 'Lafayette',
  state: 'IN',
  injuries: 'no',
  towAway: 'yes',
  truckCondition: 'not_drivable',
  cargo: 'unknown',
  police: 'yes',
  citation: null,
  hazmat: 'no',
  loadId: 'lL-48213',
  loadParty: 'Lakeshore Freight Brokerage',
};

describe('ACCEPTANCE A4 — live check and prompts', () => {
  it('A4 DOT yes, tests pending on the citation, severity serious', () => {
    const live = reportLiveCheck(a4, { now });
    expect(live.dotRecordable.value).toBe('yes');
    expect(live.dotRecordable.reasons).toEqual(['A vehicle was towed away with disabling damage']);
    expect(live.testing.alcohol.required).toBe('pending');
    expect(live.testing.alcohol.reason).toBe('Required only if our driver is cited within 8 hours — confirm citation status');
    expect(live.testing.drug.required).toBe('pending');
    expect(live.testing.drug.reason).toBe('Required only if our driver is cited within 32 hours — confirm citation status');
    expect(live.suggestedSeverity).toEqual({ value: 'serious', why: 'Disabling damage — tow-away' });
  });

  it('A4 seven prompts, in order, with departments and due times', () => {
    const p = reportPrompts(a4, { now });
    expect(p.map((x) => [x.key, x.dept])).toEqual([
      ['test', 'Safety'],
      ['tow', 'Fleet'],
      ['load', 'Dispatch'],
      ['video', 'Safety'],
      ['statement', 'Safety'],
      ['police', 'Safety'],
      ['insurer', 'Claims'],
    ]);
    // Testing decision is due at the 2-hour alcohol mark (occurred 23 min ago → 1 h 37 min from now).
    expect(p[0]!.dueInHours * HOUR_MS).toBe(97 * 60_000);
    expect(p[0]!.label).toBe('Post-accident testing decision — alcohol by 8:37 PM EDT, drug by Oct 20 8:37 PM EDT');
    expect(p[2]!.label).toBe('Notify Lakeshore Freight Brokerage and plan the load (repower / transload)');
    expect(p.map((x) => x.dueInHours).slice(1)).toEqual([2, 2, 4, 24, 24, 24]);
    expect(p.map((x) => promptPriority(x.dueInHours))).toEqual(['high', 'high', 'high', 'high', 'normal', 'normal', 'normal']);
  });

  it('A5 standard tasks: confirm the facts (+24 h) and a management review (+72 h) for serious', () => {
    expect(standardTasks('serious').map((t) => [t.title, t.dept, t.dueInHours])).toEqual([
      ['Confirm the facts and assign an investigator', 'Safety', 24],
      ['Management review of serious incident', 'Management', 72],
    ]);
    expect(standardTasks('minor')).toHaveLength(1);
  });

  it('hazmat No prefilled from the load stays a suggestion: no hazmat prompt; Yes adds the 171.15 prompt', () => {
    expect(reportPrompts({ ...a4, hazmat: 'yes' }, { now }).map((x) => x.key)).toContain('hazmat');
  });
});

describe('ACCEPTANCE A15–A17 — unknown is not No', () => {
  const a15: ReportFacts = { ...a4, injuries: 'yes', treatedAway: 2, fatalities: null, towAway: 'no', citation: 'no', truckCondition: 'drivable', cargo: 'no_damage' };
  it('A15 fatalities blank → testing pending "Waiting on fatalities", DOT yes (2 treated away)', () => {
    const live = reportLiveCheck(a15, { now });
    expect(live.testing.alcohol.required).toBe('pending');
    expect(live.testing.alcohol.reason).toBe('Waiting on fatalities — required if anyone died');
    expect(live.dotRecordable.value).toBe('yes');
    expect(live.dotRecordable.reasons).toEqual(['2 people treated away from the scene']);
  });
  it('A16 fatalities 0 → not required; 1 → required and critical', () => {
    const zero = reportLiveCheck({ ...a15, fatalities: 0 }, { now });
    expect(zero.testing.alcohol.required).toBe('no');
    expect(zero.testing.alcohol.reason).toBe('Injury treated away, but our driver was not cited');
    const one = reportLiveCheck({ ...a15, fatalities: 1 }, { now });
    expect(one.testing.alcohol.required).toBe('yes');
    expect(one.testing.alcohol.reason).toBe('Fatality — test required whether or not a citation is issued');
    expect(one.suggestedSeverity.value).toBe('critical');
  });
  it('A17 not on a road open to public travel → DOT no, testing not required', () => {
    const live = reportLiveCheck({ ...a15, fatalities: 1, publicRoad: 'no' }, { now });
    expect(live.dotRecordable).toMatchObject({ value: 'no', reasons: ['Not on a road open to public travel'] });
    expect(live.testing.alcohol.required).toBe('no');
    expect(live.testing.alcohol.reason).toBe('Not on a road open to public travel — 382.303 does not apply (company policy may still call for a test)');
  });
});

describe('prompt edge cases', () => {
  it('injuries not reported → EMS prompt; nothing answered still asks for the statement', () => {
    const p = reportPrompts({ tz: 'America/Chicago', occurredAt: isoAt(now - HOUR_MS) }, { now });
    expect(p[0]!.key).toBe('ems');
    expect(p.map((x) => x.key)).toContain('statement');
  });
});
