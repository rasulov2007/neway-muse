import { describe, expect, it } from 'vitest';
import { parseCdlText, parseMedicalCardText, toIsoDate } from './credential-ocr';

/**
 * The text below is what recognition actually returns from a photographed card: upper case, the
 * AAMVA field numbers still attached, and lines in the order they appear on the plastic. The rule
 * under test is that the *right* date is picked — a birth date read as an expiry is a driver who
 * looks qualified for forty years.
 */

const ILLINOIS_CDL = `
ILLINOIS
DRIVER'S LICENSE
4d DLN  W123-4567-8901
1 WILSON
2 JAMES R
8 1200 W FULTON ST CHICAGO IL 60607
3 DOB 03/12/1984
4a ISS 05/14/2025   4b EXP 05/14/2029
9 CLASS A     9a END H N
12 REST NONE
`;

const TEXAS_CDL = `
TEXAS
COMMERCIAL DRIVER LICENSE
DL NO 41234567
LAST HERNANDEZ
FIRST MARIA
CLASS: B
END: T
EXPIRES 11/02/2027
ISSUED 11/02/2023
DOB 07/21/1990
`;

const MEDICAL_CARD = `
MEDICAL EXAMINER'S CERTIFICATE
Driver: James Wilson
Examiner's name: Dr. Alan Reyes, DO
National Registry No. 1234567890
Issued: 06/02/2025
Expiration date: 06/02/2027
`;

describe('reading a date off a card', () => {
  it('keeps the day the card prints, whatever the time zone', () => {
    expect(toIsoDate('05/14/2029')).toBe('2029-05-14');
    expect(toIsoDate('5-14-29')).toBe('2029-05-14');
    expect(toIsoDate('11.02.2027')).toBe('2027-11-02');
    // The classic failure: parsing to a Date and formatting back a day early.
    expect(toIsoDate('01/01/2030')).toBe('2030-01-01');
  });

  it('refuses what is not a date rather than inventing one', () => {
    expect(toIsoDate('')).toBeNull();
    expect(toIsoDate('13/45/2029')).toBeNull();
    expect(toIsoDate('CLASS A')).toBeNull();
  });
});

describe('the front of a licence', () => {
  it('reads the AAMVA fields off an Illinois card', () => {
    const read = parseCdlText(ILLINOIS_CDL);
    expect(read.expiresOn).toBe('2029-05-14');
    expect(read.issuedOn).toBe('2025-05-14');
    expect(read.state).toBe('IL');
    expect(read.cdlClass).toBe('A');
    expect(read.endorsements).toEqual(['H', 'N']);
    expect(read.licenceNumber).toBe('W123-4567-8901');
    expect(read.lastName).toBe('Wilson');
  });

  it('reads a card that prints words instead of field numbers', () => {
    const read = parseCdlText(TEXAS_CDL);
    expect(read.expiresOn).toBe('2027-11-02');
    expect(read.state).toBe('TX');
    expect(read.cdlClass).toBe('B');
    expect(read.endorsements).toEqual(['T']);
  });

  it('never mistakes the birth date for the expiry', () => {
    for (const card of [ILLINOIS_CDL, TEXAS_CDL]) {
      const read = parseCdlText(card);
      expect(read.expiresOn).not.toBe('1984-03-12');
      expect(read.expiresOn).not.toBe('1990-07-21');
      expect(read.issuedOn).not.toBe('1984-03-12');
    }
  });

  it('leaves a field empty when the card does not say', () => {
    const read = parseCdlText('SOME UNREADABLE SMUDGE');
    expect(read.expiresOn).toBeNull();
    expect(read.cdlClass).toBeNull();
    expect(read.state).toBeNull();
    expect(read.endorsements).toEqual([]);
  });
});

/**
 * What recognition returns from a photograph of a real Florida licence: no field numbers survive,
 * the headings are in the text, and the surname and given name sit on their own lines above the
 * address. The names still have to come out.
 */
const FLORIDA_PHOTO = `
FLORIDA
USA DRIVER LICENSE
DLN J210-780-91-261-0
STEVENSON
JOSEPH
5750 MAROON PEAK DR
RUSKIN, FL 33573
DOB 07/21/1991
ISS 07/21/2023  EXP 07/21/2030
CLASS A
END NONE   REST NONE
SAFE DRIVER
`;

describe('the name on the card', () => {
  it('reads the numbered fields when the scan keeps them', () => {
    const read = parseCdlText(ILLINOIS_CDL);
    expect(read.lastName).toBe('Wilson');
    expect(read.firstName).toBe('James');
  });

  it('reads the words when a state prints those instead', () => {
    const read = parseCdlText(TEXAS_CDL);
    expect(read.lastName).toBe('Hernandez');
    expect(read.firstName).toBe('Maria');
  });

  it('reads a photographed card that kept neither', () => {
    const read = parseCdlText(FLORIDA_PHOTO);
    expect(read.lastName).toBe('Stevenson');
    expect(read.firstName).toBe('Joseph');
    // And the rest of that card still reads correctly.
    expect(read.expiresOn).toBe('2030-07-21');
    expect(read.state).toBe('FL');
  });

  it('takes no heading, no state and no address line for a name', () => {
    const read = parseCdlText(`
TEXAS
COMMERCIAL DRIVER LICENSE
CLASS
NONE
`);
    expect(read.lastName).toBeNull();
    expect(read.firstName).toBeNull();
  });

  it('drops a middle initial rather than putting it in the first name', () => {
    const read = parseCdlText(`
OHIO
DRIVER LICENSE
BRENNAN
THOMAS R
EXP 04/09/2029
`);
    expect(read.firstName).toBe('Thomas');
  });
});

describe('the medical certificate', () => {
  it('takes the expiry, not the issue date', () => {
    const read = parseMedicalCardText(MEDICAL_CARD);
    expect(read.expiresOn).toBe('2027-06-02');
    expect(read.issuedOn).toBe('2025-06-02');
    expect(read.examinerName).toContain('Alan Reyes');
  });

  it('returns nothing readable rather than a guess', () => {
    expect(parseMedicalCardText('CERTIFICATE').expiresOn).toBeNull();
  });
});
