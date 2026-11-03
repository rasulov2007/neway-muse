/**
 * Planning a document import from Ditat.
 *
 * Pure, like the other planners: the caller reads what is on file, hands it here with the list
 * Ditat returned, and downloads and writes exactly what comes back.
 *
 * What is actually there, counted against the live account on 2026-09-25:
 *
 *   drivers   0 documents   (all 120 driving drivers, none)
 *   trailers  0 documents   (all 161, none)
 *   trucks   80 documents   across 46 of 185 units — 19 `DOT Inspections`, 61 `Repairs`
 *
 * So this import is about trucks. The earlier note in `docs/decisions/0003` projected thousands of
 * driver files from a sample; the sample was wrong and the count above replaces it.
 *
 * Only a folder with an honest home here is imported. `DOT Inspections` is the annual inspection
 * this product already has a requirement for. `Repairs` is 61 shop invoices, and this product
 * files repair paperwork against a work order, not against a unit — filing them under a
 * compliance requirement would put a tyre invoice where a regulator's inspection belongs. They are
 * reported, with their filenames, for a decision.
 */

export type DocumentOutcome = 'create' | 'unchanged' | 'review' | 'skip';

/** A document as Ditat lists it. */
export interface DitatDocumentRow {
  documentKey: string;
  fileName: string;
  documentFolderId: string;
  /** Ditat's own expiry, when it has one. Frequently absent, and absent is not expired. */
  expireOn?: string | null;
  documentCreatedOn?: string | null;
  fileSize?: number | null;
  pagesCount?: number | null;
}

/** A document already on file here. */
export interface ExistingDocument {
  id: string;
  ownerType: string;
  ownerId: string;
  externalId: string | null;
  sourceSystem: string | null;
}

export interface DocumentPlanRow {
  outcome: DocumentOutcome;
  /** Ditat's document key, as a string. */
  externalId: string;
  ownerType: 'truck' | 'trailer' | 'driver';
  /** The row here this document belongs to. Null when the owner was never imported. */
  ownerId: string | null;
  ownerLabel: string;
  fileName: string;
  folder: string;
  requirementCode: string | null;
  issuedOn: string | null;
  expiresOn: string | null;
  note: string | null;
}

export interface DocumentPlan {
  rows: DocumentPlanRow[];
  counts: Record<DocumentOutcome, number>;
  skippedBy: Record<string, number>;
}

/** Ditat's folder → this product's requirement. A folder not here has no home and is reported. */
export const FOLDER_REQUIREMENTS: Record<string, Record<string, string>> = {
  truck: {
    'DOT Inspections': 'annual_inspection',
    'DOT Annual Inspection': 'annual_inspection',
    Registration: 'registration',
    Title: 'title',
    Insurance: 'insurance_cab_card',
  },
  trailer: {
    'DOT Annual Inspection': 'trailer_annual_inspection',
    'DOT Inspections': 'trailer_annual_inspection',
    Registration: 'trailer_registration',
    Title: 'trailer_title',
  },
  driver: {},
};

function clean(value: string | null | undefined): string {
  return (value ?? '').trim();
}

/** An ISO instant or date down to its calendar day; null for anything unreadable. */
export function dayOf(value: string | null | undefined): string | null {
  const text = clean(value);
  if (!text) return null;
  const day = text.slice(0, 10);
  return /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(day)) ? day : null;
}

export interface DocumentOwner {
  /** Ditat's key for the owner. */
  externalId: string;
  /** The row here, or null when that owner was never imported. */
  id: string | null;
  label: string;
  documents: DitatDocumentRow[];
}

export function planDocuments(
  ownerType: 'truck' | 'trailer' | 'driver',
  owners: DocumentOwner[],
  existing: ExistingDocument[],
): DocumentPlan {
  const filed = new Set(
    existing
      .filter((d) => d.sourceSystem === 'ditat' && d.externalId)
      .map((d) => `${d.ownerType}|${d.externalId}`),
  );
  const requirements = FOLDER_REQUIREMENTS[ownerType] ?? {};
  const seen = new Set<string>();

  const out: DocumentPlanRow[] = [];
  for (const owner of owners) {
    for (const doc of owner.documents) {
      const externalId = String(doc.documentKey ?? '').trim();
      const folder = clean(doc.documentFolderId) || '(no folder)';
      const base: DocumentPlanRow = {
        outcome: 'skip',
        externalId,
        ownerType,
        ownerId: owner.id,
        ownerLabel: owner.label,
        fileName: clean(doc.fileName) || `document ${externalId}`,
        folder,
        requirementCode: null,
        issuedOn: dayOf(doc.documentCreatedOn),
        // A missing expiry is missing, not expired, and nothing is read off the filename to fill it.
        expiresOn: dayOf(doc.expireOn),
        note: null,
      };

      if (!externalId) {
        out.push({ ...base, note: 'The document has no key, so a later run could not recognise it.' });
        continue;
      }
      if (seen.has(externalId)) {
        out.push({ ...base, note: `Document ${externalId} appears twice in this export.` });
        continue;
      }
      seen.add(externalId);

      if (!owner.id) {
        out.push({
          ...base,
          note: `${owner.label} is not on this fleet, so its documents have no owner to hang on.`,
        });
        continue;
      }
      if (filed.has(`${ownerType}|${externalId}`)) {
        out.push({ ...base, outcome: 'unchanged' });
        continue;
      }

      const requirementCode = requirements[folder];
      if (!requirementCode) {
        out.push({
          ...base,
          outcome: 'review',
          note: `Folder "${folder}" has no document type here; this product files that paperwork elsewhere.`,
        });
        continue;
      }

      out.push({ ...base, outcome: 'create', requirementCode });
    }
  }

  const counts: Record<DocumentOutcome, number> = { create: 0, unchanged: 0, review: 0, skip: 0 };
  const skippedBy: Record<string, number> = {};
  for (const row of out) {
    counts[row.outcome] += 1;
    if (row.outcome === 'skip' && row.note) skippedBy[row.note] = (skippedBy[row.note] ?? 0) + 1;
  }
  return { rows: out, counts, skippedBy };
}
