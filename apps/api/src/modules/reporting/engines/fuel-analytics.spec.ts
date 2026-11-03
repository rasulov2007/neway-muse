import { describe, expect, it } from 'vitest';
import type { DriverFact, FuelTransactionFact, TruckFact } from '../facts';
import { computeFuelAnalytics, sortFuelByState } from './fuel-analytics';

function tx(overrides: Partial<FuelTransactionFact> & { id: string }): FuelTransactionFact {
  return {
    at: '2026-09-01T14:00:00.000Z',
    date: '2026-09-01',
    truckId: 'trk_2701',
    driverId: 'drv_001',
    state: 'TX',
    gallons: 100,
    grossCost: 320,
    discountedCost: 300,
    stationName: "Love's TX",
    ...overrides,
  };
}

const trucks: TruckFact[] = [
  {
    truckId: 'trk_2701',
    unitNumber: '2701',
    status: 'driving',
    driverId: 'drv_001',
    driverName: 'A',
  },
  {
    truckId: 'trk_2702',
    unitNumber: '2702',
    status: 'driving',
    driverId: 'drv_002',
    driverName: 'B',
  },
];
const drivers: DriverFact[] = [
  { driverId: 'drv_001', name: 'Ann Walker', payType: 'company', rawPayTag: 'C' },
  { driverId: 'drv_002', name: 'Bob Garcia', payType: 'owner_operator', rawPayTag: 'OO' },
];

describe('computeFuelAnalytics', () => {
  const fuel = [
    tx({ id: 'f1' }),
    tx({
      id: 'f2',
      truckId: 'trk_2702',
      driverId: 'drv_002',
      state: 'CA',
      gallons: 50,
      grossCost: 220,
      discountedCost: 212.5,
    }),
    tx({ id: 'f3', state: 'tx', gallons: 100, grossCost: 310, discountedCost: 287.5 }),
  ];

  it('computes totals, average price and cost per mile', () => {
    const result = computeFuelAnalytics({ fuel, trucks, drivers }, 4000);
    expect(result.totals).toEqual({
      fillUps: 3,
      gallons: 250,
      discountedCost: 800,
      grossCost: 850,
      avgPricePerGallon: 3.2,
      fuelCostPerMile: 0.2,
      reasons: [],
      def: { fillUps: 0, gallons: 0, cost: 0 },
    });
  });

  it('keeps DEF out of diesel gallons, cost and $/gal, and reports it apart', () => {
    const withDef = [
      ...fuel,
      { ...fuel[0]!, id: 'def1', product: 'def', gallons: 10, grossCost: 50, discountedCost: 50 },
    ];
    const result = computeFuelAnalytics({ fuel: withDef, trucks, drivers }, 4000);
    expect(result.totals.gallons).toBe(250);
    expect(result.totals.discountedCost).toBe(800);
    expect(result.totals.avgPricePerGallon).toBe(3.2);
    expect(result.totals.def).toEqual({ fillUps: 1, gallons: 10, cost: 50 });
    const truck = result.byTruck.find((r) => r.truckId === fuel[0]!.truckId)!;
    expect(truck.defCost).toBe(50);
  });

  it('groups by truck and driver with names and share percentages', () => {
    const result = computeFuelAnalytics({ fuel, trucks, drivers }, 4000);
    expect(result.byTruck).toEqual([
      {
        truckId: 'trk_2701',
        unitNumber: '2701',
        fillUps: 2,
        gallons: 200,
        cost: 587.5,
        sharePct: 73.44,
      },
      {
        truckId: 'trk_2702',
        unitNumber: '2702',
        fillUps: 1,
        gallons: 50,
        cost: 212.5,
        sharePct: 26.56,
      },
    ]);
    expect(result.byDriver.map((d) => [d.name, d.cost])).toEqual([
      ['Ann Walker', 587.5],
      ['Bob Garcia', 212.5],
    ]);
  });

  it('sorts by-state rows by avg $/gal descending by default and normalizes state codes', () => {
    const result = computeFuelAnalytics({ fuel, trucks, drivers }, 4000);
    expect(result.byState).toEqual([
      { state: 'CA', fillUps: 1, gallons: 50, cost: 212.5, avgPricePerGallon: 4.25 },
      { state: 'TX', fillUps: 2, gallons: 200, cost: 587.5, avgPricePerGallon: 2.938 },
    ]);
  });

  it('is null-safe for cost per mile when miles are unknown or zero', () => {
    const unknown = computeFuelAnalytics({ fuel, trucks, drivers }, null);
    expect(unknown.totals.fuelCostPerMile).toBeNull();
    expect(unknown.totals.reasons).toEqual(['Total miles are unknown for the period.']);

    const zero = computeFuelAnalytics({ fuel, trucks, drivers }, 0);
    expect(zero.totals.fuelCostPerMile).toBeNull();
    expect(zero.totals.reasons).toEqual(['Total miles are zero.']);
  });

  it('returns zeros and nulls (never NaN) for empty input', () => {
    const result = computeFuelAnalytics({ fuel: [], trucks, drivers }, null);
    expect(result.totals.fillUps).toBe(0);
    expect(result.totals.discountedCost).toBe(0);
    expect(result.totals.avgPricePerGallon).toBeNull();
    expect(result.totals.fuelCostPerMile).toBeNull();
    expect(result.totals.reasons).toHaveLength(2);
    expect(result.byTruck).toEqual([]);
    expect(result.byDriver).toEqual([]);
    expect(result.byState).toEqual([]);
  });

  it('groups unassigned transactions under a null truck/driver and never yields NaN', () => {
    const result = computeFuelAnalytics(
      {
        fuel: [
          tx({
            id: 'f9',
            truckId: null,
            driverId: null,
            gallons: 0,
            discountedCost: 0,
            grossCost: 0,
          }),
        ],
        trucks,
        drivers,
      },
      100,
    );
    expect(result.byTruck).toEqual([
      { truckId: null, unitNumber: null, fillUps: 1, gallons: 0, cost: 0, sharePct: 0 },
    ]);
    expect(result.byState[0]?.avgPricePerGallon).toBeNull();
    expect(JSON.stringify(result)).not.toContain('null,null');
    expect(JSON.stringify(result)).not.toContain('NaN');
  });
});

describe('sortFuelByState', () => {
  const rows = [
    { state: 'IL', fillUps: 3, gallons: 300, cost: 1035, avgPricePerGallon: 3.45 },
    { state: 'TX', fillUps: 5, gallons: 500, cost: 1500, avgPricePerGallon: 3 },
    { state: 'ZZ', fillUps: 1, gallons: 0, cost: 0, avgPricePerGallon: null },
    { state: 'CA', fillUps: 2, gallons: 100, cost: 425, avgPricePerGallon: 4.25 },
  ];

  it('sorts numerically in either direction and keeps nulls last', () => {
    expect(sortFuelByState(rows, 'avgPricePerGallon', 'asc').map((r) => r.state)).toEqual([
      'TX',
      'IL',
      'CA',
      'ZZ',
    ]);
    expect(sortFuelByState(rows, 'cost', 'desc').map((r) => r.state)).toEqual([
      'TX',
      'IL',
      'CA',
      'ZZ',
    ]);
  });

  it('sorts by state name and does not mutate the input', () => {
    const sorted = sortFuelByState(rows, 'state', 'asc');
    expect(sorted.map((r) => r.state)).toEqual(['CA', 'IL', 'TX', 'ZZ']);
    expect(rows[0]?.state).toBe('IL');
  });
});
