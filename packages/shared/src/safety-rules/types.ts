// Accident & Claims v2 — domain model for the pure rules package.
// Ported from docs/accidents/prototype/src/types.ts. Differences from the prototype (SPEC §3.1, §11):
//   - every money field is an integer number of CENTS and carries a `Cents` suffix;
//   - stage `response` is `initial_response`;
//   - `isDemo` is `isTest` (the fixtures load with isTest = false — ACCEPTANCE §0);
//   - a load can say explicitly whether it is hazmat (`hazmat`), which the report prefill needs (SPEC §11 #9);
//   - a truck's daily contribution is optional (the settings fallback applies — SPEC §7.13 rule 6).
// The model is storage-independent: the API maps its rows onto it and the rules run on it.

/** Five-state answer used everywhere a fact can be unknown at intake.
 *  null = "Not yet reported" (nobody has asked/answered yet). */
export type Tri = 'yes' | 'no' | 'unknown' | 'na' | null;

export type Severity = 'minor' | 'moderate' | 'serious' | 'critical';
export type Stage = 'draft' | 'initial_response' | 'investigation' | 'resolution' | 'closed';
export type Dept = 'Safety' | 'Fleet' | 'Dispatch' | 'Claims' | 'Accounting' | 'Management' | 'Driver Relations';
export type Provenance = 'verified' | 'driver' | 'preliminary';

export type RoleKey =
  | 'safety_manager'
  | 'safety_specialist'
  | 'claims'
  | 'fleet'
  | 'dispatch'
  | 'accounting'
  | 'ops_manager'
  | 'owner';

export interface Person {
  id: string;
  name: string;
  title: string;
  dept: Dept;
  initials: string;
  base: 'US' | 'Tashkent';
  role: RoleKey;
}

export interface Driver {
  id: string;
  name: string;
  type: 'Company driver' | 'Lease operator' | 'Owner-operator';
  hired: string;
  phone: string;
  terminal: string;
  cdlState: string;
}

export interface Truck {
  id: string;
  unit: string;
  year: number;
  make: string;
  model: string;
  vinTail: string;
  status: 'Available' | 'Dispatched' | 'Out of service' | 'In shop';
  driverId?: string;
  trailerId?: string;
  loadId?: string;
  /** Average daily contribution margin used for the lost-revenue estimate (not revenue, not cash).
   *  Missing → `SafetyRuleSettings.fallbackDailyContributionCents`. */
  dailyContributionCents?: number | null;
  location: string;
}

export interface Trailer {
  id: string;
  unit: string;
  year: number;
  make: string;
  status: 'Available' | 'In use' | 'Out of service' | 'In shop';
  location: string;
}

export interface Load {
  id: string;
  number: string;
  customer: string;
  broker?: string;
  commodity: string;
  valueCents: number;
  weightLbs: number;
  origin: string;
  destination: string;
  pickupAt: string;
  deliveryDue: string;
  status: 'In transit' | 'Delivered' | 'Delayed' | 'Repowered' | 'Partially rejected';
  truckId?: string;
  driverId?: string;
  trailerId?: string;
  /** true = hazmat load, false = the load record explicitly says non-hazmat, null/undefined = not stated. */
  hazmat?: boolean | null;
}

export interface AssignmentSnapshot {
  truckId: string;
  driverId?: string;
  trailerId?: string;
  loadId?: string;
  source: string;
  asOf: string;
}

export type WOStatus = 'Awaiting estimate' | 'Waiting for approval' | 'Approved' | 'In repair' | 'Completed';
export interface Estimate {
  id: string;
  vendor: string;
  amountCents: number;
  at: string;
  selected?: boolean;
}
export interface WorkOrder {
  id: string;
  number: string;
  unitKind: 'truck' | 'trailer';
  unitId: string;
  caseId?: string;
  type: 'Accident repair' | 'Repair' | 'Inspection';
  title: string;
  shop: string;
  status: WOStatus;
  estimates: Estimate[];
  estimatesRequired: number;
  approvedAmountCents?: number;
  approvedBy?: string;
  invoiceNumber?: string;
  invoiceTotalCents?: number;
  billId?: string;
  openedAt: string;
  shopInAt?: string;
  eta?: string;
  completedAt?: string;
  createdBy: string;
}

export type BillCategory =
  | 'Towing'
  | 'Storage'
  | 'Tractor repair'
  | 'Trailer repair'
  | 'Transload / recovery'
  | 'Rental equipment'
  | 'Deductible'
  | 'Cargo'
  | 'Other';
export interface Bill {
  id: string;
  number: string;
  vendor: string;
  amountCents: number;
  date: string;
  status: 'Open' | 'Approved' | 'Paid';
  category: BillCategory;
  caseId?: string;
  claimId?: string;
  woId?: string;
  memo: string;
}

export interface DowntimePeriod {
  id: string;
  caseId: string;
  unitKind: 'truck' | 'trailer';
  unitId: string;
  start: string;
  end?: string;
  source: 'Daily board status' | 'Work order' | 'Entered by Safety';
  verifiedBy?: string;
  note?: string;
}

export interface InvolvedVehicle {
  id: string;
  description: string;
  owner: string;
  driver?: string;
  insurer?: string;
  policyNo?: string;
  damage: string;
  towed: Tri;
  plate?: string;
}

export interface Witness {
  id: string;
  name: string;
  contact: string;
  statementEvidenceId?: string;
  note?: string;
}

export interface Fact {
  id: string;
  text: string;
  source: string;
  provenance: Provenance;
  by: string;
  at: string;
}
export interface Question {
  id: string;
  text: string;
  ownerId?: string;
  answer?: string;
  resolvedAt?: string;
  resolvedBy?: string;
  createdAt: string;
}
export interface Statement {
  id: string;
  party: string;
  kind: 'Driver' | 'Witness' | 'Third party' | 'Police';
  takenAt: string;
  takenBy: string;
  summary: string;
  evidenceId?: string;
}
export interface Factor {
  id: string;
  category: 'Driver' | 'Vehicle' | 'Environment' | 'Other party' | 'Operational';
  label: string;
  level: 'confirmed' | 'possible' | 'ruled_out';
}
export interface ChecklistItem {
  key: string;
  label: string;
  state: 'reviewed' | 'pending' | 'not_available' | 'requested';
  note?: string;
  restricted?: boolean;
}

export interface Determination<T extends string> {
  value: T;
  basis?: string;
  by?: string;
  at?: string;
}
export type FaultValue = 'not_determined' | 'not_at_fault' | 'partial' | 'at_fault';
export type PreventValue = 'not_determined' | 'non_preventable' | 'preventable';
export type CpdpValue =
  | 'not_applicable'
  | 'not_eligible'
  | 'eligible_not_submitted'
  | 'submitted'
  | 'not_preventable'
  | 'preventable'
  | 'undecided';
export type LegalValue =
  | 'unknown'
  | 'no_claim_expected'
  | 'disputed'
  | 'third_party_liable'
  | 'shared'
  | 'company_liable'
  | 'in_litigation';

export interface CorrectiveAction {
  id: string;
  kind: 'Coaching' | 'Retraining' | 'Ride-along evaluation' | 'Disciplinary review' | 'Equipment fix' | 'Policy / bulletin';
  title: string;
  driverId?: string;
  assigneeId: string;
  due: string;
  status: 'Open' | 'In progress' | 'Completed' | 'Waived';
  completedAt?: string;
  evidence?: string;
  decisionBy?: string;
  restricted?: boolean;
}

export interface TestRecord {
  substance: 'alcohol' | 'drug';
  /** 'auto' = follow the rule. Safety may only escalate to 'required' (company policy); nobody can switch a
   *  legally required test off — "not required" always comes from the facts. */
  decision: 'auto' | 'required';
  administeredAt?: string;
  resultRestricted?: string;
  notAdministeredReason?: string;
  /** Alcohol test given more than 2 hours after the accident: why it was not given sooner (49 CFR 382.303(d)(1)). */
  delayReason?: string;
}

export interface EquipmentState {
  condition: 'drivable' | 'not_drivable' | 'unknown';
  status:
    | 'unknown'
    | 'operational'
    | 'at_scene'
    | 'towed_storage'
    | 'at_shop'
    | 'in_repair'
    | 'returned'
    | 'total_loss'
    | 'not_involved';
  damage: string;
  towCompany?: string;
  towedTo?: string;
  storageRatePerDayCents?: number;
  storageSince?: string;
  rtsAt?: string;
}

export interface CargoState {
  status: 'na' | 'unknown' | 'no_damage' | 'damaged' | 'loss';
  plan?: 'none_needed' | 'transload' | 'repower' | 'delivered_as_is' | 'rejected' | 'salvage';
  notes?: string;
  deliveryImpact?: string;
  brokerNotified?: Tri;
}

export interface CaseSummaryOverride {
  text: string;
  by: string;
  at: string;
  factsHash: string;
}

export interface AccidentCase {
  id: string;
  number: string;
  stage: Stage;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  version: number;
  submittedAt?: string;
  isTest: boolean;
  occurredAt: string;
  /** IANA zone of the incident location. */
  tz: string;
  timeProvenance: Provenance;
  location: {
    road?: string;
    detail?: string;
    city: string;
    state: string;
    lat?: number;
    lng?: number;
    publicRoad: Tri;
  };
  locationProvenance: Provenance;
  type: string;
  description: string;
  descriptionProvenance: Provenance;
  severity: Severity;
  severityManual?: { reason: string; by: string };
  driverId?: string;
  truckId?: string;
  trailerId?: string;
  loadId?: string;
  assignmentSource?: string;
  injuries: {
    status: Tri;
    treatedAway: number | null;
    fatalities: number | null;
    ourDriver: Tri;
    detailsRestricted?: string;
    provenance: Provenance;
  };
  towAway: Tri;
  towProvenance: Provenance;
  citation: { status: Tri; issuedAt?: string; note?: string };
  hazmat: Tri;
  excludedOccurrence?: 'boarding_alighting' | 'loading_unloading';
  police: { responded: Tri; dept?: string; reportNumber?: string };
  conditions: { weather?: string; road?: string; light?: string };
  vehicles: InvolvedVehicle[];
  witnesses: Witness[];
  equipment: { truck: EquipmentState; trailer?: EquipmentState };
  cargo: CargoState;
  immediate: { key: string; label: string; done: boolean }[];
  investigation: {
    status: 'not_started' | 'in_progress' | 'in_review' | 'complete';
    ownerId?: string;
    facts: Fact[];
    questions: Question[];
    statements: Statement[];
    checklist: ChecklistItem[];
    factors: Factor[];
    conclusion?: string;
    submittedBy?: string;
    submittedAt?: string;
    approvedBy?: string;
    completedAt?: string;
  };
  determinations: {
    fault: Determination<FaultValue>;
    preventability: Determination<PreventValue>;
    cpdp: Determination<CpdpValue> & { rdr?: string };
    legal: Determination<LegalValue>;
  };
  correctiveActions: CorrectiveAction[];
  testing: { alcohol: TestRecord; drug: TestRecord };
  ownerId: string;
  summaryOverride?: CaseSummaryOverride;
  initialEstimateCents?: number;
  claimDecision?: { text: string; by: string; at: string };
  legalHold?: { since: string; by: string; reason: string };
  closure?: {
    at: string;
    by: string;
    override?: { reason: string; by: string };
    outcome: string;
    prevention: string;
  };
  outcome?: string;
}

export type ClaimType = 'physical_damage' | 'auto_liability' | 'cargo' | 'recovery' | 'workers_comp';
export type ClaimStatus =
  | 'Draft'
  | 'Open'
  | 'Under review'
  | 'Awaiting documents'
  | 'Negotiating'
  | 'Settled'
  | 'Denied'
  | 'Closed';

export interface ClaimPayment {
  id: string;
  at: string;
  amountCents: number;
  direction: 'to_us' | 'by_insurer_to_claimant' | 'by_us';
  party: string;
  note?: string;
  billId?: string;
}
export interface Claim {
  id: string;
  number: string;
  caseId?: string;
  type: ClaimType;
  status: ClaimStatus;
  isTest: boolean;
  title: string;
  standaloneKind?: string;
  insurer: string;
  insurerClaimNo?: string;
  adjuster?: { name: string; phone: string; email: string };
  claimant?: string;
  responsibleParty?: string;
  unitLabel?: string;
  loadId?: string;
  openedAt: string;
  reportedToInsurerAt?: string;
  claimedCents?: number;
  reserveCents?: number;
  deductibleCents?: number;
  settlementCents?: number;
  payments: ClaimPayment[];
  docs: { id: string; label: string; received: boolean }[];
  log: { id: string; at: string; by: string; channel: 'Email' | 'Phone' | 'Portal' | 'Note' | 'Letter'; text: string }[];
  nextFollowUp?: { at: string; assigneeId: string; what: string };
  ownerId: string;
  /** Bodily-injury / workers' comp claims: details and money only for `safety.restricted` (SPEC §7.13 rule 7). */
  restricted?: boolean;
  lastUpdateAt: string;
  closedAt?: string;
  disputed?: boolean;
}

export type TaskStatus = 'open' | 'in_progress' | 'blocked' | 'done' | 'cancelled';
export interface Task {
  id: string;
  caseId?: string;
  claimId?: string;
  title: string;
  dept: Dept;
  assigneeId?: string;
  due: string;
  status: TaskStatus;
  priority: 'high' | 'normal';
  instructions?: string;
  updates: { id: string; at: string; by: string; text: string }[];
  createdAt: string;
  createdBy: string;
  completedAt?: string;
  completedBy?: string;
  auto?: string;
  blockedReason?: string;
}

export type EvidenceCategory =
  | 'Scene photo'
  | 'Damage photo'
  | 'Dashcam / video'
  | 'Police report'
  | 'Driver statement'
  | 'Witness statement'
  | 'Third-party correspondence'
  | 'Insurance document'
  | 'Repair estimate'
  | 'Invoice'
  | 'Medical (restricted)'
  | 'Legal (restricted)'
  | 'Settlement'
  | 'Test record (restricted)'
  | 'Other';

export interface Evidence {
  id: string;
  caseId?: string;
  claimId?: string;
  category: EvidenceCategory;
  name: string;
  description: string;
  kind: 'photo' | 'video' | 'pdf' | 'doc';
  uploadedAt: string;
  uploadedBy: string;
  sizeKb: number;
  versions: { v: number; at: string; by: string; note: string }[];
  restricted?: boolean;
  removed?: { at: string; by: string; reason: string };
}

export type EventSource =
  | 'Safety'
  | 'Fleet'
  | 'Dispatch'
  | 'Claims'
  | 'Accounting'
  | 'Telematics'
  | 'Driver'
  | 'System'
  | 'Management';
export interface TimelineEvent {
  id: string;
  caseId?: string;
  claimId?: string;
  at: string;
  loggedAt: string;
  by: string;
  source: EventSource;
  text: string;
  kind?: 'milestone' | 'change' | 'note' | 'task';
  restricted?: boolean;
}

export interface MileageMonth {
  month: string;
  miles: number;
  coverage: number;
}

/** Everything the rules read. The API assembles it from its tables (or a narrowed slice for one case). */
export interface SafetyRulesState {
  people: Person[];
  drivers: Driver[];
  trucks: Truck[];
  trailers: Trailer[];
  loads: Load[];
  assignments: AssignmentSnapshot[];
  cases: AccidentCase[];
  claims: Claim[];
  tasks: Task[];
  evidence: Evidence[];
  events: TimelineEvent[];
  workOrders: WorkOrder[];
  bills: Bill[];
  downtime: DowntimePeriod[];
  mileage: MileageMonth[];
}
