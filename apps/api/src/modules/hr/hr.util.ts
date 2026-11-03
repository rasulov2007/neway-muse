import { eq, sql, type Column, type SQL } from 'drizzle-orm';
import type { PgTable } from 'drizzle-orm/pg-core';
import type { DbExecutor } from '../../database/client';
import { AppError } from '../../common/errors/app-error';
import { employees } from '../../database/schema/people';

/**
 * Small pieces every HR service needs, in one place so five modules cannot each grow their own
 * slightly different version of "what is today" or "what is the next number".
 */

/** Today in ISO form. Passed into engines rather than read inside them. */
export function today(): string {
  return new Date().toISOString().slice(0, 10);
}

/**
 * postgres-js returns `numeric` as a string, deliberately — it is the only lossless representation
 * of an arbitrary-precision decimal. Parsed here at the boundary, once.
 */
export function num(value: string | number | null): number | null {
  if (value === null) return null;
  const parsed = typeof value === 'number' ? value : Number.parseFloat(value);
  return Number.isFinite(parsed) ? parsed : null;
}

export function numOr(value: string | number | null, fallback: number): number {
  return num(value) ?? fallback;
}

/**
 * The next human-readable number in a per-company sequence.
 *
 * Derived from the highest existing value rather than a counter, so importing records or deleting a
 * draft cannot leave the sequence pointing at a number already in use.
 */
export async function nextNumber(
  db: DbExecutor,
  table: PgTable,
  numberColumn: Column,
  companyColumn: Column,
  companyId: string,
  prefix: string,
  floor: number,
): Promise<string> {
  const [row] = await db
    .select({
      value: sql<number>`coalesce(max(nullif(regexp_replace(${numberColumn}, '\\D', '', 'g'), '')::bigint), ${floor})::int`,
    })
    .from(table)
    .where(eq(companyColumn, companyId));
  const next = Math.max(row?.value ?? floor, floor) + 1;
  return `${prefix}-${next}`;
}

/**
 * Runs an insert that derives its own number from `nextNumber` again if the first attempt lost a
 * race to the same number. Two recruiters adding a candidate in the same second are rare; a
 * suite of tests seeding in parallel is not, and both deserve the next number, not an error.
 */
export async function retryOnDuplicate<T>(attempt: () => Promise<T>, tries = 3): Promise<T> {
  for (let i = 1; ; i += 1) {
    try {
      return await attempt();
    } catch (error) {
      const code =
        (error as { code?: string }).code ?? (error as { cause?: { code?: string } }).cause?.code;
      if (code !== '23505' || i >= tries) throw error;
    }
  }
}

/**
 * How far an HR reader reaches (owner brief, 2026-10-25).
 *
 * The module's `.manage` code is the HR seat: it reaches the whole company. Anybody else who
 * holds the module's view / approve code - an operations manager approving time off - reaches only
 * their own direct reports: employees whose `manager_employee_id` is the employee record linked to
 * the caller's account - by `employees.user_id` (the imported staff) or by the account's
 * `memberships.employee_id` (accounts opened in Administration). A caller with no linked employee
 * reaches nobody.
 *
 * Returned as a SQL condition on the row's employee column, so it narrows lists, single reads,
 * summaries and the approvals that start with a read, in the same query that already scopes by
 * company.
 */
export function hrReach(principal: { userId: string; companyId: string; permissions: ReadonlySet<string> }, manageCode: string, employeeColumn: Column): SQL {
  if (principal.permissions.has(manageCode)) return sql`true`;
  return sql`${employeeColumn} in (
    select e.id from employees e
     where e.company_id = ${principal.companyId}
       and e.manager_employee_id in (
         select me.id from employees me
          where me.company_id = ${principal.companyId}
            and (me.user_id = ${principal.userId}
                 or me.id in (select m.employee_id from memberships m
                               where m.user_id = ${principal.userId} and m.company_id = ${principal.companyId}
                                 and m.status = 'active' and m.employee_id is not null))))`;
}

/**
 * Every id a request names must be a row of the caller's own company (coordinator finding 3a,
 * 2026-10-25). Employee ids are guessable (emp_<n>), so an id from the body is checked before it is
 * stored or read through: a foreign or unknown id answers 422 and writes nothing. Null / absent ids
 * are skipped (optional references).
 */
export async function assertCompanyRefs(
  db: DbExecutor,
  companyId: string,
  refs: { table: PgTable; idColumn: Column; companyColumn: Column; id: string | null | undefined; label: string }[],
): Promise<void> {
  for (const ref of refs) {
    if (ref.id === null || ref.id === undefined || ref.id === '') continue;
    const [row] = await db
      .select({ one: sql<number>`1` })
      .from(ref.table)
      .where(sql`${ref.idColumn} = ${ref.id} and ${ref.companyColumn} = ${companyId}`)
      .limit(1);
    if (!row) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: `No ${ref.label} ${ref.id} in this company.` });
    }
  }
}

/** Shorthand for an employee reference. */
export function employeeRef(id: string | null | undefined, label = 'employee') {
  return { table: employees, idColumn: employees.id, companyColumn: employees.companyId, id, label };
}
