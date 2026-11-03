import type { ComplianceDocument } from '@neway/shared';

/** The requirement code of a trailer's annual DOT inspection certificate. */
export const TRAILER_ANNUAL_INSPECTION = 'trailer_annual_inspection';

export interface NextTrailerInspection {
  /** The date the trailer's next annual inspection is due, or null when nothing says. */
  date: string | null;
  /** Where the date came from: the filed certificate, the trailer's own field, or nowhere. */
  source: 'document' | 'column' | null;
}

/**
 * When a trailer's next annual inspection is due.
 *
 * Two places can say: the `next_inspection_date` typed on the trailer, and the expiry of the
 * annual inspection certificate filed on its Documents tab. The certificate is the evidence, and
 * a trailer whose certificate is on file must not be asked for the date again (owner, 2026-10-08:
 * trailers 534263 and 904502 showed "—" with a certificate on file). So the later of the two wins;
 * an older certificate never hides a newer typed date, and vice versa.
 *
 * Only the current certificate counts: the newest version that was not rejected and carries an
 * expiry date. A rejected (voided) file says nothing; a deleted one is not in the list at all.
 */
export function nextTrailerInspection(
  columnDate: string | null | undefined,
  documents: readonly Pick<
    ComplianceDocument,
    'requirementCode' | 'status' | 'expiresOn' | 'version' | 'uploadedAt'
  >[],
): NextTrailerInspection {
  let current: (typeof documents)[number] | null = null;
  for (const doc of documents) {
    if (doc.requirementCode !== TRAILER_ANNUAL_INSPECTION) continue;
    if (doc.status === 'rejected' || !doc.expiresOn) continue;
    if (
      !current ||
      doc.version > current.version ||
      (doc.version === current.version && doc.uploadedAt > current.uploadedAt)
    ) {
      current = doc;
    }
  }
  const fromDocument = current?.expiresOn ?? null;
  const fromColumn = columnDate || null;
  if (fromDocument && (!fromColumn || fromDocument >= fromColumn)) {
    return { date: fromDocument, source: 'document' };
  }
  if (fromColumn) return { date: fromColumn, source: 'column' };
  return { date: null, source: null };
}
