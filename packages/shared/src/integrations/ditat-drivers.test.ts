import { describe, expect, it } from 'vitest';
import {
  certificateStatus,
  isoFromUs,
  placeholderEmail,
  planDrivers,
  type DitatDriverRow,
  type ExistingDriver,
} from './ditat-drivers.js';

const TODAY = '2026-09-25';

function row(over: Partial<DitatDriverRow> = {}): DitatDriverRow {
  return {
    driverId: '42',
    status: 'Driving',
    driverType: 'Leased driver',
    firstName: 'Jose',
    lastName: 'Ramirez',
    phone: '3125550177',
    email: 'Jose@Example.com',
    city: 'Springfield',
    state: 'fl',
    licenceState: 'fl',
    licenceClass: 'A',
    licenceExpiresOn: '11/26/2030',
    physicalExpiresOn: '03/01/2027',
    hiredOn: '02/03/2024',
    truckId: '9901',
    trailerId: '',
    endorsements: { hazmat: 'Yes', tanker: 'No', hazmatTanker: 'No', doubleTriple: 'No', passenger: 'No', schoolBus: 'No' },
    ...over,
  };
}

function driver(over: Partial<ExistingDriver> = {}): ExistingDriver {
  return {
    id: 'drv_0042',
    driverNumber: '42',
    firstName: 'Jose',
    lastName: 'Ramirez',
    phone: '3125550177',
    email: 'jose@example.com',
    homeCity: 'Springfield',
    homeState: 'FL',
    cdlExpiresOn: '2030-11-26',
    medicalCardExpiresOn: '2027-03-01',
    currentTruckId: null,
    source: 'ditat',
    externalId: '42',
    ...over,
  };
}

describe('the first run', () => {
  it('creates the driver with the licence, the endorsements and the truck Ditat gave', () => {
    const [r] = planDrivers([row()], [], TODAY).rows;
    expect(r?.outcome).toBe('create');
    expect(r?.values).toMatchObject({
      driverNumber: '42',
      firstName: 'Jose',
      driverType: 'lease_operator',
      cdlState: 'FL',
      cdlClass: 'A',
      cdlExpiresOn: '2030-11-26',
      medicalCardExpiresOn: '2027-03-01',
      medicalCardStatus: 'verified',
      hireDate: '2024-02-03',
      status: 'available',
      homeState: 'FL',
      truckUnitNumber: '9901',
      externalId: '42',
    });
    expect(r?.values?.cdlEndorsements).toEqual(['H']);
    expect(r?.values?.email).toBe('jose@example.com');
  });

  it('gives a driver with no email an address nobody can mistake for one', () => {
    const r = planDrivers([row({ email: '' })], [], TODAY).rows[0];
    expect(r?.values?.email).toBe(placeholderEmail('42'));
    expect(r?.values?.email).toContain('.invalid');
  });

  it('leaves a missing medical card empty and says so in the status', () => {
    const r = planDrivers([row({ physicalExpiresOn: '' })], [], TODAY).rows[0];
    expect(r?.values?.medicalCardExpiresOn).toBeNull();
    expect(r?.values?.medicalCardStatus).toBe('missing');
  });
});

describe('who it will not import', () => {
  it('leaves everyone Ditat does not have driving', () => {
    const plan = planDrivers(
      [row({ driverId: '1', status: 'Terminated' }), row({ driverId: '2', status: 'On leave' }), row({ driverId: '3', status: 'Applicant' })],
      [],
      TODAY,
    );
    expect(plan.counts.create).toBe(0);
    expect(plan.counts.skip).toBe(3);
  });

  it('refuses a licence with no class, an unreadable expiry or no hire date, saying which', () => {
    const plan = planDrivers(
      [
        row({ driverId: '1', licenceClass: 'Unknown' }),
        row({ driverId: '2', licenceExpiresOn: '' }),
        row({ driverId: '3', hiredOn: '' }),
      ],
      [],
      TODAY,
    );
    expect(plan.counts.skip).toBe(3);
    expect(Object.keys(plan.skippedBy).join(' ')).toContain('not A or B');
  });
});

describe('the second run', () => {
  it('creates nothing', () => {
    const plan = planDrivers([row()], [driver()], TODAY);
    expect(plan.counts.unchanged).toBe(1);
    expect(plan.counts.create).toBe(0);
  });

  it('updates in place when Ditat has moved on', () => {
    const plan = planDrivers([row({ phone: '5610000000' })], [driver()], TODAY);
    expect(plan.counts.update).toBe(1);
    expect(plan.rows[0]?.targetId).toBe('drv_0042');
  });
});

describe('a driver already here', () => {
  it('adopts one whose name and CDL expiry both agree, filling only the gaps', () => {
    const here = driver({ source: null, externalId: null, phone: '', medicalCardExpiresOn: null });
    const plan = planDrivers([row()], [here], TODAY);
    expect(plan.counts.adopt).toBe(1);
    expect(plan.rows[0]?.values).toEqual({
      source: 'ditat',
      externalId: '42',
      phone: '3125550177',
      medicalCardExpiresOn: '2027-03-01',
      medicalCardStatus: 'verified',
    });
  });

  it('leaves a name-only match for a person and writes nothing', () => {
    const here = driver({ source: null, externalId: null, cdlExpiresOn: '2028-01-01' });
    const plan = planDrivers([row()], [here], TODAY);
    expect(plan.counts.review).toBe(1);
    expect(plan.rows[0]?.values).toBeNull();
  });
});

describe('the small conversions', () => {
  it('reads an American date, and refuses anything that is not one', () => {
    expect(isoFromUs('3/1/2027')).toBe('2027-03-01');
    expect(isoFromUs('')).toBeNull();
    expect(isoFromUs('soon')).toBeNull();
  });

  it('calls a certificate expired, expiring inside thirty days, or verified', () => {
    expect(certificateStatus('2026-09-24', TODAY)).toBe('expired');
    expect(certificateStatus('2026-10-10', TODAY)).toBe('expiring');
    expect(certificateStatus('2027-01-01', TODAY)).toBe('verified');
    expect(certificateStatus(null, TODAY)).toBe('missing');
  });
});
