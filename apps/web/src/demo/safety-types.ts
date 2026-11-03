/**
 * The Safety records, shaped to the Phase 8 contract.
 *
 * Every field here corresponds to a column committed in `docs/DATABASE.md` §3.9–§3.10 —
 * `inspections`, `defects`, `violations`, `accidents`, `claims` — using the same names and the same
 * enums. That is the point: when Phase 8 replaces the demo data source, the adapter maps rows to
 * these interfaces and nothing above it changes.
 *
 * Where a field exists only in the UI's world (a display name for an id, say) it is marked, so the
 * boundary between "stored" and "joined for display" stays visible.
 */
import type {
  AccidentSeverity,
  AccidentStatus,
  ClaimKind,
  ClaimStatus,
  DefectSeverity,
  DefectSource,
  DefectStatus,
  EvidenceKind,
  InspectionAssetType,
  InspectionKind,
  InspectionResult,
  Preventability,
  ViolationCategory,
  ViolationSeverity,
  ViolationSource,
} from '@neway/shared';
import type { IsoDate, IsoDateTime } from './types';

// ---------------------------------------------------------------------------------------------
// Inspections (`inspections`)
// ---------------------------------------------------------------------------------------------

export interface Inspection {
  id: string;
  /** Human reference, e.g. `INS-2026-0184`. */
  inspectionNumber: string;
  assetType: InspectionAssetType;
  assetId: string;
  /** Joined for display. */
  unitNumber: string;
  kind: InspectionKind;
  at: IsoDateTime;
  /** Who performed it. A roadside inspection names the officer and agency. */
  inspector: string;
  inspectorAgency: string | null;
  location: { city: string; state: string } | null;
  /** Null until the inspection has actually been performed. */
  result: InspectionResult | null;
  startedAt: IsoDateTime | null;
  completedAt: IsoDateTime | null;
  cancelledAt: IsoDateTime | null;
  driverId: string | null;
  /** Joined for display. */
  driverName: string | null;
  trailerId: string | null;
  trailerUnit: string | null;
  odometer: number | null;
  /** The roadside report number, when one was issued. */
  reportNumber: string | null;
  /** Roadside inspections are levels I–VI; company inspections have none. */
  level: 1 | 2 | 3 | 4 | 5 | 6 | null;
  /** True when the inspection put the unit or driver out of service. */
  outOfService: boolean;
  notes: string | null;
}

// ---------------------------------------------------------------------------------------------
// Defects — an inspection's findings (`defects`)
// ---------------------------------------------------------------------------------------------

export interface Defect {
  id: string;
  /** Human reference, e.g. `DEF-0142`. */
  defectNumber: string;
  assetType: InspectionAssetType;
  assetId: string;
  unitNumber: string;
  source: DefectSource;
  /** The inspection that raised it, when it came from one. */
  inspectionId: string | null;
  severity: DefectSeverity;
  /** The vehicle system at fault, e.g. `brakes`, `lighting`, `tires`. */
  component: string;
  description: string;
  /** The CFR or CVSA reference the inspector cited, when there was one. */
  regulation: string | null;
  status: DefectStatus;
  /** The repair order fixing it — the existing maintenance record, not a parallel one. */
  repairOrderId: string | null;
  reportedAt: IsoDateTime;
  resolvedAt: IsoDateTime | null;
  /** When the repair is due. Null when nobody has set one. */
  dueOn: IsoDate | null;
  /** True when this defect is why the unit was placed out of service. */
  outOfService: boolean;
  notes: string | null;
}

// ---------------------------------------------------------------------------------------------
// Violations (`violations`)
// ---------------------------------------------------------------------------------------------

export interface Violation {
  id: string;
  /** Human reference, e.g. `VIO-2026-0091`. */
  violationNumber: string;
  driverId: string | null;
  driverName: string | null;
  truckId: string | null;
  unitNumber: string | null;
  onDate: IsoDate;
  /** One of the seven FMCSA CSA BASICs. */
  category: ViolationCategory;
  /** The FMCSA violation code, e.g. `392.2-SLLS2`. */
  code: string;
  description: string;
  severity: ViolationSeverity;
  /** FMCSA severity weight, when the code carries one. Null when it does not. */
  points: number | null;
  source: ViolationSource;
  /** The roadside inspection that produced it, when it came from one. */
  inspectionId: string | null;
  location: { city: string; state: string } | null;
  /** Citation issued alongside it, when one was. */
  citationNumber: string | null;
  issuingAgency: string | null;
  fineAmount: number | null;
  /** Court date on the citation, when there is one. */
  courtDate: IsoDate | null;
  disposition: string | null;
  contested: boolean;
  resolvedAt: IsoDateTime | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------------------------
// Accidents (`accidents`)
// ---------------------------------------------------------------------------------------------

export type AccidentKind =
  | 'collision'
  | 'rear_end'
  | 'side_impact'
  | 'backing'
  | 'rollover'
  | 'jackknife'
  | 'fixed_object'
  | 'cargo_loss'
  | 'weather'
  | 'mechanical'
  | 'animal_strike'
  | 'other';

export interface AccidentInjury {
  id: string;
  /** Named only where the viewer's role permits; masked otherwise. */
  person: string;
  role: 'driver' | 'passenger' | 'third_party' | 'pedestrian';
  injuryType: string;
  /** True when the person needed immediate treatment away from the scene (49 CFR 390.5). */
  treatedAwayFromScene: boolean;
  hospital: string | null;
  workersCompClaim: string | null;
  notes: string | null;
}

export interface AccidentDamage {
  /** Null means not yet assessed, which is different from no damage. */
  truckRepairEstimate: number | null;
  truckRepairFinal: number | null;
  trailerRepairEstimate: number | null;
  trailerRepairFinal: number | null;
  cargoLossAmount: number | null;
  thirdPartyEstimate: number | null;
  propertyDamageEstimate: number | null;
  towingCost: number | null;
  storageCost: number | null;
  otherCost: number | null;
}

export interface Accident {
  id: string;
  /** Human reference, e.g. `ACC-2026-0007`. */
  accidentNumber: string;
  at: IsoDateTime;
  driverId: string;
  driverName: string;
  truckId: string;
  unitNumber: string;
  trailerId: string | null;
  trailerUnit: string | null;
  loadId: string | null;
  loadNumber: string | null;
  location: { city: string; state: string; highway: string | null };
  kind: AccidentKind;
  severity: AccidentSeverity;
  description: string;
  /** The narrative, filled in as the investigation proceeds. */
  narrative: string | null;
  primaryCause: string | null;
  contributingFactors: string[];
  weather: string | null;
  roadConditions: string | null;
  trafficConditions: string | null;
  preventable: Preventability;
  /** Recorded when someone decides preventability, so the decision is attributable. */
  preventabilityDecidedBy: string | null;
  preventabilityDecidedAt: IsoDateTime | null;
  /** Applied from 49 CFR 390.5 by the shared engine, stored so the file keeps its determination. */
  dotRecordable: boolean;
  injuries: AccidentInjury[];
  fatalities: number;
  towedFromScene: boolean;
  policeReportNumber: string | null;
  policeAgency: string | null;
  damage: AccidentDamage;
  status: AccidentStatus;
  /** The safety manager who owns the investigation. Null means nobody does. */
  ownerId: string | null;
  ownerName: string | null;
  investigationOpenedAt: IsoDateTime | null;
  investigationDueOn: IsoDate | null;
  rootCause: string | null;
  conclusion: string | null;
  closedAt: IsoDateTime | null;
  /** Evidence kinds attached to the file, so the engine can say what is missing. */
  evidence: EvidenceKind[];
  claimId: string | null;
}

// ---------------------------------------------------------------------------------------------
// Claims (`claims`)
// ---------------------------------------------------------------------------------------------

export interface Claim {
  id: string;
  claimNumber: string;
  accidentId: string | null;
  accidentNumber: string | null;
  kind: ClaimKind;
  insurer: string;
  /** The insurer's own reference, once they issue one. */
  insurerClaimNumber: string | null;
  status: ClaimStatus;
  /** Null means unreserved — an unknown liability, never zero. */
  reserveAmount: number | null;
  paidAmount: number | null;
  deductible: number | null;
  description: string;
  /** Everything inherited from the accident, so nothing is retyped. */
  driverId: string | null;
  driverName: string | null;
  truckId: string | null;
  unitNumber: string | null;
  trailerId: string | null;
  loadId: string | null;
  loadNumber: string | null;
  customerId: string | null;
  customerName: string | null;
  brokerId: string | null;
  brokerName: string | null;
  openedAt: IsoDateTime;
  closedAt: IsoDateTime | null;
  ownerId: string | null;
  ownerName: string | null;
  notes: string | null;
}

// ---------------------------------------------------------------------------------------------
// Corrective actions — a safety-department task, not a new record type
// ---------------------------------------------------------------------------------------------

export type CorrectiveActionSubjectType =
  'inspection' | 'defect' | 'violation' | 'accident' | 'driver' | 'truck';

export interface CorrectiveAction {
  id: string;
  actionNumber: string;
  /** What caused it. */
  subjectType: CorrectiveActionSubjectType;
  subjectId: string;
  subjectLabel: string;
  title: string;
  description: string;
  assigneeId: string | null;
  assigneeName: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  /** `tasks.status` — the four the rest of the system uses. */
  status: 'open' | 'in_progress' | 'completed' | 'cancelled';
  dueAt: IsoDateTime;
  completedAt: IsoDateTime | null;
  resolution: string | null;
  createdAt: IsoDateTime;
  createdBy: string;
}

export type { AccidentSeverity, AccidentStatus, ClaimKind, ClaimStatus, EvidenceKind };
