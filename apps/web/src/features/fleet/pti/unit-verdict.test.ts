import { unitAvailability, unitServiceStatus, type UnitStatusResult } from '@neway/shared';
import { describe, expect, it } from 'vitest';
import { headerVerdict } from './unit-verdict';

const free: UnitStatusResult = { availability: 'available', dispatchable: true, reasons: ['No load attached and no shop hold'] };
const inShop: UnitStatusResult = {
  availability: 'in_maintenance',
  dispatchable: false,
  reasons: ['An open work order has the unit in a shop'],
};
const onLoad: UnitStatusResult = { availability: 'assigned', dispatchable: false, reasons: ['Attached to a load'] };

describe('the truck header says one thing (§4.2)', () => {
  it('says nothing fit before the server has answered', () => {
    const verdict = headerVerdict({ service: undefined, availability: free });
    expect(verdict.status).toBe('loading');
    expect(verdict.label).toBe('Loading…');
  });

  it('an open oos_risk defect outranks everything, naming the defect and its release', () => {
    const service = unitServiceStatus([{ id: 'd1', defectNumber: 'DEF-4417', severity: 'oos_risk', state: 'open' }]);
    const verdict = headerVerdict({ service, availability: free });
    expect(verdict).toEqual({
      status: 'out_of_service',
      label: 'Out of service',
      reason: 'hold: DEF-4417',
      releaseCondition: 'released when DEF-4417 is verified',
    });
    // Also when the truck is in the shop for that very defect: the defect is still the reason.
    expect(headerVerdict({ service, availability: inShop }).status).toBe('out_of_service');
  });

  it('a defect proposed for verification still holds the unit', () => {
    const service = unitServiceStatus([{ id: 'd1', defectNumber: 'DEF-4417', severity: 'oos_risk', state: 'fixed_pending_verify' }]);
    expect(headerVerdict({ service, availability: free }).status).toBe('out_of_service');
  });

  it('a verified defect is gone, and the unit reads cleared with no other action', () => {
    const service = unitServiceStatus([{ id: 'd1', defectNumber: 'DEF-4417', severity: 'oos_risk', state: 'verified' }]);
    expect(headerVerdict({ service, availability: free })).toEqual({
      status: 'cleared',
      label: 'Cleared',
      reason: 'No open defects and no shop hold',
      releaseCondition: null,
    });
  });

  it('with no defect, the shop is the verdict - one pill, not "Available" beside "In maintenance"', () => {
    const service = unitServiceStatus([]);
    const verdict = headerVerdict({ service, availability: inShop });
    expect(verdict.status).toBe('in_shop');
    expect(verdict.label).toBe('In maintenance');
    expect(verdict.reason).toBe('An open work order has the unit in a shop');
    expect(verdict.releaseCondition).toMatch(/work order is closed/);
  });

  it('with no defect and no shop, the load is the verdict', () => {
    const verdict = headerVerdict({ service: unitServiceStatus([]), availability: onLoad });
    expect(verdict).toMatchObject({ status: 'assigned', label: 'Assigned', reason: 'Attached to a load' });
  });

  it('a driver in the truck and no load is still cleared to run (2026-10-22)', () => {
    const withDriver = unitAvailability({ status: 'available', driverAssigned: true });
    expect(withDriver.availability).toBe('assigned');
    const verdict = headerVerdict({ service: unitServiceStatus([]), availability: withDriver });
    expect(verdict).toMatchObject({ status: 'cleared', label: 'Cleared' });
  });

  it('watch and restricted carry their reason and, where there is one, their release', () => {
    const watch = headerVerdict({
      service: unitServiceStatus([{ id: 'd2', defectNumber: 'DEF-0002', severity: 'monitor', state: 'open' }]),
      availability: free,
    });
    expect(watch.status).toBe('watch');
    expect(watch.reason).toMatch(/DEF-0002/);
    const restricted = headerVerdict({
      service: unitServiceStatus([{ id: 'd3', defectNumber: 'DEF-0003', severity: 'replace_now', state: 'assigned' }]),
      availability: free,
    });
    expect(restricted.status).toBe('restricted');
    expect(restricted.releaseCondition).toBe('released when DEF-0003 is verified');
  });
});
