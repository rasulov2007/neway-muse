import { Alert } from '@/design-system';
import { UNIT_DOCUMENT_SLOTS } from '../unit-documents';
import { FileDropzone } from './FileDropzone';
import {
  MISSING_DOCUMENTS_CONSEQUENCE,
  missingRequiredDocuments,
  type UnitDocumentFiles,
} from './unit-creation-documents';

/**
 * The paperwork a unit is created with: the required documents first, the rest offered under
 * them. Nothing here is demanded, but the form says plainly, before saving, what creating the
 * unit without its registration and inspection means.
 */

/** The plain warning shown before saving, naming what is missing. It never blocks the submit. */
export function MissingDocumentsWarning({
  scope,
  files,
}: {
  scope: 'truck' | 'trailer';
  files: UnitDocumentFiles;
}) {
  const missing = missingRequiredDocuments(scope, files);
  if (missing.length === 0) return null;
  return (
    <Alert
      tone="warning"
      data-testid="missing-documents-warning"
      title={`Missing: ${missing.map((slot) => slot.name).join(', ')}`}
      description={`${MISSING_DOCUMENTS_CONSEQUENCE[scope]}. You can attach it now, or create the unit and attach it from its Documents tab.`}
    />
  );
}

/** The Documents section of a creation form: one dropzone per document the unit should carry. */
export function UnitCreationDocuments({
  scope,
  files,
  onFile,
  disabled,
}: {
  scope: 'truck' | 'trailer';
  files: UnitDocumentFiles;
  onFile: (code: string, file: File | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
      {UNIT_DOCUMENT_SLOTS[scope].map((slot) => (
        <FileDropzone
          key={slot.code}
          title={slot.name}
          subtitle={slot.subtitle}
          actionLabel={`Attach ${slot.name.toLowerCase()}`}
          file={files[slot.code] ?? null}
          onFile={(file) => onFile(slot.code, file)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
