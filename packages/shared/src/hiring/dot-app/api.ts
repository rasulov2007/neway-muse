import { z } from 'zod';
import type { DotAppAnswers } from './answers.js';
import type { DotAppConsentLink, DotAppStepId, DotAppUploadSlot } from './documents.js';
import type { DotAppMissingItem } from './requirements.js';

/** The application's life, as Recruiting and Safety see it (the driver sees only their part). */
export const DOT_APP_STATUSES = [
  'sent',
  'opened',
  'in_progress',
  'submitted',
  'under_review',
  'changes_requested',
  'approved',
  'rejected',
  'hired',
] as const;
export type DotAppStatus = (typeof DOT_APP_STATUSES)[number];
export const DOT_APP_STATUS_LABELS: Readonly<Record<DotAppStatus, string>> = {
  sent: 'Sent',
  opened: 'Opened',
  in_progress: 'In progress',
  submitted: 'Submitted',
  under_review: 'Under Safety review',
  changes_requested: 'Changes requested',
  approved: 'Safety approved',
  rejected: 'Rejected',
  hired: 'Hired',
};
/** Statuses in which the driver can still edit (a submitted application is frozen). */
export const DOT_APP_EDITABLE: readonly DotAppStatus[] = ['sent', 'opened', 'in_progress', 'changes_requested'];

export const DOT_APP_LINK_TTL_DAYS = 14;
export const DOT_APP_CODE_TTL_MINUTES = 10;
export const DOT_APP_CODE_RESEND_SECONDS = 60;
export const DOT_APP_CODE_MAX_FAILURES = 5;
/** The one answer for an unknown, expired or revoked link — nothing about why. */
export const DOT_APP_LINK_GONE = 'This link is no longer active.';

/** One approved legal document as the driver reads it (the company's own text and version). */
export interface DotAppTemplate {
  key: string;
  version: string;
  title: string;
  /** Source (file · page) as recorded on the template. */
  source: string | null;
  /** The structured content: html, check, certify, items, pages … verbatim. */
  content: Record<string, unknown>;
  contentSha256: string;
}

export interface DotAppCompanyBrand {
  /** From the candidate's company in the database — never from the URL or the browser. */
  name: string;
  legalName: string;
  phone: string | null;
  address: string | null;
  /** Locations a driver may apply for (the company's yards; "Remote / Any location"). */
  locations: string[];
  /** The prospective employer's confidential fax number for SPH requests (set by Safety); null = not given. */
  sphConfidentialFax: string | null;
}

/** GET /public/driver-application-v2/:token — before the code. */
export interface DotAppPublicGate {
  state: 'code_required' | 'paused' | 'verified';
  company: DotAppCompanyBrand;
  /** b•••@example.com */
  maskedEmail: string;
  codeSentAt: string | null;
  /** Seconds until "Resend code" is allowed. */
  resendInSeconds: number;
  expiresAt: string;
}

export interface DotAppSignatureView {
  key: string;
  docKey: string;
  docVersion: string;
  signerName: string;
  typedName: string;
  signedAt: string;
  /** Short evidence id (first 10 of the evidence digest) shown on the page. */
  evidenceId: string;
  signerRole: 'driver' | 'employer';
  signerTitle: string | null;
}

export interface DotAppUploadView {
  id: string;
  slot: DotAppUploadSlot;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  source: 'driver' | 'consent' | 'employer';
}

export interface DotAppChangeRequestView {
  id: string;
  sections: DotAppStepId[];
  message: string;
  requestedAt: string;
  requestedByName: string;
  resolvedAt: string | null;
}

/** GET /public/driver-application-v2/:token/application — after the code (session header). */
export interface DotAppDriverState {
  applicationId: string;
  status: DotAppStatus;
  version: number;
  company: DotAppCompanyBrand;
  answers: DotAppAnswers;
  /** What the Consent Form prefilled (shown with "From Consent Form"). */
  prefilledPaths: string[];
  ssnOnFile: boolean;
  ssnLast4: string | null;
  /** ACH debit bank numbers sealed on the application; only the account's last 4 are ever returned. */
  bankOnFile: boolean;
  bankLast4: string | null;
  templates: DotAppTemplate[];
  /** Document keys that have no approved template for this company. */
  awaitingDocs: string[];
  consentLinks: { link: DotAppConsentLink; title: string; signedAt: string; version: string }[];
  signatures: DotAppSignatureView[];
  uploads: DotAppUploadView[];
  missing: DotAppMissingItem[];
  /** Today in US Eastern, from the server clock. */
  today: string;
  openChangeRequest: DotAppChangeRequestView | null;
  /** Steps whose signatures were cleared by a change request and must be signed again. */
  submittedAt: string | null;
  reference: string | null;
  lastSavedAt: string | null;
}

export const DotAppVerifyCodeSchema = z.object({ code: z.string().trim().regex(/^\d{6}$/, 'Enter the 6-digit code.') });

export const DotAppSignSchema = z.object({
  /** The signature key (document key, sph_<employerId>, or emp_* for Safety). */
  key: z.string().min(2).max(80),
  /** The version shown on screen; refused if it is not the approved version on file. */
  docVersion: z.string().min(1).max(80),
  typedName: z.string().trim().min(2, 'Type your full name.').max(160),
  esignConsent: z.literal(true, { message: 'Agree to use an electronic signature.' }),
  /** data:image/png;base64,… drawn on the pad */
  image: z.string().startsWith('data:image/png;base64,').max(800_000),
  /** Signer title for employer signatures (Safety). */
  title: z.string().trim().max(120).optional(),
});
export type DotAppSignInput = z.infer<typeof DotAppSignSchema>;

export const DotAppSubmitSchema = z.object({ version: z.number().int().min(1) });

// ================================================================== recruiter / Safety (internal)

export interface DotAppLinkView {
  id: string;
  state: 'live' | 'expired' | 'revoked' | 'paused';
  email: string;
  createdAt: string;
  createdByName: string;
  expiresAt: string;
  emailedAt: string | null;
  copiedAt: string | null;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  verifiedAt: string | null;
  pausedAt: string | null;
  revokedAt: string | null;
  revokedByName: string | null;
  /** The latest link email's delivery status (Resend): sent · delivered · bounced · complained · failed. */
  emailStatus: string | null;
}

export interface DotAppSummary {
  id: string;
  companyId: string;
  subjectKey: string;
  candidateName: string;
  driverId: string | null;
  position: string | null;
  status: DotAppStatus;
  createdAt: string;
  submittedAt: string | null;
  approvedAt: string | null;
  hiredAt: string | null;
  sectionsComplete: number;
  sectionsTotal: number;
  link: DotAppLinkView | null;
}

/** The candidate page's application card (Recruiting step 5). */
export interface DotAppRecruiterView {
  /** False when the company's documents are not all approved (the legacy application is used). */
  available: boolean;
  /** Why the new application cannot be sent yet (consent not approved, documents awaiting …). */
  blockedReason: string | null;
  awaitingDocs: { key: string; title: string }[];
  application: DotAppSummary | null;
}

export interface DotAppIssued {
  application: DotAppSummary;
  /** Shown once (for Copy link); only its digest is stored. */
  url: string;
  expiresAt: string;
  email: { status: 'sent' | 'failed' | 'skipped'; error: string | null; messageId: string | null };
}

export const DotAppIssueSchema = z.object({
  /** Send the link by email (Resend). Copy link is always offered. */
  sendEmail: z.boolean().default(true),
  /** Override the address (defaults to the candidate's email). */
  email: z.string().trim().email().max(200).optional(),
  expiresInDays: z.union([z.literal(3), z.literal(7), z.literal(14)]).default(14),
});
export type DotAppIssueInput = z.infer<typeof DotAppIssueSchema>;

export const DotAppRequestChangesSchema = z.object({
  sections: z.array(z.string()).min(1, 'Choose at least one section.').max(12),
  message: z.string().trim().min(5, 'Write a message to the driver.').max(2000),
});
export const DotAppDecisionSchema = z.object({ note: z.string().trim().max(2000).optional() });
export const DotAppRejectSchema = z.object({ reason: z.string().trim().min(3, 'Say why.').max(2000) });
export const DotAppEmployerFormsSchema = z.object({
  version: z.number().int().min(1),
  employerForms: z.record(z.string(), z.unknown()),
});
export const DotAppOnboardingSchema = z.object({
  version: z.number().int().min(1),
  onboarding: z.record(z.string(), z.unknown()),
});

export interface DotAppEmployerItem {
  key: string;
  title: string;
  done: boolean;
}

/** Safety's full view of one application. */
export interface DotAppSafetyDetail extends DotAppSummary {
  version: number;
  answers: DotAppAnswers;
  ssnLast4: string | null;
  bankLast4: string | null;
  templates: DotAppTemplate[];
  templateVersions: Record<string, string>;
  signatures: DotAppSignatureView[];
  uploads: DotAppUploadView[];
  employerForms: Record<string, unknown>;
  onboarding: Record<string, unknown>;
  employerChecklist: DotAppEmployerItem[];
  onboardingChecklist: DotAppEmployerItem[];
  changeRequests: DotAppChangeRequestView[];
  consentLinks: { link: DotAppConsentLink; title: string; signedAt: string; version: string }[];
  missing: DotAppMissingItem[];
  internalNote: string | null;
  rejectedReason: string | null;
  rosterDriverId: string | null;
  company: DotAppCompanyBrand;
  activity: { at: string; actor: string; action: string; detail: string }[];
  emails: { id: string; kind: string; to: string; status: string; at: string; error: string | null }[];
  permissions: { canReview: boolean; canHire: boolean };
}

// ================================================================== document templates (admin)

export interface DotAppTemplateRow {
  id: string;
  docKey: string;
  title: string;
  version: string;
  status: 'draft' | 'approved' | 'retired';
  sourceFileName: string | null;
  sourceSha256: string | null;
  contentSha256: string;
  createdAt: string;
  createdByName: string;
  approvedAt: string | null;
  approvedByName: string | null;
  note: string | null;
}
export interface DotAppTemplateOverview {
  company: { id: string; name: string };
  documents: { key: string; title: string; step: string; current: DotAppTemplateRow | null; versions: DotAppTemplateRow[] }[];
  /** Bundled source sets this company may import (only its own company's set). */
  importableSets: { id: string; title: string; documents: number }[];
}
export const DotAppTemplateCreateSchema = z.object({
  docKey: z.string().min(2).max(60),
  version: z.string().trim().min(1).max(60),
  title: z.string().trim().min(2).max(240),
  content: z.record(z.string(), z.unknown()),
  sourceFileId: z.string().min(1).optional(),
  note: z.string().trim().max(1000).optional(),
});

/** Hire (Safety Manager / Admin): one transaction into Fleet → Drivers under the reserved id. */
export const DotAppHireSchema = z.object({
  hireDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  dispatcherId: z.string().default(''),
  driverType: z.enum(['company', 'owner_operator', 'lease_operator']).default('company'),
  payPlanKind: z.enum(['per_mile', 'percent_of_linehaul', 'lease_owner', 'lease_to_own', 'owner_truck']).default('per_mile'),
  payPlanRate: z.number().min(0).max(100).default(0),
  preferredLanguage: z.enum(['en', 'es', 'ru', 'uz', 'uk']).default('en'),
});
export type DotAppHireInput = z.infer<typeof DotAppHireSchema>;
