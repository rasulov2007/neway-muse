import { z } from 'zod';
import { WorkAuthorizationKindSchema } from './work-authorization.js';

/**
 * What a licence and a medical certificate say, as structured data.
 *
 * The roster already holds the four facts dispatch runs on — state, class, endorsements, expiry —
 * and those stay where they are. This is everything *else* printed on the two cards: the legal
 * name as it appears on the licence, the date of birth, the licence number, restrictions, the
 * medical examiner's certificate number. Safety needs them for a file; nobody needs them twice.
 *
 * It hangs off the document it was read from, which is what makes it evidence rather than
 * assertion: the extract and the photograph it came from cannot drift apart, and replacing the
 * card replaces both.
 *
 * `needsReview` names the fields the reader was unsure of. A licence photographed at an angle
 * gives up a date of birth the machine half-read; marking it is the difference between a person
 * checking one field and a person re-reading the whole card.
 */

export const CDL_RESTRICTION_CODES = ['B', 'E', 'K', 'L', 'M', 'N', 'O', 'V', 'Z'] as const;

export const CdlExtractSchema = z.object({
  legalFirstName: z.string().trim().max(60).nullable().default(null),
  legalMiddleName: z.string().trim().max(60).nullable().default(null),
  legalLastName: z.string().trim().max(60).nullable().default(null),
  /** Date only. Assembled from the digits on the card; never parsed through a time zone. */
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  cdlNumber: z.string().trim().max(30).nullable().default(null),
  issuingState: z.string().trim().length(2).toUpperCase().nullable().default(null),
  cdlClass: z.enum(['A', 'B', 'C']).nullable().default(null),
  cdlIssuedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  cdlExpiresOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  endorsements: z.array(z.string().trim().max(3)).max(8).default([]),
  restrictions: z.array(z.string().trim().max(3)).max(8).default([]),
  medicalIssuedOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  medicalExpiresOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .default(null),
  medicalCertificateNumber: z.string().trim().max(40).nullable().default(null),
  medicalExaminerName: z.string().trim().max(80).nullable().default(null),
  /** Field names the reader was unsure of, for the screen to mark and a person to check. */
  needsReview: z.array(z.string().max(40)).max(20).default([]),
  /** Where the values came from, so a hand-typed file is never mistaken for a read one. */
  source: z.enum(['ocr', 'manual']).default('manual'),
  /**
   * On a Work authorization document only: which of the four papers it is (owner, 2026-10-26).
   * Absent on every licence and medical card.
   */
  workAuthorizationKind: WorkAuthorizationKindSchema.nullish(),
});
export type CdlExtract = z.infer<typeof CdlExtractSchema>;

/** The fields a CDL file is expected to carry, in the order the template shows them. */
export const CDL_EXTRACT_FIELDS = [
  'legalFirstName',
  'legalMiddleName',
  'legalLastName',
  'dateOfBirth',
  'cdlNumber',
  'issuingState',
  'cdlClass',
  'cdlIssuedOn',
  'cdlExpiresOn',
  'endorsements',
  'restrictions',
  'medicalIssuedOn',
  'medicalExpiresOn',
  'medicalCertificateNumber',
  'medicalExaminerName',
  'medicalStatus',
] as const;
export type CdlExtractField = (typeof CDL_EXTRACT_FIELDS)[number];

export const CDL_EXTRACT_LABEL: Record<CdlExtractField, string> = {
  legalFirstName: 'Legal first name',
  legalMiddleName: 'Legal middle name',
  legalLastName: 'Legal last name',
  dateOfBirth: 'Date of birth',
  cdlNumber: 'CDL number',
  issuingState: 'Issuing state',
  cdlClass: 'CDL class',
  cdlIssuedOn: 'CDL issued',
  cdlExpiresOn: 'CDL expires',
  endorsements: 'Endorsements',
  restrictions: 'Restrictions',
  medicalIssuedOn: 'Medical card issued',
  medicalExpiresOn: 'Medical card expires',
  medicalCertificateNumber: 'Medical certificate number',
  medicalExaminerName: 'Medical examiner',
  medicalStatus: 'Medical status',
};

/** An empty template: every field null, nothing claimed. */
export function emptyCdlExtract(): CdlExtract {
  return CdlExtractSchema.parse({});
}
