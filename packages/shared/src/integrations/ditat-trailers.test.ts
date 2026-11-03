import { describe, expect, it } from 'vitest';
import {
  planTrailers,
  unitKey,
  type DitatTrailerRow,
  type ExistingTrailer,
} from './ditat-trailers.js';

/**
 * The rule this holds above all others: a second run creates nothing. The ladder is what makes
 * that true, so each rung is tested on its own, and the re-run is tested as a whole.
 */
function row(over: Partial<DitatTrailerRow> = {}): DitatTrailerRow {
  return {
    trailerId: '904490',
    trailerType: 'Dry Van',
    isActive: 'Yes',
    vin: '1GR1P062XNT000303',
    make: 'Great Dane',
    model: '',
    makeYear: '2022',
    plateNumber: 'ABC123',
    plateState: 'il',
    ownerType: 'Company',
    ...over,
  };
}

function existing(over: Partial<ExistingTrailer> = {}): ExistingTrailer {
  return {
    id: 'trl_904490',
    unitNumber: '904490',
    vin: '1GR1P062XNT000303',
    make: 'Great Dane',
    year: 2022,
    type: 'dry_van',
    plate: 'ABC123',
    plateState: 'IL',
    status: 'available',
    ownership: 'owned',
    source: 'ditat',
    externalId: '904490',
    ...over,
  };
}

describe('the first run into an empty workspace', () => {
  it('creates every real trailer and skips Ditat’s own sample row', () => {
    const plan = planTrailers([row(), row({ trailerId: 'DitatTRL' }), row({ trailerId: '904505' })], []);
    expect(plan.counts.create).toBe(2);
    expect(plan.counts.skip).toBe(1);
    expect(Object.keys(plan.skippedBy)[0]).toContain('sample record');
  });

  it('maps the fields a person would check', () => {
    const [created] = planTrailers([row()], []).rows;
    expect(created?.values).toMatchObject({
      unitNumber: '904490',
      vin: '1GR1P062XNT000303',
      year: 2022,
      type: 'dry_van',
      plateState: 'IL',
      status: 'available',
      ownership: 'owned',
      source: 'ditat',
      externalId: '904490',
    });
  });

  it('marks an inactive trailer out of service rather than dropping it', () => {
    const [r] = planTrailers([row({ isActive: 'No' })], []).rows;
    expect(r?.values.status).toBe('out_of_service');
  });
});

describe('the second run', () => {
  it('creates nothing and reports the rows unchanged', () => {
    const plan = planTrailers([row()], [existing()]);
    expect(plan.counts.create).toBe(0);
    expect(plan.counts.unchanged).toBe(1);
    expect(plan.rows[0]?.values).toEqual({});
  });

  it('updates in place when Ditat has moved on', () => {
    const plan = planTrailers([row({ plateNumber: 'XYZ999' })], [existing()]);
    expect(plan.counts.update).toBe(1);
    expect(plan.rows[0]?.targetId).toBe('trl_904490');
    expect(plan.rows[0]?.values.plate).toBe('XYZ999');
  });
});

describe('a trailer that is already here under its own number', () => {
  it('adopts it, fills only what is empty, and asks for a person', () => {
    const here = existing({
      id: 'trl_local',
      source: null,
      externalId: null,
      vin: '',
      make: null,
      year: null,
      plate: 'KEEPME',
    });
    const plan = planTrailers([row({ plateNumber: 'FROM-DITAT' })], [here]);
    expect(plan.counts.adopt).toBe(1);
    const [r] = plan.rows;
    expect(r?.targetId).toBe('trl_local');
    expect(r?.values).toMatchObject({ source: 'ditat', externalId: '904490', vin: '1GR1P062XNT000303', year: 2022 });
    // The plate somebody typed here is not overwritten by the import.
    expect(r?.values.plate).toBeUndefined();
    expect(r?.note).toContain('Confirm');
  });

  it('matches a unit number across leading zeros', () => {
    expect(unitKey('0049')).toBe(unitKey('49'));
    const plan = planTrailers([row({ trailerId: '0049' })], [existing({ unitNumber: '49', source: null, externalId: null })]);
    expect(plan.counts.adopt).toBe(1);
  });
});

describe('what it refuses to guess', () => {
  it('skips a trailer type with no equivalent here, and says so', () => {
    const plan = planTrailers([row({ trailerType: 'Curtain Side' })], []);
    expect(plan.counts.skip).toBe(1);
    expect(plan.rows[0]?.note).toContain('Curtain Side');
  });

  it('skips a row with no trailer number', () => {
    expect(planTrailers([row({ trailerId: '  ' })], []).counts.skip).toBe(1);
  });

  it('takes the first of two rows claiming one number and says the second was dropped', () => {
    const plan = planTrailers([row(), row({ vin: 'OTHER' })], []);
    expect(plan.counts.create).toBe(1);
    expect(plan.rows[1]?.note).toContain('appears twice');
  });
});

describe('a trailer retired here', () => {
  for (const status of ['inactive', 'sold', 'archived']) {
    it(`keeps ${status} when Ditat says the trailer is not active`, () => {
      const plan = planTrailers([row({ isActive: 'No' })], [existing({ status })]);
      const [r] = plan.rows;
      expect(r?.statusKept).toBe(status);
      // Nothing else differs, so there is nothing to write at all.
      expect(r?.outcome).toBe('unchanged');
      expect(r?.values.status).toBeUndefined();
    });

    it(`keeps ${status} when Ditat says the trailer is active, and reports it`, () => {
      const plan = planTrailers([row({ isActive: 'Yes', plateNumber: 'NEW1' })], [existing({ status })]);
      const [r] = plan.rows;
      expect(r?.outcome).toBe('update');
      expect(r?.values.status).toBe(status);
      expect(r?.values.plate).toBe('NEW1');
      expect(r?.statusKept).toBe(status);
      expect(r?.note).toContain('Status kept');
    });
  }

  it('still moves an available trailer out of service when Ditat retires it', () => {
    const plan = planTrailers([row({ isActive: 'No' })], [existing({ status: 'available' })]);
    expect(plan.rows[0]?.values.status).toBe('out_of_service');
    expect(plan.rows[0]?.statusKept).toBeUndefined();
  });
});
