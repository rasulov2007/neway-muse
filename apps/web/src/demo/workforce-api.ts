import { demoCurrentUser, demoData } from './data';
import { today as companyToday } from '@/lib/clock';
import { saveSoon } from './state-persist';
import { setDriverStatusRecord } from './roster-api';
import type { IsoDate } from './types';
import {
  ISSUED_EQUIPMENT,
  type EscrowAccount,
  type EscrowEntry,
  type IssuedEquipmentItem,
  type TerminationReason,
  type TerminationRecord,
} from './workforce-types';

/**
 * The money side of a driver leaving.
 *
 * Two rules run through all of it. Nothing here estimates: a PTI that was not checked says so
 * rather than passing, and a charge is only ever taken against escrow that was actually recorded.
 * And nothing is edited away: escrow moves by new entries, never by rewriting old ones, so the
 * balance can always be explained line by line.
 */

const today = (): IsoDate => companyToday();
const stamp = () => new Date().toISOString();
const id = (prefix: string) =>
  `${prefix}_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;

// ======================================================================================= escrow

/** What the carrier expects to hold per driver, until a setting overrides it. */
export const DEFAULT_ESCROW_TARGET = 2500;

export function escrowAccount(driverId: string, target = DEFAULT_ESCROW_TARGET): EscrowAccount {
  const entries = demoData.escrowEntries
    .filter((e) => e.driverId === driverId)
    .sort((a, b) =>
      a.date < b.date ? 1 : a.date > b.date ? -1 : b.createdAt.localeCompare(a.createdAt),
    );
  const total = (kind: EscrowEntry['kind']) =>
    entries.filter((e) => e.kind === kind).reduce((sum, e) => sum + e.amount, 0);
  const held = total('payment');
  const charged = total('charge');
  const refunded = total('refund');
  return { driverId, target, held, charged, refunded, balance: held - charged - refunded, entries };
}

export interface RecordEscrowInput {
  driverId: string;
  date?: IsoDate;
  kind: EscrowEntry['kind'];
  amount: number;
  reason: string;
  reference?: string | null;
}

export async function recordEscrowEntry(input: RecordEscrowInput): Promise<EscrowEntry> {
  if (!(input.amount > 0)) throw new Error('An escrow entry has to be more than zero');
  if (input.kind !== 'payment') {
    const balance = escrowAccount(input.driverId).balance;
    if (input.amount > balance) {
      throw new Error(
        `Only ${balance.toLocaleString(undefined, { style: 'currency', currency: 'USD' })} is held for this driver`,
      );
    }
  }
  const entry: EscrowEntry = {
    id: id('esc'),
    driverId: input.driverId,
    date: input.date ?? today(),
    kind: input.kind,
    amount: Math.round(input.amount * 100) / 100,
    reason: input.reason,
    reference: input.reference ?? null,
    recordedById: demoCurrentUser.id,
    recordedByName: demoCurrentUser.name,
    createdAt: stamp(),
  };
  demoData.escrowEntries.unshift(entry);
  saveSoon();
  return entry;
}

// ================================================================================== termination

export interface TerminateDriverInput {
  driverId: string;
  effectiveOn?: IsoDate;
  reason: TerminationReason;
  reasonNote?: string | null;
  rehireEligible: boolean;
  /** Every issued item, with whether it came back. */
  equipment: IssuedEquipmentItem[];
  accident: boolean;
  accidentNote?: string | null;
  accidentCharge?: number;
  otherCharge?: number;
  otherChargeNote?: string | null;
  /**
   * The escrow held, as the canonical driver account reports it (dollars). When given, the
   * legacy browser store is neither read nor written: the caller records the offset on the
   * server. Absent only in the old tests.
   */
  escrowHeld?: number;
}

/**
 * Ends a driver's employment and settles what is owed in both directions.
 *
 * The order matters and is the whole point: charges are added up, taken from escrow only as far as
 * escrow reaches, the remainder becomes a deduction against the final settlement rather than
 * quietly disappearing, and whatever is left of the driver's own money is recorded as owed back.
 */
export async function terminateDriver(input: TerminateDriverInput): Promise<TerminationRecord> {
  const driver = demoData.drivers.find((d) => d.id === input.driverId);
  if (!driver) throw new Error('That driver is not on the roster');
  if (driver.status === 'terminated') throw new Error(`${driver.name} is already terminated`);

  const equipment = input.equipment.length > 0 ? input.equipment : defaultEquipment();
  const equipmentCharge = equipment
    .filter((item) => !item.returned)
    .reduce((sum, item) => sum + item.replacementCost, 0);
  const accidentCharge = input.accident ? Math.max(0, input.accidentCharge ?? 0) : 0;
  const otherCharge = Math.max(0, input.otherCharge ?? 0);
  const charges = equipmentCharge + accidentCharge + otherCharge;

  const account = input.escrowHeld === undefined ? escrowAccount(input.driverId) : { balance: input.escrowHeld };
  const applied = Math.min(charges, account.balance);
  const shortfall = Math.round((charges - applied) * 100) / 100;
  const refund = Math.round((account.balance - applied) * 100) / 100;

  const record: TerminationRecord = {
    id: id('term'),
    driverId: driver.id,
    driverName: driver.name,
    driverNumber: driver.driverNumber,
    effectiveOn: input.effectiveOn ?? today(),
    reason: input.reason,
    reasonNote: input.reasonNote?.trim() ? input.reasonNote.trim() : null,
    rehireEligible: input.rehireEligible,
    equipment,
    equipmentCharge,
    accident: input.accident,
    accidentNote: input.accidentNote?.trim() ? input.accidentNote.trim() : null,
    accidentCharge,
    otherCharge,
    otherChargeNote: input.otherChargeNote?.trim() ? input.otherChargeNote.trim() : null,
    escrowHeld: account.balance,
    escrowApplied: applied,
    escrowRefund: refund,
    shortfall,
    recordedById: demoCurrentUser.id,
    recordedByName: demoCurrentUser.name,
    createdAt: stamp(),
  };

  if (applied > 0 && input.escrowHeld === undefined) {
    await recordEscrowEntry({
      driverId: driver.id,
      kind: 'charge',
      amount: applied,
      reason: chargeReason(record),
      reference: record.id,
    });
  }

  // What escrow could not cover follows the driver into Accounting as a deduction, so a final
  // settlement takes it instead of the carrier writing it off silently.
  if (shortfall > 0) {
    demoData.deductionPlans.unshift({
      id: id('ded'),
      driverId: driver.id,
      kind: 'other',
      description: `Termination charges not covered by escrow — ${chargeReason(record)}`,
      amountPerPeriod: shortfall,
      balance: shortfall,
      totalCap: shortfall,
      startsOn: record.effectiveOn,
      endsOn: null,
      status: 'active',
    });
  }

  demoData.terminations.unshift(record);
  saveSoon();

  // The roster is the authority on who is employed; it is written last so a failure above cannot
  // leave a terminated driver with no record of why.
  await setDriverStatusRecord(driver.id, 'terminated');
  driver.status = 'terminated';

  return record;
}

export function listTerminations(): TerminationRecord[] {
  return [...demoData.terminations].sort((a, b) => (a.effectiveOn < b.effectiveOn ? 1 : -1));
}

export function terminationFor(driverId: string): TerminationRecord | null {
  return demoData.terminations.find((t) => t.driverId === driverId) ?? null;
}

/** Everything issued, assumed returned, as the starting point of the dialog. */
export function defaultEquipment(): IssuedEquipmentItem[] {
  return ISSUED_EQUIPMENT.map((item) => ({ ...item, returned: true }));
}

function chargeReason(record: TerminationRecord): string {
  const parts: string[] = [];
  const missing = record.equipment.filter((item) => !item.returned).map((item) => item.label);
  if (missing.length > 0) parts.push(`not returned: ${missing.join(', ')}`);
  if (record.accidentCharge > 0) parts.push('accident');
  if (record.otherCharge > 0) parts.push(record.otherChargeNote ?? 'other charges');
  return parts.length > 0 ? parts.join('; ') : 'termination';
}
