import { describe, expect, it } from 'vitest';
import { DotApplicationDraftFormSchema, dotApplicationProblems, dotSectionStates } from './dot-application-draft.js';

const NOW = new Date('2026-09-30T12:00:00Z');
const blank = DotApplicationDraftFormSchema.parse({});

describe('DOT application drafts', () => {
  it('accepts an incomplete draft with blank fields', () => {
    const parsed = DotApplicationDraftFormSchema.safeParse({
      legalFirstName: 'A',
      dateOfBirth: '',
      addresses: [{ street: '1 Elm', city: '', state: '', zip: '', from: '', to: null }],
    });
    expect(parsed.success).toBe(true);
  });

  it('still refuses what is malformed, not merely blank', () => {
    expect(DotApplicationDraftFormSchema.safeParse({ dateOfBirth: '30/09/1990' }).success).toBe(false);
  });

  it('pins each missing field to its section and path', () => {
    const problems = dotApplicationProblems(
      { ...blank, legalFirstName: 'A', addresses: [{ street: '1 Elm', city: '', state: 'IL', zip: '60601', from: '2020-01-01', to: null }] },
      NOW,
    );
    expect(problems).toContainEqual(expect.objectContaining({ section: 'identity', path: 'legalLastName', detail: 'Legal last name is required' }));
    expect(problems).toContainEqual(expect.objectContaining({ section: 'addresses', path: 'addresses.0.city', detail: 'City on address 1 is required' }));
  });

  it('reads Not started, In progress and Complete per section', () => {
    expect(dotSectionStates(blank, NOW).identity).toBe('not_started');
    expect(dotSectionStates(blank, NOW).incidents).toBe('not_started');
    const partial = { ...blank, legalFirstName: 'A', legalLastName: 'B' };
    expect(dotSectionStates(partial, NOW).identity).toBe('in_progress');
    const named = { ...partial, dateOfBirth: '1985-01-01' };
    const s = dotSectionStates(named, NOW);
    expect(s.identity).toBe('complete');
    // No accidents is an answer once the application is under way.
    expect(s.incidents).toBe('complete');
    expect(s.addresses).toBe('not_started');
  });

  it('calls a section in progress when its own 391.21 rule fails', () => {
    const shortHistory = {
      ...blank,
      legalFirstName: 'A',
      legalLastName: 'B',
      dateOfBirth: '1985-01-01',
      addresses: [{ street: '1 Elm', city: 'Chicago', state: 'IL', zip: '60601', from: '2025-01-01', to: null }],
    };
    expect(dotSectionStates(shortHistory, NOW).addresses).toBe('in_progress');
  });
});
