import { describe, expect, it } from 'vitest';
import {
  nameAgreement,
  phoneDigits,
  scoreCandidate,
  suggestMatches,
  unitKey,
  type MatchDriver,
  type MatchRow,
} from './roster-match.js';

/**
 * The rule these tests hold: a suggestion is never a decision. What matters is that an obvious
 * match is found, that a doubtful one is marked doubtful, and that a row with nobody to match is
 * said to have nobody - because a screen that guesses puts one driver on another driver's load.
 */
const row = (over: Partial<MatchRow> = {}): MatchRow => ({
  id: 'dbr_1',
  name: 'Dorian Fenwick',
  coDriver: null,
  truckUnit: '0049',
  phone: '(773) 555-8525',
  ...over,
});

const driver = (over: Partial<MatchDriver> = {}): MatchDriver => ({
  id: 'drv_1',
  firstName: 'Dorian',
  lastName: 'Fenwick',
  phone: '773-555-8525',
  truckUnit: '49',
  status: 'active',
  hasRosterRow: true,
  ...over,
});

describe('the pieces a dispatcher would compare', () => {
  it('reads a truck number the way both systems mean it', () => {
    expect(unitKey('# 0053')).toBe('53');
    expect(unitKey('0053')).toBe(unitKey('53'));
    expect(unitKey('571E')).toBe('571E');
    expect(unitKey(null)).toBe('');
  });

  it('reads a phone number past its punctuation', () => {
    expect(phoneDigits('(773) 555-8525')).toBe('7735558525');
    expect(phoneDigits('+1 773 555 8525')).toBe('7735558525');
    expect(phoneDigits('')).toBe('');
  });

  it('sees the same name written in either order, and ignores a co-driver', () => {
    expect(nameAgreement('Dorian Fenwick', 'Fenwick Dorian')).toBe(1);
    expect(nameAgreement('DORIAN FENWICK // HOLLIS CENDRICK', 'Dorian Fenwick')).toBe(1);
    expect(nameAgreement('Dorian Fenwick', 'Hamid Ali')).toBe(0);
  });
});

describe('suggesting a driver file for a board row', () => {
  it('calls a name plus a truck an exact match', () => {
    const out = suggestMatches(row(), [driver()]);
    expect(out.candidates[0]?.confidence).toBe('exact');
    expect(out.candidates[0]?.reasons).toContain('name matches');
    expect(out.ambiguous).toBe(false);
    expect(out.none).toBe(false);
  });

  it('refuses to match on a truck number alone - trucks change hands', () => {
    const out = suggestMatches(row({ name: 'Somebody Else', phone: '' }), [driver()]);
    expect(out.none).toBe(true);
  });

  it('says plainly when there is no driver file to match', () => {
    const out = suggestMatches(row(), []);
    expect(out.none).toBe(true);
    expect(out.candidates).toEqual([]);
  });

  it('marks two equally good candidates ambiguous instead of picking one', () => {
    const twin = driver({ id: 'drv_2', truckUnit: null, phone: '' });
    const out = suggestMatches(row({ truckUnit: null, phone: '' }), [driver({ truckUnit: null, phone: '' }), twin]);
    expect(out.candidates.length).toBe(2);
    expect(out.ambiguous).toBe(true);
  });

  it('keeps a half-name match as possible, never strong', () => {
    const out = suggestMatches(row({ name: 'Dorian Something', truckUnit: null, phone: '' }), [driver({ truckUnit: null, phone: '' })]);
    expect(out.candidates[0]?.confidence).toBe('possible');
  });

  it('says when confirming would merge two board rows', () => {
    const out = suggestMatches(row(), [driver({ hasRosterRow: true })]);
    expect(out.candidates[0]?.hasRosterRow).toBe(true);
  });

  it('scores a phone match without a name as nothing', () => {
    expect(scoreCandidate(row({ name: 'Zzz Zzz', truckUnit: null }), driver({ truckUnit: null }))?.confidence).toBe('possible');
  });
});
