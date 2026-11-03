import { demoCurrentUser, demoData } from './data';
import { today as companyToday } from '@/lib/clock';
import { saveSoon } from './state-persist';
import { changeEntityStatus } from './api';
import { appendFleetAudit } from './internals';
import type { IsoDate } from './types';
import type { UnitExitRecord, UnitExitReason } from './unit-status-types';

/**
 * Taking a unit off the road, with the account of why.
 *
 * One write does both halves: the status moves through the same audited path every other
 * lifecycle change uses, and the account of what happened is filed against the unit. They are not
 * separable — a truck that is suddenly inactive with no record is the thing this exists to stop.
 */

const today = (): IsoDate => companyToday();
const id = () => `exit_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

export interface RecordUnitExitInput extends Omit<
  UnitExitRecord,
  'id' | 'createdAt' | 'recordedById' | 'recordedByName' | 'fromStatus'
> {
  /** Optional: the same reason text also goes on the audit entry. */
  auditReason?: string;
}

export async function recordUnitExit(input: RecordUnitExitInput): Promise<UnitExitRecord> {
  const collection = input.entity === 'truck' ? demoData.trucks : demoData.trailers;
  const unit = collection.find((row) => row.id === input.unitId);
  if (!unit) throw new Error('That unit is not on the fleet');
  const fromStatus = unit.status;

  if (!input.narrative.trim()) {
    throw new Error('Say what happened — the reason on its own is not an account');
  }

  // The status change first: if it is refused, nothing is filed.
  await changeEntityStatus({
    entity: input.entity,
    id: input.unitId,
    toStatus: input.toStatus,
    reason: input.auditReason ?? `${input.reason}: ${input.narrative.trim()}`,
  });

  const record: UnitExitRecord = {
    ...input,
    id: id(),
    fromStatus,
    occurredOn: input.occurredOn || today(),
    narrative: input.narrative.trim(),
    recordedById: demoCurrentUser.id,
    recordedByName: demoCurrentUser.name,
    createdAt: new Date().toISOString(),
  };
  demoData.unitExits.unshift(record);
  saveSoon();
  releaseAssignments(input.entity, input.unitId);
  return record;
}

/** The fields of an account that can be filled in or corrected after it was filed. */
export type UnitExitEdit = Omit<
  RecordUnitExitInput,
  'entity' | 'unitId' | 'unitNumber' | 'toStatus' | 'auditReason'
>;

/**
 * Completes or corrects an account already on file (owner, 2026-10-10): whoever took the unit off
 * the road rarely knew the claim number or what was in it that day. The unit's status does not
 * move; the record keeps who filed it, and the change is audited with what it was before.
 */
export async function updateUnitExit(id: string, input: UnitExitEdit): Promise<UnitExitRecord> {
  const at = demoData.unitExits.findIndex((row) => row.id === id);
  const before = demoData.unitExits[at];
  if (!before) throw new Error('That account is no longer on file');
  if (before.redacted) throw new Error('This account is restricted (stolen unit)');
  if (!input.narrative.trim()) {
    throw new Error('Say what happened — the reason on its own is not an account');
  }
  const after: UnitExitRecord = {
    ...before,
    ...input,
    occurredOn: input.occurredOn || before.occurredOn,
    narrative: input.narrative.trim(),
  };
  demoData.unitExits[at] = after;
  const changed = (Object.keys(input) as Array<keyof UnitExitEdit>).filter(
    (key) => JSON.stringify(before[key]) !== JSON.stringify(after[key]),
  );
  appendFleetAudit({
    action: 'item_updated',
    entity: { type: before.entity, id: before.unitId, label: before.unitNumber },
    subject: 'Off-the-road account',
    before: JSON.stringify(Object.fromEntries(changed.map((key) => [key, before[key]]))),
    after: JSON.stringify(Object.fromEntries(changed.map((key) => [key, after[key]]))),
    reason: 'Account completed after filing',
  });
  saveSoon();
  return after;
}

/** Every account filed against one unit, newest first. */
export function unitExits(unitId: string): UnitExitRecord[] {
  return demoData.unitExits
    .filter((row) => row.unitId === unitId)
    .sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1));
}

/** The most recent account, which is the one a unit page shows. */
export function latestUnitExit(unitId: string): UnitExitRecord | null {
  return unitExits(unitId)[0] ?? null;
}

export function listUnitExits(reason?: UnitExitReason): UnitExitRecord[] {
  const rows = reason
    ? demoData.unitExits.filter((row) => row.reason === reason)
    : demoData.unitExits;
  return [...rows].sort((a, b) => (a.occurredOn < b.occurredOn ? 1 : -1));
}

/** What the carrier stands to lose: contents not recovered plus repair estimates, less recovery. */
export function exposureOf(record: UnitExitRecord): number {
  const contents = record.contents
    .filter((item) => !item.recovered)
    .reduce((sum, item) => sum + item.value, 0);
  const repairs = record.damage.reduce((sum, item) => sum + item.estimate, 0);
  return Math.round((contents + repairs - (record.expectedRecovery ?? 0)) * 100) / 100;
}

/**
 * Lets go of everything the unit was holding.
 *
 * A unit that has left the road is not "assigned to nobody", it is simply no longer part of the
 * working fleet: the driver goes back to the pool, the trailer is unhooked, and any load it was
 * on loses the unit rather than keeping a pointer to a truck that has been sold. Releasing is
 * deliberately not a precondition — blocking the status change on it is what left people unable to
 * retire a unit at all.
 */
function releaseAssignments(entity: 'truck' | 'trailer', unitId: string): void {
  if (entity === 'truck') {
    const truck = demoData.trucks.find((row) => row.id === unitId);
    if (!truck) return;
    const driver = truck.currentDriverId
      ? demoData.drivers.find((row) => row.id === truck.currentDriverId)
      : null;
    if (driver) {
      driver.currentTruckId = null;
      driver.currentTruckUnit = null;
      driver.currentTrailerId = null;
    }
    for (const load of demoData.loads) {
      if (load.truckId === unitId && ACTIVE_LOAD.has(load.status)) {
        load.truckId = null;
        load.truckUnit = null;
      }
    }
    truck.currentDriverId = null;
    truck.currentDriverName = null;
    truck.currentTrailerId = null;
    truck.currentLoadId = null;
    return;
  }

  const trailer = demoData.trailers.find((row) => row.id === unitId);
  if (!trailer) return;
  for (const truck of demoData.trucks) {
    if (truck.currentTrailerId === unitId) truck.currentTrailerId = null;
  }
  for (const driver of demoData.drivers) {
    if (driver.currentTrailerId === unitId) driver.currentTrailerId = null;
  }
  for (const load of demoData.loads) {
    if (load.trailerId === unitId && ACTIVE_LOAD.has(load.status)) {
      load.trailerId = null;
      load.trailerUnit = null;
    }
  }
}

/** Loads still running, which are the only ones whose unit pointer matters. */
const ACTIVE_LOAD = new Set([
  'booked',
  'assigned',
  'dispatched',
  'at_pickup',
  'loading',
  'loaded',
  'in_transit',
  'at_delivery',
  'unloading',
]);
