import { z } from 'zod';

/**
 * Workflow automation.
 *
 * There is no event bus in this system, and inventing one would have meant every module publishing
 * a second stream of events alongside the audit entries it already writes — two sources of "what
 * happened", guaranteed to disagree within a month.
 *
 * So rules fire off the audit trail. Every state change in this product already writes an audit
 * entry, with the actor, the entity, and the before/after of each field. That is the event stream;
 * this module subscribes to it.
 *
 * Three consequences, all of them good:
 *   - a rule can only trigger on something that was actually recorded, so a rule's history and the
 *     audit trail can never diverge;
 *   - conditions are written against `changes[]`, which is real data rather than a re-read of the
 *     entity as it looks now;
 *   - a workflow's own writes are audited as `actorType: 'workflow'` and are never re-evaluated,
 *     which is the loop protection.
 */

/**
 * Triggers.
 *
 * Every entry corresponds to an audit `action` + `entityType` pair that a service in this codebase
 * actually writes. A trigger for an event nothing emits is a rule that silently never runs.
 */
export interface WorkflowTrigger {
  /** `entityType:action`, matching what the audit entry carries. */
  id: string;
  label: string;
  module: string;
  description: string;
  /** Fields the triggering entity commonly changes, offered when building a condition. */
  fields: string[];
}

export const WORKFLOW_TRIGGERS: WorkflowTrigger[] = [
  {
    id: 'employee:create',
    label: 'Employee is added',
    module: 'People',
    description: 'A new person is added to the workforce.',
    fields: ['department', 'position', 'employmentType'],
  },
  {
    id: 'employee:status_change',
    label: 'Employee status changes',
    module: 'People',
    description: 'Someone is activated, put on leave, suspended, terminated or archived.',
    fields: ['status'],
  },
  {
    id: 'employee:assign',
    label: 'Employee assignment changes',
    module: 'People',
    description: 'A manager, department or position assignment changes.',
    fields: ['managerEmployeeId', 'department', 'position'],
  },
  {
    id: 'applicant:status_change',
    label: 'Candidate moves stage',
    module: 'Recruiting',
    description: 'A candidate advances, is rejected or is hired.',
    fields: ['status'],
  },
  {
    id: 'lead:create',
    label: 'Driver lead is added',
    module: 'Recruiting',
    description:
      'A new driver lead arrives — added by a recruiter, or from an online application link.',
    fields: ['source', 'channel', 'applyLink'],
  },
  {
    id: 'lead:apply',
    label: 'Existing lead applies again online',
    module: 'Recruiting',
    description:
      'Someone already in the funnel submits the online application again. Their stage is not changed.',
    fields: ['source', 'applyLink'],
  },
  {
    id: 'job_opening:status_change',
    label: 'Job opening changes state',
    module: 'Recruiting',
    description: 'An opening is published, put on hold, filled or closed.',
    fields: ['status'],
  },
  {
    id: 'onboarding:status_change',
    label: 'Onboarding changes state',
    module: 'Onboarding',
    description: 'An onboarding plan starts, completes or stalls.',
    fields: ['status'],
  },
  {
    id: 'pto_request:create',
    label: 'Time off is requested',
    module: 'PTO',
    description: 'Someone submits a time-off request.',
    fields: ['type', 'days'],
  },
  {
    id: 'pto_request:status_change',
    label: 'Time off is decided',
    module: 'PTO',
    description: 'A request is approved, declined or cancelled.',
    fields: ['status'],
  },
  {
    id: 'attendance:approve',
    label: 'Attendance is approved',
    module: 'Attendance',
    description: 'A timesheet entry is approved.',
    fields: ['status'],
  },
  {
    id: 'performance_review:status_change',
    label: 'Review changes state',
    module: 'Performance',
    description: 'A review is opened, submitted, acknowledged or closed.',
    fields: ['status'],
  },
  {
    id: 'user:create',
    label: 'Account is created',
    module: 'Administration',
    description: 'A new account is created for this company.',
    fields: [],
  },
  {
    id: 'user:status_change',
    label: 'Account status changes',
    module: 'Administration',
    description: 'An account is activated, suspended or disabled.',
    fields: ['status'],
  },
  {
    id: 'user:assign',
    label: 'Account roles change',
    module: 'Administration',
    description: 'Roles are assigned to or removed from an account.',
    fields: ['roles'],
  },
  {
    id: 'integration:manage',
    label: 'Integration credentials change',
    module: 'Administration',
    description: 'An integration is configured, its credential replaced, or it is disabled.',
    fields: ['status'],
  },
];

export function workflowTrigger(id: string): WorkflowTrigger | undefined {
  return WORKFLOW_TRIGGERS.find((t) => t.id === id);
}

// =================================================================================== conditions

/**
 * Conditions read the audit entry, not the entity.
 *
 * `field_changed_to` and `field_changed_from` look at `changes[]`, which is what was actually
 * recorded at the moment of the change. Re-reading the entity would give whatever it looks like
 * now — which, by the time a rule runs, may already be something else.
 */
export const CONDITION_OPERATORS = [
  'field_changed',
  'field_changed_to',
  'field_changed_from',
  'label_contains',
  'summary_contains',
] as const;
export type ConditionOperator = (typeof CONDITION_OPERATORS)[number];

export const CONDITION_OPERATOR_LABELS: Record<ConditionOperator, string> = {
  field_changed: 'Field changed at all',
  field_changed_to: 'Field changed to',
  field_changed_from: 'Field changed from',
  label_contains: 'Record name contains',
  summary_contains: 'Change summary contains',
};

export const WorkflowConditionSchema = z.object({
  operator: z.enum(CONDITION_OPERATORS),
  /** The audit `changes[].field` to inspect. Ignored by the `*_contains` operators. */
  field: z.string().trim().max(80).default(''),
  value: z.string().trim().max(200).default(''),
});
export type WorkflowCondition = z.infer<typeof WorkflowConditionSchema>;

// ====================================================================================== actions

export const ACTION_TYPES = ['notify', 'webhook', 'email'] as const;
export type ActionType = (typeof ACTION_TYPES)[number];

export interface ActionDefinition {
  type: ActionType;
  label: string;
  description: string;
  implemented: boolean;
  /** Present when not implemented: what is missing, said plainly. */
  reason?: string;
}

export const WORKFLOW_ACTIONS: ActionDefinition[] = [
  {
    type: 'notify',
    label: 'Create a notification',
    description: 'Raises an in-app notification for every active account holding a chosen role.',
    implemented: true,
  },
  {
    type: 'webhook',
    label: 'Call a webhook',
    description:
      'POSTs the triggering event to an HTTPS endpoint you control. The response status is recorded on the run.',
    implemented: true,
  },
  {
    type: 'email',
    label: 'Send an email',
    description: 'Emails the change to an address.',
    implemented: false,
    reason:
      'No mail transport is configured in this deployment, so no email can be sent. A rule using this action records a skipped run with this reason rather than failing silently.',
  },
];

export const IMPLEMENTED_ACTION_TYPES = WORKFLOW_ACTIONS.filter((a) => a.implemented).map(
  (a) => a.type,
);

export const WorkflowActionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('notify'),
    /** Role code whose active accounts receive it. */
    roleCode: z.string().trim().min(1),
    severity: z.enum(['info', 'warning', 'critical']).default('info'),
    title: z.string().trim().min(1).max(120),
  }),
  z.object({
    type: z.literal('webhook'),
    url: z
      .string()
      .trim()
      .url()
      .refine((u) => u.startsWith('https://'), 'Must be an https URL'),
  }),
  z.object({
    type: z.literal('email'),
    to: z.string().trim().email(),
  }),
]);
export type WorkflowAction = z.infer<typeof WorkflowActionSchema>;

// ======================================================================================== rules

export const WORKFLOW_STATUSES = ['draft', 'active', 'paused', 'disabled'] as const;
export type WorkflowStatus = (typeof WORKFLOW_STATUSES)[number];

export const WorkflowRuleSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullable(),
  trigger: z.string(),
  triggerLabel: z.string().nullable(),
  conditions: z.array(WorkflowConditionSchema),
  actions: z.array(WorkflowActionSchema),
  status: z.enum(WORKFLOW_STATUSES),
  runCount: z.number(),
  lastRunAt: z.string().nullable(),
  ownerName: z.string().nullable(),
  createdAt: z.string(),
});
export type WorkflowRule = z.infer<typeof WorkflowRuleSchema>;

export const CreateWorkflowSchema = z.object({
  name: z.string().trim().min(2, 'Name is required').max(80),
  description: z
    .string()
    .trim()
    .max(300)
    .nullish()
    .transform((v) => v || null),
  trigger: z.string().refine((id) => WORKFLOW_TRIGGERS.some((t) => t.id === id), 'Unknown trigger'),
  conditions: z.array(WorkflowConditionSchema).max(10).default([]),
  actions: z.array(WorkflowActionSchema).min(1, 'A rule needs at least one action').max(5),
  status: z.enum(['draft', 'active']).default('draft'),
});

export const UpdateWorkflowSchema = z.object({
  name: z.string().trim().min(2).max(80).optional(),
  description: z
    .string()
    .trim()
    .max(300)
    .nullish()
    .transform((v) => v || null)
    .optional(),
  conditions: z.array(WorkflowConditionSchema).max(10).optional(),
  actions: z.array(WorkflowActionSchema).min(1).max(5).optional(),
  status: z.enum(WORKFLOW_STATUSES).optional(),
});

export const WORKFLOW_RUN_STATUSES = ['matched', 'skipped', 'failed'] as const;
export type WorkflowRunStatus = (typeof WORKFLOW_RUN_STATUSES)[number];

export const WorkflowRunSchema = z.object({
  id: z.string(),
  ruleId: z.string(),
  ruleName: z.string().nullable(),
  triggerSummary: z.string().nullable(),
  status: z.enum(WORKFLOW_RUN_STATUSES),
  skipReason: z.string().nullable(),
  steps: z.array(
    z.object({
      action: z.string(),
      outcome: z.enum(['done', 'skipped', 'failed']),
      detail: z.string(),
    }),
  ),
  durationMs: z.number().nullable(),
  error: z.string().nullable(),
  startedAt: z.string(),
});
export type WorkflowRun = z.infer<typeof WorkflowRunSchema>;

/**
 * The pure matcher.
 *
 * Every condition must hold. An empty condition list matches every event of the trigger's type,
 * which is what "when an employee is terminated, notify safety" looks like before anybody narrows
 * it further.
 */
export interface TriggerEvent {
  entityType: string;
  action: string;
  entityLabel: string;
  summary: string;
  changes: { field: string; old: string | null; new: string | null }[];
}

export function conditionMatches(condition: WorkflowCondition, event: TriggerEvent): boolean {
  const value = condition.value.trim().toLowerCase();
  const change = event.changes.find((c) => c.field === condition.field);
  switch (condition.operator) {
    case 'field_changed':
      return change !== undefined;
    case 'field_changed_to':
      return (change?.new ?? '').trim().toLowerCase() === value;
    case 'field_changed_from':
      return (change?.old ?? '').trim().toLowerCase() === value;
    case 'label_contains':
      return event.entityLabel.toLowerCase().includes(value);
    case 'summary_contains':
      return event.summary.toLowerCase().includes(value);
    default:
      return false;
  }
}

export function ruleMatches(
  rule: { trigger: string; conditions: WorkflowCondition[] },
  event: TriggerEvent,
): boolean {
  if (rule.trigger !== `${event.entityType}:${event.action}`) return false;
  return rule.conditions.every((condition) => conditionMatches(condition, event));
}
