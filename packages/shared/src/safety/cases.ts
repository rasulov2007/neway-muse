import { z } from 'zod';
import { CLAIM_KINDS, type ClaimKind } from './accident.js';
import { VIOLATION_CATEGORIES, type ViolationCategory } from './violation.js';
import { US_STATE_CODES } from './us-states.js';
import {
  DRUG_ALCOHOL_TEST_TYPES,
  TEST_RESULTS,
  TEST_SUBSTANCES,
  type DrugAlcoholTestType,
  type PostAccidentAssessment,
  type TestResult,
  type TestStatus,
  type TestSubstance,
} from './post-accident-testing.js';

/**
 * Safety cases as the server stores them (Safety v2, owner plan 2026-10-02).
 *
 * Accidents, claims, violations, roadside inspections, safety reviews and drug & alcohol tests
 * used to live in the browser's workspace snapshot. Each is now a row with `company_id`, a
 * human number per company (ACC-001, CLM-001, V-001, INS-001, REV-001, DAT-001), an owner, a
 * next action with a due date, a version every write must name, and an audit trail. Nothing is
 * deleted: a record is voided with a reason, a person and a time.
 *
 * Money is integer cents. Times are ISO instants; business dates are Eastern `YYYY-MM-DD`.
 */

// ---------------------------------------------------------------------------------------------
// Shared vocabulary
// ---------------------------------------------------------------------------------------------

export const SAFETY_CASE_TYPES = [
  'accident',
  'claim',
  'violation',
  'roadside_inspection',
  'safety_review',
  'drug_test',
] as const;
export type SafetyCaseType = (typeof SAFETY_CASE_TYPES)[number];

export const SAFETY_CASE_PREFIX: Record<SafetyCaseType, string> = {
  accident: 'ACC',
  claim: 'CLM',
  violation: 'V',
  roadside_inspection: 'INS',
  safety_review: 'REV',
  drug_test: 'DAT',
};

export const SAFETY_CASE_LABEL: Record<SafetyCaseType, string> = {
  accident: 'Accident',
  claim: 'Claim',
  violation: 'Violation',
  roadside_inspection: 'Roadside inspection',
  safety_review: 'Safety review',
  drug_test: 'Drug & alcohol test',
};

/** `ACC-001`: the prefix and the per-company sequence, padded to three. */
export function formatCaseNumber(type: SafetyCaseType, sequence: number): string {
  return `${SAFETY_CASE_PREFIX[type]}-${String(sequence).padStart(3, '0')}`;
}

const isoInstant = z.string().refine((v) => !Number.isNaN(Date.parse(v)), 'Enter a valid date and time');
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD');
const cents = z.number().int('Amounts are whole cents').min(0, 'Amounts cannot be negative');
const optText = (max = 2000) => z.string().trim().max(max).nullable().optional();
const versionField = z.number().int().min(1);

/** Every case carries these. */
export interface SafetyCaseBase {
  id: string;
  number: string;
  ownerId: string | null;
  ownerName: string | null;
  nextAction: string | null;
  nextActionDueOn: string | null;
  isTest: boolean;
  createdAt: string;
  createdBy: string;
  updatedAt: string;
  version: number;
  voidedAt: string | null;
  voidedBy: string | null;
  voidReason: string | null;
}

export interface SafetyTimelineEntry {
  id: string;
  at: string;
  actorName: string;
  action: string;
  summary: string;
  reason: string | null;
}

export const SAFETY_DOCUMENT_KINDS = [
  'police_report',
  'photos',
  'driver_statement',
  'witness_statement',
  'repair_estimate',
  'invoice',
  'insurer_correspondence',
  'inspection_report',
  'citation',
  'repair_evidence',
  'carrier_certification',
  'return_report',
  'dataqs',
  'test_record',
  'training_record',
  'other',
] as const;
export type SafetyDocumentKind = (typeof SAFETY_DOCUMENT_KINDS)[number];

export const SAFETY_DOCUMENT_KIND_LABEL: Record<SafetyDocumentKind, string> = {
  police_report: 'Police report',
  photos: 'Scene photos',
  driver_statement: 'Driver statement',
  witness_statement: 'Witness statement',
  repair_estimate: 'Repair estimate',
  invoice: 'Invoice',
  insurer_correspondence: 'Insurer correspondence',
  inspection_report: 'Inspection report',
  citation: 'Citation',
  repair_evidence: 'Repair evidence',
  carrier_certification: 'Carrier certification',
  return_report: 'Return report',
  dataqs: 'DataQs filing',
  test_record: 'Test record',
  training_record: 'Training record',
  other: 'Other',
};

export interface SafetyDocument {
  id: string;
  caseType: SafetyCaseType;
  caseId: string;
  fileId: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  title: string;
  kind: SafetyDocumentKind;
  uploadedAt: string;
  uploadedBy: string;
}

export const AttachSafetyDocumentSchema = z.object({
  caseType: z.enum(SAFETY_CASE_TYPES),
  caseId: z.string().min(1),
  fileId: z.string().min(1, 'Upload the file first'),
  kind: z.enum(SAFETY_DOCUMENT_KINDS).default('other'),
  title: z.string().trim().max(200).optional(),
});
export type AttachSafetyDocumentInput = z.infer<typeof AttachSafetyDocumentSchema>;

export const VoidSchema = z.object({
  version: versionField,
  reason: z.string().trim().min(5, 'Say why it is being voided (at least 5 characters)').max(1000),
});
export type VoidInput = z.infer<typeof VoidSchema>;

export const VoidDocumentSchema = z.object({
  reason: z.string().trim().min(5, 'Say why it is being removed').max(1000),
});

export const VersionOnlySchema = z.object({ version: versionField });
export type VersionOnlyInput = z.infer<typeof VersionOnlySchema>;

/** Fields every case lets a person change: who owns it and what happens next. */
const caseWorkFields = {
  ownerId: z.string().min(1).nullable().optional(),
  nextAction: optText(300),
  nextActionDueOn: isoDate.nullable().optional(),
};

// ---------------------------------------------------------------------------------------------
// Accidents
// ---------------------------------------------------------------------------------------------

export const ACCIDENT_STAGES = ['reported', 'evidence', 'testing', 'repairs_claim', 'review', 'closed'] as const;
export type AccidentStage = (typeof ACCIDENT_STAGES)[number];
export const ACCIDENT_STAGE_LABEL: Record<AccidentStage, string> = {
  reported: 'Reported',
  evidence: 'Evidence',
  testing: 'Testing assessed',
  repairs_claim: 'Repairs & claim',
  review: 'Review',
  closed: 'Closed',
};

export const ACCIDENT_FAULTS = ['undetermined', 'our_driver', 'other_party', 'shared'] as const;
export type AccidentFault = (typeof ACCIDENT_FAULTS)[number];
export const ACCIDENT_FAULT_LABEL: Record<AccidentFault, string> = {
  undetermined: 'Undetermined',
  our_driver: 'Our driver',
  other_party: 'Other party',
  shared: 'Shared',
};

export const PREVENTABILITY_DECISIONS = ['undetermined', 'preventable', 'not_preventable'] as const;
export type PreventabilityDecision = (typeof PREVENTABILITY_DECISIONS)[number];
export const PREVENTABILITY_LABEL: Record<PreventabilityDecision, string> = {
  undetermined: 'Under review',
  preventable: 'Preventable',
  not_preventable: 'Not preventable',
};

export const ACCIDENT_CLOSE_KINDS = ['normal', 'administrative'] as const;
export type AccidentCloseKind = (typeof ACCIDENT_CLOSE_KINDS)[number];

export interface SafetyAccidentTest {
  id: string;
  number: string;
  substance: TestSubstance;
  required: boolean;
  /** Null when the caller may not see results. */
  result: TestResult | null;
  resultRestricted: boolean;
  scheduledAt: string | null;
  collectedAt: string | null;
  status: TestStatus;
}

export interface SafetyAccident extends SafetyCaseBase {
  occurredAt: string;
  location: string;
  city: string | null;
  state: string | null;
  driverId: string | null;
  driverName: string | null;
  truckId: string | null;
  truckNumber: string | null;
  trailerId: string | null;
  trailerNumber: string | null;
  loadId: string | null;
  loadNumber: string | null;
  description: string;
  fatalities: number;
  injuries: number;
  injuriesTreatedAway: number;
  disablingTow: boolean;
  citationIssued: boolean;
  citationAt: string | null;
  citationNote: string | null;
  policeReportNumber: string | null;
  dotRecordable: boolean;
  recordableReasons: string[];
  stage: AccidentStage;
  fault: AccidentFault;
  preventability: PreventabilityDecision;
  preventabilityNote: string | null;
  notes: string | null;
  damageEstimateCents: number | null;
  companyDeductibleCents: number | null;
  workOrderId: string | null;
  workOrderNumber: string | null;
  claimId: string | null;
  claimNumber: string | null;
  reviewId: string | null;
  reviewNumber: string | null;
  closedAt: string | null;
  closedBy: string | null;
  closeKind: AccidentCloseKind | null;
  closeReason: string | null;
  testing: PostAccidentAssessment;
  tests: SafetyAccidentTest[];
  /** What stands between this file and a normal close, in words. */
  closeBlockers: string[];
  /** What stands between this stage and the next. */
  advanceBlockers: string[];
}

const accidentFacts = {
  occurredAt: isoInstant,
  location: z.string().trim().min(2, 'Where did it happen?').max(300),
  city: optText(120),
  state: optText(40),
  driverId: z.string().min(1).nullable().optional(),
  truckId: z.string().min(1).nullable().optional(),
  trailerId: z.string().min(1).nullable().optional(),
  loadId: z.string().min(1).nullable().optional(),
  description: z.string().trim().max(4000).default(''),
  fatalities: z.number().int().min(0).default(0),
  injuries: z.number().int().min(0).default(0),
  injuriesTreatedAway: z.number().int().min(0).default(0),
  disablingTow: z.boolean().default(false),
  citationIssued: z.boolean().default(false),
  citationAt: isoInstant.nullable().optional(),
  citationNote: optText(500),
  policeReportNumber: optText(80),
};

export const CreateAccidentSchema = z.object({ ...accidentFacts, ...caseWorkFields, isTest: z.boolean().optional() });
export type CreateAccidentInput = z.infer<typeof CreateAccidentSchema>;

export const UpdateAccidentSchema = z.object({
  version: versionField,
  occurredAt: isoInstant.optional(),
  location: z.string().trim().min(2).max(300).optional(),
  city: optText(120),
  state: optText(40),
  driverId: z.string().min(1).nullable().optional(),
  truckId: z.string().min(1).nullable().optional(),
  trailerId: z.string().min(1).nullable().optional(),
  loadId: z.string().min(1).nullable().optional(),
  description: z.string().trim().max(4000).optional(),
  fatalities: z.number().int().min(0).optional(),
  injuries: z.number().int().min(0).optional(),
  injuriesTreatedAway: z.number().int().min(0).optional(),
  disablingTow: z.boolean().optional(),
  citationIssued: z.boolean().optional(),
  citationAt: isoInstant.nullable().optional(),
  citationNote: optText(500),
  policeReportNumber: optText(80),
  fault: z.enum(ACCIDENT_FAULTS).optional(),
  preventability: z.enum(PREVENTABILITY_DECISIONS).optional(),
  preventabilityNote: optText(2000),
  notes: optText(4000),
  damageEstimateCents: cents.nullable().optional(),
  companyDeductibleCents: cents.nullable().optional(),
  ...caseWorkFields,
});
export type UpdateAccidentInput = z.infer<typeof UpdateAccidentSchema>;

export const CloseAccidentSchema = z
  .object({
    version: versionField,
    kind: z.enum(ACCIDENT_CLOSE_KINDS).default('normal'),
    reason: z.string().trim().max(2000).nullable().optional(),
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'administrative' && (value.reason ?? '').length < 10) {
      ctx.addIssue({
        code: 'custom',
        path: ['reason'],
        message: 'An administrative closure needs a reason of at least 10 characters',
      });
    }
  });
export type CloseAccidentInput = z.infer<typeof CloseAccidentSchema>;

export const LinkWorkOrderSchema = z.object({ version: versionField, workOrderId: z.string().min(1) });
export type LinkWorkOrderInput = z.infer<typeof LinkWorkOrderSchema>;

// ---------------------------------------------------------------------------------------------
// Drug & alcohol tests
// ---------------------------------------------------------------------------------------------

export interface SafetyDrugTest extends SafetyCaseBase {
  testType: DrugAlcoholTestType;
  substance: TestSubstance;
  driverId: string | null;
  driverName: string | null;
  accidentId: string | null;
  accidentNumber: string | null;
  required: boolean;
  requiredReason: string | null;
  occurredAt: string | null;
  scheduledAt: string | null;
  collectedAt: string | null;
  /** Null when the caller does not hold `safety_testing.view`. */
  result: TestResult | null;
  resultAt: string | null;
  resultRestricted: boolean;
  notCompletedReason: string | null;
  lateReason: string | null;
  exceptionReviewedAt: string | null;
  exceptionReviewedBy: string | null;
  exceptionNote: string | null;
  status: TestStatus;
}

export const CreateDrugTestSchema = z.object({
  testType: z.enum(DRUG_ALCOHOL_TEST_TYPES),
  substance: z.enum(TEST_SUBSTANCES),
  driverId: z.string().min(1),
  scheduledAt: isoInstant.nullable().optional(),
  ...caseWorkFields,
});
export type CreateDrugTestInput = z.infer<typeof CreateDrugTestSchema>;

export const UpdateDrugTestSchema = z.object({
  version: versionField,
  scheduledAt: isoInstant.nullable().optional(),
  collectedAt: isoInstant.nullable().optional(),
  result: z.enum(TEST_RESULTS).optional(),
  notCompletedReason: optText(2000),
  lateReason: optText(2000),
  ...caseWorkFields,
});
export type UpdateDrugTestInput = z.infer<typeof UpdateDrugTestSchema>;

export const ReviewTestExceptionSchema = z.object({
  version: versionField,
  note: z.string().trim().min(5, 'Say what was reviewed and decided').max(2000),
});
export type ReviewTestExceptionInput = z.infer<typeof ReviewTestExceptionSchema>;

/**
 * A random test result submitted from the driver's Documents tab (owner, 2026-10-24): the
 * collection date, the result and the lab or MRO paper. One call records the test (DAT-…, type
 * `random`, results restricted as every test result is) and files the paper in the driver's
 * qualification file under `random_drug_test`.
 */
export const RANDOM_TEST_RESULTS = ['negative', 'positive', 'refused', 'cancelled', 'pending'] as const;
export const RecordRandomDrugTestSchema = z
  .object({
    driverId: z.string().min(1),
    substance: z.enum(TEST_SUBSTANCES).default('drug'),
    collectedOn: isoDate,
    result: z.enum(RANDOM_TEST_RESULTS),
    notes: optText(1000),
    fileName: z.string().min(1).max(255),
    contentType: z.enum(['application/pdf', 'image/jpeg', 'image/png']),
    /** The file, base64 without a data: prefix (20 MB at most). */
    content: z.string().min(1).max(Math.ceil(((20 * 1024 * 1024) / 3) * 4) + 1024),
  });
export type RecordRandomDrugTestInput = z.input<typeof RecordRandomDrugTestSchema>;

// ---------------------------------------------------------------------------------------------
// Claims
// ---------------------------------------------------------------------------------------------

export const CLAIM_STAGES = ['opened', 'submitted', 'insurer_review', 'decision', 'payment', 'closed'] as const;
export type ClaimStage = (typeof CLAIM_STAGES)[number];
export const CLAIM_STAGE_LABEL: Record<ClaimStage, string> = {
  opened: 'Opened',
  submitted: 'Submitted',
  insurer_review: 'Insurer review',
  decision: 'Decision',
  payment: 'Payment',
  closed: 'Closed',
};

export const CLAIM_DECISIONS = ['approved', 'partially_approved', 'denied'] as const;
export type ClaimDecision = (typeof CLAIM_DECISIONS)[number];

export const CLAIM_KIND_LABEL: Record<ClaimKind, string> = {
  cargo: 'Cargo',
  liability: 'Liability',
  physical_damage: 'Physical damage',
  workers_comp: "Workers' comp",
};

export interface SafetyClaimPayment {
  id: string;
  receivedOn: string;
  amountCents: number;
  method: string | null;
  reference: string | null;
  note: string | null;
  createdAt: string;
  createdBy: string;
  voidedAt: string | null;
  voidReason: string | null;
}

export const ACCOUNTING_ENTRY_KINDS = [
  'insurer_recovery_approved',
  'insurer_payment_received',
  'company_deductible',
  'driver_deduction_proposal',
  'driver_charge',
] as const;
export type AccountingEntryKind = (typeof ACCOUNTING_ENTRY_KINDS)[number];
export const ACCOUNTING_ENTRY_KIND_LABEL: Record<AccountingEntryKind, string> = {
  insurer_recovery_approved: 'Insurer recovery approved (receivable)',
  insurer_payment_received: 'Insurer payment received',
  company_deductible: 'Company deductible (expense)',
  driver_deduction_proposal: 'Driver deduction — proposal only',
  driver_charge: 'Driver charge — approve on the charge card',
};

export const ACCOUNTING_ENTRY_STATES = ['pending_review', 'confirmed', 'rejected', 'superseded'] as const;
export type AccountingEntryState = (typeof ACCOUNTING_ENTRY_STATES)[number];

/**
 * A claim's money, put in front of Accounting to confirm or reject. Never posted by Safety,
 * never a driver deduction by itself. One row per source key, so saving twice is one entry.
 */
export interface SafetyAccountingEntry {
  id: string;
  claimId: string;
  claimNumber: string;
  kind: AccountingEntryKind;
  amountCents: number;
  state: AccountingEntryState;
  sourceKey: string;
  memo: string;
  createdAt: string;
  reviewedAt: string | null;
  reviewedBy: string | null;
  reviewNote: string | null;
  version: number;
}

export const ReviewAccountingEntrySchema = z.object({
  version: versionField,
  note: z.string().trim().max(1000).nullable().optional(),
});
export type ReviewAccountingEntryInput = z.infer<typeof ReviewAccountingEntrySchema>;

export interface SafetyClaim extends SafetyCaseBase {
  kind: ClaimKind;
  accidentId: string | null;
  accidentNumber: string | null;
  loadId: string | null;
  loadNumber: string | null;
  driverId: string | null;
  driverName: string | null;
  truckId: string | null;
  truckNumber: string | null;
  description: string;
  insurer: string | null;
  policyNumber: string | null;
  insurerReference: string | null;
  adjusterName: string | null;
  adjusterPhone: string | null;
  adjusterEmail: string | null;
  openedOn: string;
  submittedOn: string | null;
  decisionOn: string | null;
  decision: ClaimDecision | null;
  stage: ClaimStage;
  claimedCents: number | null;
  approvedCents: number | null;
  deductibleCents: number | null;
  /** Sum of payments not voided. */
  receivedCents: number;
  /** Approved less received; null until the insurer decides. */
  remainingApprovedCents: number | null;
  driverDeductionProposedCents: number | null;
  driverDeductionNote: string | null;
  closedAt: string | null;
  closedBy: string | null;
  payments: SafetyClaimPayment[];
  accountingEntries: SafetyAccountingEntry[];
  advanceBlockers: string[];
  /** Claims v2 (2026-10-14): who is responsible, set by Safety or carried from the accident. */
  liabilityParty: import('./driver-charges.js').LiabilityParty | null;
  liabilityPct: number | null;
  /** Any event on the claim or its charge; drives "No update in N days". */
  lastActivityAt: string;
  /** One incident, many claims (Claims v2): the lines on this claim file. */
  lines: SafetyClaimLine[];
  /** The live driver charge on the claim, if any (one per claim, driver and basis). */
  driverCharge: Pick<import('./driver-charges.js').DriverCharge, 'id' | 'number' | 'state' | 'amountCents' | 'recoveredCents' | 'driverName' | 'ageDays'> | null;
}

/**
 * Claim lines (Claims v2 §2.2, owner mockup 2026-10-14): one incident, many claims - each kind the
 * New claim dialog ticks becomes a line on the one claim file.
 */
export const CLAIM_LINE_KINDS = ['own_physical_damage', 'third_party_liability', 'cargo_against_us', 'recovery_against_other', 'workers_comp'] as const;
export type ClaimLineKind = (typeof CLAIM_LINE_KINDS)[number];
export const CLAIM_LINE_KIND_LABEL: Record<ClaimLineKind, string> = {
  own_physical_damage: 'Damage to our truck / trailer',
  third_party_liability: 'Damage we caused to others (liability)',
  cargo_against_us: 'Cargo damage / shortage / loss',
  recovery_against_other: 'Recovery from the other party',
  workers_comp: "Injury (workers' comp, restricted)",
};
export const CLAIM_LINE_SHORT: Record<ClaimLineKind, string> = {
  own_physical_damage: 'Physical damage · own unit',
  third_party_liability: 'Third-party liability',
  cargo_against_us: 'Cargo against us',
  recovery_against_other: 'Recovery from the other party',
  workers_comp: "Workers' comp",
};
/** The claim's type, from its first line, for the lists that still read one type. */
export const CLAIM_KIND_OF_LINE: Record<ClaimLineKind, (typeof CLAIM_KINDS)[number]> = {
  own_physical_damage: 'physical_damage',
  third_party_liability: 'liability',
  cargo_against_us: 'cargo',
  recovery_against_other: 'physical_damage',
  workers_comp: 'workers_comp',
};
export interface SafetyClaimLine {
  id: string;
  kind: ClaimLineKind;
  status: string;
  insurer: string | null;
  reserveCents: number | null;
  createdAt: string;
  createdBy: string;
}

export const CreateClaimSchema = z
  .object({
    kind: z.enum(CLAIM_KINDS),
    /** Each ticked kind becomes a line; a claim already open for the accident gets the new ones. */
    lines: z.array(z.enum(CLAIM_LINE_KINDS)).max(5).optional(),
    accidentId: z.string().min(1).nullable().optional(),
    loadId: z.string().min(1).nullable().optional(),
    driverId: z.string().min(1).nullable().optional(),
    truckId: z.string().min(1).nullable().optional(),
    description: z.string().trim().max(4000).default(''),
    insurer: optText(160),
    policyNumber: optText(80),
    claimedCents: cents.nullable().optional(),
    openedOn: isoDate.optional(),
    isTest: z.boolean().optional(),
    ...caseWorkFields,
  })
  .superRefine((value, ctx) => {
    if (value.kind === 'cargo' && !value.loadId && !value.accidentId) {
      ctx.addIssue({ code: 'custom', path: ['loadId'], message: 'A cargo claim names the load (or the accident)' });
    }
  });
export type CreateClaimInput = z.infer<typeof CreateClaimSchema>;

export const UpdateClaimSchema = z.object({
  version: versionField,
  description: z.string().trim().max(4000).optional(),
  insurer: optText(160),
  policyNumber: optText(80),
  insurerReference: optText(80),
  adjusterName: optText(160),
  adjusterPhone: optText(40),
  adjusterEmail: optText(160),
  submittedOn: isoDate.nullable().optional(),
  decisionOn: isoDate.nullable().optional(),
  decision: z.enum(CLAIM_DECISIONS).nullable().optional(),
  claimedCents: cents.nullable().optional(),
  approvedCents: cents.nullable().optional(),
  deductibleCents: cents.nullable().optional(),
  driverDeductionProposedCents: cents.nullable().optional(),
  driverDeductionNote: optText(1000),
  ...caseWorkFields,
});
export type UpdateClaimInput = z.infer<typeof UpdateClaimSchema>;

export const RecordClaimPaymentSchema = z.object({
  version: versionField,
  receivedOn: isoDate,
  amountCents: z.number().int().min(1, 'A payment is more than $0'),
  method: optText(60),
  reference: optText(120),
  note: optText(1000),
});
export type RecordClaimPaymentInput = z.infer<typeof RecordClaimPaymentSchema>;

export const VoidClaimPaymentSchema = z.object({
  version: versionField,
  reason: z.string().trim().min(5).max(1000),
});

// ---------------------------------------------------------------------------------------------
// Violations — three tracks: correction, citation/court, DataQs
// ---------------------------------------------------------------------------------------------

/**
 * Who received the paper. `both` (owner, 2026-10-24): the officer issued it to the driver AND the
 * carrier. Stored as that one word in the same text column, so the older single values
 * (`driver`, `carrier`) read exactly as they did.
 */
export const VIOLATION_ISSUED_TO = ['driver', 'carrier', 'both'] as const;
export type ViolationIssuedTo = (typeof VIOLATION_ISSUED_TO)[number];
export type ViolationIssuedParty = 'driver' | 'carrier';

export const VIOLATION_ISSUED_TO_LABEL: Record<ViolationIssuedTo, string> = {
  driver: 'Driver',
  carrier: 'Carrier',
  both: 'Driver and Carrier',
};

/** The parties a stored value names: `both` is the driver and the carrier. */
export function issuedToParties(value: ViolationIssuedTo | null | undefined): ViolationIssuedParty[] {
  if (value === 'both') return ['driver', 'carrier'];
  return value === 'driver' || value === 'carrier' ? [value] : [];
}

/** The stored value for a set of ticked parties; null when none is ticked. */
export function issuedToFromParties(parties: readonly ViolationIssuedParty[]): ViolationIssuedTo | null {
  const driver = parties.includes('driver');
  const carrier = parties.includes('carrier');
  return driver && carrier ? 'both' : driver ? 'driver' : carrier ? 'carrier' : null;
}

/** True when the paper was issued to this party (alone or together with the other). */
export function issuedToIncludes(value: ViolationIssuedTo | null | undefined, party: ViolationIssuedParty): boolean {
  return issuedToParties(value).includes(party);
}

/**
 * Reads a stored or imported value. Accepts the three words and a list ("driver,carrier",
 * "Driver and Carrier"), so nothing written before or by an import reads as blank.
 */
export function parseViolationIssuedTo(raw: string | null | undefined): ViolationIssuedTo | null {
  if (!raw) return null;
  const text = raw.trim().toLowerCase();
  if ((VIOLATION_ISSUED_TO as readonly string[]).includes(text)) return text as ViolationIssuedTo;
  const parties: ViolationIssuedParty[] = [];
  if (/\bdriver\b/.test(text)) parties.push('driver');
  if (/\bcarrier\b/.test(text)) parties.push('carrier');
  return issuedToFromParties(parties);
}

/** "Driver", "Carrier", "Driver and Carrier", or "—" when not recorded. */
export function issuedToLabel(value: ViolationIssuedTo | null | undefined): string {
  return value ? VIOLATION_ISSUED_TO_LABEL[value] : '—';
}

/** What the paper was (owner, 2026-10-12). */
export const VIOLATION_TYPES = ['inspection', 'citation', 'warning'] as const;
export type ViolationType = (typeof VIOLATION_TYPES)[number];
export const VIOLATION_TYPE_LABEL: Record<ViolationType, string> = { inspection: 'Inspection', citation: 'Citation', warning: 'Warning' };

export const VIOLATION_RECORD_SOURCES = ['roadside', 'manual'] as const;
export type ViolationRecordSource = (typeof VIOLATION_RECORD_SOURCES)[number];

export const CORRECTION_STATUSES = ['not_required', 'open', 'repaired', 'proof_submitted', 'certified'] as const;
export type CorrectionStatus = (typeof CORRECTION_STATUSES)[number];
export const CORRECTION_STATUS_LABEL: Record<CorrectionStatus, string> = {
  not_required: 'No correction needed',
  open: 'Repair / proof needed',
  repaired: 'Repaired',
  proof_submitted: 'Proof submitted',
  certified: 'Certified — corrected',
};

export const CITATION_DISPOSITIONS = ['none', 'pending', 'paid', 'contested', 'dismissed', 'reduced', 'convicted'] as const;
export type CitationDisposition = (typeof CITATION_DISPOSITIONS)[number];
export const CITATION_DISPOSITION_LABEL: Record<CitationDisposition, string> = {
  none: 'No citation',
  pending: 'Pending',
  paid: 'Paid',
  contested: 'Contested in court',
  dismissed: 'Dismissed',
  reduced: 'Reduced',
  convicted: 'Convicted',
};

export const DATAQS_STATUSES = ['not_filed', 'filed', 'under_review', 'accepted', 'denied'] as const;
export type DataqsStatus = (typeof DATAQS_STATUSES)[number];
export const DATAQS_STATUS_LABEL: Record<DataqsStatus, string> = {
  not_filed: 'Not filed',
  filed: 'Filed',
  under_review: 'Under review',
  accepted: 'Accepted',
  denied: 'Denied',
};

/** The driver's training after a violation (owner, 2026-10-13). */
export const VIOLATION_TRAINING_STATUSES = ['not_required', 'pending', 'in_progress', 'completed'] as const;
export type ViolationTrainingStatus = (typeof VIOLATION_TRAINING_STATUSES)[number];
export const VIOLATION_TRAINING_LABEL: Record<ViolationTrainingStatus, string> = {
  not_required: 'Not required',
  pending: 'Pending',
  in_progress: 'In progress',
  completed: 'Completed',
};

/**
 * What Safety decides about money. Charged and Bonus received also follow from Accounting's
 * approval; Safety may set them itself, and dismiss a bonus (owner, 2026-10-19).
 */
export const VIOLATION_FOLLOWUP_CHOICES = ['bonus_received', 'bonus_pending', 'charge_pending', 'charged', 'not_charged', 'bonus_dismissed'] as const;
export type ViolationFollowupChoice = (typeof VIOLATION_FOLLOWUP_CHOICES)[number];

/** The status the row shows (owner, 2026-10-13). */
export const VIOLATION_STATUSES = ['undecided', 'not_charged', 'charge_pending', 'charged', 'bonus_pending', 'bonus_received', 'bonus_dismissed', 'ready_to_close', 'closed'] as const;
export type ViolationStatus = (typeof VIOLATION_STATUSES)[number];
export const VIOLATION_STATUS_LABEL: Record<ViolationStatus, string> = {
  undecided: 'Needs decision',
  not_charged: 'Charge dismissed',
  // Sent to Accounting, not yet approved there (owner/Safety, 2026-10-27: "Charge pending" read like Accounting's own).
  charge_pending: 'Charge · waiting Accounting',
  charged: 'Charged',
  bonus_pending: 'Bonus · waiting Accounting',
  bonus_received: 'Bonus received',
  bonus_dismissed: 'Bonus dismissed',
  ready_to_close: 'Ready to close',
  closed: 'Closed',
};

export interface ViolationNote {
  id: string;
  body: string;
  by: string;
  at: string;
}

export interface SafetyViolation extends SafetyCaseBase {
  occurredAt: string;
  source: ViolationRecordSource;
  inspectionId: string | null;
  inspectionNumber: string | null;
  reportNumber: string | null;
  code: string | null;
  description: string;
  category: ViolationCategory | null;
  /** Who received the violation; null on a warning nobody said (optional for warnings since 2026-10-19). */
  issuedTo: ViolationIssuedTo | null;
  /** Which agency issued it; empty when nobody recorded one (optional since 2026-10-12). */
  agency: string;
  violationType: ViolationType | null;
  /** The paper carries no fine: N/A, not an unknown amount. */
  fineNotApplicable: boolean;
  driverId: string | null;
  driverName: string | null;
  truckId: string | null;
  truckNumber: string | null;
  oos: boolean;
  correctionStatus: CorrectionStatus;
  correctionDueOn: string | null;
  correctionNote: string | null;
  fineCents: number | null;
  courtDate: string | null;
  citationDisposition: CitationDisposition;
  dataqsStatus: DataqsStatus;
  dataqsFiledOn: string | null;
  dataqsReference: string | null;
  dataqsNote: string | null;
  reviewId: string | null;
  reviewNumber: string | null;
  closedAt: string | null;
  closedBy: string | null;
  /** Tracks still open, by name. Empty means it can be closed. */
  openTracks: string[];
  // Follow-up (owner, 2026-10-13).
  citationNumber: string | null;
  state: string | null;
  inspectionLevel: number | null;
  dispute: boolean;
  lawyerName: string | null;
  lawyerPhone: string | null;
  lawyerFeeCents: number | null;
  lawyerPaid: boolean;
  trainingStatus: ViolationTrainingStatus;
  trainingCompletedOn: string | null;
  trainerName: string | null;
  trainingProofFileId: string | null;
  followupStatus: 'undecided' | ViolationFollowupChoice;
  /** What the row shows: the decision, moved on by Accounting's answer. */
  status: ViolationStatus;
  moneyKind: 'charge' | 'bonus' | null;
  moneyCents: number | null;
  moneyParty: 'driver' | null;
  moneyReason: string | null;
  /** The driver-account transaction Accounting reviews, and where it stands there. */
  moneyTxId: string | null;
  moneyTxState: string | null;
  moneySentAt: string | null;
  notes: ViolationNote[];
  /** One paper, one case (owner, 2026-10-21): rows entered together share it; null = a case of its own. */
  caseId: string | null;
}

/**
 * One case: one paper (inspection, citation or warning) and every violation on it (owner,
 * 2026-10-21). The follow-up - status, charge or bonus, training, notes - is the case's and lives
 * on its lead violation (the first one recorded); code, description, category, OOS and the
 * correction stay on each violation.
 */
export interface SafetyViolationCase {
  /** The case key: the shared case id, or the lead violation's id when it stands alone. */
  id: string;
  caseId: string | null;
  leadId: string;
  /** The lead violation's number. */
  number: string;
  occurredAt: string;
  violationType: ViolationType | null;
  reportNumber: string | null;
  state: string | null;
  inspectionLevel: number | null;
  /** Kept for old rows; new papers record the state instead. */
  agency: string;
  issuedTo: ViolationIssuedTo | null;
  driverId: string | null;
  driverName: string | null;
  truckId: string | null;
  truckNumber: string | null;
  isTest: boolean;
  reviewId: string | null;
  reviewNumber: string | null;
  oos: boolean;
  status: ViolationStatus;
  trainingStatus: ViolationTrainingStatus;
  moneyKind: 'charge' | 'bonus' | null;
  moneyCents: number | null;
  closed: boolean;
  /** "3 violations: 392.9A2-C (OOS), 393.47E, 393.53B-B". */
  summary: string;
  /** Lead first, then in the order recorded. */
  violations: SafetyViolation[];
}

const violationFields = {
  occurredAt: isoInstant,
  reportNumber: optText(80),
  code: optText(80),
  description: z.string().trim().min(2, 'What was the violation?').max(1000),
  category: z.enum(VIOLATION_CATEGORIES).nullable().optional(),
  // Required on an inspection or a citation; a warning may leave it blank (owner, 2026-10-19).
  issuedTo: z.enum(VIOLATION_ISSUED_TO).nullable().optional(),
  agency: z.string().trim().max(200).default(''),
  violationType: z.enum(VIOLATION_TYPES).nullable().optional(),
  fineNotApplicable: z.boolean().optional(),
  driverId: z.string().min(1).nullable().optional(),
  truckId: z.string().min(1).nullable().optional(),
  oos: z.boolean().default(false),
  correctionStatus: z.enum(CORRECTION_STATUSES).optional(),
  correctionDueOn: isoDate.nullable().optional(),
  fineCents: cents.nullable().optional(),
  courtDate: isoDate.nullable().optional(),
  citationDisposition: z.enum(CITATION_DISPOSITIONS).optional(),
};

export const CreateViolationSchema = z
  .object({
    ...violationFields,
    inspectionId: z.string().min(1).nullable().optional(),
    isTest: z.boolean().optional(),
    // The state on the paper (owner, 2026-10-21); old rows may hold free text, new ones a code.
    state: z.enum(US_STATE_CODES).nullable().optional(),
    inspectionLevel: z.number().int().min(1).max(6).nullable().optional(),
    ...caseWorkFields,
  })
  .refine((v) => v.violationType === 'warning' || Boolean(v.issuedTo), { path: ['issuedTo'], message: 'Who received it?' });
export type CreateViolationInput = z.infer<typeof CreateViolationSchema>;

/** One violation on the paper: the rule first, then what it was, the category, OOS. */
export const ViolationCaseLineSchema = z.object({
  code: optText(80),
  description: z.string().trim().min(2, 'What was the violation?').max(1000),
  category: z.enum(VIOLATION_CATEGORIES).nullable().optional(),
  oos: z.boolean().default(false),
});
export type ViolationCaseLineInput = z.infer<typeof ViolationCaseLineSchema>;

/**
 * One paper with every violation on it (owner, 2026-10-21): one case, one driver review. The
 * paper's facts are shared; each line is its own violation record.
 */
export const CreateViolationCaseSchema = z
  .object({
    occurredAt: isoInstant,
    reportNumber: optText(80),
    issuedTo: z.enum(VIOLATION_ISSUED_TO).nullable().optional(),
    violationType: z.enum(VIOLATION_TYPES).nullable().optional(),
    state: z.enum(US_STATE_CODES).nullable().optional(),
    inspectionLevel: z.number().int().min(1).max(6).nullable().optional(),
    fineNotApplicable: z.boolean().optional(),
    fineCents: cents.nullable().optional(),
    driverId: z.string().min(1).nullable().optional(),
    truckId: z.string().min(1).nullable().optional(),
    inspectionId: z.string().min(1).nullable().optional(),
    isTest: z.boolean().optional(),
    lines: z.array(ViolationCaseLineSchema).min(1, 'Add at least one violation').max(30),
  })
  .refine((v) => v.violationType === 'warning' || Boolean(v.issuedTo), { path: ['issuedTo'], message: 'Who received it?' });
export type CreateViolationCaseInput = z.infer<typeof CreateViolationCaseSchema>;

const deleteReason = z.string().trim().min(3, 'Say why it is being deleted (at least 3 characters)').max(1000);

/** "Delete" a violation (owner, 2026-10-21): voided - hidden, kept on record, audited. */
export const VoidViolationSchema = z.object({ version: versionField, reason: deleteReason });
export type VoidViolationInput = z.infer<typeof VoidViolationSchema>;

/** "Delete" a whole case: every live violation in it, each named with the version the page saw. */
export const VoidViolationCaseSchema = z.object({
  versions: z.record(z.string().min(1), versionField),
  reason: deleteReason,
});
export type VoidViolationCaseInput = z.infer<typeof VoidViolationCaseSchema>;

export const UpdateViolationSchema = z.object({
  version: versionField,
  occurredAt: isoInstant.optional(),
  reportNumber: optText(80),
  code: optText(80),
  description: z.string().trim().min(2).max(1000).optional(),
  category: z.enum(VIOLATION_CATEGORIES).nullable().optional(),
  issuedTo: z.enum(VIOLATION_ISSUED_TO).nullable().optional(),
  agency: z.string().trim().max(200).optional(),
  violationType: z.enum(VIOLATION_TYPES).nullable().optional(),
  fineNotApplicable: z.boolean().optional(),
  driverId: z.string().min(1).nullable().optional(),
  truckId: z.string().min(1).nullable().optional(),
  oos: z.boolean().optional(),
  correctionStatus: z.enum(CORRECTION_STATUSES).optional(),
  correctionDueOn: isoDate.nullable().optional(),
  correctionNote: optText(2000),
  fineCents: cents.nullable().optional(),
  courtDate: isoDate.nullable().optional(),
  citationDisposition: z.enum(CITATION_DISPOSITIONS).optional(),
  dataqsStatus: z.enum(DATAQS_STATUSES).optional(),
  dataqsFiledOn: isoDate.nullable().optional(),
  dataqsReference: optText(120),
  dataqsNote: optText(2000),
  citationNumber: optText(80),
  state: optText(40),
  inspectionLevel: z.number().int().min(1).max(6).nullable().optional(),
  dispute: z.boolean().optional(),
  lawyerName: optText(160),
  lawyerPhone: optText(40),
  lawyerFeeCents: cents.nullable().optional(),
  lawyerPaid: z.boolean().optional(),
  ...caseWorkFields,
});
export type UpdateViolationInput = z.infer<typeof UpdateViolationSchema>;

export const ViolationTrainingSchema = z.object({
  version: versionField,
  status: z.enum(VIOLATION_TRAINING_STATUSES),
  completedOn: isoDate.nullable().optional(),
  trainerName: optText(160),
  proofFileId: z.string().min(1).nullable().optional(),
});
export type ViolationTrainingInput = z.infer<typeof ViolationTrainingSchema>;

export const ViolationStatusSchema = z.object({ version: versionField, status: z.enum(VIOLATION_FOLLOWUP_CHOICES) });
export type ViolationStatusInput = z.infer<typeof ViolationStatusSchema>;

export const ViolationMoneySchema = z.object({
  version: versionField,
  kind: z.enum(['charge', 'bonus']),
  amountCents: z.number().int().min(1, 'Enter an amount above $0'),
  party: z.enum(['driver']).default('driver'),
  reason: z.string().trim().min(2, 'Say why').max(500),
});
export type ViolationMoneyInput = z.infer<typeof ViolationMoneySchema>;

export const ViolationNoteSchema = z.object({ version: versionField, body: z.string().trim().min(1, 'Write the note').max(2000) });
export type ViolationNoteInput = z.infer<typeof ViolationNoteSchema>;

// ---------------------------------------------------------------------------------------------
// Roadside inspections
// ---------------------------------------------------------------------------------------------

export const ROADSIDE_STAGES = ['received', 'reviewed', 'defects_corrected', 'certified', 'returned'] as const;
export type RoadsideStage = (typeof ROADSIDE_STAGES)[number];
export const ROADSIDE_STAGE_LABEL: Record<RoadsideStage, string> = {
  received: 'Received',
  reviewed: 'Reviewed',
  defects_corrected: 'Defects corrected',
  certified: 'Certified',
  returned: 'Returned if requested',
};

export const INSPECTION_LEVELS = [1, 2, 3, 4, 5, 6] as const;

export interface SafetyRoadsideInspection extends SafetyCaseBase {
  inspectedAt: string;
  level: number;
  reportNumber: string | null;
  agency: string;
  location: string | null;
  state: string | null;
  driverId: string | null;
  driverName: string | null;
  truckId: string | null;
  truckNumber: string | null;
  trailerId: string | null;
  trailerNumber: string | null;
  oos: boolean;
  oosNote: string | null;
  correctionDueOn: string | null;
  returnRequired: boolean;
  stage: RoadsideStage;
  /** When each stage was reached; null for stages not reached. */
  stageDates: Record<RoadsideStage, string | null>;
  workOrderId: string | null;
  workOrderNumber: string | null;
  violationCount: number;
  violations: { id: string; number: string; description: string; oos: boolean; correctionStatus: CorrectionStatus }[];
  /** clean: no violations; open: work remains; closed: the last required stage is reached. */
  status: 'clean' | 'open' | 'closed';
}

export const CreateRoadsideInspectionSchema = z.object({
  inspectedAt: isoInstant,
  level: z.number().int().min(1).max(6),
  reportNumber: optText(80),
  agency: z.string().trim().min(2, 'Which agency inspected?').max(200),
  location: optText(300),
  state: optText(40),
  driverId: z.string().min(1).nullable().optional(),
  truckId: z.string().min(1).nullable().optional(),
  trailerId: z.string().min(1).nullable().optional(),
  oos: z.boolean().default(false),
  oosNote: optText(1000),
  correctionDueOn: isoDate.nullable().optional(),
  returnRequired: z.boolean().default(false),
  isTest: z.boolean().optional(),
  ...caseWorkFields,
});
export type CreateRoadsideInspectionInput = z.infer<typeof CreateRoadsideInspectionSchema>;

export const UpdateRoadsideInspectionSchema = z.object({
  version: versionField,
  inspectedAt: isoInstant.optional(),
  level: z.number().int().min(1).max(6).optional(),
  reportNumber: optText(80),
  agency: z.string().trim().min(2).max(200).optional(),
  location: optText(300),
  state: optText(40),
  driverId: z.string().min(1).nullable().optional(),
  truckId: z.string().min(1).nullable().optional(),
  trailerId: z.string().min(1).nullable().optional(),
  oos: z.boolean().optional(),
  oosNote: optText(1000),
  correctionDueOn: isoDate.nullable().optional(),
  returnRequired: z.boolean().optional(),
  ...caseWorkFields,
});
export type UpdateRoadsideInspectionInput = z.infer<typeof UpdateRoadsideInspectionSchema>;

export const RoadsideStageSchema = z.object({ version: versionField, stage: z.enum(ROADSIDE_STAGES) });
export type RoadsideStageInput = z.infer<typeof RoadsideStageSchema>;

export const RoadsideViolationSchema = z.object({
  version: versionField,
  code: optText(80),
  description: z.string().trim().min(2, 'What was the violation?').max(1000),
  category: z.enum(VIOLATION_CATEGORIES).nullable().optional(),
  issuedTo: z.enum(VIOLATION_ISSUED_TO),
  oos: z.boolean().default(false),
  fineCents: cents.nullable().optional(),
  correctionDueOn: isoDate.nullable().optional(),
});
export type RoadsideViolationInput = z.infer<typeof RoadsideViolationSchema>;

// ---------------------------------------------------------------------------------------------
// Safety reviews: driver reviews, coaching, corrective actions
// ---------------------------------------------------------------------------------------------

// vacation_return (owner, 2026-10-17): the company's check before a driver back from 30+ days away drives again.
export const SAFETY_REVIEW_KINDS = ['driver_review', 'coaching', 'corrective_action', 'vacation_return'] as const;
export type SafetyReviewKind = (typeof SAFETY_REVIEW_KINDS)[number];
export const SAFETY_REVIEW_KIND_LABEL: Record<SafetyReviewKind, string> = {
  driver_review: 'Driver review',
  coaching: 'Coaching',
  corrective_action: 'Corrective action',
  vacation_return: 'Vacation return review',
};

export const SAFETY_REVIEW_STATUSES = ['not_started', 'scheduled', 'in_progress', 'completed'] as const;
export type SafetyReviewStatus = (typeof SAFETY_REVIEW_STATUSES)[number];

export const SAFETY_LINKED_TYPES = ['accident', 'claim', 'violation', 'roadside_inspection', 'drug_test', 'vacation'] as const;
export type SafetyLinkedType = (typeof SAFETY_LINKED_TYPES)[number];

export interface SafetyReview extends SafetyCaseBase {
  kind: SafetyReviewKind;
  reason: string;
  driverId: string | null;
  driverName: string | null;
  linkedType: SafetyLinkedType | null;
  linkedId: string | null;
  linkedNumber: string | null;
  status: SafetyReviewStatus;
  scheduledFor: string | null;
  /** True for an accident review: preventability must be decided before completing. */
  preventabilityRequired: boolean;
  preventability: PreventabilityDecision;
  requiredTraining: string | null;
  trainingCompletedOn: string | null;
  notes: string | null;
  outcome: string | null;
  followUpOn: string | null;
  evidenceNote: string | null;
  completedAt: string | null;
  completedBy: string | null;
  /** What must be done before Complete review is allowed. */
  completeBlockers: string[];
}

export const CreateSafetyReviewSchema = z.object({
  kind: z.enum(SAFETY_REVIEW_KINDS),
  reason: z.string().trim().min(2, 'Why is this review needed?').max(300),
  driverId: z.string().min(1).nullable().optional(),
  linkedType: z.enum(SAFETY_LINKED_TYPES).nullable().optional(),
  linkedId: z.string().min(1).nullable().optional(),
  scheduledFor: isoDate.nullable().optional(),
  requiredTraining: optText(300),
  notes: optText(4000),
  isTest: z.boolean().optional(),
  ...caseWorkFields,
});
export type CreateSafetyReviewInput = z.infer<typeof CreateSafetyReviewSchema>;

export const UpdateSafetyReviewSchema = z.object({
  version: versionField,
  reason: z.string().trim().min(2).max(300).optional(),
  status: z.enum(['not_started', 'scheduled', 'in_progress'] as const).optional(),
  scheduledFor: isoDate.nullable().optional(),
  preventability: z.enum(PREVENTABILITY_DECISIONS).optional(),
  requiredTraining: optText(300),
  trainingCompletedOn: isoDate.nullable().optional(),
  notes: optText(4000),
  outcome: optText(4000),
  followUpOn: isoDate.nullable().optional(),
  evidenceNote: optText(1000),
  ...caseWorkFields,
});
export type UpdateSafetyReviewInput = z.infer<typeof UpdateSafetyReviewSchema>;

export const CompleteSafetyReviewSchema = z.object({
  version: versionField,
  outcome: z.string().trim().min(3, 'Say what was decided').max(4000).optional(),
});
export type CompleteSafetyReviewInput = z.infer<typeof CompleteSafetyReviewSchema>;

// ---------------------------------------------------------------------------------------------
// Details: a case with its documents and timeline
// ---------------------------------------------------------------------------------------------

export interface SafetyCaseDetail<T> {
  record: T;
  documents: SafetyDocument[];
  timeline: SafetyTimelineEntry[];
}

export interface SafetyPerson {
  id: string;
  name: string;
}

/** What Safety forms pick from (GET /safety/pickers). */
export interface SafetyPickers {
  drivers: { id: string; name: string; truckId: string | null }[];
  trucks: { id: string; number: string; driverId: string | null }[];
  trailers: { id: string; number: string }[];
  loads: { id: string; number: string; driverId: string | null; truckId: string | null }[];
  workOrders: { id: string; number: string; unitId: string; unitNumber: string; status: string }[];
}

// ---------------------------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------------------------

export type AttentionPriority = 'high' | 'medium' | 'low';

export interface SafetyAttentionItem {
  key: string;
  priority: AttentionPriority;
  task: string;
  caseType: SafetyCaseType;
  caseId: string;
  caseNumber: string;
  driverName: string | null;
  truckNumber: string | null;
  ownerName: string | null;
  dueOn: string | null;
  overdue: boolean;
}

export interface SafetyOpenCase {
  caseType: 'accident' | 'claim';
  caseId: string;
  caseNumber: string;
  stageLabel: string;
  nextAction: string | null;
  ownerName: string | null;
  dueOn: string | null;
}

export interface SafetyOverview {
  today: string;
  tiles: {
    urgentTasks: number;
    openAccidents: number;
    activeClaims: number;
    unresolvedViolations: number;
    complianceDue30: number;
  };
  needsAttention: SafetyAttentionItem[];
  openCases: SafetyOpenCase[];
}

// ---------------------------------------------------------------------------------------------
// Compliance views
// ---------------------------------------------------------------------------------------------

export const DRIVER_COMPLIANCE_COLUMNS = ['cdl', 'medical_card', 'mvr_review', 'clearinghouse_query', 'testing_program'] as const;
export type DriverComplianceColumn = (typeof DRIVER_COMPLIANCE_COLUMNS)[number];

export interface ComplianceCell {
  /** A compliance engine status (verified, valid, expiring, expired, missing, …). */
  status: string;
  date: string | null;
}

export interface DriverComplianceRow {
  driverId: string;
  driverName: string;
  group: 'roster' | 'in_hiring';
  cells: Record<DriverComplianceColumn, ComplianceCell>;
}

export interface DriverComplianceView {
  today: string;
  totals: { expired: number; dueSoon: number; missing: number };
  rows: DriverComplianceRow[];
}

export interface CompanyChecklistRow {
  code: string;
  name: string;
  authority: string;
  status: string;
  expiresOn: string | null;
  documentId: string | null;
}

export interface TestingSummaryRow {
  testType: DrugAlcoholTestType;
  openTasks: number;
  /** Records whose result is restricted to `safety_testing.view`. */
  restrictedRecords: number;
}

export interface TestingSummary {
  rows: TestingSummaryRow[];
  /** Pre-employment tests come from the recruiting qualification item, counted here. */
  preEmploymentFromQualificationFile: { onFile: number; missing: number };
}

/** The weekly walk-around, read for Safety (GET /safety/inspections/pretrip). */
export interface PreTripSummary {
  weekStart: string;
  counts: { missing: number; awaitingReview: number; issueFound: number; monitoring: number };
  recent: {
    inspectionId: string;
    unitId: string;
    unitNumber: string;
    driverName: string | null;
    receivedAt: string;
    /** good · issue_found · monitoring · awaiting_review */
    result: 'good' | 'issue_found' | 'monitoring' | 'awaiting_review';
    notes: string | null;
  }[];
}

export interface UnitComplianceRow {
  unitId: string;
  unitNumber: string;
  scope: 'truck' | 'trailer';
  cells: { code: string; name: string; status: string; date: string | null }[];
}
