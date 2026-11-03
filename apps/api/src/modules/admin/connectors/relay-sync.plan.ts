import type { SyncSummary } from '@neway/shared';
import type { RelayTransaction } from './relay.client';

/**
 * What Relay's transactions mean for the fuel ledger. Pure: no database, no network, no clock.
 *
 * The ledger is the workspace collection `ws2-fueltransactions`, whose shape the web client owns
 * (`FuelTransaction` in apps/web/src/demo/types.ts). It is mirrored here field for field, because
 * a row this planner writes is read by the same screens as one keyed in by hand.
 *
 * One Relay transaction can become two rows: its diesel and its DEF. They are kept apart because
 * DEF is real money but not fuel burned - folded into diesel it would quietly wreck every MPG
 * figure. Anything that is neither (additives, gasoline) is counted and left out.
 *
 * A row's id is derived from Relay's transaction id, so reading the same window twice changes
 * nothing: Relay posts late and windows are re-read on purpose.
 */

export interface WorkspaceFuelTransaction {
  id: string;
  truckId: string;
  unitNumber: string;
  driverId: string;
  driverName: string;
  loadId: string | null;
  at: string;
  station: { brand: string; name: string; city: string; state: string };
  product: 'diesel' | 'def';
  gallons: number;
  pricePerGallon: number;
  amount: number;
  /** Relay never asks for one. Zero is the ledger's "no reading", which the checks skip. */
  odometer: number;
  cardLast4: string;
  anomalyFlags: ('duplicate' | 'impossible_gallons' | 'location_mismatch')[];
  status: 'verified' | 'warning' | 'problem';
}

export interface RelayTruck {
  id: string;
  unitNumber: string;
  currentDriverId: string | null;
}

export interface RelayDriver {
  id: string;
  name: string;
  currentTruckId: string | null;
}

export interface RelayPlan {
  add: WorkspaceFuelTransaction[];
  /** Transactions that name no truck we have, said in a sentence each, for the screen. */
  unmatched: string[];
  summary: SyncSummary;
}

const IMPOSSIBLE_GALLONS = 300;
const SAME_FILL_WINDOW_MS = 30 * 60_000;

export function relayRowId(transactionId: string, product: 'diesel' | 'def'): string {
  return product === 'diesel' ? `fue_rly_${transactionId}` : `fue_rly_${transactionId}_def`;
}

export function planRelaySync(
  transactions: RelayTransaction[],
  ctx: { trucks: RelayTruck[]; drivers: RelayDriver[]; existing: WorkspaceFuelTransaction[] },
): RelayPlan {
  const byUnit = new Map<string, RelayTruck>();
  for (const truck of ctx.trucks) {
    byUnit.set(unitKey(truck.unitNumber), truck);
    // A driver types "49" as readily as "0049".
    byUnit.set(unitKey(truck.unitNumber).replace(/^0+(?=\d)/, ''), truck);
  }
  const byName = new Map<string, RelayDriver>();
  const byTokens = new Map<string, RelayDriver | null>();
  for (const driver of ctx.drivers) {
    byName.set(nameKey(driver.name), driver);
    const tokens = tokenKey(driver.name);
    // Two drivers with the same words in a different order is no match at all, not a guess.
    byTokens.set(tokens, byTokens.has(tokens) ? null : driver);
  }
  const trucksById = new Map(ctx.trucks.map((t) => [t.id, t]));
  const driversById = new Map(ctx.drivers.map((d) => [d.id, d]));

  const known = new Set(ctx.existing.map((row) => row.id));
  const ledger = [...ctx.existing];
  const add: WorkspaceFuelTransaction[] = [];
  const unmatched: string[] = [];
  let unchanged = 0;
  let duplicates = 0;
  let notFuel = 0;

  for (const tx of transactions) {
    const groups = groupProducts(tx);
    if (groups.length === 0) {
      notFuel += 1;
      continue;
    }

    const fullName = `${tx.driver.firstName} ${tx.driver.lastName}`.trim();
    const driver = byName.get(nameKey(fullName)) ?? byTokens.get(tokenKey(fullName)) ?? null;
    const prompted = tx.truckPrompt ? byUnit.get(unitKey(tx.truckPrompt)) ?? byUnit.get(unitKey(tx.truckPrompt).replace(/^0+(?=\d)/, '')) : undefined;
    // The prompt is what the driver said at the pump; their usual unit is only the fallback.
    const truck = prompted ?? (driver?.currentTruckId ? trucksById.get(driver.currentTruckId) : undefined);

    for (const group of groups) {
      const id = relayRowId(tx.id, group.product);
      if (known.has(id)) {
        unchanged += 1;
        continue;
      }
      if (!truck) {
        unmatched.push(
          `${tx.id}: ${tx.truckPrompt ? `truck "${tx.truckPrompt}" is not in the fleet` : 'no truck number was entered'}` +
            `${fullName ? ` (${fullName})` : ''}`,
        );
        continue;
      }
      const at = tx.at ?? new Date(0).toISOString();
      const gallons = round(group.gallons, 3);
      const amount = round(group.amount, 2);
      const flags: WorkspaceFuelTransaction['anomalyFlags'] = [];
      if (gallons > IMPOSSIBLE_GALLONS) flags.push('impossible_gallons');
      // The same fill keyed by hand as well as arriving from Relay.
      const twin = ledger.some(
        (row) =>
          row.truckId === truck.id &&
          row.product === group.product &&
          !row.id.startsWith('fue_rly_') &&
          Math.abs(Date.parse(row.at) - Date.parse(at)) < SAME_FILL_WINDOW_MS &&
          Math.abs(row.gallons - gallons) < 0.5,
      );
      if (twin) {
        flags.push('duplicate');
        duplicates += 1;
      }
      const assigned = driver ?? (truck.currentDriverId ? driversById.get(truck.currentDriverId) ?? null : null);
      const row: WorkspaceFuelTransaction = {
        id,
        truckId: truck.id,
        unitNumber: truck.unitNumber,
        driverId: assigned?.id ?? '',
        driverName: assigned?.name ?? (fullName || 'Unassigned'),
        loadId: null,
        at,
        station: tx.station,
        product: group.product,
        gallons,
        pricePerGallon: gallons > 0 ? round(amount / gallons, 3) : 0,
        amount,
        odometer: 0,
        cardLast4: (tx.driver.card ?? '').replace(/\D/g, '').slice(-4),
        anomalyFlags: flags,
        status: flags.length > 0 ? 'warning' : 'verified',
      };
      add.push(row);
      ledger.push(row);
      known.add(id);
    }
  }

  return {
    add,
    unmatched,
    summary: {
      fetched: transactions.length,
      matched: add.length + unchanged,
      updated: 0,
      created: add.length,
      unchanged,
      // Transactions with nothing a truck burns: additives, gasoline. Counted, never written.
      inactive: notFuel,
      duplicates,
      unmatched: unmatched.length,
      conflicts: 0,
    },
  };
}

function groupProducts(tx: RelayTransaction): { product: 'diesel' | 'def'; gallons: number; amount: number }[] {
  const out: { product: 'diesel' | 'def'; gallons: number; amount: number }[] = [];
  for (const product of ['diesel', 'def'] as const) {
    const items = tx.items.filter((item) =>
      product === 'def' ? item.fuelType === 'def' : item.fuelType.startsWith('diesel'),
    );
    const gallons = items.reduce((sum, item) => sum + item.gallons, 0);
    const amount = items.reduce((sum, item) => sum + item.amount, 0);
    if (gallons > 0 && amount > 0) out.push({ product, gallons, amount });
  }
  return out;
}

function unitKey(unit: string): string {
  return unit.trim().toUpperCase().replace(/^#/, '').replace(/\s+/g, '');
}

function nameKey(name: string): string {
  return name.trim().toUpperCase().replace(/\s+/g, ' ');
}

function tokenKey(name: string): string {
  return nameKey(name).split(' ').filter(Boolean).sort().join(' ');
}

function round(value: number, places: number): number {
  const f = 10 ** places;
  return Math.round(value * f) / f;
}
