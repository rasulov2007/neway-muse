import { describe, expect, it } from 'vitest';
import {
  fleetSize,
  isActiveUnit,
  isLateWorkOrder,
  isOutOfService,
  isOverduePm,
  pmPosition,
} from './counts.js';
import { buildFleetExceptions } from './exceptions.js';

const TODAY = '2026-09-16';

describe('isLateWorkOrder', () => {
  it('is late when the promised date has gone by and the job is not finished', () => {
    expect(isLateWorkOrder({ status: 'in_shop', promisedAt: '2026-09-14T12:00:00Z' }, TODAY)).toBe(
      true,
    );
  });

  it('gives the shop the whole day it promised', () => {
    expect(isLateWorkOrder({ status: 'in_shop', promisedAt: `${TODAY}T23:00:00Z` }, TODAY)).toBe(
      false,
    );
  });

  it('is never late once the work is done', () => {
    expect(
      isLateWorkOrder(
        { status: 'in_shop', promisedAt: '2026-09-01T12:00:00Z', completedAt: '2026-09-02' },
        TODAY,
      ),
    ).toBe(false);
    expect(
      isLateWorkOrder({ status: 'completed', promisedAt: '2026-09-01T12:00:00Z' }, TODAY),
    ).toBe(false);
  });

  it('cannot be late with nothing promised', () => {
    expect(isLateWorkOrder({ status: 'open', promisedAt: null }, TODAY)).toBe(false);
  });
});

describe('preventive maintenance', () => {
  const overdueUnit = {
    status: 'available',
    odometer: 310_000,
    nextServiceOdometer: 300_000,
    nextServiceDate: null,
  };

  it('is overdue past the service limit', () => {
    expect(isOverduePm(overdueUnit, TODAY)).toBe(true);
  });

  it('is not overdue for a unit that has left the fleet', () => {
    // 2734 was Retired and still being told its PM was due soon.
    expect(isOverduePm({ ...overdueUnit, status: 'retired' }, TODAY)).toBe(false);
    expect(isOverduePm({ ...overdueUnit, status: 'sold' }, TODAY)).toBe(false);
  });

  it('calls a booked unit scheduled rather than due soon', () => {
    const booked = {
      status: 'available',
      odometer: 299_000,
      nextServiceOdometer: 300_000,
      nextServiceDate: null,
      scheduledFor: '2026-09-22',
    };
    expect(pmPosition(booked, TODAY).urgency).toBe('scheduled');
    expect(pmPosition({ ...booked, scheduledFor: null }, TODAY).urgency).toBe('due_soon');
  });
});

describe('fleet size', () => {
  it('counts active units and nothing else', () => {
    const units = [
      { status: 'available' },
      { status: 'in_shop' },
      { status: 'sold' },
      { status: 'inactive' },
      { status: 'retired' },
    ];
    expect(fleetSize(units)).toBe(2);
    expect(isActiveUnit('available')).toBe(true);
    expect(isActiveUnit(undefined)).toBe(true);
  });

  it('knows which statuses mean off the road', () => {
    expect(isOutOfService('out_of_service')).toBe(true);
    expect(isOutOfService('in_shop')).toBe(true);
    expect(isOutOfService('available')).toBe(false);
    expect(isOutOfService(null)).toBe(false);
  });
});

/**
 * Acceptance test A7, in the form the bug actually took: the needs-attention panel judged a unit's
 * service position without its booking while the Trucks list judged it with, so the panel counted
 * trucks the list would then refuse to show. Clicking the finding landed on an empty table.
 */
describe('a finding and the list it opens agree', () => {
  const truck = {
    id: 'trk_1',
    unitNumber: '2785',
    status: 'available',
    currentLoadId: null,
    odometer: 299_000,
    nextServiceOdometer: 300_000,
    nextServiceDate: null,
    scheduledFor: '2026-09-22',
  };

  it('does not call a booked truck due for service', () => {
    const queue = buildFleetExceptions(
      { trucks: [truck], trailers: [], workOrders: [] },
      TODAY,
    );
    const dueSoon = queue.items.find((item) => item.key === 'maintenance_due_soon');
    expect(dueSoon).toBeUndefined();
    // And the Trucks list, asked the same question, says the same thing.
    expect(pmPosition(truck, TODAY).urgency).toBe('scheduled');
  });

  it('leaves a retired truck out of the overdue finding', () => {
    const queue = buildFleetExceptions(
      {
        trucks: [{ ...truck, status: 'retired', odometer: 400_000, scheduledFor: null }],
        trailers: [],
        workOrders: [],
      },
      TODAY,
    );
    expect(queue.items.find((item) => item.key === 'maintenance_overdue')).toBeUndefined();
  });

  it('counts exactly the late work orders the list will show', () => {
    const workOrders = [
      { id: 'ro_1', roNumber: 'RO-1', status: 'in_shop', promisedAt: '2026-09-10', completedAt: null },
      { id: 'ro_2', roNumber: 'RO-2', status: 'open', promisedAt: null, completedAt: null },
      {
        id: 'ro_3',
        roNumber: 'RO-3',
        status: 'completed',
        promisedAt: '2026-09-01',
        completedAt: '2026-09-02',
      },
    ];
    const queue = buildFleetExceptions({ trucks: [], trailers: [], workOrders }, TODAY);
    const late = queue.items.find((item) => item.key === 'work_orders_past_promise');
    expect(late?.count).toBe(1);
    expect(late?.ids).toEqual(['ro_1']);
    expect(workOrders.filter((wo) => isLateWorkOrder(wo, TODAY)).map((wo) => wo.id)).toEqual([
      'ro_1',
    ]);
  });
});

/**
 * Acceptance test A23. A unit past its annual inspection may not be driven at all (49 CFR 396.17),
 * so it is not the same problem as a lapsed lease agreement and must not be filed with one.
 */
describe('a lapsed annual inspection', () => {
  const documents = {
    expiredUnitIds: ['trk_1', 'trk_2'],
    expiringUnitIds: [],
    inspectionLapsedUnitIds: ['trk_1'],
  };

  it('is its own finding, naming the regulation', () => {
    const queue = buildFleetExceptions(
      { trucks: [], trailers: [], workOrders: [], unitDocuments: documents },
      TODAY,
    );
    const finding = queue.items.find((item) => item.key === 'annual_inspection_lapsed');
    expect(finding?.ids).toEqual(['trk_1']);
    expect(finding?.severity).toBe('critical');
    expect(finding?.reason).toMatch(/396\.17/);
  });

  it('is not counted a second time under expired paperwork', () => {
    const queue = buildFleetExceptions(
      { trucks: [], trailers: [], workOrders: [], unitDocuments: documents },
      TODAY,
    );
    expect(queue.items.find((item) => item.key === 'documents_expired')?.ids).toEqual(['trk_2']);
  });
});
