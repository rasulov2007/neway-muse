import { describe, expect, it } from 'vitest';
import { CdlMuseAnswerSchema, cdlDate, cdlReadingFromAnswer, sameName, type CdlMuseAnswer } from './cdl-reading.js';

const sure = <T>(value: T, confidence = 0.97) => ({ value, confidence });

const answer = (over: Partial<CdlMuseAnswer> = {}): CdlMuseAnswer => ({
  isDriverLicence: true,
  isCommercial: true,
  legalFirstName: sure('JORDAN'),
  legalMiddleName: sure('LEE'),
  legalLastName: sure('SAMPLETON'),
  dateOfBirth: sure('03/14/1988'),
  cdlNumber: sure('DL S123-456-789'),
  issuingState: sure('il'),
  cdlClass: sure('CLASS A'),
  endorsements: sure(['N, T']),
  restrictions: sure(['NONE']),
  cdlIssuedOn: sure('2024-06-01'),
  cdlExpiresOn: sure('06/01/2028'),
  ...over,
});

const application = {
  legalFirstName: 'Jordan',
  legalLastName: 'Sampleton',
  dateOfBirth: '1988-03-14',
  licences: [{ state: 'IL', number: 'S123456789', expiresOn: '2028-06-01' }],
};

describe('cdlDate', () => {
  it('reads US and ISO dates without a time zone', () => {
    expect(cdlDate('03/14/1988')).toBe('1988-03-14');
    expect(cdlDate('3-4-2029')).toBe('2029-03-04');
    expect(cdlDate('2028-06-01')).toBe('2028-06-01');
  });
  it('refuses dates that are not on the calendar', () => {
    expect(cdlDate('02/30/2027')).toBeNull();
    expect(cdlDate('13/01/2027')).toBeNull();
    expect(cdlDate('soon')).toBeNull();
    expect(cdlDate('2024-02-29')).toBe('2024-02-29');
  });
});

describe('sameName', () => {
  it('ignores case, accents and punctuation', () => {
    expect(sameName("O'Neil", 'ONEIL')).toBe(true);
    expect(sameName('José', 'JOSE')).toBe(true);
    expect(sameName('Jordan', 'Jordyn')).toBe(false);
    expect(sameName('', '')).toBe(false);
  });
});

describe('cdlReadingFromAnswer', () => {
  it('turns a clean read into a tidy extract with no warnings when it matches the application', () => {
    const r = cdlReadingFromAnswer(answer(), { application, today: '2026-11-03' });
    expect(r.extract).toMatchObject({
      legalFirstName: 'JORDAN',
      legalLastName: 'SAMPLETON',
      dateOfBirth: '1988-03-14',
      cdlNumber: 'S123-456-789',
      issuingState: 'IL',
      cdlClass: 'A',
      endorsements: ['N', 'T'],
      restrictions: [],
      cdlIssuedOn: '2024-06-01',
      cdlExpiresOn: '2028-06-01',
      source: 'ocr',
      needsReview: [],
    });
    expect(r.warnings).toEqual([]);
    expect(r.compared).toBe(true);
  });

  it('marks unsure and unreadable fields for review', () => {
    const r = cdlReadingFromAnswer(
      answer({ dateOfBirth: sure('1988-03-14', 0.55), cdlIssuedOn: sure('31/31/2024'), cdlNumber: sure(null, 0.2) }),
      { application, today: '2026-11-03' },
    );
    expect(r.extract.needsReview).toEqual(['dateOfBirth', 'cdlNumber', 'cdlIssuedOn']);
    expect(r.extract.cdlIssuedOn).toBeNull();
    expect(r.confidence.dateOfBirth).toBe(0.55);
  });

  it('accepts a percentage confidence', () => {
    const r = cdlReadingFromAnswer(answer({ legalFirstName: sure('JORDAN', 92) }), { application, today: '2026-11-03' });
    expect(r.confidence.legalFirstName).toBe(0.92);
  });

  it('warns when the card disagrees with what the candidate typed', () => {
    const r = cdlReadingFromAnswer(
      answer({ legalFirstName: sure('JORDYN'), dateOfBirth: sure('1988-04-14') }),
      { application, today: '2026-11-03' },
    );
    expect(r.warnings.map((w) => w.field)).toEqual(['legalFirstName', 'dateOfBirth']);
    expect(r.warnings.every((w) => w.tone === 'warning')).toBe(true);
  });

  it('warns on a licence number the application does not list, and on another state', () => {
    expect(
      cdlReadingFromAnswer(answer({ cdlNumber: sure('X999') }), { application, today: '2026-11-03' }).warnings[0]?.field,
    ).toBe('cdlNumber');
    expect(
      cdlReadingFromAnswer(answer({ issuingState: sure('IN') }), { application, today: '2026-11-03' }).warnings[0],
    ).toMatchObject({ field: 'issuingState', tone: 'warning' });
  });

  it('says an expired or soon-expiring licence, and a non-licence file, as urgent / warning', () => {
    expect(cdlReadingFromAnswer(answer(), { application, today: '2028-06-02' }).warnings[0]).toMatchObject({
      field: 'cdlExpiresOn',
      tone: 'urgent',
    });
    expect(cdlReadingFromAnswer(answer(), { application, today: '2028-05-20' }).warnings[0]).toMatchObject({
      field: 'cdlExpiresOn',
      tone: 'warning',
    });
    expect(
      cdlReadingFromAnswer(answer({ isDriverLicence: false }), { application, today: '2026-11-03' }).warnings[0],
    ).toMatchObject({ field: 'document', tone: 'urgent' });
  });

  it('says when there is nothing to compare with', () => {
    const r = cdlReadingFromAnswer(answer(), { application: null, today: '2026-11-03' });
    expect(r.compared).toBe(false);
    expect(r.warnings).toEqual([expect.objectContaining({ tone: 'info', field: 'document' })]);
  });

  it('the wire schema refuses an answer with a field missing', () => {
    const { cdlNumber: _drop, ...partial } = answer();
    expect(CdlMuseAnswerSchema.safeParse(partial).success).toBe(false);
    expect(CdlMuseAnswerSchema.safeParse(answer()).success).toBe(true);
  });
});
