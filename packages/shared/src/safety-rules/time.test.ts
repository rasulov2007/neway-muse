// Time-zone helpers: ACCEPTANCE A13 (DST gap / overlap, SPEC §7.15), A12 (split-zone hint) and O8.
import { describe, expect, it } from 'vitest';
import { fmtShort, isoToLocalInput, localToUtc, resetRulesClock, rulesNow, setRulesClock, zoneForState } from './time.js';
import { hazmatPrefill } from './rules.js';

const CT = 'America/Chicago';

describe('localToUtc — SPEC §7.15', () => {
  it('O8 ACC-2026-016 "2026-10-02T15:45" Central = 20:45Z', () => {
    expect(localToUtc('2026-10-02T15:45', CT)).toEqual({ ok: true, iso: '2026-10-02T20:45:00.000Z', abbr: 'CDT' });
  });

  it('O8 Arizona has no DST (MST all year)', () => {
    expect(localToUtc('2026-07-01T12:00', 'America/Phoenix')).toMatchObject({ ok: true, iso: '2026-07-01T19:00:00.000Z' });
    expect(localToUtc('2026-01-01T12:00', 'America/Phoenix')).toMatchObject({ ok: true, iso: '2026-01-01T19:00:00.000Z' });
    expect(localToUtc('2026-03-08T02:30', 'America/Phoenix')).toMatchObject({ ok: true, iso: '2026-03-08T09:30:00.000Z' });
  });

  it('A13 2026-03-08 02:30 Central does not exist (spring forward) → validation error', () => {
    expect(localToUtc('2026-03-08T02:30', CT)).toEqual({
      ok: false,
      error: 'nonexistent',
      message: 'This time does not exist in Central time on Mar 8 — clocks moved forward',
    });
    // the minutes either side of the gap are fine
    expect(localToUtc('2026-03-08T01:59', CT)).toMatchObject({ ok: true, iso: '2026-03-08T07:59:00.000Z', abbr: 'CST' });
    expect(localToUtc('2026-03-08T03:00', CT)).toMatchObject({ ok: true, iso: '2026-03-08T08:00:00.000Z', abbr: 'CDT' });
  });

  it('A13 2026-11-01 01:30 Central occurs twice (fall back) → the user must pick CDT or CST', () => {
    const r = localToUtc('2026-11-01T01:30', CT);
    expect(r).toEqual({
      ok: false,
      error: 'ambiguous',
      message: 'This time occurs twice in Central time on Nov 1 — clocks moved back. Pick CDT or CST',
      options: [
        { iso: '2026-11-01T06:30:00.000Z', abbr: 'CDT' },
        { iso: '2026-11-01T07:30:00.000Z', abbr: 'CST' },
      ],
    });
    expect(localToUtc('2026-11-01T01:30', CT, 'CDT')).toEqual({ ok: true, iso: '2026-11-01T06:30:00.000Z', abbr: 'CDT' });
    expect(localToUtc('2026-11-01T01:30', CT, 'CST')).toEqual({ ok: true, iso: '2026-11-01T07:30:00.000Z', abbr: 'CST' });
    expect(localToUtc('2026-11-01T01:30', CT, 'earlier')).toMatchObject({ ok: true, abbr: 'CDT' });
    expect(localToUtc('2026-11-01T01:30', CT, 'later')).toMatchObject({ ok: true, abbr: 'CST' });
  });

  it('A13 the same edges in Eastern time', () => {
    expect(localToUtc('2026-03-08T02:15', 'America/New_York')).toMatchObject({ ok: false, error: 'nonexistent', message: 'This time does not exist in Eastern time on Mar 8 — clocks moved forward' });
    expect(localToUtc('2026-11-01T01:05', 'America/New_York')).toMatchObject({ ok: false, error: 'ambiguous' });
  });

  it('rejects malformed input instead of guessing', () => {
    expect(localToUtc('2026-02-30T10:00', CT)).toMatchObject({ ok: false, error: 'invalid' });
    expect(localToUtc('', CT)).toMatchObject({ ok: false, error: 'invalid' });
  });

  it('round-trips through isoToLocalInput', () => {
    expect(isoToLocalInput('2026-10-02T20:45:00.000Z', CT)).toBe('2026-10-02T15:45');
  });
});

describe('zones and clock', () => {
  it('A12 split-zone state default + confirm hint', () => {
    expect(zoneForState('TN')).toEqual({ tz: 'America/Chicago', confirmHint: 'TN has more than one time zone — confirm' });
    expect(zoneForState('IL')).toEqual({ tz: 'America/Chicago', confirmHint: null });
  });

  it('the rules clock is injectable; an explicit now wins', () => {
    setRulesClock(() => Date.parse('2027-01-05T12:00:00Z'));
    try {
      expect(rulesNow()).toBe(Date.parse('2027-01-05T12:00:00Z'));
      expect(fmtShort('2026-10-12T15:00:00Z')).toBe('Oct 12, 2026'); // different year from the clock → year shown
      expect(fmtShort('2026-10-12T15:00:00Z', undefined, Date.parse('2026-10-19T17:00:00Z'))).toBe('Oct 12');
    } finally {
      resetRulesClock();
    }
  });
});

describe('SPEC §11 shortcut 9 — hazmat prefill only from an explicit non-hazmat load record', () => {
  const load = { id: 'l1', number: 'L-48213', customer: 'x', commodity: 'x', valueCents: 0, weightLbs: 0, origin: 'a', destination: 'b', pickupAt: '', deliveryDue: '', status: 'In transit' as const };
  it('A4 prefills No with the source when the load says non-hazmat', () => {
    expect(hazmatPrefill({ ...load, hazmat: false }, null)).toEqual({ value: 'no', hint: 'Load L-48213 is not a hazmat load (load record)' });
  });
  it('no prefill when the load does not say, is hazmat, or someone already answered', () => {
    expect(hazmatPrefill(load, null)).toBeNull();
    expect(hazmatPrefill({ ...load, hazmat: null }, null)).toBeNull();
    expect(hazmatPrefill({ ...load, hazmat: true }, null)).toBeNull();
    expect(hazmatPrefill({ ...load, hazmat: false }, 'yes')).toBeNull();
    expect(hazmatPrefill(undefined, null)).toBeNull();
  });
});
