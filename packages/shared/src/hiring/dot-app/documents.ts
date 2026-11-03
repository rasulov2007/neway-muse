/**
 * The legal documents of the DOT driver application v2 (owner brief 2026-10-27).
 *
 * This file names the documents and where they sit; it holds NO legal wording. The wording is
 * per company: each company's approved template rows (application_document_templates) carry the
 * text, verbatim from that company's own approved source. A document without an approved template
 * for the candidate's company is shown as "Awaiting <company> approved document" and cannot be
 * signed — one company's documents are never used for another.
 */

export const DOT_APP_STEP_IDS = [
  'personal',
  'company',
  'license',
  'employment',
  'history',
  'emergency',
  'certs',
  'disclosures',
  'policies',
  'contractor',
  'documents',
  'review',
] as const;
export type DotAppStepId = (typeof DOT_APP_STEP_IDS)[number];

export const DOT_APP_STEP_TITLES: Readonly<Record<DotAppStepId, string>> = {
  personal: 'Personal information',
  company: 'Company questions',
  license: 'License & experience',
  employment: 'Employment history',
  history: 'Safety record',
  emergency: 'Emergency contact',
  certs: 'Driver certifications',
  disclosures: 'Disclosures & authorizations',
  policies: 'Company policies',
  contractor: 'Contractor forms',
  documents: 'Documents',
  review: 'Review & submit',
};

/** Consent Form documents that may already cover an application document. */
export type DotAppConsentLink = 'psp' | 'mvr' | 'clearinghouse';

export interface DotAppDocumentDef {
  key: string;
  step: DotAppStepId | 'employer' | 'onboarding';
  /** Fallback title when no template is on file (the template's own title wins). */
  title: string;
  /** Who signs it. `none` = read / acknowledge only. */
  signer: 'driver' | 'employer' | 'none';
  /** The driver ticks the document's own acknowledgement checkbox. */
  ack?: boolean;
  /** Signed already in the Consent Form when this consent is on file: linked, not signed again. */
  consentLink?: DotAppConsentLink;
  /** Only owner-operators / contractors see it. */
  contractorOnly?: boolean;
  /** Supporting text only (e.g. the EEO statement, the opt-in wording): never signed, never blocks. */
  textOnly?: boolean;
  /**
   * Added after the first approved sets (2026-10-27). While a company has no approved version the
   * driver sees "Awaiting <company> approved document" and it does not block that company's
   * applications — unless the company's own bundled source set carries the document (then the set
   * must be complete before an application is sent).
   */
  addedLater?: boolean;
  /** Signed once per entity (previous employer / trucking school), not once per application. */
  perEntity?: boolean;
}

export const DOT_APP_DOCUMENTS: readonly DotAppDocumentDef[] = [
  { key: 'intelliapp_intro', step: 'personal', title: 'Introduction & EEO statement', signer: 'none', textOnly: true },
  { key: 'optins', step: 'personal', title: 'Email and text-message opt-in wording', signer: 'none', textOnly: true },
  { key: 'emergency', step: 'emergency', title: 'Emergency Contact Information', signer: 'driver' },
  { key: 'license_compliance', step: 'certs', title: 'Certification of Compliance with Driver License Requirements', signer: 'driver' },
  { key: 'violations_cert', step: 'certs', title: 'Certification of Violations', signer: 'driver' },
  { key: 'prev_da', step: 'certs', title: 'Previous Employment – Employee Alcohol & Drug Test Statement', signer: 'driver' },
  { key: 'onduty', step: 'certs', title: 'Driver Statement of On-Duty Hours', signer: 'driver' },
  { key: 'other_work', step: 'certs', title: 'Driver Certification for Other Compensated Work', signer: 'driver' },
  { key: 'fcra_summary', step: 'disclosures', title: 'Federal FCRA Summary of Rights Acknowledgment', signer: 'none', ack: true },
  { key: 'ny23a', step: 'disclosures', title: 'New York State Article 23-A Notice', signer: 'none', ack: true },
  { key: 'psp', step: 'disclosures', title: 'PSP Disclosure and Authorization', signer: 'driver', ack: true, consentLink: 'psp' },
  { key: 'fcra_disclosure', step: 'disclosures', title: 'FCRA Disclosure for Consumer Reports', signer: 'driver', ack: true, consentLink: 'mvr' },
  { key: 'fcra_authorization', step: 'disclosures', title: 'FCRA Authorization for Consumer Reports', signer: 'driver', ack: true, consentLink: 'mvr' },
  { key: 'emp_verification', step: 'disclosures', title: 'Employment Verification Acknowledgment and Release', signer: 'driver', ack: true },
  { key: 'clearinghouse_ongoing', step: 'disclosures', title: 'Clearinghouse Consent for Limited Queries', signer: 'driver', ack: true, consentLink: 'clearinghouse' },
  { key: 'fcra_1681m', step: 'disclosures', title: '1681m', signer: 'none', ack: true },
  { key: 'icr', step: 'disclosures', title: 'Investigative Consumer Report Disclosure', signer: 'none', ack: true },
  { key: 'fcra_disclosure_entity', step: 'disclosures', title: 'FCRA Disclosure for Consumer Reports — per employer / school', signer: 'driver', ack: true, perEntity: true, addedLater: true },
  { key: 'fcra_authorization_entity', step: 'disclosures', title: 'FCRA Authorization for Consumer Reports — per employer / school', signer: 'driver', ack: true, perEntity: true, addedLater: true },
  { key: 'sph_request', step: 'disclosures', title: 'Safety Performance History Records Request', signer: 'driver' },
  { key: 'clearinghouse_single', step: 'disclosures', title: 'General Consent for Limited Queries of the Clearinghouse', signer: 'driver', consentLink: 'clearinghouse' },
  { key: 'user_copy', step: 'disclosures', title: 'User Requested Copy', signer: 'none', textOnly: true },
  { key: 'da_receipt', step: 'policies', title: 'Alcohol and Drug Employee’s Certified Receipt', signer: 'driver' },
  { key: 'ic_ack', step: 'policies', title: 'Independent Contractor’s Acknowledgement Form', signer: 'driver' },
  { key: 'employee_ack', step: 'policies', title: 'Employee Acknowledgement Form', signer: 'driver' },
  { key: 'handbook_ack', step: 'policies', title: 'Acknowledgement Receipt — Employee Handbook', signer: 'driver' },
  { key: 'video_consent', step: 'policies', title: 'Video Consent and Release Policy', signer: 'driver' },
  { key: 'w9', step: 'contractor', title: 'Form W-9', signer: 'driver', contractorOnly: true },
  { key: 'ach_debit', step: 'contractor', title: 'Consumer Authorization for Direct Payment via ACH (ACH Debits)', signer: 'driver', contractorOnly: true, addedLater: true },
  { key: 'occ_accident', step: 'contractor', title: 'Occupational Accident Insurance Enrollment', signer: 'driver', contractorOnly: true },
  { key: 'app_signature', step: 'review', title: 'Application Signature', signer: 'driver' },
  { key: 'safety_training', step: 'onboarding', title: 'Driver Safety Training', signer: 'employer' },
];

export const DOT_APP_DOCUMENT_KEYS = DOT_APP_DOCUMENTS.map((d) => d.key);
export function dotAppDocument(key: string): DotAppDocumentDef | undefined {
  return DOT_APP_DOCUMENTS.find((d) => d.key === key);
}

/** The documents the motor carrier signs inside Safety review (never shown to the driver). */
export const DOT_APP_EMPLOYER_SIGNATURES = ['emp_annual', 'emp_da', 'emp_prevda', 'emp_onduty', 'emp_oa', 'emp_training', 'emp_training_driver'] as const;
export type DotAppEmployerSignature = (typeof DOT_APP_EMPLOYER_SIGNATURES)[number];
/** The template each employer signature belongs to (its version is recorded on the signature). */
export const DOT_APP_EMPLOYER_SIGNATURE_DOC: Readonly<Record<DotAppEmployerSignature, string>> = {
  emp_annual: 'violations_cert',
  emp_da: 'da_receipt',
  emp_prevda: 'prev_da',
  emp_onduty: 'other_work',
  emp_oa: 'occ_accident',
  emp_training: 'safety_training',
  /** The DRIVER's own signature on Driver Safety Training, given in person on the Safety screen. */
  emp_training_driver: 'safety_training',
};
/** Signatures given on the Safety screen whose signer is the driver (in person), not the carrier. */
export const DOT_APP_IN_PERSON_DRIVER_SIGNATURES: readonly string[] = ['emp_training_driver'];

/** A signature key for one Safety Performance History request (one per previous employer). */
export function sphSignatureKey(employerId: string): string {
  return `sph_${employerId}`;
}
/** The 391.23 Request/Consent for one previous employer (WB-app pp.21–22: the employer in the box). */
export function evSignatureKey(employerId: string): string {
  return `ev_${employerId}`;
}
/** The FCRA Disclosure / Authorization for one employer or trucking school (WB-app pp.26–29). */
export function fcraDisclosureKey(entityId: string): string {
  return `fcrad_${entityId}`;
}
export function fcraAuthorizationKey(entityId: string): string {
  return `fcraa_${entityId}`;
}
/** The template a signature key is signed against (sph_<id> → sph_request, emp_* → its form). */
export function signatureDocKey(signatureKey: string): string {
  if (signatureKey.startsWith('sph_')) return 'sph_request';
  if (signatureKey.startsWith('ev_')) return 'emp_verification';
  if (signatureKey.startsWith('fcrad_')) return 'fcra_disclosure_entity';
  if (signatureKey.startsWith('fcraa_')) return 'fcra_authorization_entity';
  return DOT_APP_EMPLOYER_SIGNATURE_DOC[signatureKey as DotAppEmployerSignature] ?? signatureKey;
}

/** Upload slots on the Documents step. */
export const DOT_APP_UPLOAD_SLOTS = ['cdl_front', 'cdl_back', 'med_card', 'twic', 'registration', 'other'] as const;
export type DotAppUploadSlot = (typeof DOT_APP_UPLOAD_SLOTS)[number];
export const DOT_APP_UPLOAD_LABELS: Readonly<Record<DotAppUploadSlot, string>> = {
  cdl_front: 'CDL — front',
  cdl_back: 'CDL — back',
  med_card: 'DOT medical card',
  twic: 'TWIC card',
  registration: 'Truck registration',
  other: 'Other document (optional)',
};
/** 15 MB per file (owner brief §4). JPEG, PNG, HEIC or PDF; checked on the server by content. */
export const DOT_APP_MAX_UPLOAD_BYTES = 15 * 1024 * 1024;
export const DOT_APP_UPLOAD_TYPES = ['image/jpeg', 'image/png', 'image/heic', 'image/heif', 'application/pdf'] as const;
export const DOT_APP_MAX_SIGNATURE_BYTES = 512 * 1024;
