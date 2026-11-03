// ACCEPTANCE B (DOT recordability), C (post-accident testing) and D (suggested severity) — rule level, P0.
// Inputs mirror docs/accidents/prototype/tools/dump-fixtures.ts; expected values are the ACCEPTANCE strings
// (checked inline) and the fixture JSON (checked field by field).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dotRecordable, suggestedSeverity, testing } from './rules.js';
import { resetRulesClock, setRulesClock } from './time.js';
import { EXPECTED, FIXTURE_CLOCK, HOUR_MS, cite, isoAt, truthCase } from './test-fixtures/helpers.js';
import type { AccidentCase } from './types.js';

beforeAll(() => setRulesClock(() => FIXTURE_CLOCK));
afterAll(() => resetRulesClock());

type Row = [id: string, input: string, build: () => AccidentCase];

/* ------------------------------------------------------------------ B */
const DOT: (Row | [string, string, () => AccidentCase, 'yes' | 'no' | 'pending', string[]])[] = [
  ['B1', 'Only loading/unloading (excluded), tow yes', () => truthCase((c) => { c.excludedOccurrence = 'loading_unloading'; c.towAway = 'yes'; }), 'no', ['Only loading or unloading cargo — excluded by definition']],
  ['B2', 'Fatalities 1, public road yes', () => truthCase((c) => { c.injuries = { ...c.injuries, status: 'yes', fatalities: 1 }; }), 'yes', ['1 fatality']],
  ['B3', 'Injuries yes, treated away 2, public road yes', () => truthCase((c) => { c.injuries = { ...c.injuries, status: 'yes', treatedAway: 2 }; }), 'yes', ['2 people treated away from the scene']],
  ['B4', 'Tow-away yes, public road yes', () => truthCase((c) => { c.towAway = 'yes'; }), 'yes', ['A vehicle was towed away with disabling damage']],
  ['B5', 'Tow-away yes, public road no', () => truthCase((c) => { c.towAway = 'yes'; c.location.publicRoad = 'no'; }), 'no', ['Not on a road open to public travel']],
  ['B6', 'Tow-away yes, public road unknown', () => truthCase((c) => { c.towAway = 'yes'; c.location.publicRoad = 'unknown'; }), 'pending', ['Confirm it happened on a road open to public travel']],
  ['B7', 'Injuries no, tow no, public road yes', () => truthCase(), 'no', ['No fatality, no injury treated away from the scene, no disabling-damage tow-away']],
  ['B8', 'Injuries not reported, tow no', () => truthCase((c) => { c.injuries = { ...c.injuries, status: null, treatedAway: null, fatalities: null }; }), 'pending', ['Injury status', 'Fatalities']],
  ['B9', 'Injuries yes, treated away not known, fatalities 0, tow no', () => truthCase((c) => { c.injuries = { ...c.injuries, status: 'yes', treatedAway: null, fatalities: 0 }; }), 'pending', ['Whether anyone was treated away from the scene']],
  ['B10', 'Injuries no, tow unknown', () => truthCase((c) => { c.towAway = 'unknown'; }), 'pending', ['Whether any vehicle was towed with disabling damage']],
  ['B11', 'Injuries no, tow no, public road no', () => truthCase((c) => { c.location.publicRoad = 'no'; }), 'no', ['Not on a road open to public travel']],
  ['B12', 'Injuries yes, treated away 0, fatalities 0, tow no', () => truthCase((c) => { c.injuries = { ...c.injuries, status: 'yes', treatedAway: 0, fatalities: 0 }; }), 'no', ['No fatality, no injury treated away from the scene, no disabling-damage tow-away']],
];

describe('ACCEPTANCE B — DOT recordability (49 CFR 390.5T)', () => {
  DOT.forEach((row, i) => {
    const [id, input, build, value, words] = row as [string, string, () => AccidentCase, string, string[]];
    it(`${id} ${input} → ${value}`, () => {
      const got = dotRecordable(build());
      const exp = EXPECTED.truthTables.dot[i];
      expect(exp.input).toBe(input);
      expect(got).toEqual({ value: exp.value, reasons: exp.reasons, missing: exp.missing });
      expect(got.value).toBe(value);
      // ACCEPTANCE column "Reasons / Needs": the needs when pending, else the reasons
      expect(got.value === 'pending' ? got.missing : got.reasons).toEqual(words);
    });
  });
});

/* ------------------------------------------------------------------ C */
const TEST: Row[] = [
  ['C1', 'Fatality, no citation, 1 h ago', () => truthCase((c) => { c.injuries = { ...c.injuries, status: 'yes', fatalities: 1 }; })],
  ['C2', 'Tow-away, cited 3 h after', () => truthCase((c) => cite(c, 5, 3))],
  ['C3', 'Tow-away, cited 10 h after', () => truthCase((c) => cite(c, 20, 10))],
  ['C4', 'Tow-away, cited 40 h after', () => truthCase((c) => cite(c, 50, 40))],
  ['C5', 'Tow-away, cited, citation time not recorded', () => truthCase((c) => cite(c, 1))],
  ['C6', 'Treated away 1, driver not cited', () => truthCase((c) => { c.injuries = { ...c.injuries, status: 'yes', treatedAway: 1 }; })],
  ['C7', 'Tow-away, citation not reported, 1 h ago', () => truthCase((c) => { c.towAway = 'yes'; c.citation = { status: null }; })],
  ['C8', 'Tow-away, citation not reported, 10 h ago', () => truthCase((c) => { c.towAway = 'yes'; c.citation = { status: null }; c.occurredAt = isoAt(FIXTURE_CLOCK - 10 * HOUR_MS); })],
  ['C9', 'Injuries and tow unknown, 1 h ago', () => truthCase((c) => { c.injuries = { ...c.injuries, status: 'unknown', treatedAway: null, fatalities: null }; c.towAway = 'unknown'; })],
  ['C10', 'Injuries and tow unknown, 40 h ago', () => truthCase((c) => { c.injuries = { ...c.injuries, status: 'unknown', treatedAway: null, fatalities: null }; c.towAway = 'unknown'; c.occurredAt = isoAt(FIXTURE_CLOCK - 40 * HOUR_MS); })],
  ['C11', 'No fatality, no injury away, no tow', () => truthCase()],
  ['C12', 'Same, Safety marked alcohol “required”', () => truthCase((c) => { c.testing.alcohol.decision = 'required'; })],
  ['C13', 'Injured, treated away not known, fatalities 0, tow no, cited 3 h after', () => truthCase((c) => { c.injuries = { ...c.injuries, status: 'yes', treatedAway: null, fatalities: 0 }; c.occurredAt = isoAt(FIXTURE_CLOCK - 5 * HOUR_MS); c.citation = { status: 'yes', issuedAt: isoAt(FIXTURE_CLOCK - 2 * HOUR_MS) }; })],
  ['C14', 'Treated away 2, fatalities not known, not cited', () => truthCase((c) => { c.injuries = { ...c.injuries, status: 'yes', treatedAway: 2, fatalities: null }; })],
  ['C15', 'Tow-away, cited 3 h after, road NOT open to public travel', () => truthCase((c) => { cite(c, 5, 3); c.location.publicRoad = 'no'; })],
  ['C16', 'Fatality, road open to public travel unknown', () => truthCase((c) => { c.injuries = { ...c.injuries, status: 'yes', fatalities: 1 }; c.location.publicRoad = 'unknown'; })],
  ['C17', 'Tow-away, cited 1 h after; alcohol given 5 h after, no delay reason', () => truthCase((c) => { cite(c, 6, 1); c.testing.alcohol.administeredAt = isoAt(FIXTURE_CLOCK - HOUR_MS); })],
  ['C18', 'Same, delay reason recorded', () => truthCase((c) => { cite(c, 6, 1); c.testing.alcohol.administeredAt = isoAt(FIXTURE_CLOCK - HOUR_MS); c.testing.alcohol.delayReason = 'Collector arrived 4 h after the call'; })],
  ['C19', 'Tow-away, cited 1 h after; alcohol "given" 9 h after', () => truthCase((c) => { cite(c, 10, 1); c.testing.alcohol.administeredAt = isoAt(FIXTURE_CLOCK - HOUR_MS); })],
];

/** ACCEPTANCE C exact strings, alcohol / drug. */
const C_TEXT: Record<string, [string, string, string?, string?]> = {
  C1: ['yes', 'Fatality — test required whether or not a citation is issued', 'yes', 'Fatality — test required whether or not a citation is issued'],
  C2: ['yes', 'Disabling-damage tow-away and our driver was cited within 8 hours', 'yes', 'Disabling-damage tow-away and our driver was cited within 32 hours'],
  C3: ['no', 'Citation issued after the 8-hour window', 'yes', 'Disabling-damage tow-away and our driver was cited within 32 hours'],
  C4: ['no', 'Citation issued after the 8-hour window', 'no', 'Citation issued after the 32-hour window'],
  C6: ['no', 'Injury treated away, but our driver was not cited', 'no', 'Injury treated away, but our driver was not cited'],
  C7: ['pending', 'Required only if our driver is cited within 8 hours — confirm citation status', 'pending', 'Required only if our driver is cited within 32 hours — confirm citation status'],
  C8: ['no', 'No citation recorded within 8 hours — confirm none was issued', 'pending'],
  C9: ['pending', 'Waiting on injury status and tow-away — required if anyone died', 'pending', 'Waiting on injury status and tow-away — required if anyone died'],
  C10: ['no', 'The 8-hour limit passed before injury status and tow-away were confirmed — document why', 'no', 'The 32-hour limit passed before injury status and tow-away were confirmed — document why'],
  C11: ['no', 'No fatality, no injury treated away from the scene and no disabling-damage tow', 'no'],
  C13: ['pending', 'Waiting on people treated away — required if it qualifies and our driver is cited within 8 hours', 'pending', 'Waiting on people treated away — required if it qualifies and our driver is cited within 32 hours'],
  C14: ['pending', 'Waiting on fatalities — required if anyone died', 'pending', 'Waiting on fatalities — required if anyone died'],
  C15: ['no', 'Not on a road open to public travel — 382.303 does not apply (company policy may still call for a test)', 'no', 'Not on a road open to public travel — 382.303 does not apply (company policy may still call for a test)'],
  C16: ['pending', 'Fatality — required if it happened on a road open to public travel; confirm the location', 'pending', 'Fatality — required if it happened on a road open to public travel; confirm the location'],
};

describe('ACCEPTANCE C — post-accident testing (49 CFR 382.303)', () => {
  TEST.forEach(([id, input, build], i) => {
    it(`${id} ${input}`, () => {
      const t = testing(build());
      const exp = EXPECTED.truthTables.testing[i];
      expect(exp.input).toBe(input);
      for (const sub of ['alcohol', 'drug'] as const) {
        const x = t[sub];
        expect({ required: x.required, reason: x.reason, overrideNote: x.overrideNote ?? null, documented: x.documented, docNote: x.docNote ?? null }).toEqual(exp[sub]);
      }
      const text = C_TEXT[id];
      if (text) {
        expect(t.alcohol.required).toBe(text[0]);
        expect(t.alcohol.reason).toBe(text[1]);
        if (text[2]) expect(t.drug.required).toBe(text[2]);
        if (text[3]) expect(t.drug.reason).toBe(text[3]);
      }
    });
  });

  it('C5 a citation with no time counts as within the window (both required)', () => {
    const t = testing(truthCase((c) => cite(c, 1)));
    expect([t.alcohol.required, t.drug.required]).toEqual(['yes', 'yes']);
  });
  it('C12 Safety escalation: alcohol required with the policy note, drug untouched; Use rule restores', () => {
    const c = truthCase((x) => { x.testing.alcohol.decision = 'required'; });
    expect(testing(c).alcohol).toMatchObject({ required: 'yes', overrideNote: 'Marked required by Safety (company policy)' });
    expect(testing(c).drug.required).toBe('no');
    c.testing.alcohol.decision = 'auto';
    expect(testing(c).alcohol).toMatchObject({ required: 'no', overrideNote: undefined });
  });
  it('C17/C18/C19 documentation of a late alcohol test', () => {
    const late = testing(TEST[16]![2]()).alcohol;
    expect(late).toMatchObject({ required: 'yes', documented: false, docNote: 'Given more than 2 hours after the accident — record why it was not given sooner (382.303(d)(1))' });
    expect(testing(TEST[17]![2]()).alcohol).toMatchObject({ required: 'yes', documented: true });
    expect(testing(TEST[18]![2]()).alcohol).toMatchObject({ required: 'yes', documented: false, docNote: 'Recorded test time is after the 8-hour limit — record why the test was not given instead' });
  });
  it('C-extra an explicit `now` overrides the injected clock (window closes)', () => {
    const c = truthCase((x) => { x.towAway = 'yes'; x.citation = { status: null }; });
    expect(testing(c).alcohol.required).toBe('pending');
    expect(testing(c, { now: FIXTURE_CLOCK + 8 * HOUR_MS }).alcohol).toMatchObject({ required: 'no', reason: 'No citation recorded within 8 hours — confirm none was issued' });
  });
});

/* ------------------------------------------------------------------ D */
const SEV: [string, string, () => AccidentCase, string, string][] = [
  ['D1', 'Fatality', () => truthCase((c) => { c.injuries = { ...c.injuries, status: 'yes', fatalities: 1 }; }), 'critical', 'Fatality'],
  ['D2', 'Hazmat released', () => truthCase((c) => { c.hazmat = 'yes'; }), 'critical', 'Hazardous material released'],
  ['D3', 'Treated away 1', () => truthCase((c) => { c.injuries = { ...c.injuries, status: 'yes', treatedAway: 1 }; }), 'serious', 'Injury treated away from the scene'],
  ['D4', 'Tow-away', () => truthCase((c) => { c.towAway = 'yes'; }), 'serious', 'Disabling damage — tow-away'],
  ['D5', 'Driver cited (no injury, no tow)', () => truthCase((c) => { c.citation = { status: 'yes' }; }), 'serious', 'Our driver was cited'],
  ['D6', 'Cargo loss', () => truthCase((c) => { c.cargo = { status: 'loss' }; }), 'serious', 'Cargo loss'],
  ['D7', 'Initial estimate $25,000', () => truthCase((c) => { c.initialEstimateCents = 25_000_00; }), 'serious', 'Estimated damage $25,000 or more'],
  ['D8', 'Injury status not reported', () => truthCase((c) => { c.injuries = { ...c.injuries, status: null, treatedAway: null, fatalities: null }; }), 'moderate', 'Injury status not confirmed yet'],
  ['D9', 'Initial estimate $5,000', () => truthCase((c) => { c.initialEstimateCents = 5_000_00; }), 'moderate', 'Estimated damage $5,000 or more'],
  ['D10', 'Cargo damaged', () => truthCase((c) => { c.cargo = { status: 'damaged' }; }), 'moderate', 'Cargo damaged'],
  ['D11', 'Truck not drivable', () => truthCase((c) => { c.equipment.truck.condition = 'not_drivable'; }), 'moderate', 'Truck not drivable'],
  ['D12', 'Injuries yes, treated away and fatalities not known', () => truthCase((c) => { c.injuries = { ...c.injuries, status: 'yes', treatedAway: null, fatalities: null }; }), 'moderate', 'Injuries reported — treatment and fatality details not confirmed yet'],
  ['D13', 'None of the above', () => truthCase(), 'minor', 'No injuries, no tow-away, low damage'],
];

describe('ACCEPTANCE D — suggested severity', () => {
  SEV.forEach(([id, input, build, value, why], i) => {
    it(`${id} ${input} → ${value}`, () => {
      const got = suggestedSeverity(build());
      const exp = EXPECTED.truthTables.severity[i];
      expect(exp.input).toBe(input);
      expect(got).toEqual({ value: exp.value, why: exp.why });
      expect(got).toEqual({ value, why });
    });
  });
  it('D-extra estimate thresholds come from settings, and the reason prints them', () => {
    const c = truthCase((x) => { x.initialEstimateCents = 10_000_00; });
    expect(suggestedSeverity(c, { settings: { severitySeriousEstimateCents: 10_000_00 } })).toEqual({ value: 'serious', why: 'Estimated damage $10,000 or more' });
    expect(suggestedSeverity(truthCase((x) => { x.initialEstimateCents = 24_999_99; }))).toEqual({ value: 'moderate', why: 'Estimated damage $5,000 or more' });
  });
});
