import { z } from 'zod';

/**
 * The audit trail, read-only by construction.
 *
 * There is no update contract and no delete contract in this file, and that is not an omission. An
 * audit record that an administrator can edit answers the question "what happened?" with "whatever
 * somebody last decided it should say". The API exposes exactly three verbs — list, read one,
 * export — and the service behind them has no write path at all.
 */

export const AUDIT_ACTIONS = [
  'create',
  'update',
  'delete',
  'status_change',
  'assign',
  'approve',
  'export',
] as const;
export type AuditAction = (typeof AUDIT_ACTIONS)[number];

export const AUDIT_ACTION_LABELS: Record<string, string> = {
  create: 'Created',
  update: 'Updated',
  delete: 'Deleted',
  status_change: 'Status changed',
  assign: 'Assigned',
  approve: 'Approved',
  export: 'Exported',
};

/** Who caused the entry. `workflow` entries are never re-evaluated by the workflow engine. */
export const AUDIT_ACTOR_TYPES = ['user', 'system', 'workflow'] as const;
export type AuditActorType = (typeof AUDIT_ACTOR_TYPES)[number];

export const AuditEntrySchema = z.object({
  id: z.string(),
  at: z.string(),
  actorType: z.string(),
  actorId: z.string().nullable(),
  actorName: z.string(),
  action: z.string(),
  actionLabel: z.string(),
  entityType: z.string(),
  entityId: z.string(),
  entityLabel: z.string(),
  summary: z.string(),
  reason: z.string().nullable(),
  changes: z.array(
    z.object({
      field: z.string(),
      old: z.string().nullable(),
      new: z.string().nullable(),
    }),
  ),
});
export type AuditEntry = z.infer<typeof AuditEntrySchema>;

export const AuditQuerySchema = z.object({
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(200).default(50),
  search: z.string().trim().min(1).optional(),
  action: z.string().optional(),
  entityType: z.string().optional(),
  entityId: z.string().optional(),
  actorId: z.string().optional(),
  actorType: z.enum(AUDIT_ACTOR_TYPES).optional(),
  /** Inclusive company-local dates. */
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
});
export type AuditQuery = z.infer<typeof AuditQuerySchema>;

/**
 * How far back the trail actually goes.
 *
 * Returned alongside every list so a filter that finds nothing can say whether that means "no such
 * change" or "before this system started recording". The audit table began with the People module;
 * anything that happened before it is not in here and never will be.
 */
export const AuditCoverageSchema = z.object({
  earliest: z.string().nullable(),
  latest: z.string().nullable(),
  total: z.number(),
  note: z.string(),
});
export type AuditCoverage = z.infer<typeof AuditCoverageSchema>;
