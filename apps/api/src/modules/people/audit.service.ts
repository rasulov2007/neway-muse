import { Injectable, Optional } from '@nestjs/common';
import { and, desc, eq } from 'drizzle-orm';
import type { Principal } from '../../common/auth/principal';
import { DatabaseService } from '../../database/database.service';
import type { Database } from '../../database/client';
import { auditLogs, type AuditLogRow } from '../../database/schema/people';
import { StolenUnitsService } from '../state/stolen-units.service';

export interface AuditChange {
  field: string;
  old: string | null;
  new: string | null;
}

export interface WriteAuditInput {
  action: string;
  entityType: string;
  entityId: string;
  entityLabel: string;
  summary: string;
  changes?: AuditChange[];
  reason?: string | null;
  /**
   * Who caused it. `user` unless something automated did: a workflow's own writes are marked
   * `workflow` so the workflow engine can refuse to react to them, which is the loop protection.
   */
  actorType?: 'user' | 'system' | 'workflow';
  /**
   * The acting party when it is not the principal: a driver signing a consent from the portal, or
   * the system expiring a link. The principal still scopes the company.
   */
  actor?: { id: string; name: string };
  /** When the change happened, if not now — the seed writes history with its real timestamps. */
  at?: Date;
}

/** The entry as it was written, handed to every listener. */
export interface AuditEvent extends Required<Omit<WriteAuditInput, 'reason' | 'actor' | 'at'>> {
  id: string;
  companyId: string;
  reason: string | null;
  at: Date;
}

export type AuditListener = (event: AuditEvent) => void | Promise<void>;

/**
 * The durable audit trail.
 *
 * One table for the whole product, in the shape docs/DATABASE.md §3.16 commits — not a People-owned
 * log. Before this existed the only audit was an array in the browser, which meant every "who
 * changed this and when" answer disappeared on refresh. An audit that does not survive the thing it
 * is meant to survive is decoration.
 *
 * `changes` records the previous and new value of each field, because "role changed" is not an
 * audit entry; "Dispatcher → Operations Manager, by Sarah Chen, 4 March" is.
 */
@Injectable()
export class AuditService {
  constructor(
    private readonly database: DatabaseService,
    // Optional so a unit test can build the writer alone; in the app it is always there.
    @Optional() private readonly stolen?: StolenUnitsService,
  ) {}

  private readonly listeners: AuditListener[] = [];

  /**
   * Subscribes to entries as they are written.
   *
   * This is the product's event stream, and it is the audit trail rather than a second one beside
   * it. Every state change already records what happened, who did it and the before/after of each
   * field; a parallel `domain_events` table would be the same information, published by the same
   * services, free to drift. Automation therefore reads from here.
   *
   * A listener that throws is logged and swallowed: an automation rule must never be able to fail
   * the business operation that triggered it.
   */
  onWrite(listener: AuditListener): void {
    this.listeners.push(listener);
  }

  async write(principal: Principal, input: WriteAuditInput): Promise<string> {
    const event = await this.writeIn(this.database.db, principal, input);
    await this.publish(event);
    return event.id;
  }

  /**
   * Writes the entry through `tx` — a transaction, so the entry commits or rolls back with the
   * change it describes — and returns it without telling the listeners. Call `publish` with the
   * events once the transaction has committed.
   */
  async writeIn(
    tx: Pick<Database, 'insert'>,
    principal: Principal,
    input: WriteAuditInput,
  ): Promise<AuditEvent> {
    const id = `aud_${crypto.randomUUID()}`;
    const at = input.at ?? new Date();
    const event: AuditEvent = {
      id,
      companyId: principal.companyId,
      actorType: input.actorType ?? 'user',
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      entityLabel: input.entityLabel,
      summary: input.summary,
      changes: input.changes ?? [],
      reason: input.reason ?? null,
      at,
    };

    await tx.insert(auditLogs).values({
      id,
      companyId: principal.companyId,
      actorType: event.actorType,
      actorId: input.actor?.id ?? principal.userId,
      actorName: input.actor?.name ?? principal.userName ?? principal.userId,
      action: input.action,
      entityType: input.entityType,
      entityId: input.entityId,
      entityLabel: input.entityLabel,
      changes: event.changes,
      summary: input.summary,
      reason: event.reason,
      at,
    });
    return event;
  }

  /** Hands written entries to the listeners (after their transaction committed). */
  async publish(...events: AuditEvent[]): Promise<void> {
    for (const event of events) {
      for (const listener of this.listeners) {
        try {
          await listener(event);
        } catch {
          // Deliberately swallowed. The change is recorded; a broken listener is not the caller's
          // problem, and the listener is responsible for recording its own failure.
        }
      }
    }
  }

  /** The timeline for one record, newest first. */
  async forEntity(
    principal: Principal,
    entityType: string,
    entityId: string,
    limit = 100,
  ): Promise<AuditLogRow[]> {
    const rows = await this.database.db
      .select()
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, principal.companyId),
          eq(auditLogs.entityType, entityType),
          eq(auditLogs.entityId, entityId),
        ),
      )
      .orderBy(desc(auditLogs.at))
      .limit(limit);
    // A timeline line about a stolen unit reads "Restricted (stolen unit)" to everyone but an
    // administrator (owner decision); see stolen-privacy.ts.
    return this.stolen ? this.stolen.redactAuditLines(principal, rows) : rows;
  }
}

/** Builds the `changes` array by comparing what was sent against what is stored. */
export function diff<T extends Record<string, unknown>>(
  before: T,
  patch: Partial<T>,
  fields: (keyof T & string)[],
): AuditChange[] {
  const changes: AuditChange[] = [];
  for (const field of fields) {
    if (!(field in patch)) continue;
    const next = patch[field];
    if (next === undefined) continue;
    const prev = before[field];
    if (String(prev ?? '') === String(next ?? '')) continue;
    changes.push({
      field,
      old: prev === null || prev === undefined ? null : String(prev),
      new: next === null ? null : String(next),
    });
  }
  return changes;
}
