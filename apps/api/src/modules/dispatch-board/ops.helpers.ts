import { localParts } from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { dispatchAudit } from '../../database/schema/dispatch-ops';

/** What every service in this layer needs: ids, the company's today, the audit line, the errors. */

export function newId(prefix: string): string {
  return `${prefix}_${crypto.randomUUID()}`;
}

export function companyToday(principal: Principal, now: Date): string {
  return localParts(now.toISOString(), principal.companyTimezone)?.date ?? now.toISOString().slice(0, 10);
}

export function forbidden(detail: string): AppError {
  return new AppError({ status: 403, title: 'Forbidden', detail });
}

export function notFound(detail: string): AppError {
  return new AppError({ status: 404, title: 'Not found', detail });
}

export function unprocessable(detail: string): AppError {
  return new AppError({ status: 422, title: 'Unprocessable', detail });
}

export function conflict(detail: string, extra?: Record<string, unknown>): AppError {
  return new AppError({ status: 409, title: 'Conflict', detail, ...(extra ? { extensions: extra } : {}) });
}

type Tx = { insert: (table: typeof dispatchAudit) => { values: (v: typeof dispatchAudit.$inferInsert) => Promise<unknown> } };

/** One audit line: who, when, before, after. The caller passes its transaction. */
export async function audit(
  tx: Tx,
  principal: Pick<Principal, 'companyId' | 'userId' | 'userName'>,
  now: Date,
  entity: string,
  entityId: string,
  action: string,
  before: unknown,
  after: unknown,
): Promise<void> {
  await tx.insert(dispatchAudit).values({
    id: newId('dau'),
    companyId: principal.companyId,
    entity,
    entityId,
    action,
    before: before === null || before === undefined ? null : JSON.stringify(before),
    after: after === null || after === undefined ? null : JSON.stringify(after),
    by: principal.userId,
    byName: principal.userName ?? principal.userId,
    at: now,
  });
}

export function iso(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : String(value);
}
