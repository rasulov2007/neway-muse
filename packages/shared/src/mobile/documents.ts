import { z } from 'zod';

/**
 * The driver's own qualification papers in the app (mobile M3, docs/mobile/API.md §13).
 *
 * What a driver may send is a short list (their CDL front and back, medical card, work
 * authorization, photo). An upload is a `compliance_documents` row, `pending_review`, source
 * `driver_portal`, superseding the previous version (kept): Safety verifies or rejects it in the
 * existing qualification-file screens. Reminders are computed from the stored expiry dates.
 */

export const DRIVER_APP_DOCUMENT_CODES = ['cdl', 'cdl_back', 'medical_card', 'work_authorization', 'driver_photo'] as const;
export type DriverAppDocumentCode = (typeof DRIVER_APP_DOCUMENT_CODES)[number];

export const DRIVER_APP_DOCUMENT_LABEL: Record<DriverAppDocumentCode, string> = {
  cdl: 'CDL (front)',
  cdl_back: 'CDL (back)',
  medical_card: 'Medical card',
  work_authorization: 'Work authorization',
  driver_photo: 'Driver photo',
};

/** Reminders start this many days before a stored expiry. */
export const DRIVER_DOCUMENT_REMINDER_DAYS = 30;

export const DriverDocumentCreateSchema = z
  .object({
    type: z.enum(DRIVER_APP_DOCUMENT_CODES),
    /** From POST /driver/files (photo or PDF). */
    fileId: z.string().min(1),
    expiresOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    issuedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable().optional(),
    note: z.string().trim().max(1000).nullable().optional(),
  })
  .strict();
export type DriverDocumentCreateInput = z.input<typeof DriverDocumentCreateSchema>;

export const DRIVER_QUAL_DOC_STATES = ['missing', 'pending_review', 'verified', 'rejected', 'expired'] as const;
export type DriverQualDocState = (typeof DRIVER_QUAL_DOC_STATES)[number];
export const DRIVER_QUAL_DOC_STATE_LABEL: Record<DriverQualDocState, string> = {
  missing: 'Not on file',
  pending_review: 'Received · Safety is reviewing',
  verified: 'Verified',
  rejected: 'Rejected',
  expired: 'Expired',
};

export interface DriverDocumentReminder {
  /** expiring (within the reminder window) · expired */
  kind: 'expiring' | 'expired';
  daysLeft: number;
  text: string;
}

export interface DriverQualificationDocument {
  type: DriverAppDocumentCode;
  label: string;
  state: DriverQualDocState;
  stateLabel: string;
  documentId: string | null;
  fileName: string | null;
  version: number | null;
  uploadedAt: string | null;
  source: string | null;
  expiresOn: string | null;
  rejectionReason: string | null;
  reminder: DriverDocumentReminder | null;
  /** Earlier versions kept on file, newest first. */
  previous: Array<{ documentId: string; version: number; status: string; uploadedAt: string }>;
}

export interface DriverDocumentList {
  today: string;
  documents: DriverQualificationDocument[];
  reminders: Array<DriverDocumentReminder & { type: DriverAppDocumentCode; label: string }>;
}
