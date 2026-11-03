import { toBase64 } from '@/features/operations/credential-ocr';
import { uploadComplianceDocument } from '@/features/safety/compliance-api';
import {
  UNIT_DOCUMENT_SLOTS,
  requiredUnitDocumentSlots,
  type UnitDocumentSlot,
} from '../unit-documents';

/**
 * The files a creation form has collected, and what becomes of them.
 *
 * A unit created with no registration and no annual inspection is out of service from its first
 * day, and nobody finds out until dispatch tries to use it. So the creation form asks while the
 * folder is open. None of it is demanded — the unit exists either way — and the files go up
 * after the unit is created, because a document needs the unit's id.
 */

/** The file attached for each requirement code, by code. */
export type UnitDocumentFiles = Record<string, File | null>;

/** The required slots with no file attached, in catalog order. */
export function missingRequiredDocuments(
  scope: 'truck' | 'trailer',
  files: UnitDocumentFiles,
): UnitDocumentSlot[] {
  return requiredUnitDocumentSlots(scope).filter((slot) => !files[slot.code]);
}

/** What creating the unit without its required paperwork means, in the owner's words. */
export const MISSING_DOCUMENTS_CONSEQUENCE: Record<'truck' | 'trailer', string> = {
  trailer:
    "Without a registration and a current annual inspection, this trailer will be created out of service and can't be dispatched",
  truck:
    "Without a registration, a current annual inspection and proof of insurance, this truck will be created out of service and can't be dispatched",
};

/**
 * Uploads the attached files against the unit that was just created.
 *
 * Returns the names of the documents that did not make it. The unit exists either way, so a
 * failure here is reported as "the registration did not upload", never as a failed creation.
 */
export async function uploadUnitDocuments({
  scope,
  ownerId,
  ownerLabel,
  files,
  expiresOn = {},
}: {
  scope: 'truck' | 'trailer';
  ownerId: string;
  ownerLabel: string;
  files: UnitDocumentFiles;
  /** Expiry per requirement code, when the form already asked for the date. */
  expiresOn?: Record<string, string | undefined>;
}): Promise<string[]> {
  const failed: string[] = [];
  for (const slot of UNIT_DOCUMENT_SLOTS[scope]) {
    const file = files[slot.code];
    if (!file) continue;
    try {
      await uploadComplianceDocument({
        ownerType: scope,
        ownerId,
        ownerLabel,
        requirementCode: slot.code,
        title: `${slot.name} — ${ownerLabel}`,
        fileName: file.name,
        contentType: file.type || 'application/pdf',
        sizeBytes: file.size,
        issuedOn: null,
        expiresOn: expiresOn[slot.code] ?? null,
        notes: 'Attached when the unit was created.',
        content: await toBase64(file),
      });
    } catch {
      failed.push(slot.name);
    }
  }
  return failed;
}
