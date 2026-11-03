import { localParts } from '../loads/format-time.js';
import type { DriverTx } from './driver-account.js';
import { txInPeriod, type SettlementPeriod } from './settlement-rules.js';

/**
 * Fuel on the driver statement (owner, 2026-10-21).
 *
 * The Fleet › Fuel ledger (Relay's sync and the fills keyed by hand) is where a purchase is
 * recorded; the statement reads driver transactions. This planner is the one bridge: each
 * purchase for the driver - or for their truck when it names no driver - timed inside the pay
 * period becomes one `fuel` transaction, keyed by the purchase, so a recompute never writes it
 * twice. A driver whose profile does not deduct fuel gets it as the company's cost (shown, never
 * owed). A purchase the ledger marks as a problem waits for approval instead of being taken. The
 * amount is the ledger's own; nothing is estimated.
 *
 * Pure: no database, no clock. The service assigns ids and writes.
 */

/** A row of the fuel ledger (`ws2-fueltransactions`), as far as the statement needs it. */
export interface FuelPurchase {
  id: string;
  truckId: string;
  driverId: string;
  loadId?: string | null;
  at: string;
  station: { brand?: string; name?: string; city?: string; state?: string };
  product: 'diesel' | 'def';
  gallons: number;
  amount: number;
  status?: 'verified' | 'warning' | 'problem';
}

export const FUEL_LEDGER_SOURCE = 'fuel_ledger';

/** The transaction's key: the purchase and the driver it is charged to. */
export function fuelSourceKey(purchaseId: string, driverId: string): string {
  return `${FUEL_LEDGER_SOURCE}:${purchaseId}:${driverId}`;
}

/** The Relay transaction behind a ledger row Relay's sync wrote (`fue_rly_<id>` / `fue_rly_<id>_def`). */
export function relayTransactionIdOf(purchaseId: string): string | null {
  const m = /^fue_rly_(.+?)(_def)?$/.exec(purchaseId);
  return m ? m[1]! : null;
}

/** "Fuel · Pilot #123 · Dallas, TX · 112.4 gal" - what the driver reads on the statement. */
export function fuelLineDescription(p: Pick<FuelPurchase, 'station' | 'product' | 'gallons'>): string {
  const where = [p.station.name || p.station.brand, [p.station.city, p.station.state].filter(Boolean).join(', ')].filter((s) => Boolean(s && s.trim())).join(' · ');
  const gallons = `${(Math.round(p.gallons * 10) / 10).toLocaleString('en-US', { maximumFractionDigits: 1 })} gal`;
  return [p.product === 'def' ? 'DEF' : 'Fuel', where || null, gallons].filter(Boolean).join(' · ');
}

export interface FuelChargePlan {
  add: Array<Omit<DriverTx, 'id'>>;
  /** Unclaimed rows whose purchase changed in the ledger (amount, place): brought in line. */
  update: Array<{ id: string; amountCents: number; description: string; onDate: string; occurredAt: string }>;
  /** Unclaimed rows whose purchase is no longer this driver's in the ledger. */
  void: string[];
  /** Purchases already on the account through a Relay CSV import: left to that row. */
  alreadyImported: string[];
}

export function planFuelCharges(input: {
  driverId: string;
  truckId: string | null;
  period: Pick<SettlementPeriod, 'start' | 'end' | 'startsAt' | 'cutoffAt'>;
  purchases: readonly FuelPurchase[];
  /** The driver's transactions, all of them. */
  existing: readonly DriverTx[];
  /** The profile's "deduct fuel" switch in force for the period. */
  deductFuel: boolean;
  timezone: string;
}): FuelChargePlan {
  const plan: FuelChargePlan = { add: [], update: [], void: [], alreadyImported: [] };
  const mine = input.purchases.filter(
    (p) =>
      Number.isFinite(p.amount) && p.amount > 0 && typeof p.at === 'string' && !Number.isNaN(Date.parse(p.at)) &&
      (p.driverId === input.driverId || (!p.driverId && Boolean(input.truckId) && p.truckId === input.truckId)) &&
      txInPeriod({ onDate: '', occurredAt: p.at }, { ...input.period, startsAt: input.period.startsAt ?? `${input.period.start}T00:00:00.000Z` }),
  );
  const bySource = new Map(input.existing.map((t) => [t.sourceKey, t]));
  const keep = new Set<string>();
  for (const p of mine) {
    const relayId = relayTransactionIdOf(p.id);
    const imported = relayId ? bySource.get(`import:relay:${relayId}`) : undefined;
    if (imported && imported.state !== 'void') {
      plan.alreadyImported.push(p.id);
      continue;
    }
    const key = fuelSourceKey(p.id, input.driverId);
    keep.add(key);
    const amountCents = Math.round(p.amount * 100);
    const description = fuelLineDescription(p);
    const onDate = localParts(p.at, input.timezone)?.date ?? p.at.slice(0, 10);
    const occurredAt = new Date(p.at).toISOString();
    const ex = bySource.get(key);
    if (!ex) {
      plan.add.push({
        driverId: input.driverId,
        kind: 'fuel',
        onDate,
        occurredAt,
        amountCents,
        recoveredCents: 0,
        state: input.deductFuel ? (p.status === 'problem' ? 'pending' : 'approved') : 'applied',
        source: FUEL_LEDGER_SOURCE,
        sourceKey: key,
        truckId: p.truckId || input.truckId,
        loadId: p.loadId ?? null,
        settlementId: null,
        description,
        companyCost: !input.deductFuel,
        reason: p.status === 'problem' ? 'The fuel ledger marks this purchase as a problem: approve it on the driver’s account before it is deducted.' : null,
      });
      continue;
    }
    const open = !ex.settlementId && ex.recoveredCents === 0 && ex.state !== 'void';
    if (open && (ex.amountCents !== amountCents || ex.description !== description || ex.onDate !== onDate || ex.occurredAt !== occurredAt)) {
      plan.update.push({ id: ex.id, amountCents, description, onDate, occurredAt });
    }
  }
  for (const t of input.existing) {
    if (t.source !== FUEL_LEDGER_SOURCE || keep.has(t.sourceKey) || t.state === 'void' || t.settlementId || t.recoveredCents > 0) continue;
    if (!t.occurredAt || !txInPeriod(t, { ...input.period, startsAt: input.period.startsAt ?? `${input.period.start}T00:00:00.000Z` })) continue;
    plan.void.push(t.id);
  }
  return plan;
}
