import { describe, expect, it } from 'vitest';
import { brokerKey, mcKey, planBrokers, type DitatCustomerRow, type ExistingBroker } from './ditat-brokers.js';

function row(over: Partial<DitatCustomerRow> = {}): DitatCustomerRow {
  return {
    customerId: 'CUST-1',
    company: 'Prime Logistics Inc.',
    firstName: 'Dana',
    lastName: 'Reed',
    phone: '312-555-0100',
    email: 'Dana@Prime.com',
    address1: '100 W Monroe',
    address2: 'Suite 400',
    municipality: 'Chicago',
    administrativeArea: 'il',
    postalCode: '60603',
    mcOrFFNumber: 'MC-123456',
    paymentTermsDays: '30',
    isOnCreditHold: 'No',
    isActive: 'Yes',
    ...over,
  };
}

function broker(over: Partial<ExistingBroker> = {}): ExistingBroker {
  return {
    id: 'brk_01',
    name: 'Prime Logistics Inc.',
    mcNumber: 'MC-123456',
    usdot: '',
    address: { line1: '100 W Monroe, Suite 400', city: 'Chicago', state: 'IL', zip: '60603' },
    paymentTermsDays: 30,
    status: 'active',
    primaryContact: { name: 'Dana Reed', email: 'dana@prime.com', phone: '312-555-0100' },
    source: 'ditat',
    externalId: 'CUST-1',
    ...over,
  };
}

describe('the first run', () => {
  it('creates a broker with its address, terms and contact', () => {
    const [r] = planBrokers([row()], []).rows;
    expect(r?.outcome).toBe('create');
    expect(r?.values).toMatchObject({
      name: 'Prime Logistics Inc.',
      mcNumber: 'MC-123456',
      paymentTermsDays: 30,
      status: 'active',
      source: 'ditat',
      externalId: 'CUST-1',
    });
    expect(r?.values?.address).toEqual({ line1: '100 W Monroe, Suite 400', city: 'Chicago', state: 'IL', zip: '60603' });
    expect(r?.values?.primaryContact?.email).toBe('dana@prime.com');
  });

  it('reads a credit hold as on_hold and an inactive customer as inactive', () => {
    expect(planBrokers([row({ isOnCreditHold: 'Yes' })], []).rows[0]?.values?.status).toBe('on_hold');
    expect(planBrokers([row({ isActive: 'No' })], []).rows[0]?.values?.status).toBe('inactive');
  });

  it('falls back to the contact name when the company column is empty', () => {
    expect(planBrokers([row({ company: '' })], []).rows[0]?.name).toBe('Dana Reed');
  });
});

describe('the second run', () => {
  it('creates nothing', () => {
    const plan = planBrokers([row()], [broker()]);
    expect(plan.counts.create).toBe(0);
    expect(plan.counts.unchanged).toBe(1);
  });

  it('updates in place when Ditat has moved on', () => {
    const plan = planBrokers([row({ paymentTermsDays: '45' })], [broker()]);
    expect(plan.counts.update).toBe(1);
    expect(plan.rows[0]?.values?.paymentTermsDays).toBe(45);
  });
});

describe('what it will not merge', () => {
  it('adopts a broker already here when the name and the MC number agree', () => {
    const here = broker({ id: 'brk_local', source: null, externalId: null });
    const plan = planBrokers([row()], [here]);
    expect(plan.counts.adopt).toBe(1);
    expect(plan.rows[0]?.values).toEqual({ source: 'ditat', externalId: 'CUST-1' });
  });

  it('leaves a name-only match for a person and writes nothing', () => {
    const here = broker({ id: 'brk_local', source: null, externalId: null, mcNumber: '' });
    const plan = planBrokers([row()], [here]);
    expect(plan.counts.review).toBe(1);
    expect(plan.rows[0]?.values).toBeNull();
    expect(plan.rows[0]?.note).toContain('name only');
  });

  it('skips a row with no id or no name, saying which', () => {
    const plan = planBrokers([row({ customerId: '' }), row({ customerId: 'C2', company: '', firstName: '', lastName: '' })], []);
    expect(plan.counts.skip).toBe(2);
    expect(Object.keys(plan.skippedBy).join(' ')).toContain('customer id');
  });

  it('takes the first of two rows sharing a customer id', () => {
    const plan = planBrokers([row(), row({ company: 'Another' })], []);
    expect(plan.counts.create).toBe(1);
    expect(plan.rows[1]?.note).toContain('appears twice');
  });
});

describe('the keys it compares on', () => {
  it('reads one company name through its punctuation and suffixes', () => {
    expect(brokerKey('Prime Logistics, Inc.')).toBe(brokerKey('PRIME logistics inc'));
    expect(brokerKey('Prime')).toBe(brokerKey('Prime Trucking LLC'));
  });

  it('reads an MC number through its prefix, and refuses a short one as a key', () => {
    expect(mcKey('MC-123456')).toBe('123456');
    expect(mcKey('123456')).toBe('123456');
    expect(mcKey('MC')).toBe('');
  });
});
