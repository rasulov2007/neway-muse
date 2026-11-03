import { z } from 'zod';

/**
 * The personal driver application (owner brief, 2026-10-08).
 *
 * Recruiting issues one private link per lead or candidate; the driver fills the approved
 * five-step NORTHWIND FREIGHT application (served by the TMS at /application/) and the page posts a
 * multipart form to the same-origin `/api/applications`. The server resolves the candidate from
 * the token alone, validates every field, file and drawn signature, and answers
 * `{ tmsSaved: true, reference }` only after the application, its documents and each
 * authorization are committed.
 *
 * These are the field rules of that page, field for field (names, required, lengths, choices),
 * so the server refuses exactly what the page would refuse.
 */

export const DRIVER_APPLICATION_SCHEMA_VERSION = 'nwf-application-v1';
export const DRIVER_APPLICATION_TTL_DAYS = 14;
/** One selected document (CDL front/back, medical card): JPEG, PNG or PDF up to 8 MiB. */
export const DRIVER_APPLICATION_MAX_FILE_BYTES = 8 * 1024 * 1024;
/** One drawn signature PNG, decoded. The page draws a 640×140 canvas: tens of kilobytes. */
export const DRIVER_APPLICATION_MAX_SIGNATURE_BYTES = 512 * 1024;
/** The whole multipart request: three documents, the JSON with two signatures, the fields. */
export const DRIVER_APPLICATION_MAX_REQUEST_BYTES = 27 * 1024 * 1024;

export const DRIVER_APPLICATION_FILE_FIELDS = ['cdlFront', 'cdlBack', 'medicalCard'] as const;
export type DriverApplicationFileField = (typeof DRIVER_APPLICATION_FILE_FIELDS)[number];
/** The qualification-file requirement each upload is filed under (pending Safety's review). */
export const DRIVER_APPLICATION_FILE_CODES: Readonly<Record<DriverApplicationFileField, 'cdl' | 'cdl_back' | 'medical_card'>> = {
  cdlFront: 'cdl',
  cdlBack: 'cdl_back',
  medicalCard: 'medical_card',
};
export const DRIVER_APPLICATION_FILE_LABELS: Readonly<Record<string, string>> = {
  cdl: 'CDL — front',
  cdl_back: 'CDL — back',
  medical_card: 'Medical card',
};

export const DRIVER_AUTHORIZATION_TYPES = ['mvr', 'psp'] as const;
export type DriverAuthorizationType = (typeof DRIVER_AUTHORIZATION_TYPES)[number];
export const DRIVER_AUTHORIZATION_LABELS: Readonly<Record<DriverAuthorizationType, string>> = {
  mvr: 'MVR — driving record authorization',
  psp: 'PSP — pre-employment screening',
};

const CDL_CLASSES = ['Class A', 'Class B', 'Other'] as const;
const EXPERIENCE = ['Less than 6 months', '6–12 months', '1–2 years', '2–5 years', '5+ years'] as const;
const POSITIONS = ['Company driver', 'Lease operator', 'Owner operator'] as const;
const PREFERENCES = ['Solo', 'Team', 'Either'] as const;
const COUNTS = ['0', '1', '2+'] as const;
const YES_NO = ['No', 'Yes'] as const;
const SOURCES = ['Direct link', 'Instagram', 'Referral', 'Other'] as const;

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Enter a date');
const isoMonth = z.string().regex(/^\d{4}-\d{2}$/, 'Enter a month');
const required = (max: number, message = 'This field is required') => z.string().trim().min(1, message).max(max, `Up to ${max} characters`);
const optional = (max: number) =>
  z
    .string()
    .trim()
    .max(max, `Up to ${max} characters`)
    .optional()
    .transform((v) => (v ? v : null));
const choice = <T extends readonly [string, ...string[]]>(values: T) => z.enum(values, { message: 'Choose one of the options' });
const optionalDate = (schema: z.ZodString) =>
  z
    .string()
    .trim()
    .optional()
    .transform((v) => (v ? v : null))
    .pipe(schema.nullable());

/** The answers, as the page names them. Unknown fields are refused, not ignored. */
export const DriverApplicationFieldsSchema = z
  .object({
    firstName: required(80),
    lastName: required(80),
    phone: z.string().trim().min(7, 'Enter a phone number').max(30, 'Up to 30 characters'),
    email: z.string().trim().max(150, 'Up to 150 characters').pipe(z.email('Enter a valid email')),
    address: required(200),
    city: required(80),
    stateZip: required(50),
    cdlClass: choice(CDL_CLASSES),
    cdlState: required(40),
    cdlExpiration: isoDate,
    ssn: z
      .string()
      .trim()
      .regex(/^\d{3}-?\d{2}-?\d{4}$/, 'Enter a 9-digit SSN'),
    medicalExpiration: isoDate,
    experience: choice(EXPERIENCE),
    endorsements: optional(150),
    position: choice(POSITIONS),
    preference: choice(PREFERENCES),
    startDate: optionalDate(isoDate),
    routes: optional(150),
    employer: required(150),
    employmentStart: optionalDate(isoMonth),
    employmentEnd: optionalDate(isoMonth),
    leavingReason: optional(1000),
    accidents: choice(COUNTS),
    violations: choice(COUNTS),
    suspended: choice(YES_NO),
    source: choice(SOURCES).optional().transform((v) => v ?? null),
    details: optional(2000),
    consent: z.literal('on', { message: 'Confirm the statement before sending' }),
    submissionKey: z.uuid('Missing submission key'),
    applicationToken: z.string().min(1, 'Missing application link'),
    schemaVersion: z.literal(DRIVER_APPLICATION_SCHEMA_VERSION, { message: 'This page is out of date. Reload it and try again.' }),
    authorizations: z.string().max(3 * 1024 * 1024, 'The authorizations are too large'),
  })
  .strict();
export type DriverApplicationFieldsInput = z.input<typeof DriverApplicationFieldsSchema>;
export type DriverApplicationFields = z.infer<typeof DriverApplicationFieldsSchema>;

/** One authorization as the page sends it: declined, or signed with the drawn image. */
export const DriverAuthorizationDeclinedSchema = z.object({ authorized: z.literal(false) }).strict();
export const DriverAuthorizationSignedSchema = z
  .object({
    authorized: z.literal(true),
    name: z.string().min(3).max(170),
    signature: z.string().min(3).max(170),
    signatureMethod: z.literal('drawn'),
    drawing: z.string().startsWith('data:image/png;base64,', 'The drawn signature is missing').max(1_000_000),
    signedAt: z.string().max(40),
    electronicSignature: z.literal(true),
    disclosureOpened: z.boolean(),
    documentType: z.enum(DRIVER_AUTHORIZATION_TYPES),
    disclosureText: z.string().max(20_000),
    disclosureSha256: z.string().regex(/^[0-9a-f]{64}$/),
    disclosureVersion: z.string().max(80),
  })
  .strict();
export const DriverAuthorizationsSchema = z
  .object({
    mvr: z.union([DriverAuthorizationDeclinedSchema, DriverAuthorizationSignedSchema]).optional(),
    psp: z.union([DriverAuthorizationDeclinedSchema, DriverAuthorizationSignedSchema]).optional(),
  })
  .strict();
export type DriverAuthorizations = z.infer<typeof DriverAuthorizationsSchema>;

/** The acknowledgement the page shows only when `tmsSaved` is true and the reference is set. */
export interface DriverApplicationAck {
  tmsSaved: true;
  reference: string;
}

// ------------------------------------------------------------------------- the staff's side

export type DriverApplicationSessionState = 'live' | 'expired' | 'revoked' | 'submitted';

export interface DriverApplicationSessionView {
  id: string;
  state: DriverApplicationSessionState;
  createdAt: string;
  createdByName: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  /** Recruiter copied the link (copying is not sending). */
  linkCopiedAt: string | null;
  linkCopiedBy: string | null;
  /** Recruiter said they sent it by hand ("Mark as sent"). */
  markedSentAt: string | null;
  markedSentBy: string | null;
  markedSentChannel: string | null;
  submittedAt: string | null;
}

export interface DriverApplicationLinkIssued {
  /** The personal link, shown once: only its fingerprint is kept. */
  url: string;
  expiresAt: string;
  /** The candidate key the page should use afterwards. */
  key: string;
  session: DriverApplicationSessionView;
}

export interface DriverApplicationFileView {
  id: string;
  code: 'cdl' | 'cdl_back' | 'medical_card';
  label: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedAt: string;
  /** The qualification-file document it was filed as (pending Safety's review), once filed. */
  documentId: string | null;
  documentStatus: string | null;
}

export interface DriverAuthorizationView {
  type: DriverAuthorizationType;
  label: string;
  /** signed · declined · not_provided */
  decision: 'signed' | 'declined' | 'not_provided';
  id: string | null;
  signerName: string | null;
  /** What the driver's device said, kept as claimed; never authoritative. */
  clientSignedAt: string | null;
  /** When the server received and committed it. */
  receivedAt: string | null;
  disclosureVersion: string | null;
  disclosureSha256: string | null;
  disclosureOpenedClaim: boolean | null;
  hasSignatureImage: boolean;
}

export interface DriverApplicationSubmissionView {
  id: string;
  reference: string;
  receivedAt: string;
  via: 'same_origin' | 'forwarder';
  schemaVersion: string;
  answers: { key: string; label: string; value: string }[];
  ssnMasked: string | null;
  files: DriverApplicationFileView[];
  authorizations: DriverAuthorizationView[];
}

export interface DriverApplicationView {
  session: DriverApplicationSessionView | null;
  submission: DriverApplicationSubmissionView | null;
}

export const MarkApplicationSentSchema = z.object({
  channel: z
    .string()
    .trim()
    .max(40)
    .nullish()
    .transform((v) => v || null),
});
export type MarkApplicationSentRequest = z.infer<typeof MarkApplicationSentSchema>;

/** The labels the TMS shows the answers under, in the page's order. */
export const DRIVER_APPLICATION_ANSWER_LABELS: readonly (readonly [string, string])[] = [
  ['firstName', 'First name'],
  ['lastName', 'Last name'],
  ['phone', 'Phone'],
  ['email', 'Email'],
  ['address', 'Street address'],
  ['city', 'City'],
  ['stateZip', 'State / ZIP'],
  ['cdlClass', 'CDL class'],
  ['cdlState', 'Issuing state'],
  ['cdlExpiration', 'CDL expiration'],
  ['medicalExpiration', 'Medical card expiration'],
  ['experience', 'Driving experience'],
  ['endorsements', 'Endorsements'],
  ['position', 'Position'],
  ['preference', 'Driving preference'],
  ['startDate', 'Available start date'],
  ['routes', 'Preferred routes'],
  ['employer', 'Most recent employer'],
  ['employmentStart', 'Employment start'],
  ['employmentEnd', 'Employment end'],
  ['leavingReason', 'Reason for leaving'],
  ['accidents', 'Accidents in last 3 years'],
  ['violations', 'Moving violations in last 3 years'],
  ['suspended', 'License suspended in last 3 years'],
  ['source', 'How they found us'],
  ['details', 'Additional details'],
];
