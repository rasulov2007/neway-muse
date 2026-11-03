import { describe, expect, it } from 'vitest';
import { inspection, row } from './board-fixtures';
import { driverPti } from './board-view';

describe('driverPti (owner, 2026-10-12)', () => {
  it('counts drivers, not trucks: sent, not sent yet, missed; no driver and shop units left out', () => {
    const d = driverPti([
      row(inspection({ unitNumber: '101', unitId: 'u1', driverId: 'd1', driverName: 'Ann', receiptStatus: 'received' })),
      row(inspection({ unitNumber: '102', unitId: 'u2', driverId: 'd2', driverName: 'Bob', receiptStatus: 'late' })),
      row(inspection({ unitNumber: '103', unitId: 'u3', driverId: 'd3', driverName: 'Cal', receiptStatus: 'awaiting' })),
      row(inspection({ unitNumber: '104', unitId: 'u4', driverId: 'd4', driverName: 'Dee', receiptStatus: 'missing' })),
      row(inspection({ unitNumber: '105', unitId: 'u5', driverId: null, driverName: null, receiptStatus: 'missing' })),
      row(inspection({ unitNumber: '106', unitId: 'u6', driverId: 'd6', driverName: 'Eve', receiptStatus: 'exempt_in_shop' })),
      // The same driver on a second unit counts once, with the best state.
      row(inspection({ unitNumber: '107', unitId: 'u7', driverId: 'd1', driverName: 'Ann', receiptStatus: 'missing' })),
    ]);
    expect(d.total).toBe(4);
    expect(d.sent.map((x) => x.driverName)).toEqual(['Ann', 'Bob']);
    expect(d.waiting.map((x) => x.driverName)).toEqual(['Cal']);
    expect(d.missed.map((x) => x.driverName)).toEqual(['Dee']);
  });
});
