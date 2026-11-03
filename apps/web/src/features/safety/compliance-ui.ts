/**
 * Presentation maps for the compliance domain. Labels only — every status, severity and gate
 * decision comes from the engine in @neway/shared; nothing here re-derives a rule.
 */
import { daysBetween } from '@neway/shared';
import type {
  ComplianceAction,
  ComplianceRole,
  ComplianceScope,
  ComplianceSeverity,
  EntityCompliance,
  EvaluatedItem,
} from '@neway/shared';
import type { BadgeTone } from '@/design-system';
import type { ComplianceDocument } from '@neway/shared';
import type { ConsentPurpose, VerificationStage } from '@neway/shared';

export const SCOPE_LABEL: Record<ComplianceScope, string> = {
  driver: 'Driver',
  truck: 'Unit',
  trailer: 'Trailer',
  company: 'Company',
};

export const ROLE_LABEL: Record<ComplianceRole, string> = {
  driver: 'Driver',
  safety_coordinator: 'Safety coordinator',
  safety_manager: 'Safety manager',
  safety_director: 'Director of safety',
  operations_manager: 'Operations manager',
  fleet_manager: 'Fleet manager',
  recruiter: 'Recruiter',
};

export const SEVERITY_TONE: Record<ComplianceSeverity, BadgeTone> = {
  ok: 'success',
  info: 'info',
  warning: 'warning',
  critical: 'danger',
};

export const SEVERITY_LABEL: Record<ComplianceSeverity, string> = {
  ok: 'OK',
  info: 'Info',
  warning: 'Warning',
  critical: 'Critical',
};

/**
 * Work-queue priority. Anything that stops a driver or unit moving is critical regardless of how
 * the calendar reads; after that the engine's severity decides.
 */
export type QueuePriority = 'critical' | 'high' | 'medium' | 'low';

export const PRIORITY_ORDER: readonly QueuePriority[] = ['critical', 'high', 'medium', 'low'];

export const PRIORITY_LABEL: Record<QueuePriority, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

export const PRIORITY_TONE: Record<QueuePriority, BadgeTone> = {
  critical: 'danger',
  high: 'danger',
  medium: 'warning',
  low: 'info',
};

export function priorityOf(action: ComplianceAction): QueuePriority {
  if (action.blocksDispatch) return 'critical';
  if (action.severity === 'critical') return 'high';
  if (action.severity === 'warning') return 'medium';
  return 'low';
}

export const CONSENT_PURPOSE_LABEL: Record<ConsentPurpose, string> = {
  mvr: 'MVR authorization',
  psp: 'PSP authorization',
  background_check: 'Background check',
  employment_verification: 'Employment verification',
  clearinghouse: 'Clearinghouse query',
  drug_alcohol_testing: 'Drug & alcohol testing',
  safety_investigation: 'Safety investigation',
};

export const STAGE_ORDER: readonly VerificationStage[] = [
  'recruiting',
  'document_collection',
  'consent',
  'screening',
  'verification',
  'safety_review',
  'decision',
  'active',
];

export const STAGE_LABEL: Record<VerificationStage, string> = {
  recruiting: 'Recruiting',
  document_collection: 'Documents',
  consent: 'Consent',
  screening: 'MVR / PSP / background',
  verification: 'Verification',
  safety_review: 'Safety review',
  decision: 'Decision',
  active: 'Active driver',
};

/** Key used for lookups and URL params: `driver:drv_01`. */
export function entityKey(scope: ComplianceScope, id: string): string {
  return `${scope}:${id}`;
}

export function parseEntityKey(key: string): { scope: ComplianceScope; id: string } | null {
  const [scope, ...rest] = key.split(':');
  const id = rest.join(':');
  if (!id) return null;
  if (scope !== 'driver' && scope !== 'truck' && scope !== 'trailer' && scope !== 'company') {
    return null;
  }
  return { scope, id };
}

/** Unsatisfied items only, worst first, for the "Issues" column and the drawer's top block. */
export function openItems(entity: EntityCompliance): EvaluatedItem[] {
  const rank: Record<ComplianceSeverity, number> = { critical: 0, warning: 1, info: 2, ok: 3 };
  return entity.items
    .filter((item) => item.requiredAction !== null)
    .sort((a, b) => rank[a.severity] - rank[b.severity]);
}

/**
 * Days until the item's `deadline`, which is not always its expiry: a missing document or a
 * rejected one is due today, whatever date sits on the record. The urgency label must describe
 * the date shown beside it, or a rejected document reads "in 239d" next to a deadline of today.
 */
export function deadlineDays(item: EvaluatedItem, today: string): number | null {
  return item.deadline ? daysBetween(today, item.deadline) : null;
}

export function daysLabel(days: number | null): string {
  if (days === null) return '—';
  if (days < 0) return `${Math.abs(days)}d overdue`;
  if (days === 0) return 'today';
  return `in ${days}d`;
}

// ---------------------------------------------------------------------------------------------
// Needs-attention grouping
// ---------------------------------------------------------------------------------------------

/**
 * The states a "needs attention" list is split into, in reading order. The split answers the
 * safety desk's first question — chase it, or review it? — so *missing* (nothing on file) and
 * *pending verification* (a document is attached and waiting on safety) are never one bucket.
 *
 * `rejected` is the engine's `verification_failed`: a reviewer looked and refused, so nothing
 * acceptable is on file and it needs re-collecting, like a missing one, but it is listed on its
 * own because the reason on the record is the thing to read before chasing.
 */
export const ATTENTION_GROUPS = ['missing', 'rejected', 'pending', 'expiring', 'expired'] as const;
export type AttentionGroup = (typeof ATTENTION_GROUPS)[number];

export const ATTENTION_GROUP_LABEL: Record<AttentionGroup, string> = {
  missing: 'Missing',
  rejected: 'Rejected',
  pending: 'Pending verification',
  expiring: 'Expiring',
  expired: 'Expired',
};

/** Rows in the pending group carry the warning treatment: nothing to chase, something to review. */
export const ATTENTION_GROUP_TONE: Record<AttentionGroup, BadgeTone> = {
  missing: 'danger',
  rejected: 'danger',
  pending: 'warning',
  expiring: 'warning',
  expired: 'danger',
};

/**
 * Which group an unsatisfied item belongs to, straight from the engine's status. Null for a
 * satisfied item. The status is what the engine derives from the stored item (a document attached,
 * an expiry recorded, no verification yet → `pending_verification`), so every count on the page
 * agrees with `entity.counts` and the command-centre summary.
 */
export function attentionGroupOf(item: EvaluatedItem): AttentionGroup | null {
  if (item.requiredAction === null) return null;
  switch (item.status) {
    case 'missing':
      return 'missing';
    case 'verification_failed':
      return 'rejected';
    case 'pending_verification':
      return 'pending';
    case 'expiring':
      return 'expiring';
    case 'expired':
      return 'expired';
    default:
      return null;
  }
}

export interface AttentionGroupRows {
  group: AttentionGroup;
  label: string;
  tone: BadgeTone;
  items: EvaluatedItem[];
}

/** Open items split by group, empty groups left out, worst first inside each group. */
export function groupOpenItems(entity: EntityCompliance): AttentionGroupRows[] {
  const buckets = new Map<AttentionGroup, EvaluatedItem[]>(ATTENTION_GROUPS.map((g) => [g, []]));
  for (const item of openItems(entity)) {
    const group = attentionGroupOf(item);
    if (group) buckets.get(group)?.push(item);
  }
  return ATTENTION_GROUPS.filter((g) => (buckets.get(g) ?? []).length > 0).map((group) => ({
    group,
    label: ATTENTION_GROUP_LABEL[group],
    tone: ATTENTION_GROUP_TONE[group],
    items: buckets.get(group) ?? [],
  }));
}

/**
 * The document a reviewer would verify for a pending item: the newest `pending_review` upload
 * for the same owner and requirement. Null when the item reads pending but no reviewable document
 * can be found - the engine graded the stored item, not the document store, and the two can
 * disagree.
 */
export function pendingDocumentFor(
  item: EvaluatedItem,
  documents: readonly ComplianceDocument[],
): ComplianceDocument | null {
  const candidates = documents.filter(
    (doc) =>
      doc.status === 'pending_review' &&
      doc.ownerId === item.entityId &&
      doc.requirementCode === item.requirementCode,
  );
  return [...candidates].sort((a, b) => b.uploadedAt.localeCompare(a.uploadedAt))[0] ?? null;
}
