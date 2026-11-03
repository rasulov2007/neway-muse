import { describe, expect, it } from 'vitest';
import { ageLabel } from './recruit-format';

describe('ageLabel', () => {
  const now = Date.parse('2026-10-09T13:00:00.000Z');
  const ago = (ms: number) => new Date(now - ms).toISOString();
  it('says how long ago a lead came in', () => {
    expect(ageLabel(ago(20_000), now)).toBe('just now');
    expect(ageLabel(ago(25 * 60_000), now)).toBe('25 min ago');
    expect(ageLabel(ago(60 * 60_000), now)).toBe('1 hour ago');
    expect(ageLabel(ago(5 * 3_600_000), now)).toBe('5 hours ago');
    expect(ageLabel(ago(26 * 3_600_000), now)).toBe('1 day ago');
    expect(ageLabel(ago(3 * 86_400_000), now)).toBe('3 days ago');
    expect(ageLabel(ago(45 * 86_400_000), now)).toBe('Aug 25');
    expect(ageLabel(null, now)).toBe('—');
  });
});
