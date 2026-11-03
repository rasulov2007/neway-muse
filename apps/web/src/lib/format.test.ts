import { describe, expect, it } from 'vitest';
import {
  COMPANY_TIMEZONE,
  formatDate,
  formatDateTime,
  formatDuration,
  formatMiles,
  formatMoney,
  formatNumber,
  formatPercent,
  formatPhone,
  formatRelative,
  formatRpm,
  formatTime,
  initials,
  parseMoney,
} from './format';

const NOW = new Date('2026-09-06T14:30:00-05:00');

describe('format', () => {
  it('uses the company timezone', () => {
    expect(COMPANY_TIMEZONE).toBe('America/New_York');
  });

  it('formats money', () => {
    expect(formatMoney(84250)).toBe('$84,250.00');
    expect(formatMoney(-1200)).toBe('-$1,200.00');
    expect(formatMoney(84250, { compact: true })).toBe('$84.3K');
    expect(formatMoney(1_250_000, { compact: true })).toBe('$1.3M');
    expect(formatMoney(950, { compact: true })).toBe('$950');
    expect(formatMoney(Number.NaN)).toBe('—');
  });

  it('formats numbers, miles and rates', () => {
    expect(formatNumber(421500)).toBe('421,500');
    expect(formatNumber(6.42, 1)).toBe('6.4');
    expect(formatMiles(421500)).toBe('421,500 mi');
    expect(formatMiles(1000.4)).toBe('1,000 mi');
    expect(formatRpm(2.5)).toBe('$2.50');
  });

  it('formats percentages with sign', () => {
    expect(formatPercent(4.2)).toBe('+4.2%');
    expect(formatPercent(-1.85)).toBe('-1.9%');
    expect(formatPercent(0)).toBe('0.0%');
    expect(formatPercent(6.44, 0)).toBe('+6%');
    expect(formatPercent(12.5, { signed: false })).toBe('12.5%');
  });

  it('formats dates in America/New_York, and says which clock', () => {
    const at = new Date('2026-09-06T14:14:00-04:00');
    expect(formatDate(at)).toBe('Sep 6, 2026');
    expect(formatDateTime(at)).toBe('Sep 6, 2026, 2:14 PM EDT');
    expect(formatTime(at.toISOString())).toBe('2:14 PM EDT');
    // 11:30 PM UTC on Sep 6 is still Sep 6 in New York.
    expect(formatDate('2026-09-06T23:30:00Z')).toBe('Sep 6, 2026');
    // 3:30 AM UTC on Sep 7 is Sep 6 in New York.
    expect(formatDate('2026-09-07T03:30:00Z')).toBe('Sep 6, 2026');
    expect(formatDate('not a date')).toBe('—');
  });

  it('formats relative times with short units', () => {
    expect(formatRelative(new Date(NOW.getTime() - 3 * 60_000), { now: NOW })).toBe('3 min ago');
    expect(formatRelative(new Date(NOW.getTime() + 2 * 3_600_000), { now: NOW })).toBe('in 2 h');
    expect(formatRelative(new Date(NOW.getTime() - 5 * 86_400_000), { now: NOW })).toBe('5 d ago');
    expect(formatRelative(new Date(NOW.getTime() - 45_000), { now: NOW })).toBe('45 s ago');
  });

  it('builds initials', () => {
    expect(initials('Sarah Chen')).toBe('SC');
    expect(initials('Maria de la Cruz')).toBe('MC');
    expect(initials('Prince')).toBe('P');
    expect(initials('  ')).toBe('?');
  });

  it('formats phones and durations', () => {
    expect(formatPhone('+13125550142')).toBe('(312) 555-0142');
    expect(formatPhone('3125550142')).toBe('(312) 555-0142');
    expect(formatPhone('+442071234567')).toBe('+442071234567');
    expect(formatDuration(135)).toBe('2h 15m');
    expect(formatDuration(45)).toBe('45m');
    expect(formatDuration(120)).toBe('2h');
    expect(formatDuration(1500)).toBe('1d 1h');
  });
});

/**
 * Money is typed the way it is written: a dollar sign, thousands separators, cents. A number input
 * refuses most of that and keeps nothing, so the field takes text and this reads it.
 */
describe('reading a typed amount', () => {
  it('takes the dollar sign, the commas and the cents', () => {
    expect(parseMoney('$5,503.00')).toBe(5503);
    expect(parseMoney('5,503.55')).toBe(5503.55);
    expect(parseMoney('5503')).toBe(5503);
    expect(parseMoney(' $ 1,250.10 ')).toBe(1250.1);
  });

  it('reads the European hand as well', () => {
    expect(parseMoney('5.503,00')).toBe(5503);
    expect(parseMoney('1.250,10')).toBe(1250.1);
  });

  it('keeps a lone separator as thousands when it cannot be cents', () => {
    expect(parseMoney('5,503')).toBe(5503);
    expect(parseMoney('12.500')).toBe(12500);
  });

  it('says nothing rather than zero when there is no number', () => {
    expect(parseMoney('')).toBeNull();
    expect(parseMoney('  ')).toBeNull();
    expect(parseMoney('$')).toBeNull();
    expect(parseMoney('free')).toBeNull();
  });
});
