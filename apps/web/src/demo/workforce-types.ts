import type { IsoDate, IsoDateTime } from './types';

/**
 * Driver escrow, and what happens when a driver leaves.
 *
 * One file because they answer one question between them: what a driver owes the company and what
 * the company owes the driver on the day they walk out. Equipment that never came back is money;
 * escrow is the money held against exactly that. (The weekly inspection moved to `pti-types.ts`,
 * where it is keyed on the truck rather than the driver.)
 */

// ======================================================================================= escrow

/**
 * One movement of a driver's escrow.
 *
 * Escrow is the driver's own money held by the carrier. Every entry is signed by the person who
 * recorded it and never edited afterwards — a balance that can be quietly rewritten is not a
 * balance anybody can be held to.
 */
export type EscrowEntryKind = 'payment' | 'charge' | 'refund';

export interface EscrowEntry {
  id: string;
  driverId: string;
  date: IsoDate;
  kind: EscrowEntryKind;
  /** Always positive. The kind decides the direction. */
  amount: number;
  reason: string;
  /** What it relates to: a termination id, a settlement number, a deposit reference. */
  reference: string | null;
  recordedById: string | null;
  recordedByName: string;
  createdAt: IsoDateTime;
}

/** What the carrier holds for one driver, and what it is meant to hold. */
export interface EscrowAccount {
  driverId: string;
  target: number;
  held: number;
  charged: number;
  refunded: number;
  /** `held - charged - refunded`: what is actually on hand today. */
  balance: number;
  entries: EscrowEntry[];
}

// ================================================================================== termination

export type TerminationReason =
  | 'resigned'
  | 'dismissed_performance'
  | 'dismissed_safety'
  | 'abandoned_truck'
  | 'failed_drug_test'
  | 'medical'
  | 'end_of_contract'
  | 'other';

export const TERMINATION_REASON_LABEL: Record<TerminationReason, string> = {
  resigned: 'Resigned',
  dismissed_performance: 'Dismissed — performance',
  dismissed_safety: 'Dismissed — safety',
  abandoned_truck: 'Abandoned the truck',
  failed_drug_test: 'Failed a drug or alcohol test',
  medical: 'Medical',
  end_of_contract: 'End of contract',
  other: 'Other',
};

/** One piece of company property the driver was issued. */
export interface IssuedEquipmentItem {
  code: string;
  label: string;
  returned: boolean;
  /** Charged only when the item did not come back. */
  replacementCost: number;
}

/** The kit a driver is issued, with what each piece costs to replace. */
export const ISSUED_EQUIPMENT: Array<{ code: string; label: string; replacementCost: number }> = [
  { code: 'tablet', label: 'Tablet / ELD', replacementCost: 450 },
  { code: 'chains', label: 'Tire chains (set)', replacementCost: 380 },
  { code: 'straps', label: 'Straps and binders', replacementCost: 220 },
  { code: 'fuel_card', label: 'Fuel card', replacementCost: 50 },
  { code: 'ez_pass', label: 'Toll transponder', replacementCost: 35 },
  { code: 'keys', label: 'Truck and trailer keys', replacementCost: 120 },
  { code: 'pallet_jack', label: 'Pallet jack', replacementCost: 600 },
  { code: 'ppe', label: 'Safety kit and PPE', replacementCost: 90 },
];

export interface TerminationRecord {
  id: string;
  driverId: string;
  driverName: string;
  driverNumber: string;
  /** The day they left. */
  effectiveOn: IsoDate;
  reason: TerminationReason;
  reasonNote: string | null;
  /** Would the carrier take them back. Recorded because it is asked on every reference call. */
  rehireEligible: boolean;
  equipment: IssuedEquipmentItem[];
  /** Sum of the replacement cost of everything not returned. */
  equipmentCharge: number;
  accident: boolean;
  accidentNote: string | null;
  accidentCharge: number;
  otherCharge: number;
  otherChargeNote: string | null;
  /** Escrow balance at the moment of termination. */
  escrowHeld: number;
  /** What the charges actually took from escrow — never more than was held. */
  escrowApplied: number;
  /** Owed back to the driver after charges. */
  escrowRefund: number;
  /** Charges escrow could not cover; becomes a deduction against the final settlement. */
  shortfall: number;
  recordedById: string | null;
  recordedByName: string;
  createdAt: IsoDateTime;
}
