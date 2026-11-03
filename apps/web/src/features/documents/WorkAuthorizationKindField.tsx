import {
  WORK_AUTHORIZATION_CODE,
  WORK_AUTHORIZATION_KINDS,
  WORK_AUTHORIZATION_KIND_LABELS,
  WORK_AUTHORIZATION_KIND_SHORT,
  workAuthorizationKindOf,
  type ComplianceDocument,
  type WorkAuthorizationKind,
} from '@neway/shared';
import { FormField, Select } from '@/design-system';

/** True when the requirement asks which paper the document is. */
export const asksWorkAuthorizationKind = (code: string | null | undefined) => code === WORK_AUTHORIZATION_CODE;

/**
 * The second select a Work authorization needs (owner, 2026-10-26): which of the four papers it
 * is. Required wherever such a document is added or replaced.
 */
export function WorkAuthorizationKindField({
  value,
  onChange,
}: {
  value: WorkAuthorizationKind | '';
  onChange: (next: WorkAuthorizationKind) => void;
}) {
  return (
    <FormField label="Work authorization type" required>
      <Select
        aria-label="Work authorization type"
        placeholder="Choose the document…"
        value={value}
        onValueChange={(next) => onChange(next as WorkAuthorizationKind)}
        options={WORK_AUTHORIZATION_KINDS.map((kind) => ({ value: kind, label: WORK_AUTHORIZATION_KIND_LABELS[kind] }))}
      />
    </FormField>
  );
}

/** "Work authorization · Green Card" when the document says which paper it is, else the name. */
export function documentNameWithKind(name: string, document: ComplianceDocument | null | undefined): string {
  const kind = workAuthorizationKindOf(document);
  return kind ? `${name} · ${WORK_AUTHORIZATION_KIND_SHORT[kind]}` : name;
}

/** What an upload carries for the kind: an `extracted` reading, only on a Work authorization. */
export function workAuthorizationExtract(code: string, kind: WorkAuthorizationKind | '') {
  return asksWorkAuthorizationKind(code) && kind ? { extracted: { workAuthorizationKind: kind } } : {};
}
