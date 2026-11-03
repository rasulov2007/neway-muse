import { describe, expect, it } from 'vitest';
import { formatMoneyInput, formatUsPhone, maskDateTyping } from './inputMasks';

describe('input masks (owner, 2026-10-13)', () => {
  it('writes a US phone as (555) 010-1431', () => {
    expect(formatUsPhone('5550101431')).toBe('(555) 010-1431');
    expect(formatUsPhone('954695')).toBe('(954) 695');
    expect(formatUsPhone('15550101431')).toBe('(555) 010-1431');
    expect(formatUsPhone('+998 99 696 7681')).toBe('+998 99 696 7681');
    expect(formatUsPhone('')).toBe('');
  });
  it('puts the date slashes in as the digits arrive', () => {
    expect(maskDateTyping('0', '08')).toBe('08/');
    expect(maskDateTyping('08/', '08/0')).toBe('08/0');
    expect(maskDateTyping('08/0', '08/09')).toBe('08/09/');
    expect(maskDateTyping('08/09/202', '08/09/2029')).toBe('08/09/2029');
    expect(maskDateTyping('', '11252029')).toBe('11/25/2029');
    // Typed by hand with its own slashes, or deleting: left alone.
    expect(maskDateTyping('8', '8/')).toBe('8/');
    expect(maskDateTyping('08/', '08')).toBe('08');
    // Typing the slash yourself after the mask put one in does not double it.
    expect(maskDateTyping('09/', '09//')).toBe('09/');
    // A year typed first (ISO) is not a month: no slash goes in.
    expect(maskDateTyping('2', '20')).toBe('20');
    expect(maskDateTyping('2031-01-3', '2031-01-31')).toBe('2031-01-31');
  });
  it('writes money with its cents', () => {
    expect(formatMoneyInput('500')).toBe('500.00');
    expect(formatMoneyInput('1,250.5')).toBe('1250.50');
    expect(formatMoneyInput('')).toBe('');
    expect(formatMoneyInput('abc')).toBe('abc');
  });
});
