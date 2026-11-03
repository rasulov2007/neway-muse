import { describe, expect, it } from 'vitest';
import { etaText } from './dispatch-board.service';

describe('the ETA cell (owner, 2026-10-26)', () => {
  it('is the time alone on the board day, without the zone word', () => {
    expect(etaText('2026-10-26T12:40:00.000Z', 'America/New_York', '2026-10-26')).toBe('8:40 AM');
  });
  it('carries the date when the appointment is on another day', () => {
    // L-100003: delivery Tue Oct 27 7:00 AM EDT, seen on Monday's board.
    expect(etaText('2026-10-27T11:00:00.000Z', 'America/New_York', '2026-10-26')).toBe('Oct 27 7:00 AM');
  });
  it('reads the date in the stop zone', () => {
    // 03:30 UTC on the 27th is still the 26th in Chicago.
    expect(etaText('2026-10-27T03:30:00.000Z', 'America/Chicago', '2026-10-26')).toBe('10:30 PM');
  });
});
