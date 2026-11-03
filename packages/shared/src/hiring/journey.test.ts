import { describe, expect, it } from 'vitest';
import type { Lead } from './leads.js';
import type { HiringCase } from './stages.js';
import { journeyPeople, journeyPlaceOfCase, journeySteps, lastLiveStep, summarizeJourney } from './journey.js';

const lead = (over: Partial<Lead>): Lead => ({
  id: 'l1', leadNumber: 'LD-1', firstName: 'A', lastName: 'B', name: 'A B', phone: '555', email: null,
  cdlClass: 'A', state: 'GA', yearsExperience: 2, source: 'facebook', campaignId: null,
  recruiterEmployeeId: null, recruiterName: null, notes: null, status: 'new', prequalification: null,
  prequalResult: null, applicantId: null, hiringCaseId: null, deadReason: null,
  createdAt: '2026-09-20T12:00:00.000Z', contactedAt: null, prequalifiedAt: null, convertedAt: null, deadAt: null,
  ...over,
});
const kase = (over: Partial<HiringCase>): HiringCase => ({
  id: 'c1', applicantId: 'ap1', driverId: null, verificationCaseId: null, candidateName: 'C D',
  state: 'checks', stateSince: '2026-09-20T12:00:00.000Z', daysInState: 0, openedAt: '2026-09-18T12:00:00.000Z',
  closedAt: null, endReason: null, endNote: null, recruiterId: null, recruiterName: null, dotApplication: null,
  offerId: null, employeeId: null, hiredAt: null, firstDispatchAt: null, onboardingGate: null, events: [],
  ...over,
});

describe('the hiring journey', () => {
  it('reads every stored state onto one of nine steps or two exits', () => {
    expect(journeyPlaceOfCase('checks')).toBe('documents');
    expect(journeyPlaceOfCase('ticketed')).toBe('offer_travel');
    expect(journeyPlaceOfCase('active_driver')).toBe('first_load');
    expect(journeyPlaceOfCase('disqualified')).toBe('disqualified');
    expect(journeyPlaceOfCase('no_show')).toBe('dropped');
  });

  it('counts a converted lead once, through its case', () => {
    const people = journeyPeople(
      [lead({ id: 'l1', status: 'converted', hiringCaseId: 'c1' }), lead({ id: 'l2' })],
      [kase({ id: 'c1' })],
      '2026-09-29',
    );
    expect(people.map((p) => p.key).sort()).toEqual(['case:c1', 'lead:l2']);
    expect(people.find((p) => p.kind === 'case')?.source).toBe('facebook');
  });

  it('calls a new lead stuck after a day and documents after five', () => {
    const [fresh] = journeyPeople([lead({ createdAt: '2026-09-29T09:00:00.000Z' })], [], '2026-09-29');
    const [old] = journeyPeople([lead({ createdAt: '2026-09-26T09:00:00.000Z' })], [], '2026-09-29');
    expect(fresh?.stuck).toBe(false);
    expect(old?.stuck).toBe(true);
    const [docs] = journeyPeople([], [kase({ stateSince: '2026-09-25T12:00:00.000Z' })], '2026-09-29');
    expect(docs?.daysOnStep).toBe(4);
    expect(docs?.stuck).toBe(false);
  });

  it('summarizes started, passed, dropped and disqualified by source', () => {
    const people = journeyPeople(
      [lead({ id: 'a', source: 'facebook' }), lead({ id: 'b', source: 'referral', status: 'dead', deadAt: '2026-09-22T00:00:00.000Z' })],
      [kase({ id: 'h', state: 'hired' }), kase({ id: 'd', state: 'disqualified' })],
      '2026-09-29',
    );
    const s = summarizeJourney(people, '2026-09-01', '2026-09-30');
    expect(s.started).toBe(4);
    expect(s.passed).toBe(1);
    expect(s.dropped).toBe(1);
    expect(s.disqualified).toBe(1);
    expect(s.onStep.lead).toBe(1);
    expect(s.bySource.find((r) => r.source === 'referral')?.dropped).toBe(1);
  });

  it('shows where an ended case stopped', () => {
    const c = kase({
      state: 'disqualified',
      events: [
        { id: 'e1', caseId: 'c1', fromState: null, toState: 'application', at: '2026-09-18T00:00:00.000Z', byId: null, byName: 'x', reason: null, note: null, source: 'user' },
        { id: 'e2', caseId: 'c1', fromState: 'application', toState: 'safety_review', at: '2026-09-19T00:00:00.000Z', byId: null, byName: 'x', reason: null, note: null, source: 'verification' },
        { id: 'e3', caseId: 'c1', fromState: 'safety_review', toState: 'disqualified', at: '2026-09-20T00:00:00.000Z', byId: null, byName: 'x', reason: 'safety_review_rejected', note: null, source: 'verification' },
      ],
    });
    const steps = journeySteps('disqualified', lastLiveStep(c));
    expect(steps.find((s) => s.step === 'safety_review')?.state).toBe('stopped');
    expect(steps.find((s) => s.step === 'documents')?.state).toBe('done');
    expect(steps.find((s) => s.step === 'offer_travel')?.state).toBe('todo');
  });
});
