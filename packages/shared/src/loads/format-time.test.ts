import { describe, expect, it } from 'vitest';
import {
  HOME_ZONE,
  formatAppointment,
  formatInstant,
  instantFromLocal,
  localParts,
  looksLikeRawIso,
  timeInZone,
} from './format-time.js';

/**
 * Everybody reads Eastern (rule 1.1).
 *
 * A stop keeps its own clock for the appointment somebody typed and the arrival somebody
 * recorded; it is shown beside the Eastern time, never instead of it. So one instant reads the
 * same on every screen, and the shipper's wall-clock is a hover away.
 */
describe('the clock everybody reads', () => {
  it('is Eastern', () => {
    expect(HOME_ZONE).toBe('America/New_York');
  });

  it('prints a Chicago stop in Eastern, with the stop clock on hover', () => {
    // 2:00 PM CDT = 3:00 PM EDT
    const f = formatInstant('2026-09-25T19:00:00.000Z', 'America/Chicago');
    expect(f.time).toBe('3:00 PM EDT');
    expect(f.zone).toBe('EDT');
    expect(f.tooltip).toContain('2:00 PM CDT - stop local');
    expect(f.tooltip).toContain('3:00 PM EDT - Eastern');
    expect(f.tooltip).toContain('Tashkent');
  });

  it('does not repeat the stop clock when the stop is already Eastern', () => {
    const f = formatInstant('2026-09-25T19:00:00.000Z', 'America/New_York');
    expect(f.tooltip).not.toContain('stop local');
  });

  it('says when the stop zone is unknown rather than guessing one', () => {
    const f = formatInstant('2026-09-25T19:00:00.000Z', null);
    expect(f.time).toBe('3:00 PM EDT');
    expect(f.tooltip).toContain('stop zone unknown');
  });

  it('prints an appointment in Eastern with the stop clock after it', () => {
    const text = formatAppointment({
      appointmentStartAt: '2026-09-25T13:00:00.000Z', // 8:00 AM CDT, 9:00 AM EDT
      appointmentEndAt: '2026-09-25T15:00:00.000Z',
      timezone: 'America/Chicago',
    });
    expect(text).toBe('Sep 25, 9:00 AM – 11:00 AM EDT · 8:00 AM CDT stop local');
  });

  it('never prints a raw ISO string', () => {
    const f = formatInstant('2026-09-25T19:00:00.000Z', 'America/Chicago');
    for (const text of [f.time, f.text, f.tooltip, f.day, f.weekday]) expect(looksLikeRawIso(text)).toBe(false);
  });
});

/**
 * The night the clocks go back.
 *
 * On 1 November 2026 Eastern leaves daylight time at 2:00 AM: 1:30 AM happens twice, once as
 * EDT and once as EST. A clock that gets this wrong is an hour out on every appointment for a
 * week before anybody notices, so both halves of that hour are pinned here.
 */
describe('the DST change on November 1', () => {
  it('reads the first 1:30 AM as EDT and the second as EST', () => {
    expect(timeInZone('2026-11-01T05:30:00.000Z', HOME_ZONE)).toBe('1:30 AM EDT');
    expect(timeInZone('2026-11-01T06:30:00.000Z', HOME_ZONE)).toBe('1:30 AM EST');
  });

  it('converts a stop-local time typed after the change with the winter offset', () => {
    // 8:00 AM EST on Nov 2 is 13:00 UTC; the day before the change it would have been 12:00.
    expect(instantFromLocal('2026-11-02', '08:00', HOME_ZONE)).toBe('2026-11-02T13:00:00.000Z');
    expect(instantFromLocal('2026-10-31', '08:00', HOME_ZONE)).toBe('2026-10-31T12:00:00.000Z');
  });

  it('round-trips a Chicago appointment through the stop zone and back', () => {
    const iso = instantFromLocal('2026-11-03', '14:00', 'America/Chicago');
    expect(iso).toBe('2026-11-03T20:00:00.000Z');
    expect(localParts(iso, 'America/Chicago')).toEqual({ date: '2026-11-03', time: '14:00' });
    // and the same instant, in Eastern, is an hour later on the wall
    expect(localParts(iso, HOME_ZONE)).toEqual({ date: '2026-11-03', time: '15:00' });
  });
});
