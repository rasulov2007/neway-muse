import { z } from 'zod';
import { ComplianceScopeSchema } from './requirement.js';
import { CdlExtractSchema } from './cdl-extract.js';

/**
 * The compliance records the qualification file is made of, beyond the items themselves.
 *
 * These shapes were born in the browser demo layer and moved here when compliance storage moved to
 * PostgreSQL. They are the contract between the API and the Safety screens — and, from the hiring
 * funnel's point of view, the middle of the pipeline: a candidate's Checks and Safety review *are*
 * their consents, documents and verification case. Nothing in hiring stores a copy of any of it.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const isoDateTime = z.string().datetime();

// ---------------------------------------------------------------------------------- documents

export const COMPLIANCE_OWNER_TYPES = ['driver', 'truck', 'trailer', 'company'] as const;
export const ComplianceOwnerTypeSchema = z.enum(COMPLIANCE_OWNER_TYPES);
export type ComplianceOwnerType = z.infer<typeof ComplianceOwnerTypeSchema>;

export const COMPLIANCE_DOCUMENT_STATUSES = [
  'pending_review',
  'verified',
  'rejected',
  'expired',
] as const;
export const ComplianceDocumentStatusSchema = z.enum(COMPLIANCE_DOCUMENT_STATUSES);
export type ComplianceDocumentStatus = z.infer<typeof ComplianceDocumentStatusSchema>;

/** How a document reached the system. */
export const DOCUMENT_SOURCES = [
  'staff',
  'driver_portal',
  'public_link',
  'integration',
  'email',
] as const;
export const DocumentSourceSchema = z.enum(DOCUMENT_SOURCES);
export type DocumentSource = z.infer<typeof DocumentSourceSchema>;

/**
 * A compliance document: typed, owned, versioned and verifiable. Never a generic upload — the
 * `requirementCode` says which rule it satisfies and `version` / `supersedesDocumentId` keep the
 * history when a renewal replaces it.
 */
export const ComplianceDocumentSchema = z.object({
  id: z.string(),
  ownerType: ComplianceOwnerTypeSchema,
  ownerId: z.string(),
  ownerLabel: z.string(),
  requirementCode: z.string(),
  title: z.string(),
  fileName: z.string(),
  contentType: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  issuedOn: isoDate.nullable(),
  expiresOn: isoDate.nullable(),
  status: ComplianceDocumentStatusSchema,
  source: DocumentSourceSchema,
  uploadedAt: isoDateTime,
  uploadedBy: z.string(),
  verifiedAt: isoDateTime.nullable(),
  verifiedBy: z.string().nullable(),
  rejectionReason: z.string().nullable(),
  version: z.number().int().positive(),
  supersedesDocumentId: z.string().nullable(),
  /** True for identity, medical and licence documents; access is logged and masked by role. */
  containsPii: z.boolean(),
  /**
   * Whether the bytes are held. False for every document recorded before storage existed and for
   * uploads that only registered a file; true for documents the system rendered itself.
   */
  hasFile: z.boolean(),
  /**
   * What was read off this document, structured and corrected by a person before it was saved.
   *
   * Null for everything that carries no template — a lumper receipt has nothing to extract — and
   * for documents filed before the reader existed.
   */
  extracted: CdlExtractSchema.nullable().default(null),
});
export type ComplianceDocument = z.infer<typeof ComplianceDocumentSchema>;

/**
 * What the system will keep the bytes of.
 *
 * A licence photographed on a phone, a scanned medical card, a PDF from an examiner — and nothing
 * else. Anything outside this list is refused before it reaches disk rather than stored and
 * discovered later, because a file store that accepts whatever arrives is the one that ends up
 * serving somebody's uploaded HTML back to a browser.
 */
export const STORABLE_CONTENT_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;
export type StorableContentType = (typeof STORABLE_CONTENT_TYPES)[number];

/** 20 MB, matched to what the dialog refuses client-side. Base64 costs a third on top. */
export const MAX_DOCUMENT_BYTES = 20 * 1024 * 1024;
const MAX_BASE64_LENGTH = Math.ceil((MAX_DOCUMENT_BYTES / 3) * 4) + 1024;

export const UploadComplianceDocumentSchema = z
  .object({
    ownerType: ComplianceOwnerTypeSchema,
    ownerId: z.string().min(1),
    ownerLabel: z.string().min(1),
    requirementCode: z.string().min(1),
    title: z.string().trim().min(1).max(200),
    fileName: z.string().min(1).max(255),
    contentType: z.string().min(1).max(120),
    sizeBytes: z.number().int().nonnegative(),
    issuedOn: isoDate.nullable(),
    expiresOn: isoDate.nullable(),
    source: DocumentSourceSchema.default('staff'),
    notes: z.string().max(1000).nullish(),
    /**
     * The file itself, base64, without a data: prefix.
     *
     * Optional because the record of a document held somewhere else is still worth keeping — a
     * licence the safety office has in a drawer is a fact about the driver either way. When it is
     * given, the bytes are stored and the document can be opened again from here.
     */
    content: z.string().min(1).max(MAX_BASE64_LENGTH).optional(),
    /** The structured reading of the card, as the person confirmed it. */
    extracted: CdlExtractSchema.optional(),
  })
  .superRefine((value, ctx) => {
    if (!value.content) return;
    if (!(STORABLE_CONTENT_TYPES as readonly string[]).includes(value.contentType)) {
      ctx.addIssue({
        code: 'custom',
        path: ['contentType'],
        message: `Only ${STORABLE_CONTENT_TYPES.join(', ')} can be stored`,
      });
    }
  });
export type UploadComplianceDocumentInput = z.input<typeof UploadComplianceDocumentSchema>;

export const RejectComplianceDocumentSchema = z.object({
  reason: z.string().trim().min(1, 'A rejection needs a reason').max(500),
});

export const WaiveQualificationItemSchema = z.object({
  until: isoDate,
  reason: z.string().trim().min(1, 'A waiver needs a reason').max(500),
});

// ----------------------------------------------------------------------------------- consents

export const CONSENT_PURPOSES = [
  'mvr',
  'psp',
  'background_check',
  'employment_verification',
  'clearinghouse',
  'drug_alcohol_testing',
  'safety_investigation',
] as const;
export const ConsentPurposeSchema = z.enum(CONSENT_PURPOSES);
export type ConsentPurpose = z.infer<typeof ConsentPurposeSchema>;

export const CONSENT_STATUSES = [
  'draft',
  'sent',
  'viewed',
  'signed',
  'declined',
  'expired',
  'cancelled',
] as const;
export const ConsentStatusSchema = z.enum(CONSENT_STATUSES);
export type ConsentStatus = z.infer<typeof ConsentStatusSchema>;

export const ConsentEventSchema = z.object({
  at: isoDateTime,
  status: ConsentStatusSchema,
  actor: z.string(),
  note: z.string().nullable(),
});
export type ConsentEvent = z.infer<typeof ConsentEventSchema>;

export const SIGNER_CHANNELS = ['driver_portal', 'public_link', 'in_person'] as const;

/**
 * One authorization request to one driver for one purpose. A consent is never generic: the purpose
 * is the legal basis for the check it unlocks, so an MVR consent does not cover a background check.
 */
export const ConsentRequestSchema = z.object({
  id: z.string(),
  driverId: z.string(),
  driverName: z.string(),
  purpose: ConsentPurposeSchema,
  /** The requirement this consent unlocks, so the qualification item can reference it. */
  requirementCode: z.string(),
  /**
   * Who the consent is addressed to when a purpose has several: one previous-employer
   * verification per employer the applicant listed. Null for the single-party purposes.
   */
  subject: z.string().nullable(),
  status: ConsentStatusSchema,
  requestedAt: isoDateTime,
  requestedBy: z.string(),
  sentAt: isoDateTime.nullable(),
  viewedAt: isoDateTime.nullable(),
  signedAt: isoDateTime.nullable(),
  declinedAt: isoDateTime.nullable(),
  /** Sent links lapse; an expired request must be re-sent, not revived. */
  expiresAt: isoDateTime,
  signerName: z.string().nullable(),
  signerChannel: z.enum(SIGNER_CHANNELS).nullable(),
  signedDocumentId: z.string().nullable(),
  /** Every transition, oldest first. */
  history: z.array(ConsentEventSchema),
});
export type ConsentRequest = z.infer<typeof ConsentRequestSchema>;

export const CreateConsentRequestSchema = z.object({
  driverId: z.string().min(1),
  purpose: ConsentPurposeSchema,
  subject: z.string().trim().min(1).max(200).nullish(),
});

export const ConsentResponseSchema = z.object({
  outcome: z.enum(['viewed', 'signed', 'declined']),
  signerName: z.string().trim().min(1).max(120).optional(),
});

/** Consent links lapse after this long unsigned. */
export const CONSENT_TTL_DAYS = 14;

/** Which consent purpose unlocks which catalog requirement, and back. */
export const REQUIREMENT_BY_CONSENT_PURPOSE: Readonly<Record<ConsentPurpose, string>> = {
  mvr: 'mvr_review',
  psp: 'psp_review',
  background_check: 'background_check',
  employment_verification: 'employment_verification',
  clearinghouse: 'clearinghouse_query',
  drug_alcohol_testing: 'pre_employment_drug_test',
  safety_investigation: 'safety_investigation',
};

export const CONSENT_PURPOSE_BY_REQUIREMENT: Readonly<Record<string, ConsentPurpose>> =
  Object.fromEntries(
    Object.entries(REQUIREMENT_BY_CONSENT_PURPOSE).map(([purpose, code]) => [code, purpose]),
  ) as Record<string, ConsentPurpose>;

export const CONSENT_PURPOSE_LABELS: Readonly<Record<ConsentPurpose, string>> = {
  mvr: 'MVR',
  psp: 'PSP',
  background_check: 'Background check',
  employment_verification: 'Previous employer verification',
  clearinghouse: 'Clearinghouse',
  drug_alcohol_testing: 'Drug & alcohol testing',
  safety_investigation: 'Safety investigation',
};

/** Documents whose contents identify a person; access is masked and logged by role. */
/**
 * Requirements collected after the hiring decision — at orientation, not during checks. The
 * verification ladder's "all verified" gate leaves them out, or no candidate could ever reach
 * safety review; the qualification file still lists them, and they hold dispatch until met.
 */
export const POST_OFFER_REQUIREMENTS: ReadonlySet<string> = new Set(['road_test']);

export const PII_REQUIREMENTS: ReadonlySet<string> = new Set([
  'cdl',
  'medical_card',
  'work_authorization',
  'background_check',
  'dot_application',
  // The W-9 carries the driver's taxpayer ID (SSN or EIN).
  'w9',
]);

/**
 * Qualification records whose details are restricted to `compliance_sensitive.view` (owner,
 * 2026-10-02): the MVR, the PSP report, the Clearinghouse query, the medical certificate and the
 * pre-employment drug test. Without the code the server still says whether the requirement is
 * met and until when; it withholds the file, what was read off it and the reviewer's notes.
 */
export const SENSITIVE_REQUIREMENTS: ReadonlySet<string> = new Set([
  'mvr_review',
  'psp_review',
  'clearinghouse_query',
  'medical_card',
  'pre_employment_drug_test',
  // W-9 (owner, 2026-10-25): the file holds a taxpayer ID, so it is withheld like the MVR.
  // Accounting reads the W-9 alone through driver_tax_forms.view (owner, 2026-10-25; apps/api compliance/sensitive.ts).
  'w9',
]);

// ------------------------------------------------------------------------------- verification

export const VERIFICATION_STAGES = [
  'recruiting',
  'document_collection',
  'consent',
  'screening',
  'verification',
  'safety_review',
  'decision',
  'active',
] as const;
export const VerificationStageSchema = z.enum(VERIFICATION_STAGES);
export type VerificationStage = z.infer<typeof VerificationStageSchema>;

export const VERIFICATION_DECISIONS = ['approved', 'conditional', 'rejected'] as const;
export const VerificationDecisionSchema = z.enum(VERIFICATION_DECISIONS);
export type VerificationDecision = z.infer<typeof VerificationDecisionSchema>;

export const VERIFICATION_STEP_STATUSES = [
  'not_started',
  'in_progress',
  'blocked',
  'complete',
] as const;
export const VerificationStepStatusSchema = z.enum(VERIFICATION_STEP_STATUSES);
export type VerificationStepStatus = z.infer<typeof VerificationStepStatusSchema>;

export const VerificationStepSchema = z.object({
  key: z.string(),
  label: z.string(),
  stage: VerificationStageSchema,
  status: VerificationStepStatusSchema,
  /** The requirement or consent this step waits on, so the UI can deep-link to it. */
  requirementCode: z.string().nullable(),
  /** Why the step is blocked, in the words the recruiter needs. Null unless blocked. */
  blocker: z.string().nullable(),
  completedAt: isoDateTime.nullable(),
  completedBy: z.string().nullable(),
});
export type VerificationStep = z.infer<typeof VerificationStepSchema>;

/**
 * What is actually stored about a case.
 *
 * Deliberately small. The steps are **not** here: they are derived from the items and consents
 * every time the case is read, the same way a qualification item's status is derived from its
 * dates. Storing them would let "CDL on file: blocked" survive the CDL being verified, which is
 * exactly the drift the whole compliance design exists to make impossible.
 */
export const VerificationCaseRecordSchema = z.object({
  id: z.string(),
  driverId: z.string(),
  driverName: z.string(),
  openedAt: isoDateTime,
  ownerId: z.string(),
  ownerName: z.string(),
  /** The safety manager's review is a human step with no document behind it, so it is recorded. */
  safetyReviewStatus: z.enum(['not_started', 'in_progress', 'complete']),
  safetyReviewAt: isoDateTime.nullable(),
  safetyReviewBy: z.string().nullable(),
  decision: VerificationDecisionSchema.nullable(),
  decisionAt: isoDateTime.nullable(),
  decisionBy: z.string().nullable(),
  conditions: z.array(z.string()),
  decisionNote: z.string().nullable(),
});
export type VerificationCaseRecord = z.infer<typeof VerificationCaseRecordSchema>;

/** The case as every screen reads it: the record plus everything derived from it. */
export const VerificationCaseSchema = VerificationCaseRecordSchema.extend({
  stage: VerificationStageSchema,
  steps: z.array(VerificationStepSchema),
  /** Days spent in the current stage, for spotting where the pipeline stalls. */
  daysInStage: z.number().int().nonnegative(),
});
export type VerificationCase = z.infer<typeof VerificationCaseSchema>;

export const RecordVerificationDecisionSchema = z.object({
  decision: VerificationDecisionSchema,
  conditions: z.array(z.string().trim().min(1).max(300)).max(10).default([]),
  note: z
    .string()
    .trim()
    .max(1000)
    .nullish()
    .transform((v) => v || null),
});

export interface VerificationLadderStep {
  key: string;
  label: string;
  stage: VerificationStage;
  requirementCode: string | null;
}

/** The fixed order every driver moves through, applicant to active. */
export const VERIFICATION_LADDER: readonly VerificationLadderStep[] = [
  {
    key: 'application',
    label: 'Application received',
    stage: 'recruiting',
    requirementCode: 'dot_application',
  },
  { key: 'cdl', label: 'CDL on file', stage: 'document_collection', requirementCode: 'cdl' },
  {
    key: 'medical_card',
    label: 'Medical certificate on file',
    stage: 'document_collection',
    requirementCode: 'medical_card',
  },
  {
    key: 'work_authorization',
    label: 'Work authorization',
    stage: 'document_collection',
    requirementCode: 'work_authorization',
  },
  { key: 'consent_mvr', label: 'MVR consent', stage: 'consent', requirementCode: 'mvr_review' },
  { key: 'consent_psp', label: 'PSP consent', stage: 'consent', requirementCode: 'psp_review' },
  {
    key: 'consent_background',
    label: 'Background check consent',
    stage: 'consent',
    requirementCode: 'background_check',
  },
  {
    key: 'consent_clearinghouse',
    label: 'Clearinghouse consent',
    stage: 'consent',
    requirementCode: 'clearinghouse_query',
  },
  { key: 'mvr_review', label: 'MVR review', stage: 'screening', requirementCode: 'mvr_review' },
  { key: 'psp_review', label: 'PSP review', stage: 'screening', requirementCode: 'psp_review' },
  {
    key: 'background_check',
    label: 'Background check',
    stage: 'screening',
    requirementCode: 'background_check',
  },
  {
    key: 'clearinghouse_query',
    label: 'Clearinghouse query',
    stage: 'screening',
    requirementCode: 'clearinghouse_query',
  },
  {
    key: 'pre_employment_drug_test',
    label: 'Pre-employment drug test',
    stage: 'screening',
    requirementCode: 'pre_employment_drug_test',
  },
  {
    key: 'employment_verification',
    label: 'Previous employer verification',
    stage: 'screening',
    requirementCode: 'employment_verification',
  },
  {
    key: 'document_verification',
    label: 'Document verification',
    stage: 'verification',
    requirementCode: null,
  },
  { key: 'safety_review', label: 'Safety review', stage: 'safety_review', requirementCode: null },
  { key: 'decision', label: 'Hiring decision', stage: 'decision', requirementCode: null },
];

// -------------------------------------------------------------------------------------- audit

export const COMPLIANCE_AUDIT_ACTIONS = [
  'document_uploaded',
  'document_verified',
  'document_rejected',
  'document_deleted',
  'item_updated',
  'item_waived',
  'hold_placed',
  'hold_released',
  'consent_sent',
  'consent_signed',
  'consent_declined',
  'verification_advanced',
  'decision_recorded',
  'status_changed',
] as const;
export const ComplianceAuditActionSchema = z.enum(COMPLIANCE_AUDIT_ACTIONS);
export type ComplianceAuditAction = z.infer<typeof ComplianceAuditActionSchema>;

export const COMPLIANCE_AUDIT_ACTION_LABELS: Readonly<Record<ComplianceAuditAction, string>> = {
  document_uploaded: 'Document uploaded',
  document_verified: 'Document verified',
  document_rejected: 'Document rejected',
  document_deleted: 'Document deleted',
  item_updated: 'Requirement updated',
  item_waived: 'Requirement waived',
  hold_placed: 'Hold placed',
  hold_released: 'Hold released',
  consent_sent: 'Consent sent',
  consent_signed: 'Consent signed',
  consent_declined: 'Consent declined',
  verification_advanced: 'Verification advanced',
  decision_recorded: 'Decision recorded',
  status_changed: 'Status changed',
};

export const EntityRefSchema = z.object({
  type: ComplianceOwnerTypeSchema,
  id: z.string(),
  label: z.string(),
});
export type EntityRef = z.infer<typeof EntityRefSchema>;

/**
 * A compliance change as the Safety screens read it.
 *
 * Stored in the product's single audit trail (`audit_logs`), not a second one: the compliance
 * action is the entry's `action`, the requirement or document is the change's `field`, and the
 * before/after are its old/new. This is the projection of that row.
 */
export const ComplianceAuditEntrySchema = z.object({
  id: z.string(),
  at: isoDateTime,
  actorId: z.string(),
  actorName: z.string(),
  action: ComplianceAuditActionSchema,
  entity: EntityRefSchema,
  /** The requirement or document the change concerns, when there is one. */
  subject: z.string().nullable(),
  before: z.string().nullable(),
  after: z.string().nullable(),
  reason: z.string().nullable(),
  source: z.enum(['user', 'system', 'workflow', 'integration']),
});
export type ComplianceAuditEntry = z.infer<typeof ComplianceAuditEntrySchema>;

// ------------------------------------------------------------------------------------ queries

export const QualificationItemQuerySchema = z.object({
  scope: ComplianceScopeSchema.optional(),
  entityId: z.string().optional(),
});

export const ComplianceDocumentQuerySchema = z.object({
  ownerType: ComplianceOwnerTypeSchema.optional(),
  ownerId: z.string().optional(),
  requirementCode: z.string().optional(),
  status: ComplianceDocumentStatusSchema.optional(),
});

export const ConsentQuerySchema = z.object({
  driverId: z.string().optional(),
  status: ConsentStatusSchema.optional(),
  purpose: ConsentPurposeSchema.optional(),
});

export const VerificationQuerySchema = z.object({
  stage: VerificationStageSchema.optional(),
  ownerId: z.string().optional(),
  driverId: z.string().optional(),
});

export const ComplianceAuditQuerySchema = z.object({
  entityId: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(500).default(50),
});
