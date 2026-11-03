import { describe, expect, it } from 'vitest';
import { normalizeAddress, vendorNameFor } from './address-norm';

describe('shop addresses are compared by number, street and ZIP (04-sheet-import §4)', () => {
  it('collapses the three Naperville spellings into one key', () => {
    const keys = [
      '1101 Frontenac Rd, Naperville, IL 60563, USA',
      '1101 Frontenac Rd, Naperville, IL 60563, United States',
      '1101 Frontenac RD Naperville, IL 60563',
    ].map((a) => normalizeAddress(a).key);
    expect(new Set(keys).size).toBe(1);
    expect(keys[0]).toBe('1101|frontenac road|60563');
  });

  it('reads the town for the vendor record, with or without the comma', () => {
    const a = normalizeAddress('1101 Frontenac RD Naperville, IL 60563');
    expect(a).toMatchObject({ number: '1101', street: 'frontenac road', city: 'Naperville', state: 'IL', zip: '60563' });
    const b = normalizeAddress('8501 Hegerman Street Philadelphia, PA 19136');
    expect(b).toMatchObject({ street: 'hegerman street', city: 'Philadelphia', state: 'PA', zip: '19136' });
    expect(b.line).toBe('8501 Hegerman Street');
    expect(vendorNameFor(b)).toBe('8501 Hegerman Street, Philadelphia, PA');
    // The city keeps its own spelling: St. Charles is not a street.
    const c = normalizeAddress('510 S Tyler Rd, St. Charles, IL 60174, United States');
    expect(c).toMatchObject({ key: '510|s tyler road|60174', city: 'St Charles', state: 'IL' });
    expect(vendorNameFor(c)).toBe('510 S Tyler Rd, St Charles, IL');
  });

  it('keeps different ZIPs apart even on the same street', () => {
    const a = normalizeAddress('2950 Roy Orr Blvd, Grand Prairie, TX 75050, United States').key;
    const b = normalizeAddress('2950 Roy Orr Blvd, Grand Prairie, TX 75051').key;
    expect(a).toBe('2950|roy orr boulevard|75050');
    expect(b).not.toBe(a);
  });

  it('handles a route number and a pike, and gives up on an address with no number or ZIP', () => {
    expect(normalizeAddress('11166 IN-10, De Motte, IN 46310, United States')).toMatchObject({ key: '11166|in 10|46310', city: 'De Motte', state: 'IN' });
    expect(normalizeAddress('7777 Burlington Pike, Florence, KY 41042, United States').key).toBe('7777|burlington pike|41042');
    expect(normalizeAddress('Naperville yard').key).toBeNull();
    expect(normalizeAddress('').key).toBeNull();
    expect(normalizeAddress(null).line).toBe('');
  });
});
