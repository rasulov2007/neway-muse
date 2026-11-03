import { describe, expect, it } from 'vitest';
import { assessPostAccidentTesting, type SafetyAccident } from '@neway/shared';
import { accidentTestingStatus } from './AccidentsPage';
import { fromEasternInput, toEasternInput } from './time';

describe('Eastern wall-clock inputs', () => {
  it('reads a typed time as Eastern, in summer and in winter', () => {
    expect(fromEasternInput('2026-10-01T08:00')).toBe('2026-10-01T12:00:00.000Z'); // EDT, UTC-4
    expect(fromEasternInput('2026-12-01T08:00')).toBe('2026-12-01T13:00:00.000Z'); // EST, UTC-5
    expect(fromEasternInput('nonsense')).toBeNull();
  });

  it('shows an instant on the Eastern wall clock, whatever the browser zone', () => {
    expect(toEasternInput('2026-10-01T12:00:00.000Z')).toBe('2026-10-01T08:00');
    expect(toEasternInput(fromEasternInput('2026-03-08T03:30') as string)).toBe('2026-03-08T03:30');
  });
});

describe('the Testing column', () => {
  const accident = (over: Partial<SafetyAccident>): SafetyAccident =>
    ({
      testing: assessPostAccidentTesting({ occurredAt: '2026-10-01T12:00:00Z', fatalities: 0, injuriesTreatedAway: 0, disablingTow: false, citationIssued: false, citationAt: null }),
      tests: [],
      ...over,
    }) as SafetyAccident;

  it('says Not required when neither test is', () => {
    expect(accidentTestingStatus(accident({})).status).toBe('not_required');
  });

  it('says Needs assessment while the citation time is missing', () => {
    const testing = assessPostAccidentTesting({ occurredAt: '2026-10-01T12:00:00Z', fatalities: 0, injuriesTreatedAway: 1, disablingTow: false, citationIssued: true, citationAt: null });
    expect(accidentTestingStatus(accident({ testing })).label).toBe('Needs assessment');
  });

  it('says Required until each required test is collected', () => {
    const testing = assessPostAccidentTesting({ occurredAt: '2026-10-01T12:00:00Z', fatalities: 1, injuriesTreatedAway: 0, disablingTow: false, citationIssued: false, citationAt: null });
    const pending = { required: true, collectedAt: null, status: { progress: 'required', resolved: false } };
    expect(accidentTestingStatus(accident({ testing, tests: [pending, pending] as never })).status).toBe('required');
    const done = { required: true, collectedAt: '2026-10-01T13:00:00Z', status: { progress: 'result_recorded', resolved: true } };
    expect(accidentTestingStatus(accident({ testing, tests: [done, done] as never })).label).toBe('Complete');
  });
});
