import { describe, expect, it } from 'vitest';
import type { FuelTransaction } from '@/demo';
import {
  fillKey,
  formatRange,
  fuelCsv,
  groupFills,
  inRange,
  rangeLabel,
  relayTransactionId,
  resolveRange,
} from './fuel-ledger';

function fill(patch: Partial<FuelTransaction>): FuelTransaction {
  return {
    id: 'fue_1',
    truckId: 'trk_1',
    unitNumber: '1189',
    driverId: 'drv_1',
    driverName: 'Jem Mayfield',
    loadId: null,
    at: '2026-10-05T09:58:00Z',
    station: { brand: 'Pilot', name: 'Pilot #412', city: 'Haughton', state: 'LA' },
    product: 'diesel',
    gallons: 119.8,
    pricePerGallon: 5.282,
    amount: 632.66,
    odometer: 0,
    cardLast4: '4421',
    anomalyFlags: [],
    status: 'verified',
    ...patch,
  };
}

describe('fuel ledger', () => {
  it('reads the Relay transaction id from both lines of a fill', () => {
    expect(relayTransactionId({ id: 'fue_rly_abc-1' })).toBe('abc-1');
    expect(relayTransactionId({ id: 'fue_rly_abc-1_def' })).toBe('abc-1');
    expect(relayTransactionId({ id: 'fue_8d2' })).toBeNull();
    expect(fillKey({ id: 'fue_rly_abc-1_def' })).toBe(fillKey({ id: 'fue_rly_abc-1' }));
  });

  it('gathers diesel and DEF of one transaction into one fill, diesel first', () => {
    const groups = groupFills([
      fill({ id: 'fue_rly_T1_def', product: 'def', gallons: 9.8, amount: 47.79 }),
      fill({ id: 'fue_rly_T1' }),
      fill({ id: 'fue_hand' }),
    ]);
    expect(groups).toHaveLength(2);
    const [relay, hand] = groups;
    expect(relay?.relayTransactionId).toBe('T1');
    expect(relay?.lead.id).toBe('fue_rly_T1');
    expect(relay?.lines.map((l) => l.product)).toEqual(['diesel', 'def']);
    expect(relay?.total).toBe(680.45);
    expect(hand?.relayTransactionId).toBeNull();
  });

  it('measures the range in Eastern calendar days', () => {
    const range = resolveRange('2026-10-05');
    expect(range).toEqual({ from: '2026-09-06', to: '2026-10-05' });
    expect(rangeLabel(range, '2026-10-05')).toBe('Last 30 days');
    expect(rangeLabel({ from: '2026-09-07', to: '2026-10-05' }, '2026-10-05')).toBe('Custom');
    expect(formatRange(range)).toBe('Sep 6 – Oct 5, 2026');
    expect(formatRange({ from: '2025-12-30', to: '2026-01-02' })).toBe(
      'Dec 30, 2025 – Jan 2, 2026',
    );
    // 02:30 UTC on Sep 6 is still Sep 5 in New York.
    expect(inRange({ at: '2026-09-06T02:30:00Z' }, range)).toBe(false);
    expect(inRange({ at: '2026-09-06T04:30:00Z' }, range)).toBe(true);
  });

  it('exports CSV with odometer, price and card, safe against spreadsheet formulas', () => {
    const csv = fuelCsv([
      fill({ id: 'fue_rly_T1', driverName: '=HYPERLINK("x")', odometer: 412_300 }),
    ]);
    const [header, line] = csv.split('\r\n');
    expect(header).toContain('Odometer');
    expect(header).toContain('Price per gallon');
    expect(header).toContain('Card last 4');
    expect(line).toContain(`"'=HYPERLINK(""x"")"`);
    expect(line).toContain('412300');
    // The charged price: 632.66 / 119.8, so gallons times it is the total to the cent.
    expect(line).toContain(',5.281,');
    expect(line).toContain('T1');
    expect(line).toContain('EDT');
  });
});
