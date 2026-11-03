import { z } from 'zod';
import type { CandidateSafetyStatus } from './recruit.js';

/**
 * The candidate journey (owner brief, 2026-10-11): Consent → Safety review → Application →
 * Onboarding and costs → Ready to hire. The contracts both sides share; the rules that decide what
 * is allowed live on the server.
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD');
const optText = (max: number) =>
  z
    .string()
    .trim()
    .max(max)
    .nullish()
    .transform((v) => (v ? v : null));
const money = z.coerce.number().finite().min(0).max(1_000_000);

// =================================================================================== consent

/** Each disclosure is its own document; the official PSP disclosure stays standalone. */
export const CONSENT_DOCUMENT_TYPES = ['mvr', 'psp', 'clearinghouse'] as const;
export type ConsentDocumentType = (typeof CONSENT_DOCUMENT_TYPES)[number];

export const CONSENT_DOCUMENT_LABELS: Readonly<Record<ConsentDocumentType, string>> = {
  mvr: 'MVR consent',
  psp: 'PSP consent',
  clearinghouse: 'Clearinghouse limited consent',
};

export const CANDIDATE_CONSENT_TTL_DAYS = 14;
export const CONSENT_MAX_FILE_BYTES = 8 * 1024 * 1024;
export const CONSENT_MAX_SIGNATURE_BYTES = 512 * 1024;

/** What the driver confirms before signing, as the page words it. */
export const CONSENT_CONFIRMATION_STATEMENT =
  'I have been given each disclosure above, I confirm the information I entered is accurate, and I sign each authorization electronically.';

export type ConsentLinkState = 'live' | 'expired' | 'revoked' | 'submitted';

export interface ConsentSessionView {
  id: string;
  state: ConsentLinkState;
  createdAt: string;
  createdByName: string;
  expiresAt: string;
  revokedAt: string | null;
  revokeReason: string | null;
  linkCopiedAt: string | null;
  /** Sent by the TMS's own email, when email is configured. */
  emailedAt: string | null;
  emailedTo: string | null;
  /** Recorded by a recruiter who sent it themselves (text, WhatsApp…). */
  markedSentAt: string | null;
  markedSentBy: string | null;
  markedSentChannel: string | null;
  /** The page was opened — not proof that anything was read. */
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  openCount: number;
  submittedAt: string | null;
}

export interface ConsentLinkIssued {
  /** Shown once; only its digest is kept. */
  url: string;
  expiresAt: string;
  session: ConsentSessionView;
}

export interface ConsentDocumentView {
  id: string;
  type: ConsentDocumentType;
  label: string;
  signedAt: string;
  disclosureVersion: string;
  /** The company scope of a Clearinghouse limited consent, and until when it may be used. */
  scope: string | null;
  validUntil: string | null;
}

export interface ConsentFileView {
  id: string;
  code: 'cdl_front' | 'cdl_back';
  label: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  documentId: string | null;
}

/**
 * The safety questions on the consent (owner, 2026-10-13): the last three years. Any Yes is an
 * automatic disqualification under the company's hiring policy - shown to staff only, evaluated
 * apart from the verified reports.
 */
export const SAFETY_SCREENING_QUESTIONS = [
  { key: 'dui', label: 'DUI/DWI, BAC violations, implied consent violations, or drug-related violations' },
  { key: 'felony_vehicle', label: 'Any felony involving a motor vehicle' },
  { key: 'hit_and_run', label: 'Hit-and-run or leaving the scene of an accident' },
  { key: 'reckless', label: 'Reckless driving, racing, drag racing, or excessive speeding (20+ MPH over the posted limit)' },
  { key: 'fleeing', label: 'Fleeing or evading police' },
  { key: 'suspended', label: 'Driving with a suspended license or without a valid CDL' },
  { key: 'school_bus', label: 'Failure to stop for a school bus' },
  { key: 'sap', label: 'SAP program' },
] as const;
export type SafetyScreeningKey = (typeof SAFETY_SCREENING_QUESTIONS)[number]['key'];
export interface SafetyScreeningAnswer {
  key: SafetyScreeningKey;
  label: string;
  /** true = Yes. */
  answer: boolean;
}

/** Reads the form's answers: every question, Yes or No; null when any is missing or unreadable. */
export function readSafetyAnswers(raw: string | null | undefined): SafetyScreeningAnswer[] | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object') return null;
  const out: SafetyScreeningAnswer[] = [];
  for (const q of SAFETY_SCREENING_QUESTIONS) {
    const v = (parsed as Record<string, unknown>)[q.key];
    if (typeof v !== 'boolean') return null;
    out.push({ key: q.key, label: q.label, answer: v });
  }
  return out;
}

export interface ConsentSubmissionView {
  id: string;
  reference: string;
  receivedAt: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  signatureMethod: 'typed' | 'drawn';
  signatureText: string | null;
  hasSignatureImage: boolean;
  confirmedAt: string;
  documents: ConsentDocumentView[];
  files: ConsentFileView[];
  /** Staff-only evidence; the IP only for restricted-records holders. */
  audit: { clientSignedAt: string | null; userAgent: string | null; ipAddress: string | null; ipVisible: boolean };
  /** The safety questions as answered; null for a consent signed before they were asked. Staff only. */
  safetyAnswers: SafetyScreeningAnswer[] | null;
  /** Any Yes: disqualified under the company's hiring policy. */
  safetyDisqualified: boolean;
}

export interface CandidateConsentView {
  session: ConsentSessionView | null;
  submission: ConsentSubmissionView | null;
  /** The company's Clearinghouse wording is on file; until then that consent is not offered. */
  clearinghouseAvailable: boolean;
  /** The TMS can send the link by email itself (SMTP configured). */
  emailAvailable: boolean;
}

export const ConsentEmailSchema = z.object({ to: z.string().trim().email().max(160).nullish().transform((v) => v ?? null) });
export const ConsentMarkSentSchema = z.object({ channel: optText(40) });

/** What the public consent page reads from its token. */
export interface ConsentFormContext {
  /**
   * Opened by a signed-in member of the company (owner, 2026-10-14): a read-only preview that
   * neither binds the link to this device nor counts as the driver opening it.
   */
  preview?: boolean;
  companyName: string;
  firstName: string;
  lastName: string;
  phone: string;
  email: string;
  expiresAt: string;
  alreadySubmitted: boolean;
  confirmationStatement: string;
  disclosures: {
    type: ConsentDocumentType;
    label: string;
    title: string;
    text: string;
    version: string;
    sha256: string;
    /** The text carries the signer's name here; the page fills it with the name as typed. */
    driverNamePlaceholder: string | null;
    scope: string | null;
  }[];
  /** Disclosures the company has not published yet (Clearinghouse until its wording arrives). */
  pending: { type: ConsentDocumentType; label: string }[];
}

/** The text fields of the consent submission (multipart); files and the signature PNG ride beside. */
export const ConsentSubmitFieldsSchema = z
  .object({
    token: z.string().min(20).max(200),
    submissionKey: z.string().uuid(),
    firstName: z.string().trim().min(1, 'First name is required').max(80),
    lastName: z.string().trim().min(1, 'Last name is required').max(80),
    phone: z.string().trim().min(7, 'Phone is required').max(30),
    email: z.string().trim().email('Enter a valid email').max(160),
    confirmed: z.literal('true', { message: 'Tick the confirmation first' }),
    signatureMethod: z.enum(['typed', 'drawn']),
    signatureText: optText(120),
    signatureDrawing: z.string().max(800_000).nullish().transform((v) => v ?? null),
    clientSignedAt: optText(40),
    /** JSON: [{ type, version, sha256 }] for every disclosure signed. */
    documents: z.string().min(2).max(4000),
    /** JSON: { questionKey: true (Yes) | false (No) } for every safety question. */
    safetyAnswers: z.string().min(2).max(2000).optional(),
  })
  .strict();
export type ConsentSubmitFields = z.infer<typeof ConsentSubmitFieldsSchema>;

export interface ConsentAck {
  saved: true;
  reference: string;
}

// ================================================================== sending links (SMS / email)

/** The two private links the journey sends: the consent (step 2) and the application (step 5). */
export const JOURNEY_LINK_KINDS = ['consent', 'application'] as const;
export type JourneyLinkKind = (typeof JOURNEY_LINK_KINDS)[number];

export const LINK_DELIVERY_CHANNELS = ['sms', 'email'] as const;
export type LinkDeliveryChannel = (typeof LINK_DELIVERY_CHANNELS)[number];

/**
 * `sending` while the provider is asked; `sent` once it accepted the message; `delivered` only when
 * the carrier confirms it (SMS); `failed` with the provider's reason. Email has no delivery receipt,
 * so an email stays `sent` — accepted by the mail server, not proof it was read.
 */
export const LINK_DELIVERY_STATUSES = ['sending', 'sent', 'delivered', 'failed'] as const;
export type LinkDeliveryStatus = (typeof LINK_DELIVERY_STATUSES)[number];

export const LINK_DELIVERY_STATUS_LABELS: Readonly<Record<LinkDeliveryStatus, string>> = {
  sending: 'Sending',
  sent: 'Sent',
  delivered: 'Delivered',
  failed: 'Failed',
};

export interface LinkDeliveryView {
  id: string;
  link: JourneyLinkKind;
  channel: LinkDeliveryChannel;
  recipient: string;
  status: LinkDeliveryStatus;
  /** twilio · smtp · file (QA sandbox) */
  provider: string;
  providerStatus: string | null;
  error: string | null;
  createdAt: string;
  createdByName: string;
  sentAt: string | null;
  deliveredAt: string | null;
  failedAt: string | null;
  statusCheckedAt: string | null;
  resendOfId: string | null;
  /** The link this message carried is still the live one (a newer link turns it off). */
  linkLive: boolean;
  version: number;
}

/** Whether the TMS can send on a channel, and if not, exactly why. */
export interface LinkChannelState {
  available: boolean;
  /** e.g. "Twilio · +1 512…" or "SMTP · recruiting@…" */
  via: string | null;
  reason: string | null;
}

/** How the person agreed to texts, as staff record it. */
export const SMS_OPT_IN_SOURCES = ['applied_online', 'verbal', 'texted_first', 'written'] as const;
export type SmsOptInSource = (typeof SMS_OPT_IN_SOURCES)[number];
export const SMS_OPT_IN_SOURCE_LABELS: Readonly<Record<SmsOptInSource, string>> = {
  applied_online: 'Agreed to texts when applying online',
  verbal: 'Agreed on a call',
  texted_first: 'Texted us first',
  written: 'Agreed in writing',
};

/** The candidate's texting consent: nobody who replied STOP is texted; staff cannot undo a STOP. */
export interface SmsConsentView {
  phone: string | null;
  status: 'none' | 'opted_in' | 'opted_out';
  optedInAt: string | null;
  optedInBy: string | null;
  optedInSource: SmsOptInSource | null;
  optedOutAt: string | null;
  /** reply_stop · carrier · staff */
  optedOutSource: string | null;
}

export const SmsConsentSchema = z.object({
  action: z.enum(['opt_in', 'opt_out']),
  source: z.enum(SMS_OPT_IN_SOURCES).nullish().transform((v) => v ?? null),
  note: optText(300),
});
export type SmsConsentInput = z.input<typeof SmsConsentSchema>;

export interface CandidateDeliveries {
  channels: Record<LinkDeliveryChannel, LinkChannelState>;
  items: LinkDeliveryView[];
  sms: SmsConsentView;
}

export const SendLinkSchema = z.object({
  link: z.enum(JOURNEY_LINK_KINDS),
  channel: z.enum(LINK_DELIVERY_CHANNELS),
  /** Defaults to the candidate's phone (SMS) or email; may be corrected here. */
  to: z.string().trim().min(3).max(160).nullish().transform((v) => v ?? null),
});
export type SendLinkInput = z.input<typeof SendLinkSchema>;
export type SendLinkRequest = z.infer<typeof SendLinkSchema>;

/** US phone numbers in E.164; anything else is refused before it reaches the provider. */
export function toE164(raw: string): string | null {
  const trimmed = raw.trim();
  const digits = trimmed.replace(/\D/g, '');
  if (trimmed.startsWith('+')) return digits.length >= 10 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith('1')) return `+${digits}`;
  return null;
}

// ============================================================================ safety review

export const SAFETY_REPORT_KINDS = ['mvr', 'psp', 'clearinghouse_limited', 'clearinghouse_full', 'other'] as const;
export type SafetyReportKind = (typeof SAFETY_REPORT_KINDS)[number];

export const SAFETY_REPORT_LABELS: Readonly<Record<SafetyReportKind, string>> = {
  mvr: 'MVR report',
  psp: 'PSP report',
  clearinghouse_limited: 'Clearinghouse limited query',
  clearinghouse_full: 'Clearinghouse full query',
  other: 'Other evidence',
};

export const SAFETY_REPORT_RESULTS = ['pending', 'clear', 'findings', 'prohibited'] as const;
export type SafetyReportResult = (typeof SAFETY_REPORT_RESULTS)[number];

/** The driver's own consent in the FMCSA Clearinghouse for a full query — not something this TMS collects. */
export const FMCSA_FULL_QUERY_STATUSES = ['not_requested', 'requested', 'received', 'declined'] as const;
export type FmcsaFullQueryStatus = (typeof FMCSA_FULL_QUERY_STATUSES)[number];

export interface SafetyReportView {
  id: string;
  kind: SafetyReportKind;
  label: string;
  result: SafetyReportResult;
  status: 'received' | 'reviewed';
  documentId: string | null;
  fileName: string | null;
  receivedOn: string | null;
  note: string | null;
  uploadedAt: string;
  uploadedByName: string;
  reviewedAt: string | null;
  reviewedByName: string | null;
  reviewNote: string | null;
  version: number;
}

/**
 * The checks Safety runs (owner brief, 2026-10-11): each moves Requested → Pending → Received →
 * Reviewed, with who and when at every step. A signed consent is permission to check, not a check;
 * a received report is not a reviewed one; nothing reads as passed until Safety reviews it.
 */
export const SAFETY_CHECK_KINDS = ['mvr', 'psp', 'clearinghouse_limited', 'clearinghouse_full'] as const;
export type SafetyCheckKind = (typeof SAFETY_CHECK_KINDS)[number];

export const SAFETY_CHECK_LABELS: Readonly<Record<SafetyCheckKind, string>> = {
  mvr: 'MVR',
  psp: 'PSP',
  clearinghouse_limited: 'Clearinghouse limited query',
  clearinghouse_full: 'Clearinghouse full query',
};

export const SAFETY_CHECK_STATUSES = ['not_requested', 'requested', 'pending', 'received', 'reviewed'] as const;
export type SafetyCheckStatus = (typeof SAFETY_CHECK_STATUSES)[number];

export const SAFETY_CHECK_STATUS_LABELS: Readonly<Record<SafetyCheckStatus, string>> = {
  not_requested: 'Not requested',
  requested: 'Requested',
  pending: 'Pending',
  received: 'Received',
  reviewed: 'Reviewed',
};

export interface SafetyCheckView {
  kind: SafetyCheckKind;
  label: string;
  status: SafetyCheckStatus;
  required: boolean;
  /** The authorization this check runs under, and whether the candidate gave it. */
  authorization: { label: string; given: boolean; detail: string };
  /** Why it cannot be requested yet (e.g. the Clearinghouse wording is not on file). */
  blockedReason: string | null;
  provider: string;
  orderRef: string | null;
  note: string | null;
  requestedAt: string | null;
  requestedByName: string | null;
  pendingAt: string | null;
  pendingByName: string | null;
  receivedAt: string | null;
  receivedByName: string | null;
  reportId: string | null;
  reviewedAt: string | null;
  reviewedByName: string | null;
  result: SafetyReportResult | null;
  version: number;
}

export const SafetyCheckRequestSchema = z.object({
  kind: z.enum(SAFETY_CHECK_KINDS),
  /** Where it was ordered: "manual" (Safety ran it in the provider's own site) or the vendor's name. */
  provider: z.string().trim().min(1).max(60).default('manual'),
  orderRef: optText(80),
  note: optText(1000),
});
export type SafetyCheckRequestInput = z.input<typeof SafetyCheckRequestSchema>;
export type SafetyCheckRequest = z.infer<typeof SafetyCheckRequestSchema>;

export const SafetyCheckPendingSchema = z.object({
  orderRef: optText(80),
  note: optText(1000),
  version: z.number().int().min(1),
});

export interface CandidateSafetyView {
  review: {
    id: string;
    status: CandidateSafetyStatus;
    openedAt: string;
    openedByName: string;
    requestNote: string | null;
    fmcsaFullQueryStatus: FmcsaFullQueryStatus;
    fmcsaFullQueryAt: string | null;
    decidedAt: string | null;
    decidedByName: string | null;
    decisionNote: string | null;
    insurance: SafetyInsuranceView | null;
    version: number;
  } | null;
  /** The signed authorizations (from the consent): proof Safety may run the checks, not results. */
  authorizations: { type: ConsentDocumentType; label: string; signedAt: string | null }[];
  reports: SafetyReportView[];
  /** MVR, PSP and the Clearinghouse queries, each Requested → Pending → Received → Reviewed. */
  checks: SafetyCheckView[];
  canDecide: boolean;
  /** Recruiting runs the checks and files the reports (owner, 2026-10-12); Safety decides. */
  canUpload: boolean;
}

/** Safety's insurance check (owner, 2026-10-12): asked, then the insurer's answer. */
export const SAFETY_INSURANCE_STATUSES = ['pending', 'approved', 'declined'] as const;
export type SafetyInsuranceStatus = (typeof SAFETY_INSURANCE_STATUSES)[number];
export interface SafetyInsuranceView {
  status: SafetyInsuranceStatus;
  note: string | null;
  requestedAt: string | null;
  requestedBy: string | null;
  respondedAt: string | null;
  respondedBy: string | null;
}
export const SafetyInsuranceRequestSchema = z.object({ note: z.string().trim().max(1000).nullable().default(null), version: z.number().int() });
export const SafetyInsuranceResponseSchema = z.object({ result: z.enum(['approved', 'declined']), note: z.string().trim().max(1000).nullable().default(null), version: z.number().int() });

/**
 * Safety's desk for candidates (owner, 2026-10-11): everyone Recruiting sent to Safety, waiting for a
 * Qualified / Not qualified decision, with the signed consents beside them. Safety works here; the
 * recruiter's candidate page only shows the decision.
 */
export interface SafetyDeskRow {
  caseId: string;
  /** The candidate page key, for a link to it. */
  key: string;
  name: string;
  phone: string | null;
  email: string | null;
  status: CandidateSafetyStatus;
  sentAt: string;
  sentByName: string;
  requestNote: string | null;
  decidedAt: string | null;
  decidedByName: string | null;
  decisionNote: string | null;
  insuranceStatus: SafetyInsuranceStatus | null;
  consentsSigned: ConsentDocumentType[];
  reportsWithResult: number;
  reportsOnFile: number;
}

export interface SafetyDeskList {
  waiting: SafetyDeskRow[];
  decided: SafetyDeskRow[];
}

export interface SafetyDeskDetail {
  row: SafetyDeskRow;
  consent: CandidateConsentView;
  safety: CandidateSafetyView;
}

export const SendConsentToSafetySchema = z.object({ note: optText(1000) });

export const SafetyStatusChangeSchema = z.object({
  status: z.enum(['in_review', 'needs_follow_up', 'approved', 'declined']),
  note: optText(2000),
  version: z.number().int().min(1),
});
export type SafetyStatusChangeInput = z.input<typeof SafetyStatusChangeSchema>;
export type SafetyStatusChangeRequest = z.infer<typeof SafetyStatusChangeSchema>;

export const FullQueryStatusSchema = z.object({ status: z.enum(FMCSA_FULL_QUERY_STATUSES), version: z.number().int().min(1) });

export const SafetyReportUploadSchema = z.object({
  kind: z.enum(SAFETY_REPORT_KINDS),
  result: z.enum(SAFETY_REPORT_RESULTS).default('pending'),
  receivedOn: isoDate.nullish().transform((v) => v ?? null),
  note: optText(2000),
  fileName: z.string().trim().min(1).max(200),
  contentType: z.string().max(100),
  /** base64 of the file. */
  content: z.string().min(4).max(28_000_000),
});
export type SafetyReportUploadInput = z.input<typeof SafetyReportUploadSchema>;
export type SafetyReportUploadRequest = z.infer<typeof SafetyReportUploadSchema>;

export const SafetyReportReviewSchema = z.object({
  result: z.enum(SAFETY_REPORT_RESULTS),
  note: optText(2000),
  version: z.number().int().min(1),
});

// =============================================================================== onboarding

export const ONBOARDING_TASK_STATUSES = ['pending', 'in_progress', 'done', 'failed', 'waived'] as const;
export type OnboardingTaskStatus = (typeof ONBOARDING_TASK_STATUSES)[number];

/** The checklist every candidate starts with; a company can add its own. */
export const DEFAULT_ONBOARDING_TASKS: readonly { code: string; label: string; required: boolean }[] = [
  { code: 'documents_verified', label: 'Documents verified', required: true },
  { code: 'drug_test', label: 'Drug test result', required: true },
  { code: 'employer_checks', label: 'Previous employer checks', required: true },
  { code: 'orientation', label: 'Orientation', required: true },
  { code: 'arrival', label: 'Arrival', required: true },
];

export interface OnboardingTaskView {
  id: string;
  code: string;
  label: string;
  required: boolean;
  status: OnboardingTaskStatus;
  ownerEmployeeId: string | null;
  ownerName: string | null;
  dueOn: string | null;
  completedAt: string | null;
  completedByName: string | null;
  result: string | null;
  evidenceDocumentId: string | null;
  evidenceFileId: string | null;
  note: string | null;
  version: number;
}

export const OnboardingTaskUpdateSchema = z.object({
  status: z.enum(ONBOARDING_TASK_STATUSES),
  ownerEmployeeId: z.string().min(1).nullish().transform((v) => v ?? null),
  dueOn: isoDate.nullish().transform((v) => v ?? null),
  result: optText(200),
  note: optText(2000),
  evidenceFileId: z.string().min(1).nullish().transform((v) => v ?? null),
  version: z.number().int().min(1),
});
export type OnboardingTaskUpdateInput = z.input<typeof OnboardingTaskUpdateSchema>;
export type OnboardingTaskUpdateRequest = z.infer<typeof OnboardingTaskUpdateSchema>;

export const OnboardingTaskAddSchema = z.object({
  label: z.string().trim().min(2).max(120),
  required: z.boolean().default(true),
  dueOn: isoDate.nullish().transform((v) => v ?? null),
});

// =================================================================================== travel

export const TRAVEL_KINDS = ['flight', 'hotel', 'ground'] as const;
export type TravelKind = (typeof TRAVEL_KINDS)[number];
export const TRAVEL_KIND_LABELS: Readonly<Record<TravelKind, string>> = { flight: 'Flight', hotel: 'Hotel', ground: 'Ground transport' };
export const TRAVEL_STATUSES = ['booked', 'rescheduled', 'cancelled'] as const;
export type TravelStatus = (typeof TRAVEL_STATUSES)[number];

export interface TravelItemView {
  id: string;
  kind: TravelKind;
  status: TravelStatus;
  vendor: string | null;
  routeFrom: string | null;
  routeTo: string | null;
  bookingReference: string | null;
  departAt: string | null;
  arriveAt: string | null;
  checkInOn: string | null;
  checkOutOn: string | null;
  notes: string | null;
  confirmationFileId: string | null;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdByName: string;
  createdAt: string;
  version: number;
  /** What the booking cost (its linked, not-voided costs, refunds taken off); null when none recorded. */
  cost: number | null;
}

const instant = z.string().datetime({ offset: true }).nullish().transform((v) => v ?? null);

export const TravelItemSchema = z.object({
  kind: z.enum(TRAVEL_KINDS),
  vendor: optText(120),
  routeFrom: optText(120),
  routeTo: optText(120),
  bookingReference: optText(80),
  departAt: instant,
  arriveAt: instant,
  checkInOn: isoDate.nullish().transform((v) => v ?? null),
  checkOutOn: isoDate.nullish().transform((v) => v ?? null),
  notes: optText(1000),
  confirmationFileId: z.string().min(1).nullish().transform((v) => v ?? null),
  /** The ticket or room price (owner, 2026-10-12): recorded at once as a spent cost on this booking. */
  price: money.nullish().transform((v) => (v ? v : null)),
  paidBy: z.enum(['company', 'driver']).default('company'),
});
export type TravelItemInput = z.input<typeof TravelItemSchema>;
export type TravelItemRequest = z.infer<typeof TravelItemSchema>;

export const TravelUpdateSchema = TravelItemSchema.omit({ kind: true }).extend({
  status: z.enum(['booked', 'rescheduled']),
  version: z.number().int().min(1),
});
export const TravelCancelSchema = z.object({ reason: z.string().trim().min(3).max(500), version: z.number().int().min(1) });

// ==================================================================================== costs

export const COST_PARTIES = ['company', 'driver'] as const;
export type CostParty = (typeof COST_PARTIES)[number];
export const COST_APPROVALS = ['planned', 'approved', 'rejected'] as const;
export type CostApproval = (typeof COST_APPROVALS)[number];

/**
 * Where a cost goes, from who paid and whose cost it is (owner's brief, 2026-10-11):
 * - company paid, company's cost → a company recruiting expense;
 * - driver paid, company's cost → reimbursement review (paid only when the payment is recorded);
 * - company paid, driver's cost → a driver charge, only with the driver's recorded agreement;
 * - driver paid, driver's cost → the driver's own; the company records it and pays nothing.
 */
export type CostTreatment = 'company_expense' | 'reimbursement' | 'driver_charge' | 'personal';

export function costTreatment(paidBy: CostParty, costOwner: CostParty): CostTreatment {
  if (paidBy === 'company') return costOwner === 'company' ? 'company_expense' : 'driver_charge';
  return costOwner === 'company' ? 'reimbursement' : 'personal';
}

export const COST_TREATMENT_LABELS: Readonly<Record<CostTreatment, string>> = {
  company_expense: 'Company recruiting expense',
  reimbursement: 'Reimburse the driver',
  driver_charge: 'Charge the driver',
  personal: "Driver's own cost",
};

export interface CandidateCostView {
  id: string;
  type: string;
  label: string;
  amount: number;
  refundAmount: number;
  nonrefundableFee: number | null;
  incurredOn: string;
  vendor: string | null;
  paidBy: CostParty;
  costOwner: CostParty;
  treatment: CostTreatment;
  approvalStatus: CostApproval;
  approvedAt: string | null;
  approvedBy: string | null;
  paymentStatus: 'unpaid' | 'paid';
  paidAt: string | null;
  /** Where Accounting has it: posted expense, reimbursement, driver charge, or nothing yet. */
  accounting: { state: 'not_posted' | 'posted' | 'reimbursement' | 'driver_charge' | 'none_needed' | 'waiting_agreement'; note: string | null };
  travelItemId: string | null;
  receiptFileId: string | null;
  driverAgreementNote: string | null;
  note: string | null;
  source: string;
  voided: boolean;
  version: number;
}

export interface CandidateCostSummary {
  /** What was spent: every confirmed cost, refunds taken off (owner, 2026-10-12). */
  spent: number;
  planned: number;
  approved: number;
  paid: number;
  companyCost: number;
  driverCost: number;
}

export const CandidateCostSchema = z.object({
  type: z.string().trim().min(1).max(40),
  amount: money.refine((v) => v > 0, 'Enter an amount'),
  incurredOn: isoDate,
  vendor: optText(120),
  paidBy: z.enum(COST_PARTIES),
  costOwner: z.enum(COST_PARTIES),
  approvalStatus: z.enum(['planned', 'approved']).default('planned'),
  travelItemId: z.string().min(1).nullish().transform((v) => v ?? null),
  receiptFileId: z.string().min(1).nullish().transform((v) => v ?? null),
  driverAgreementNote: optText(1000),
  note: optText(1000),
});
export type CandidateCostInput = z.input<typeof CandidateCostSchema>;
export type CandidateCostRequest = z.infer<typeof CandidateCostSchema>;

export const CostApprovalSchema = z.object({ decision: z.enum(['approved', 'rejected']), note: optText(500), version: z.number().int().min(1) });
export const CostPaymentSchema = z.object({ paidOn: isoDate, note: optText(500), version: z.number().int().min(1) });
export const CostRefundSchema = z.object({
  refundAmount: money,
  nonrefundableFee: money.nullish().transform((v) => v ?? null),
  note: optText(500),
  version: z.number().int().min(1),
});
export const CostAgreementSchema = z.object({ note: z.string().trim().min(5).max(1000), version: z.number().int().min(1) });

// ============================================================================ ready to hire

export interface HireChecklistItem {
  code: 'safety' | 'clearinghouse_full' | 'application' | 'documents' | 'drug_test' | 'checks' | 'orientation' | 'hold';
  label: string;
  ok: boolean;
  detail: string;
  at: string | null;
}

export interface CandidateHireChecklist {
  ready: boolean;
  items: HireChecklistItem[];
  onHold: { at: string; by: string | null; reason: string | null } | null;
  hired: { at: string; driverId: string; driverNumber: string | null; employeeId: string | null } | null;
}

export const HireCandidateSchema = z.object({
  hireDate: isoDate,
  driverType: z.enum(['company', 'owner_operator', 'lease_operator']).default('company'),
  payPlanKind: z.enum(['per_mile', 'percent_of_linehaul']).default('per_mile'),
  payPlanRate: z.coerce.number().min(0).max(100),
  dispatcherId: z.string().min(1, 'Choose a dispatcher'),
  managerEmployeeId: z.string().min(1).nullish().transform((v) => v ?? null),
  preferredLanguage: z.enum(['en', 'es', 'ru', 'uz', 'uk']).default('en'),
});
export type HireCandidateInput = z.input<typeof HireCandidateSchema>;
export type HireCandidateRequest = z.infer<typeof HireCandidateSchema>;

export const HoldCandidateSchema = z.object({ hold: z.boolean(), reason: optText(500) });
export const WithdrawCandidateSchema = z.object({ reason: z.string().trim().min(3).max(500) });

/** Everything the candidate page shows for the journey's later steps, in one read. */
export interface CandidateJourney {
  consent: CandidateConsentView;
  /** Links the TMS sent by SMS or email, newest first, and whether each channel can send. */
  deliveries: CandidateDeliveries;
  safety: CandidateSafetyView;
  application: {
    /** The application invite is blocked until Safety approves (owner's brief). */
    canSend: boolean;
    blockedReason: string | null;
    reviewedAt: string | null;
    reviewedBy: string | null;
    inheritedFromConsent: boolean;
  };
  onboarding: { startedAt: string | null; startedBy: string | null; tasks: OnboardingTaskView[] };
  travel: TravelItemView[];
  costs: { entries: CandidateCostView[]; summary: CandidateCostSummary };
  hire: CandidateHireChecklist;
  permissions: { canManage: boolean; canSafety: boolean; canAccounting: boolean; canSeeSensitive: boolean };
}
