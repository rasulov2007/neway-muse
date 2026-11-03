import { describe, expect, it } from 'vitest';
import { planRelaySync, relayRowId, type RelayDriver, type RelayTruck, type WorkspaceFuelTransaction } from './relay-sync.plan';
import type { RelayTransaction } from './relay.client';

/**
 * The rules a Relay sync runs by: the truck comes from what the driver typed at the pump, diesel
 * and DEF never share a row, and reading a window twice changes nothing.
 */

const TRUCKS: RelayTruck[] = [
  { id: 'trk_0049', unitNumber: '0049', currentDriverId: 'drv_hubert' },
  { id: 'trk_1992', unitNumber: '1992', currentDriverId: 'drv_jimmy' },
];
const DRIVERS: RelayDriver[] = [
  { id: 'drv_hubert', name: 'Hollis Cendrick', currentTruckId: 'trk_0049' },
  { id: 'drv_jimmy', name: 'Jimmy Bastian', currentTruckId: 'trk_1992' },
];

function tx(over: Partial<RelayTransaction> = {}): RelayTransaction {
  return {
    id: 'txn_1',
    at: '2026-10-03T14:05:00Z',
    driver: { firstName: 'Hollis', lastName: 'Cendrick', card: '7083050012345678' },
    truckPrompt: '0049',
    station: { brand: 'Pilot', name: 'Pilot #412', city: 'Gary', state: 'IN' },
    items: [{ fuelType: 'diesel', gallons: 120.5, amount: 451.88 }],
    ...over,
  };
}

const run = (txs: RelayTransaction[], existing: WorkspaceFuelTransaction[] = []) =>
  planRelaySync(txs, { trucks: TRUCKS, drivers: DRIVERS, existing });

describe('planRelaySync', () => {
  it('turns a diesel fill into one verified ledger row on the prompted truck', () => {
    const plan = run([tx()]);
    expect(plan.add).toHaveLength(1);
    expect(plan.add[0]).toMatchObject({
      id: 'fue_rly_txn_1',
      truckId: 'trk_0049',
      unitNumber: '0049',
      driverId: 'drv_hubert',
      product: 'diesel',
      gallons: 120.5,
      amount: 451.88,
      pricePerGallon: 3.75,
      odometer: 0,
      cardLast4: '5678',
      status: 'verified',
    });
    expect(plan.summary).toMatchObject({ fetched: 1, created: 1, unchanged: 0, unmatched: 0 });
  });

  it('reads "49" as unit 0049 - drivers drop the leading zeros', () => {
    expect(run([tx({ truckPrompt: '49' })]).add[0]?.truckId).toBe('trk_0049');
  });

  it('trusts the pump prompt over the driver usual truck', () => {
    // Hollis normally drives 0049, but he typed 1992 at the pump.
    expect(run([tx({ truckPrompt: '1992' })]).add[0]?.truckId).toBe('trk_1992');
  });

  it('falls back to the driver usual truck only when no truck was typed', () => {
    expect(run([tx({ truckPrompt: null })]).add[0]?.truckId).toBe('trk_0049');
  });

  it('keeps DEF out of the diesel row so MPG is never inflated', () => {
    const plan = run([
      tx({
        items: [
          { fuelType: 'diesel', gallons: 100, amount: 380 },
          { fuelType: 'def', gallons: 5, amount: 22.5 },
        ],
      }),
    ]);
    expect(plan.add.map((r) => [r.id, r.product, r.gallons])).toEqual([
      ['fue_rly_txn_1', 'diesel', 100],
      ['fue_rly_txn_1_def', 'def', 5],
    ]);
  });

  it('writes nothing for a transaction with nothing a truck burns', () => {
    const plan = run([tx({ items: [{ fuelType: 'additive', gallons: 1, amount: 9.99 }] })]);
    expect(plan.add).toHaveLength(0);
    expect(plan.summary.inactive).toBe(1);
  });

  it('is exactly-once: a window read twice adds nothing the second time', () => {
    const first = run([tx()]);
    const second = run([tx()], first.add);
    expect(second.add).toHaveLength(0);
    expect(second.summary.unchanged).toBe(1);
  });

  it('lists a truck number nobody owns instead of inventing a truck', () => {
    const plan = run([tx({ truckPrompt: '7777', driver: { firstName: 'Nobody', lastName: 'Known', card: null } })]);
    expect(plan.add).toHaveLength(0);
    expect(plan.unmatched[0]).toContain('truck "7777" is not in the fleet');
  });

  it('flags a fill that was also keyed in by hand, without dropping either', () => {
    const manual: WorkspaceFuelTransaction = {
      id: 'fue_0042',
      truckId: 'trk_0049',
      unitNumber: '0049',
      driverId: 'drv_hubert',
      driverName: 'Hollis Cendrick',
      loadId: null,
      at: '2026-10-03T14:20:00Z',
      station: { brand: 'Pilot', name: 'Pilot #412', city: 'Gary', state: 'IN' },
      product: 'diesel',
      gallons: 120.4,
      pricePerGallon: 3.75,
      amount: 451.5,
      odometer: 0,
      cardLast4: '5678',
      anomalyFlags: [],
      status: 'verified',
    };
    const plan = run([tx()], [manual]);
    expect(plan.add[0]?.anomalyFlags).toEqual(['duplicate']);
    expect(plan.add[0]?.status).toBe('warning');
    expect(plan.summary.duplicates).toBe(1);
  });

  it('flags more gallons than any tank holds', () => {
    const plan = run([tx({ items: [{ fuelType: 'diesel', gallons: 420, amount: 1500 }] })]);
    expect(plan.add[0]?.anomalyFlags).toContain('impossible_gallons');
  });

  it('matches a driver whose name Relay spells in the other order', () => {
    const plan = run([tx({ truckPrompt: null, driver: { firstName: 'Bastian', lastName: 'Jimmy', card: null } })]);
    expect(plan.add[0]?.driverId).toBe('drv_jimmy');
    expect(plan.add[0]?.truckId).toBe('trk_1992');
  });

  it('derives ids from the Relay transaction id', () => {
    expect(relayRowId('abc', 'diesel')).toBe('fue_rly_abc');
    expect(relayRowId('abc', 'def')).toBe('fue_rly_abc_def');
  });
});
