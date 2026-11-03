// Test-only helpers: the fixture clock, the expected values and a minimal case for truth tables.
// Never exported from the package (ACCEPTANCE §0 — fixture data stays out of production).
import { readFileSync } from 'node:fs';
import type { AccidentCase } from '../types.js';

/** ACCEPTANCE §0 fixture clock: 12:00 PM CDT · 1:00 PM EDT. */
export const FIXTURE_CLOCK = Date.parse('2026-10-19T17:00:00Z');
export const HOUR_MS = 3_600_000;
export const isoAt = (ms: number): string => new Date(ms).toISOString();

/** Expected values produced by docs/accidents/prototype/tools/dump-fixtures.ts (prototype dollars). */
export const EXPECTED: any = JSON.parse(readFileSync(new URL('./fixtures-2026-10-19T17Z.json', import.meta.url), 'utf8'));

/** Same base as dump-fixtures.ts `base()`: public road yes, no injuries (0/0), no tow, not cited, 1 h before the clock. */
export function truthCase(edit: (c: AccidentCase) => void = () => {}): AccidentCase {
  const c: AccidentCase = {
    id: 'x', number: 'X', stage: 'initial_response', createdAt: isoAt(FIXTURE_CLOCK - HOUR_MS), createdBy: 'p_rm',
    updatedAt: isoAt(FIXTURE_CLOCK - HOUR_MS), version: 1, isTest: false,
    occurredAt: isoAt(FIXTURE_CLOCK - HOUR_MS), tz: 'America/Chicago', timeProvenance: 'driver',
    location: { city: 'Joliet', state: 'IL', publicRoad: 'yes' }, locationProvenance: 'driver',
    type: 'Other', description: 'Truth-table case', descriptionProvenance: 'driver', severity: 'minor',
    injuries: { status: 'no', treatedAway: 0, fatalities: 0, ourDriver: 'no', provenance: 'driver' },
    towAway: 'no', towProvenance: 'driver', citation: { status: 'no' }, hazmat: 'no', police: { responded: 'no' },
    conditions: {}, vehicles: [], witnesses: [],
    equipment: { truck: { condition: 'drivable', status: 'operational', damage: '' } },
    cargo: { status: 'no_damage' }, immediate: [],
    investigation: { status: 'not_started', facts: [], questions: [], statements: [], checklist: [], factors: [] },
    determinations: { fault: { value: 'not_determined' }, preventability: { value: 'not_determined' }, cpdp: { value: 'not_applicable' }, legal: { value: 'unknown' } },
    correctiveActions: [],
    testing: { alcohol: { substance: 'alcohol', decision: 'auto' }, drug: { substance: 'drug', decision: 'auto' } },
    ownerId: 'p_rm', initialEstimateCents: 0,
  };
  edit(c);
  return c;
}

/** dump-fixtures.ts `cite()`: tow-away, occurred occH hours before the clock, cited afterH hours after it (or no time). */
export function cite(c: AccidentCase, occH: number, afterH?: number): void {
  c.towAway = 'yes';
  c.occurredAt = isoAt(FIXTURE_CLOCK - occH * HOUR_MS);
  c.citation = { status: 'yes', ...(afterH !== undefined ? { issuedAt: isoAt(FIXTURE_CLOCK - occH * HOUR_MS + afterH * HOUR_MS) } : {}) };
}
