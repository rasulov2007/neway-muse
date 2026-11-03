import { Injectable, type OnModuleInit } from '@nestjs/common';
import { and, count, desc, eq, inArray, sql } from 'drizzle-orm';
import { PinoLogger } from 'nestjs-pino';
import {
  WORKFLOW_ACTIONS,
  WORKFLOW_TRIGGERS,
  ruleMatches,
  workflowTrigger,
  type TriggerEvent,
  type WorkflowAction,
  type WorkflowCondition,
  type WorkflowRule,
  type WorkflowRun,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import {
  memberships,
  membershipRoles,
  notifications,
  roles,
  workflowRules,
  workflowRuns,
} from '../../database/schema/admin';
import { AuditService, type AuditEvent } from '../people/audit.service';
import { SettingsService } from './settings.service';

interface RunStep {
  action: string;
  outcome: 'done' | 'skipped' | 'failed';
  detail: string;
}

/**
 * The workflow engine.
 *
 * Subscribes to the audit stream (see `AuditService.onWrite`) and evaluates every active rule whose
 * trigger matches. Four properties it was built around:
 *
 *   **No loops.** A workflow's own writes are audited as `actorType: 'workflow'` and are skipped
 *   before a rule is even loaded. A rule cannot trigger itself, or another rule, indirectly.
 *
 *   **No double-firing.** `workflow_runs` has a unique index on (rule, triggering audit entry). A
 *   retry, a duplicate delivery or two listeners racing all collapse to one run.
 *
 *   **No silence.** A rule that matched but did nothing writes a `skipped` run carrying the reason.
 *   "The email action is not implemented" is visible on the run, not swallowed.
 *
 *   **No blocking.** Evaluation never fails the operation that triggered it. A rule that throws
 *   records a `failed` run and the employee still got terminated.
 */
@Injectable()
export class WorkflowsService implements OnModuleInit {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly settings: SettingsService,
    private readonly logger: PinoLogger,
  ) {
    this.logger.setContext(WorkflowsService.name);
  }

  private get db() {
    return this.database.db;
  }

  onModuleInit(): void {
    this.audit.onWrite(async (event) => {
      try {
        await this.dispatch(event);
      } catch (error) {
        // The audit service swallows a throwing listener so automation can never fail the business
        // operation. That is right, but it must not also be invisible — log it here, where the
        // context is.
        this.logger.error(
          { err: error, auditId: event.id, trigger: `${event.entityType}:${event.action}` },
          'Workflow evaluation failed',
        );
      }
    });
  }

  // ============================================================================== the engine

  async dispatch(event: AuditEvent): Promise<void> {
    // Loop protection, first and unconditionally.
    if (event.actorType === 'workflow') return;

    const trigger = `${event.entityType}:${event.action}`;
    if (!WORKFLOW_TRIGGERS.some((t) => t.id === trigger)) return;

    const candidates = await this.db
      .select()
      .from(workflowRules)
      .where(
        and(
          eq(workflowRules.companyId, event.companyId),
          eq(workflowRules.trigger, trigger),
          eq(workflowRules.status, 'active'),
        ),
      );
    if (candidates.length === 0) return;

    const config = await this.settings.valuesFor(event.companyId, [
      'automation.workflows_enabled',
      'automation.notifications_enabled',
    ]);

    const triggerEvent: TriggerEvent = {
      entityType: event.entityType,
      action: event.action,
      entityLabel: event.entityLabel,
      summary: event.summary,
      changes: event.changes,
    };

    for (const rule of candidates) {
      const conditions = (rule.conditions ?? []) as WorkflowCondition[];
      if (!ruleMatches({ trigger: rule.trigger, conditions }, triggerEvent)) continue;

      if (config['automation.workflows_enabled'] === false) {
        await this.record(rule, event, 'skipped', [], 0, {
          skipReason: 'Automation is switched off in company settings.',
        });
        continue;
      }
      await this.run(rule, event, triggerEvent, config);
    }
  }

  private async run(
    rule: typeof workflowRules.$inferSelect,
    event: AuditEvent,
    triggerEvent: TriggerEvent,
    config: Record<string, unknown>,
  ): Promise<void> {
    const started = Date.now();
    const steps: RunStep[] = [];
    let failure: string | null = null;

    for (const action of (rule.actions ?? []) as WorkflowAction[]) {
      try {
        steps.push(await this.execute(action, rule, event, triggerEvent, config));
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        steps.push({ action: action.type, outcome: 'failed', detail });
        failure = detail;
      }
    }

    const status = failure ? 'failed' : steps.some((s) => s.outcome === 'done') ? 'matched' : 'skipped';
    await this.record(rule, event, status, steps, Date.now() - started, {
      error: failure,
      skipReason:
        status === 'skipped'
          ? (steps.find((s) => s.outcome === 'skipped')?.detail ??
            'The rule matched but every action was skipped.')
          : null,
    });
  }

  private async execute(
    action: WorkflowAction,
    rule: typeof workflowRules.$inferSelect,
    event: AuditEvent,
    triggerEvent: TriggerEvent,
    config: Record<string, unknown>,
  ): Promise<RunStep> {
    const definition = WORKFLOW_ACTIONS.find((a) => a.type === action.type);
    if (!definition?.implemented) {
      return {
        action: action.type,
        outcome: 'skipped',
        detail: definition?.reason ?? `The ${action.type} action is not implemented.`,
      };
    }

    if (action.type === 'notify') {
      if (config['automation.notifications_enabled'] === false) {
        return {
          action: 'notify',
          outcome: 'skipped',
          detail: 'Notifications are switched off in company settings.',
        };
      }
      const recipients = await this.recipientsWithRole(event.companyId, action.roleCode);
      if (recipients.length === 0) {
        return {
          action: 'notify',
          outcome: 'skipped',
          detail: `No active account holds the ${action.roleCode} role, so there was nobody to notify.`,
        };
      }
      await this.db
        .insert(notifications)
        .values(
          recipients.map((userId) => ({
            id: `ntf_${crypto.randomUUID()}`,
            companyId: event.companyId,
            recipientUserId: userId,
            severity: action.severity,
            title: action.title,
            body: `${triggerEvent.entityLabel} — ${triggerEvent.summary}`,
            entityType: event.entityType,
            entityId: event.entityId,
            source: 'workflow',
            // One notification per recipient per triggering event, whatever happens upstream.
            dedupeKey: `${rule.id}:${event.id}:${userId}`,
          })),
        )
        .onConflictDoNothing();
      return {
        action: 'notify',
        outcome: 'done',
        detail: `Notified ${recipients.length} account${recipients.length === 1 ? '' : 's'} holding ${action.roleCode}.`,
      };
    }

    if (action.type === 'webhook') {
      const url = new URL(action.url);
      // https only, and never a private or loopback address: a webhook is an outbound call this
      // server makes on a user's instruction, which is exactly the shape of an SSRF.
      if (url.protocol !== 'https:' || this.isPrivateHost(url.hostname)) {
        return {
          action: 'webhook',
          outcome: 'skipped',
          detail: 'Only public https endpoints can be called.',
        };
      }
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 5_000);
      try {
        const response = await fetch(url, {
          method: 'POST',
          signal: controller.signal,
          headers: { 'content-type': 'application/json', 'user-agent': 'neway-tms-workflow/1' },
          body: JSON.stringify({
            rule: { id: rule.id, name: rule.name },
            event: {
              id: event.id,
              at: event.at.toISOString(),
              trigger: rule.trigger,
              entityType: event.entityType,
              entityId: event.entityId,
              entityLabel: event.entityLabel,
              summary: event.summary,
              changes: event.changes,
            },
          }),
        });
        return {
          action: 'webhook',
          outcome: response.ok ? 'done' : 'failed',
          detail: `${url.host} responded ${response.status}`,
        };
      } finally {
        clearTimeout(timeout);
      }
    }

    return { action: action.type, outcome: 'skipped', detail: 'Unknown action.' };
  }

  private isPrivateHost(hostname: string): boolean {
    const host = hostname.toLowerCase();
    if (host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.internal')) {
      return true;
    }
    if (/^(\d{1,3}\.){3}\d{1,3}$/.test(host)) {
      const octets = host.split('.').map(Number);
      const a = octets[0] ?? 0;
      const b = octets[1] ?? 0;
      if (a === 10 || a === 127 || a === 0) return true;
      if (a === 172 && b >= 16 && b <= 31) return true;
      if (a === 192 && b === 168) return true;
      if (a === 169 && b === 254) return true;
    }
    return host === '::1' || host.startsWith('[');
  }

  private async recipientsWithRole(companyId: string, roleCode: string): Promise<string[]> {
    const rows = await this.db
      .selectDistinct({ userId: memberships.userId })
      .from(memberships)
      .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
      .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
      .where(
        and(
          eq(memberships.companyId, companyId),
          eq(memberships.status, 'active'),
          eq(roles.code, roleCode),
        ),
      );
    return rows.map((r) => r.userId);
  }

  private async record(
    rule: typeof workflowRules.$inferSelect,
    event: AuditEvent,
    status: string,
    steps: RunStep[],
    durationMs: number,
    extra: { error?: string | null; skipReason?: string | null } = {},
  ): Promise<void> {
    const inserted = await this.db
      .insert(workflowRuns)
      .values({
        id: `wfr_${crypto.randomUUID()}`,
        companyId: event.companyId,
        ruleId: rule.id,
        triggerAuditId: event.id,
        triggerSummary: `${event.entityLabel} — ${event.summary}`,
        status,
        skipReason: extra.skipReason ?? null,
        steps,
        durationMs,
        error: extra.error ?? null,
      })
      // The idempotency index. A second delivery of the same event is not a second run. The index
      // is partial, so its predicate has to be repeated here or Postgres cannot infer it.
      .onConflictDoNothing({
        target: [workflowRuns.ruleId, workflowRuns.triggerAuditId],
        where: sql`${workflowRuns.triggerAuditId} is not null`,
      })
      .returning({ id: workflowRuns.id });

    if (inserted.length === 0) return;
    if (status === 'matched') {
      await this.db
        .update(workflowRules)
        .set({ runCount: sql`${workflowRules.runCount} + 1`, lastRunAt: new Date() })
        .where(eq(workflowRules.id, rule.id));
    }
  }

  // ============================================================================ configuration

  catalog() {
    return { triggers: WORKFLOW_TRIGGERS, actions: WORKFLOW_ACTIONS };
  }

  async list(principal: Principal): Promise<WorkflowRule[]> {
    const rows = await this.db
      .select()
      .from(workflowRules)
      .where(eq(workflowRules.companyId, principal.companyId))
      .orderBy(desc(workflowRules.createdAt));
    return rows.map((row) => this.toRule(row));
  }

  async get(principal: Principal, id: string): Promise<WorkflowRule> {
    const [row] = await this.db
      .select()
      .from(workflowRules)
      .where(and(eq(workflowRules.companyId, principal.companyId), eq(workflowRules.id, id)))
      .limit(1);
    if (!row) throw new AppError({ status: 404, title: 'Not Found', detail: `No rule ${id}` });
    return this.toRule(row);
  }

  async create(
    principal: Principal,
    input: {
      name: string;
      description: string | null;
      trigger: string;
      conditions: WorkflowCondition[];
      actions: WorkflowAction[];
      status: string;
    },
  ): Promise<WorkflowRule> {
    await this.assertActionsUsable(principal, input.actions);

    const [clash] = await this.db
      .select({ id: workflowRules.id })
      .from(workflowRules)
      .where(
        and(eq(workflowRules.companyId, principal.companyId), eq(workflowRules.name, input.name)),
      )
      .limit(1);
    if (clash) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'A rule with that name already exists',
      });
    }

    const id = `wfl_${crypto.randomUUID()}`;
    await this.db.insert(workflowRules).values({
      id,
      companyId: principal.companyId,
      name: input.name,
      description: input.description,
      trigger: input.trigger,
      conditions: input.conditions,
      actions: input.actions,
      status: input.status,
      ownerName: principal.userName ?? principal.userId,
    });
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'workflow',
      entityId: id,
      entityLabel: input.name,
      summary: `Rule created on ${workflowTrigger(input.trigger)?.label ?? input.trigger}`,
    });
    return this.get(principal, id);
  }

  async update(
    principal: Principal,
    id: string,
    patch: {
      name?: string;
      description?: string | null;
      conditions?: WorkflowCondition[];
      actions?: WorkflowAction[];
      status?: string;
    },
  ): Promise<WorkflowRule> {
    const before = await this.get(principal, id);
    if (patch.actions) await this.assertActionsUsable(principal, patch.actions);

    await this.db
      .update(workflowRules)
      .set({
        name: patch.name ?? undefined,
        description: patch.description === undefined ? undefined : patch.description,
        conditions: patch.conditions ?? undefined,
        actions: patch.actions ?? undefined,
        status: patch.status ?? undefined,
        updatedAt: new Date(),
      })
      .where(and(eq(workflowRules.companyId, principal.companyId), eq(workflowRules.id, id)));

    const after = await this.get(principal, id);
    const changes = [
      { field: 'name', old: before.name, new: after.name },
      { field: 'status', old: before.status, new: after.status },
      {
        field: 'actions',
        old: before.actions.map((a) => a.type).join(', '),
        new: after.actions.map((a) => a.type).join(', '),
      },
      {
        field: 'conditions',
        old: String(before.conditions.length),
        new: String(after.conditions.length),
      },
    ].filter((c) => c.old !== c.new);

    if (changes.length > 0) {
      await this.audit.write(principal, {
        action: patch.status && patch.status !== before.status ? 'status_change' : 'update',
        entityType: 'workflow',
        entityId: id,
        entityLabel: after.name,
        summary: `${changes.map((c) => c.field).join(', ')} changed`,
        changes,
      });
    }
    return after;
  }

  /** Rejects a rule whose recipient role does not exist — a rule that could never notify anybody. */
  private async assertActionsUsable(
    principal: Principal,
    actions: WorkflowAction[],
  ): Promise<void> {
    const roleCodes = actions
      .filter((a): a is Extract<WorkflowAction, { type: 'notify' }> => a.type === 'notify')
      .map((a) => a.roleCode);
    if (roleCodes.length === 0) return;

    const found = await this.db
      .select({ code: roles.code })
      .from(roles)
      .where(
        and(
          inArray(roles.code, roleCodes),
          sql`(${roles.companyId} = ${principal.companyId} or ${roles.companyId} is null)`,
          eq(roles.status, 'active'),
        ),
      );
    const missing = roleCodes.filter((code) => !found.some((r) => r.code === code));
    if (missing.length > 0) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `No such role: ${missing.join(', ')}`,
      });
    }
  }

  async runs(principal: Principal, ruleId?: string, limit = 50): Promise<WorkflowRun[]> {
    const parts = [eq(workflowRuns.companyId, principal.companyId)];
    if (ruleId) parts.push(eq(workflowRuns.ruleId, ruleId));
    const rows = await this.db
      .select({ run: workflowRuns, ruleName: workflowRules.name })
      .from(workflowRuns)
      .leftJoin(workflowRules, eq(workflowRuns.ruleId, workflowRules.id))
      .where(and(...parts))
      .orderBy(desc(workflowRuns.startedAt))
      .limit(limit);

    return rows.map(({ run, ruleName }) => ({
      id: run.id,
      ruleId: run.ruleId,
      ruleName,
      triggerSummary: run.triggerSummary,
      status: run.status as WorkflowRun['status'],
      skipReason: run.skipReason,
      steps: (run.steps ?? []) as WorkflowRun['steps'],
      durationMs: run.durationMs,
      error: run.error,
      startedAt: run.startedAt.toISOString(),
    }));
  }

  async summary(principal: Principal) {
    const [rules] = await this.db
      .select({
        total: count(),
        active: sql<number>`count(*) filter (where ${workflowRules.status} = 'active')::int`,
      })
      .from(workflowRules)
      .where(eq(workflowRules.companyId, principal.companyId));

    const [runs] = await this.db
      .select({
        total: count(),
        matched: sql<number>`count(*) filter (where ${workflowRuns.status} = 'matched')::int`,
        skipped: sql<number>`count(*) filter (where ${workflowRuns.status} = 'skipped')::int`,
        failed: sql<number>`count(*) filter (where ${workflowRuns.status} = 'failed')::int`,
      })
      .from(workflowRuns)
      .where(eq(workflowRuns.companyId, principal.companyId));

    return {
      rules: { total: rules?.total ?? 0, active: rules?.active ?? 0 },
      runs: {
        total: runs?.total ?? 0,
        matched: runs?.matched ?? 0,
        skipped: runs?.skipped ?? 0,
        failed: runs?.failed ?? 0,
      },
    };
  }

  private toRule(row: typeof workflowRules.$inferSelect): WorkflowRule {
    return {
      id: row.id,
      name: row.name,
      description: row.description,
      trigger: row.trigger,
      triggerLabel: workflowTrigger(row.trigger)?.label ?? null,
      conditions: (row.conditions ?? []) as WorkflowCondition[],
      actions: (row.actions ?? []) as WorkflowAction[],
      status: row.status as WorkflowRule['status'],
      runCount: row.runCount,
      lastRunAt: row.lastRunAt?.toISOString() ?? null,
      ownerName: row.ownerName,
      createdAt: row.createdAt.toISOString(),
    };
  }
}
