import { describe, expect, it } from 'vitest';
import { followUpSlot, followUpText } from './lead-follow-up.scheduler';

describe('lead follow-ups (owner, 2026-10-23)', () => {
  it('fires at 10:00, 13:00 and 17:00 Eastern, once per slot', () => {
    // 2026-10-23 is EDT (UTC-4): 10:00 ET = 14:00 UTC.
    expect(followUpSlot(new Date('2026-10-23T14:00:00Z'))).toBe('2026-10-23 10');
    expect(followUpSlot(new Date('2026-10-23T14:09:00Z'))).toBe('2026-10-23 10');
    expect(followUpSlot(new Date('2026-10-23T14:10:00Z'))).toBeNull();
    expect(followUpSlot(new Date('2026-10-23T17:03:00Z'))).toBe('2026-10-23 13');
    expect(followUpSlot(new Date('2026-10-23T21:00:00Z'))).toBe('2026-10-23 17');
    expect(followUpSlot(new Date('2026-10-23T15:00:00Z'))).toBeNull();
    // After the clocks change (EST, UTC-5): 10:00 ET = 15:00 UTC.
    expect(followUpSlot(new Date('2026-11-10T15:05:00Z'))).toBe('2026-11-10 10');
  });

  it('writes the owner format with a link to the lead', () => {
    const text = followUpText({ id: 'lead_1', leadNumber: 'LD-1203', firstName: 'John', lastName: 'Smith', phone: '(555) 010-0000', recruiterName: 'Greta Harper' });
    const lines = text.split('\n');
    expect(lines[0]).toBe('FOLLOW UP 🟥🟥🟥🟥');
    expect(lines.slice(1, 5)).toEqual(['LD-1203', 'Name: John Smith', 'Phone: (555) 010-0000', 'Recruiter: Greta Harper']);
    expect(lines[5]).toContain('/hr/recruiting/lead_1');
    expect(lines[5]).toContain('>Open in TMS</a>');
  });
});
