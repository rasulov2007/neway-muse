import { z } from 'zod';

/**
 * Which paper a driver's Work authorization document is (owner, 2026-10-26): exactly these four.
 *
 * Kept on the document itself, in its `extracted` reading (`workAuthorizationKind`), so replacing
 * the paper replaces the kind with it and no column is needed.
 */
export const WORK_AUTHORIZATION_KINDS = [
  'us_passport',
  'green_card',
  'employment_authorization',
  'non_domiciled',
] as const;
export const WorkAuthorizationKindSchema = z.enum(WORK_AUTHORIZATION_KINDS);
export type WorkAuthorizationKind = z.infer<typeof WorkAuthorizationKindSchema>;

/** The option labels, as the owner wrote them. */
export const WORK_AUTHORIZATION_KIND_LABELS: Readonly<Record<WorkAuthorizationKind, string>> = {
  us_passport: 'U.S. Passport / Passport Card',
  green_card: 'Permanent Resident Card (Green Card)',
  employment_authorization: 'Employment Authorization',
  non_domiciled: 'Non-Domiciled',
};

/** The short name a document row shows after "Work authorization · ". */
export const WORK_AUTHORIZATION_KIND_SHORT: Readonly<Record<WorkAuthorizationKind, string>> = {
  us_passport: 'U.S. Passport',
  green_card: 'Green Card',
  employment_authorization: 'Employment Authorization',
  non_domiciled: 'Non-Domiciled',
};

/** The requirement code that asks for the kind. */
export const WORK_AUTHORIZATION_CODE = 'work_authorization';

/** The kind filed on a document, when it carries a valid one. */
export function workAuthorizationKindOf(
  document: { requirementCode: string; extracted?: { workAuthorizationKind?: string | null } | null } | null | undefined,
): WorkAuthorizationKind | null {
  if (!document || document.requirementCode !== WORK_AUTHORIZATION_CODE) return null;
  const parsed = WorkAuthorizationKindSchema.safeParse(document.extracted?.workAuthorizationKind);
  return parsed.success ? parsed.data : null;
}
