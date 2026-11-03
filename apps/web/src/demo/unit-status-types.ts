import type { IsoDate, IsoDateTime } from './types';

/**
 * Why a unit left the road, in enough detail to answer the questions that follow.
 *
 * A status of "inactive" tells an auditor, an insurer and an accountant nothing. Each of them asks
 * a different question the next morning: what did it sell for, what was in it when it was taken,
 * what burned, what broke. This record is where those answers live, written once by the person who
 * made the change and never edited afterwards.
 */

export type UnitExitReason =
  | 'sold'
  | 'stolen'
  | 'fire'
  | 'accident'
  | 'totaled'
  | 'mechanical'
  | 'lease_returned'
  | 'age_retired'
  | 'other';

export const UNIT_EXIT_REASON_LABEL: Record<UnitExitReason, string> = {
  sold: 'Sold',
  stolen: 'Stolen',
  fire: 'Fire',
  accident: 'Accident',
  totaled: 'Totaled (total loss)',
  mechanical: 'Mechanical failure',
  lease_returned: 'Returned (lease / owner)',
  age_retired: 'Retired on age or mileage',
  other: 'Other',
};

/** One thing that was in or on the truck, and what it was worth. */
export interface UnitContentItem {
  label: string;
  value: number;
  recovered: boolean;
}

/** One thing the impact broke. */
export interface UnitDamageItem {
  part: string;
  note: string;
  repairable: boolean;
  estimate: number;
}

export interface UnitExitRecord {
  id: string;
  entity: 'truck' | 'trailer';
  unitId: string;
  unitNumber: string;
  /** The status the unit moved to: out_of_service, inactive, sold. */
  toStatus: string;
  fromStatus: string;
  occurredOn: IsoDate;
  reason: UnitExitReason;
  /** The plain-language account. Always required — the dropdown alone is not an answer. */
  narrative: string;
  odometer: number | null;

  // ---- sold ----------------------------------------------------------------------------------
  salePrice: number | null;
  buyer: string | null;
  titleTransferred: boolean | null;

  // ---- stolen --------------------------------------------------------------------------------
  policeReport: string | null;
  stolenFrom: string | null;
  recovered: boolean | null;

  // ---- fire and accident ---------------------------------------------------------------------
  /** What was in the truck at the time, with its value. */
  contents: UnitContentItem[];
  /** What broke. Accident and fire both use it. */
  damage: UnitDamageItem[];
  injuries: boolean | null;
  driverId: string | null;
  driverName: string | null;
  loadNumber: string | null;

  // ---- money ---------------------------------------------------------------------------------
  insuranceClaimNumber: string | null;
  insuredValue: number | null;
  deductible: number | null;
  /** What the carrier expects to recover: a sale price, a claim payout, nothing. */
  expectedRecovery: number | null;

  recordedById: string | null;
  recordedByName: string;
  createdAt: IsoDateTime;
  /**
   * Set by the server on a stolen unit's record for anyone without the administrator role (owner
   * decision): every detail is blank and the screens show only the word "Stolen" and the status.
   */
  redacted?: boolean;
}

/** The fields each reason actually asks for; the dialog and the summary both read this. */
export const EXIT_REASON_FIELDS: Record<
  UnitExitReason,
  { contents: boolean; damage: boolean; sale: boolean; theft: boolean; claim: boolean }
> = {
  sold: { contents: false, damage: false, sale: true, theft: false, claim: false },
  stolen: { contents: true, damage: false, sale: false, theft: true, claim: true },
  fire: { contents: true, damage: true, sale: false, theft: false, claim: true },
  accident: { contents: true, damage: true, sale: false, theft: false, claim: true },
  totaled: { contents: true, damage: true, sale: false, theft: false, claim: true },
  mechanical: { contents: false, damage: true, sale: false, theft: false, claim: false },
  lease_returned: { contents: false, damage: false, sale: false, theft: false, claim: false },
  age_retired: { contents: false, damage: false, sale: true, theft: false, claim: false },
  other: { contents: false, damage: false, sale: false, theft: false, claim: false },
};

/** Parts offered as damage rows; anything else is typed in. */
export const DAMAGE_PARTS = [
  'Cab',
  'Frame',
  'Engine',
  'Transmission',
  'Drive axle',
  'Steer axle',
  'Fuel tanks',
  'Fifth wheel',
  'Electrical',
  'Tyres',
  'Body panels',
  'Interior',
] as const;
