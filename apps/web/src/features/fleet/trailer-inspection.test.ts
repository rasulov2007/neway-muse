import { describe, expect, it } from 'vitest';
import { nextTrailerInspection } from './trailer-inspection';
import { unitHeaderLine, unitIdentity } from './unit-header';

type Doc = Parameters<typeof nextTrailerInspection>[1][number];

function doc(over: Partial<Doc> = {}): Doc {
  return {
    requirementCode: 'trailer_annual_inspection',
    status: 'pending_review',
    expiresOn: '2026-12-03',
    version: 1,
    uploadedAt: '2026-09-01T00:00:00.000Z',
    ...over,
  };
}

describe('nextTrailerInspection', () => {
  it('uses the trailer’s own date when no certificate is on file', () => {
    expect(nextTrailerInspection('2027-01-15', [])).toEqual({ date: '2027-01-15', source: 'column' });
  });

  it('uses the certificate when the trailer has no date (trailer 534263)', () => {
    expect(nextTrailerInspection(null, [doc()])).toEqual({ date: '2026-12-03', source: 'document' });
  });

  it('takes the later of the two', () => {
    expect(nextTrailerInspection('2026-06-01', [doc()])).toEqual({ date: '2026-12-03', source: 'document' });
    expect(nextTrailerInspection('2027-03-01', [doc()])).toEqual({ date: '2027-03-01', source: 'column' });
  });

  it('lets a newer typed date win over an expired certificate (trailer 904502)', () => {
    expect(nextTrailerInspection('2026-11-30', [doc({ expiresOn: '2025-12-18' })])).toEqual({
      date: '2026-11-30',
      source: 'column',
    });
    // With nothing typed, the expired certificate's date is still the answer: it is overdue.
    expect(nextTrailerInspection(null, [doc({ expiresOn: '2025-12-18' })]).date).toBe('2025-12-18');
  });

  it('ignores a rejected (voided) certificate, other types and a certificate without an expiry', () => {
    expect(
      nextTrailerInspection(null, [
        doc({ status: 'rejected', expiresOn: '2027-06-01' }),
        doc({ requirementCode: 'trailer_registration', expiresOn: '2028-01-01' }),
        doc({ expiresOn: null }),
      ]),
    ).toEqual({ date: null, source: null });
  });

  it('reads the newest version of the certificate, not the latest date', () => {
    const r = nextTrailerInspection(null, [
      doc({ version: 1, expiresOn: '2027-05-01' }),
      doc({ version: 2, expiresOn: '2027-04-01' }),
    ]);
    expect(r.date).toBe('2027-04-01');
  });
});

describe('unit header line', () => {
  it('drops missing parts with their separators', () => {
    expect(unitHeaderLine([null, null], '1GR1P062XNT000303')).toBe('VIN 1GR1P062XNT000303');
    expect(unitHeaderLine([2022, 'Great Dane'], 'ABC')).toBe('2022 Great Dane · VIN ABC');
    expect(unitHeaderLine([null, 'Utility'], '')).toBe('Utility');
    expect(unitHeaderLine([null, null], null)).toBe('');
    expect(unitIdentity([0, '', 'null', 'Freightliner', 'Cascadia'])).toBe('Freightliner Cascadia');
  });
});
