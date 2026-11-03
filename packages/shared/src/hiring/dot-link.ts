import { z } from 'zod';
import type { DotApplicationDraftForm, DotSection, DotSectionState } from './dot-application-draft.js';

/**
 * The DOT application sent to the driver (owner, 2026-10-07): one private link the driver opens on
 * a phone, fills in, submits and uses to upload the CDL. Everything lands on the candidate in the
 * TMS. The raw token is shown once to the recruiter and never stored; the server keeps its digest.
 */

/** How long a link works after it is created. */
export const DOT_LINK_TTL_DAYS = 14;

/** The token in a link: 32 random bytes, base64url. Anything else is refused before the database. */
export const DOT_LINK_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

/** The one answer for an unknown, expired or turned-off link, so a token cannot be probed. */
export const DOT_LINK_GONE_MESSAGE =
  'This link has expired or was turned off. Contact your recruiter for a new one.';

/** The largest DOT application body the public page may send (the form is a few kilobytes). */
export const DOT_LINK_MAX_SAVE_BYTES = 256 * 1024;

export type DotLinkState = 'live' | 'expired' | 'revoked';

/** The recruiter's view of the latest link on a case. Never carries the token. */
export interface DotLinkStatus {
  id: string;
  state: DotLinkState;
  createdAt: string;
  createdByName: string;
  expiresAt: string;
  revokedAt: string | null;
  revokedBy: string | null;
  firstOpenedAt: string | null;
  lastOpenedAt: string | null;
  lastSavedAt: string | null;
  submittedAt: string | null;
  cdlUploadedAt: string | null;
  /** Where the application itself stands, so the line can say "needs review" / "accepted" / "returned". */
  applicationStatus: 'draft' | 'driver_submitted' | 'submitted' | null;
  certifiedAt: string | null;
  acceptedAt: string | null;
  acceptedBy: string | null;
  returnedAt: string | null;
  returnedBy: string | null;
}

/** A CDL file the driver sent before acceptance, kept against the case until it is filed. */
export interface DotLinkStagedFile {
  id: string;
  code: DotLinkDocumentCode;
  label: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  expiresOn: string | null;
  uploadedAt: string;
  /** Set once Accept filed it into the candidate's documents. */
  filedAt: string | null;
  filedDocumentId: string | null;
}

/** "Return to driver": the note says what to fix; the driver must certify again. */
export const ReturnDotApplicationSchema = z.object({
  note: z.string().trim().min(3, 'Say what the driver should fix').max(1000),
});
export type ReturnDotApplicationInput = z.input<typeof ReturnDotApplicationSchema>;

/** Failed token lookups one address may make before every link route refuses it for a while. */
export const DOT_LINK_MISSES_ALLOWED = 20;
export const DOT_LINK_MISS_WINDOW_MS = 10 * 60_000;

/** Returned once, when the link is made. */
export interface DotLinkCreated {
  url: string;
  expiresAt: string;
  link: DotLinkStatus;
}

/** Codes the driver may upload through the link. */
export const DOT_LINK_DOCUMENT_CODES = ['cdl', 'cdl_back'] as const;
export type DotLinkDocumentCode = (typeof DOT_LINK_DOCUMENT_CODES)[number];
export const DOT_LINK_DOCUMENT_LABELS: Readonly<Record<DotLinkDocumentCode, string>> = {
  cdl: 'CDL — front',
  cdl_back: 'CDL — back',
};

/** File types a driver may send: a photo or a PDF, judged by the bytes on the server. */
export const DOT_LINK_FILE_TYPES = ['image/jpeg', 'image/png', 'application/pdf'] as const;

export const DotLinkDocumentUploadSchema = z.object({
  code: z.enum(DOT_LINK_DOCUMENT_CODES),
  fileName: z.string().trim().min(1).max(255),
  /** The file, base64 (a `data:` URL prefix is accepted). */
  content: z.string().min(1),
  /** Only needed when the licences section has no expiry date. */
  expiresOn: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'Expected YYYY-MM-DD')
    .nullish(),
});
export type DotLinkDocumentUploadInput = z.input<typeof DotLinkDocumentUploadSchema>;
export type DotLinkDocumentUpload = z.infer<typeof DotLinkDocumentUploadSchema>;

/** What the driver's page is drawn from. No SSN, no ids, nothing from another case. */
export interface PublicDotApplication {
  companyName: string;
  firstName: string;
  lastName: string;
  /** null until anything has been saved; the page then starts from the candidate's name. */
  form: DotApplicationDraftForm | null;
  hasSsn: boolean;
  ssnLast4: string | null;
  /** From the candidate record, read-only on the page. */
  contact: { email: string | null; phone: string | null; location: string | null };
  sections: { section: DotSection; label: string; state: DotSectionState }[];
  /** driver_submitted: certified by the driver, waiting for the recruiter. */
  status: 'draft' | 'driver_submitted' | 'submitted';
  /** When the driver certified it (null while a draft). */
  certifiedAt: string | null;
  /** A recruiter sent it back: what to fix, and when. Shown until the driver certifies again. */
  returnNote: string | null;
  returnedAt: string | null;
  updatedAt: string | null;
  cdlUploaded: boolean;
  cdlBackUploaded: boolean;
  /** The latest licence expiry in the licences section, used for the CDL upload. */
  cdlExpiresOn: string | null;
  expiresAt: string;
}

/** The licence expiry a CDL upload carries: the latest one the driver entered. */
export function cdlExpiryFromForm(form: Pick<DotApplicationDraftForm, 'licenses'> | null): string | null {
  if (!form) return null;
  const dates = form.licenses.map((l) => l.expiresOn).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d));
  if (dates.length === 0) return null;
  dates.sort();
  return dates[dates.length - 1] ?? null;
}
