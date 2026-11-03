import { describe, expect, it } from 'vitest';
import { eventTime } from './time';

// The formatter renders in the company timezone (America/New_York, since 2026-09-25) and says
// which clock, so these are Eastern instants.
const NOW = new Date('2026-09-08T15:00:00-04:00');

describe('eventTime', () => {
  it('labels the current company day as Today', () => {
    expect(eventTime('2026-09-08T10:24:00-04:00', NOW)).toBe('Today, 10:24 AM EDT');
  });

  it('labels the previous company day as Yesterday', () => {
    expect(eventTime('2026-09-07T17:32:00-04:00', NOW)).toBe('Yesterday, 5:32 PM EDT');
  });

  it('falls back to a dated label, without the year, for anything older', () => {
    expect(eventTime('2026-09-04T09:15:00-04:00', NOW)).toBe('Sep 4, 9:15 AM EDT');
  });

  it('renders a dash rather than "Invalid Date" for an unparseable timestamp', () => {
    expect(eventTime('not a date', NOW)).toBe('—');
  });
});
