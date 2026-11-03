/**
 * Test-only fixture builders for the reporting engines. Not exported from `index.ts`.
 * Defaults describe a small fleet: two active trucks, one idle truck, one sold truck, three
 * drivers of different pay types, and one week of expense coverage.
 */
import type {
  DriverFact,
  ExpenseLine,
  FuelTransactionFact,
  MileageRecord,
  ReportingFacts,
  RevenueLine,
  TruckFact,
} from '../facts';

export const RANGE = { from: '2026-08-31', to: '2026-09-06' } as const;

export function revenue(overrides: Partial<RevenueLine> & { loadId: string }): RevenueLine {
  return {
    loadNumber: `L-${overrides.loadId}`,
    truckId: 'T1',
    driverId: 'D1',
    teamId: 'TEAM1',
    deliveredAt: '2026-09-02T15:00:00Z',
    deliveredOn: '2026-09-02',
    linehaul: 1000,
    loadedMiles: 400,
    emptyMiles: 100,
    ...overrides,
  };
}

export function expense(overrides: Partial<ExpenseLine> & { id: string }): ExpenseLine {
  return {
    date: '2026-09-02',
    category: 'fuel',
    amount: 100,
    truckId: 'T1',
    driverId: null,
    source: 'accounting',
    isEstimate: false,
    ...overrides,
  };
}

export function mileage(overrides: Partial<MileageRecord> & { truckId: string }): MileageRecord {
  return { driverId: null, date: '2026-09-02', miles: 500, source: 'odometer', ...overrides };
}

export function fuelTx(
  overrides: Partial<FuelTransactionFact> & { id: string },
): FuelTransactionFact {
  return {
    at: '2026-09-02T10:00:00Z',
    date: '2026-09-02',
    truckId: 'T1',
    driverId: 'D1',
    state: 'TX',
    gallons: 100,
    grossCost: 400,
    discountedCost: 380,
    stationName: 'Pilot',
    ...overrides,
  };
}

export function truck(overrides: Partial<TruckFact> & { truckId: string }): TruckFact {
  return {
    unitNumber: overrides.truckId,
    status: 'driving',
    driverId: null,
    driverName: null,
    ...overrides,
  };
}

export function driver(overrides: Partial<DriverFact> & { driverId: string }): DriverFact {
  return {
    name: `Driver ${overrides.driverId}`,
    payType: 'company',
    rawPayTag: 'company',
    ...overrides,
  };
}

export const DEFAULT_TRUCKS: TruckFact[] = [
  truck({ truckId: 'T1', unitNumber: '101', driverId: 'D1', driverName: 'Driver D1' }),
  truck({ truckId: 'T2', unitNumber: '102', driverId: 'D2', driverName: 'Driver D2' }),
  truck({
    truckId: 'T3',
    unitNumber: '103',
    status: 'idle',
    driverId: 'D3',
    driverName: 'Driver D3',
  }),
  truck({ truckId: 'T9', unitNumber: '999', status: 'sold' }),
];

export const DEFAULT_DRIVERS: DriverFact[] = [
  driver({ driverId: 'D1', payType: 'company' }),
  driver({ driverId: 'D2', payType: 'owner_operator', rawPayTag: 'O/O' }),
  driver({ driverId: 'D3', payType: 'lease_owner', rawPayTag: 'lease' }),
];

export const DEFAULT_REVENUE: RevenueLine[] = [
  revenue({
    loadId: 'A',
    truckId: 'T1',
    driverId: 'D1',
    linehaul: 1200.5,
    loadedMiles: 500,
    emptyMiles: 50,
  }),
  revenue({
    loadId: 'B',
    truckId: 'T1',
    driverId: 'D1',
    linehaul: 800.25,
    loadedMiles: 300,
    emptyMiles: 20,
  }),
  revenue({
    loadId: 'C',
    truckId: 'T2',
    driverId: 'D2',
    linehaul: 2000,
    loadedMiles: 900,
    emptyMiles: 100,
  }),
];

export const DEFAULT_EXPENSES: ExpenseLine[] = [
  expense({ id: 'E1', category: 'fuel', amount: 500, truckId: 'T1', source: 'fuel' }),
  expense({ id: 'E2', category: 'fuel', amount: 700, truckId: 'T2', source: 'fuel' }),
  expense({
    id: 'E3',
    category: 'driver_pay',
    amount: 600,
    truckId: 'T1',
    driverId: 'D1',
    source: 'settlement',
  }),
  expense({ id: 'E4', category: 'insurance', amount: 300, truckId: null, source: 'accounting' }),
];

/** Builds a complete `ReportingFacts` with sensible defaults, overriding any field. */
export function makeFacts(overrides: Partial<ReportingFacts> = {}): ReportingFacts {
  const base: ReportingFacts = {
    companyId: 'C1',
    range: { ...RANGE },
    revenue: [...DEFAULT_REVENUE],
    expenses: [...DEFAULT_EXPENSES],
    fuel: [fuelTx({ id: 'F1' })],
    mileage: [],
    trucks: [...DEFAULT_TRUCKS],
    drivers: [...DEFAULT_DRIVERS],
    dispatchWeeks: [],
    expenseCoverage: [{ weekStart: '2026-08-31', hasExpenseData: true }],
    revenueLedgerTotal: 4000.75,
  };
  return { ...base, ...overrides };
}
