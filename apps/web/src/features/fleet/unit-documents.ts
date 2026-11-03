import type {
  ComplianceDocument,
  ExpiryTone,
  ExpiryToneResult,
  QualificationRequirement,
} from '@neway/shared';
import { API_PREFIX, SYSTEM_REQUIREMENTS, expiryTone } from '@neway/shared';
import { sessionToken } from '@/lib/session';
import { resolveFileFetchUrl } from '@/lib/files';

/**
 * A unit's paperwork, read the way the yard reads it: valid, expiring, expired, or no expiry.
 *
 * The compliance engine judges the *requirement* — is there a verified registration on file. This
 * judges the *document* — is the file in the drawer still in date — which is what somebody looking
 * at a truck's Documents tab is asking. The two agree on the dates; they answer different questions.
 */

export type DocumentExpiryStatus = 'valid' | 'expiring' | 'expired' | 'no_expiry';

/**
 * The document's standing, read off the shared expiry bands (`expiryTone` in `@neway/shared`):
 * anything inside three calendar months — the blue, yellow and red bands — is `expiring`; the
 * band itself (how loud to say it) is `documentExpiryTone`.
 */
export function documentExpiryStatus(
  doc: Pick<ComplianceDocument, 'expiresOn'>,
  today: string,
): DocumentExpiryStatus {
  const { tone } = expiryTone(doc.expiresOn, today);
  if (tone === 'none') return 'no_expiry';
  if (tone === 'expired') return 'expired';
  if (tone === 'normal') return 'valid';
  return 'expiring';
}

/** The colour band and the words for a document's expiry date. */
export function documentExpiryTone(
  doc: Pick<ComplianceDocument, 'expiresOn'>,
  today: string,
): ExpiryToneResult {
  return expiryTone(doc.expiresOn, today);
}

const TONE_RANK: Record<ExpiryTone, number> = {
  none: 0,
  normal: 0,
  info: 1,
  warning: 2,
  danger: 3,
  expired: 4,
};

/** The loudest band among a unit's document issues, for the chip beside its status. */
export function worstExpiryTone(tones: readonly ExpiryTone[]): ExpiryTone {
  return tones.reduce<ExpiryTone>((worst, t) => (TONE_RANK[t] > TONE_RANK[worst] ? t : worst), 'normal');
}

export const EXPIRY_LABEL: Record<DocumentExpiryStatus, string> = {
  valid: 'Valid',
  expiring: 'Expiring soon',
  expired: 'Expired',
  no_expiry: 'No expiry',
};

/** What an expired document of a type does to the unit: stops dispatch, or only warns. */
export type DocumentRule = 'block' | 'warn';

/** The document types a unit can carry, including the ones that are files rather than rules. */
export function documentTypesFor(scope: 'truck' | 'trailer'): QualificationRequirement[] {
  return SYSTEM_REQUIREMENTS.filter((r) => r.scope === scope && r.active);
}

/** The rule the catalog ships with: a regulatory unit hold blocks; everything else warns. */
export function defaultDocumentRule(
  requirement: Pick<QualificationRequirement, 'holdEffect'>,
): DocumentRule {
  return requirement.holdEffect === 'unit_hold' ? 'block' : 'warn';
}

export function documentRuleFor(
  code: string,
  overrides: Record<string, DocumentRule>,
  scope: 'truck' | 'trailer',
): DocumentRule {
  const override = overrides[code];
  if (override) return override;
  const requirement = documentTypesFor(scope).find((r) => r.code === code);
  return requirement ? defaultDocumentRule(requirement) : 'warn';
}

export interface UnitDocumentIssue {
  document: ComplianceDocument;
  status: 'expired' | 'expiring';
  /** The colour band and words for the date (`expiryTone`). */
  expiry: ExpiryToneResult;
  typeName: string;
  /** True when the rule for this type stops dispatch once the document has expired. */
  blocks: boolean;
}

export interface UnitDocumentIssues {
  expired: UnitDocumentIssue[];
  expiring: UnitDocumentIssue[];
  /** The paperwork a unit is supposed to carry and has nothing on file for at all. */
  missing: MissingUnitDocument[];
  /** The reason dispatch is held, when an expired document's rule says it is. */
  hold: string | null;
}

/**
 * The paperwork a unit is asked for the moment it is created.
 *
 * A unit with no registration and no annual inspection is out of service the day it is added —
 * so the creation form asks for those files, and the unit says which one it is still missing
 * until somebody attaches it. `required` marks the ones whose absence stops dispatch; the rest
 * are offered at creation because that is when the folder is open, not because they are demanded.
 *
 * Every code here is a real requirement in `@neway/shared`'s compliance catalog.
 */
export interface UnitDocumentSlot {
  code: string;
  /** The catalog name, for the dropzone title. */
  name: string;
  /** One line under the title saying what it is. */
  subtitle: string;
  /** How the chip names it when nothing is on file: "No registration". */
  missingLabel: string;
  /** True when its absence leaves the unit out of service. */
  required: boolean;
}

export const UNIT_DOCUMENT_SLOTS: Record<'truck' | 'trailer', readonly UnitDocumentSlot[]> = {
  truck: [
    {
      code: 'registration',
      name: 'Vehicle registration',
      subtitle: 'Current state registration for the power unit.',
      missingLabel: 'No registration',
      required: true,
    },
    {
      code: 'annual_inspection',
      name: 'DOT annual inspection',
      subtitle: 'Inspection certificate from the last 12 months.',
      missingLabel: 'No annual inspection',
      required: true,
    },
  ],
  trailer: [
    {
      code: 'trailer_registration',
      name: 'Trailer registration',
      subtitle: 'Current registration for the trailer.',
      missingLabel: 'No registration',
      required: true,
    },
    {
      code: 'trailer_annual_inspection',
      name: 'Annual DOT inspection certificate',
      subtitle: 'Inspection certificate from the last 12 months.',
      missingLabel: 'No annual inspection',
      required: true,
    },
    {
      code: 'trailer_insurance_card',
      name: 'Insurance card',
      subtitle: 'Optional. Proof of insurance carried on the trailer.',
      missingLabel: 'No insurance card',
      required: false,
    },
    {
      code: 'trailer_lease_agreement',
      name: 'Lease agreement',
      subtitle: 'Optional. Only when the trailer is leased rather than owned.',
      missingLabel: 'No lease agreement',
      required: false,
    },
    {
      code: 'trailer_title',
      name: 'Title',
      subtitle: 'Optional. Certificate of title for the trailer.',
      missingLabel: 'No title',
      required: false,
    },
  ],
};

/** The slots whose absence leaves the unit out of service. */
export function requiredUnitDocumentSlots(scope: 'truck' | 'trailer'): UnitDocumentSlot[] {
  return UNIT_DOCUMENT_SLOTS[scope].filter((slot) => slot.required);
}

export interface MissingUnitDocument {
  code: string;
  typeName: string;
  /** "No registration" — what the chip says. */
  label: string;
}

/**
 * The required paperwork with nothing on file at all.
 *
 * Nothing on file is a different finding from an expired file: an expired registration was at
 * least registered once, and the fix is a renewal. This is the unit nobody ever filed for.
 */
export function missingUnitDocuments(
  docs: readonly ComplianceDocument[],
  scope: 'truck' | 'trailer',
): MissingUnitDocument[] {
  const onFile = new Set(docs.filter((d) => d.status !== 'rejected').map((d) => d.requirementCode));
  return requiredUnitDocumentSlots(scope)
    .filter((slot) => !onFile.has(slot.code))
    .map((slot) => ({ code: slot.code, typeName: slot.name, label: slot.missingLabel }));
}

/** True when a unit's paperwork has anything worth saying beside its status. */
export function hasUnitDocumentIssue(issues: UnitDocumentIssues): boolean {
  return issues.expired.length > 0 || issues.expiring.length > 0 || issues.missing.length > 0;
}

/**
 * The current document per type (the newest version), and which of them are a problem.
 *
 * Only the latest version of each type counts: a renewal supersedes the old card, and the old
 * card being expired is the normal state of a superseded document, not a finding.
 */
export function unitDocumentIssues(
  docs: readonly ComplianceDocument[],
  scope: 'truck' | 'trailer',
  overrides: Record<string, DocumentRule>,
  today: string,
): UnitDocumentIssues {
  const latestByType = new Map<string, ComplianceDocument>();
  for (const doc of docs) {
    if (doc.status === 'rejected') continue;
    const current = latestByType.get(doc.requirementCode);
    if (!current || doc.version > current.version) latestByType.set(doc.requirementCode, doc);
  }
  const types = new Map(documentTypesFor(scope).map((r) => [r.code, r]));
  const expired: UnitDocumentIssue[] = [];
  const expiring: UnitDocumentIssue[] = [];
  for (const doc of latestByType.values()) {
    const status = documentExpiryStatus(doc, today);
    if (status !== 'expired' && status !== 'expiring') continue;
    const issue: UnitDocumentIssue = {
      document: doc,
      status,
      expiry: documentExpiryTone(doc, today),
      typeName: types.get(doc.requirementCode)?.name ?? doc.requirementCode.replace(/_/g, ' '),
      blocks: documentRuleFor(doc.requirementCode, overrides, scope) === 'block',
    };
    (status === 'expired' ? expired : expiring).push(issue);
  }
  const blocking = expired.filter((i) => i.blocks);
  return {
    expired,
    expiring,
    missing: missingUnitDocuments(docs, scope),
    hold:
      blocking.length > 0
        ? `${blocking.map((i) => i.typeName).join(', ')} expired — dispatch is held until a current document is on file`
        : null,
  };
}

/** The file's bytes, fetched with the session so the viewer can show them inline. */
export async function fetchDocumentBlob(id: string): Promise<Blob> {
  const token = sessionToken();
  // Personnel and unit documents open through a five-minute signed link (owner, 2026-10-25).
  const response = await fetch(
    await resolveFileFetchUrl(`/${API_PREFIX}/compliance/documents/${encodeURIComponent(id)}/file`),
    {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    },
  );
  if (!response.ok) throw new Error(`The file could not be loaded (${response.status})`);
  return response.blob();
}
