import { Injectable } from '@nestjs/common';
import { and, asc, count, desc, eq, ilike, inArray, isNull, ne, sql } from 'drizzle-orm';
import type {
  LeadRotation,
  LeadRotationMember,
  RotationExcludeRequest,
  RotationMember,
  RotationSettings,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import type { DbExecutor } from '../../database/client';
import { DatabaseService } from '../../database/database.service';
import { memberships, users } from '../../database/schema/admin';
import {
  hiringLeads,
  hiringRotationMembers,
  hiringRotationState,
  type HiringRotationMemberRow,
  type HiringRotationStateRow,
} from '../../database/schema/hiring';
import { auditLogs, employees, positionHistory } from '../../database/schema/people';

/** The audit action that records an automatic assignment (and the pointer the pre-0048 code read). */
export const AUTO_ASSIGN_ACTION = 'auto_assign';

const RECRUITER_POSITION = /recruit/i;

/** The permission that may reorder or exclude members of the rotation (administrators). */
export const ROTATION_ADMIN_PERMISSION = 'users.edit';

/** The eligibility rule, as Recruiting settings states it. */
export const ROTATION_RULE =
  'An account takes turns when it is active, its membership in this company is active, and it is linked to an employee who is not terminated and whose position names recruiting (Recruiter, Senior Recruiter …). Accounts that newly meet the rule join at the end; excluded or ineligible ones are skipped and keep their place.';

interface LegacyMember extends LeadRotationMember {
  /** `since|createdAt|id`: fixed-width ISO strings, so plain string order is turn order. */
  key: string;
}

interface Eligible {
  userId: string;
  employeeId: string;
  name: string;
  legacyKey: string;
  since: string;
}

interface Loaded {
  members: HiringRotationMemberRow[];
  state: HiringRotationStateRow;
  eligible: Map<string, Eligible>;
}

/**
 * Who gets the next lead that arrives by itself (owner, 2026-10-07; persisted 2026-10-08).
 *
 * Strict turns over a roster kept per company in `hiring_rotation_members`, in its stored order,
 * with the cursor (`hiring_rotation_state`) naming the place that took the last turn. The roster
 * is keyed by the recruiter's account (user id), never a name:
 *
 *   - Eligible = active account, active membership in the company, linked (membership.employee_id,
 *     else employees.user_id) to an employee who is not terminated and whose position names
 *     recruiting. That is the same "recruiter" rule the rest of Recruiting uses, tied to a real
 *     account so the turn can always be traced to a person who can sign in.
 *   - An account that newly meets the rule is appended at the end on the next read or allocation;
 *     nothing about the cursor or older leads changes.
 *   - A member who stops being eligible, or whom an administrator excludes, keeps the row and the
 *     place and is stepped over; the turn after them continues in order.
 *
 * Seeding: the first time a company's rotation is read after 0048, the roster is written from the
 * order the previous code used (when each person became a recruiter) and the cursor from the last
 * `auto_assign` audit entry — so the next recipient is the same before and after the change.
 *
 * Concurrency: every allocation takes a per-company advisory lock inside the caller's transaction,
 * reads and moves the cursor, and writes the `auto_assign` audit entry there; two leads arriving
 * at once take consecutive turns, and a rolled-back intake never consumes one.
 */
@Injectable()
export class LeadRotationService {
  constructor(private readonly database: DatabaseService) {}

  private lock(tx: DbExecutor, companyId: string) {
    return tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`lead-rotation:${companyId}`}))`);
  }

  // ======================================================================= the legacy order

  /**
   * The active recruiter employees in the order the pre-0048 rotation used: the moment each became
   * a recruiter (position history, else the audited position change, else the record). Kept to
   * seed the persisted roster and to stamp `rotationKey` on audit entries, so a rollback to the
   * previous code continues at the right turn.
   */
  async recruiters(db: DbExecutor, companyId: string): Promise<LegacyMember[]> {
    const people = await db
      .select({
        id: employees.id,
        first: employees.firstName,
        last: employees.lastName,
        createdAt: employees.createdAt,
        updatedAt: employees.updatedAt,
      })
      .from(employees)
      .where(
        and(
          eq(employees.companyId, companyId),
          ne(employees.status, 'terminated'),
          ilike(employees.position, '%recruit%'),
        ),
      );
    if (people.length === 0) return [];
    const history = await db
      .select({
        employeeId: positionHistory.employeeId,
        position: positionHistory.position,
        createdAt: positionHistory.createdAt,
      })
      .from(positionHistory)
      .where(
        and(
          eq(positionHistory.companyId, companyId),
          inArray(
            positionHistory.employeeId,
            people.map((p) => p.id),
          ),
        ),
      )
      .orderBy(asc(positionHistory.createdAt), asc(positionHistory.id));

    const since = new Map<string, Date | null>();
    for (const row of history) {
      const isRecruiter = RECRUITER_POSITION.test(row.position);
      if (!isRecruiter) since.set(row.employeeId, null);
      else if (!since.get(row.employeeId)) since.set(row.employeeId, row.createdAt);
    }
    const moves = await db
      .select({ employeeId: auditLogs.entityId, at: auditLogs.at, changes: auditLogs.changes })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, companyId),
          eq(auditLogs.entityType, 'employee'),
          inArray(
            auditLogs.entityId,
            people.map((p) => p.id),
          ),
          sql`${auditLogs.changes} @> '[{"field":"position"}]'::jsonb`,
        ),
      )
      .orderBy(asc(auditLogs.at), asc(auditLogs.id));
    const audited = new Map<string, Date | null>();
    for (const move of moves) {
      const change = ((move.changes as { field: string; new: string | null }[] | null) ?? []).find(
        (c) => c.field === 'position',
      );
      if (!change) continue;
      if (!RECRUITER_POSITION.test(change.new ?? '')) audited.set(move.employeeId, null);
      else if (!audited.get(move.employeeId)) audited.set(move.employeeId, move.at);
    }
    const hasHistory = new Set(history.map((h) => h.employeeId));
    return people
      .map((p) => {
        const at =
          since.get(p.id) ??
          audited.get(p.id) ??
          (hasHistory.has(p.id) ? p.updatedAt : p.createdAt);
        return {
          employeeId: p.id,
          name: `${p.first} ${p.last}`.trim(),
          since: at.toISOString(),
          key: `${at.toISOString()}|${p.createdAt.toISOString()}|${p.id}`,
        };
      })
      .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  }

  /** The most recent automatic assignment in the company: the pre-0048 pointer. */
  private async lastAudited(db: DbExecutor, companyId: string) {
    const [row] = await db
      .select({ at: auditLogs.at, changes: auditLogs.changes, entityId: auditLogs.entityId })
      .from(auditLogs)
      .where(
        and(
          eq(auditLogs.companyId, companyId),
          eq(auditLogs.entityType, 'lead'),
          eq(auditLogs.action, AUTO_ASSIGN_ACTION),
        ),
      )
      .orderBy(desc(auditLogs.at), desc(auditLogs.id))
      .limit(1);
    if (!row) return null;
    const changes = (row.changes as { field: string; new: string | null }[] | null) ?? [];
    const value = (field: string) => changes.find((c) => c.field === field)?.new ?? null;
    const employeeId = value('recruiterEmployeeId');
    if (!employeeId) return null;
    return { at: row.at, employeeId, leadId: row.entityId, name: value('recruiter') ?? employeeId, key: value('rotationKey') };
  }

  // ============================================================================ eligibility

  /** Recruiter accounts that meet the rule now, in the legacy order (the seed order). */
  async eligible(db: DbExecutor, companyId: string): Promise<Eligible[]> {
    const order = await this.recruiters(db, companyId);
    if (order.length === 0) return [];
    const employeeIds = order.map((m) => m.employeeId);
    // The membership's own link first (Administration › Users), then an employee that names the user.
    const viaMembership = await db
      .select({ userId: memberships.userId, employeeId: memberships.employeeId })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(
        and(
          eq(memberships.companyId, companyId),
          eq(memberships.status, 'active'),
          eq(users.isActive, true),
          inArray(memberships.employeeId, employeeIds),
        ),
      );
    const viaUser = await db
      .select({ userId: employees.userId, employeeId: employees.id })
      .from(employees)
      .innerJoin(
        memberships,
        and(eq(memberships.userId, employees.userId), eq(memberships.companyId, companyId)),
      )
      .innerJoin(users, eq(users.id, employees.userId))
      .where(
        and(
          eq(employees.companyId, companyId),
          inArray(employees.id, employeeIds),
          eq(memberships.status, 'active'),
          eq(users.isActive, true),
        ),
      );
    const userOf = new Map<string, string>();
    for (const r of viaUser) if (r.userId && r.employeeId) userOf.set(r.employeeId, r.userId);
    for (const r of viaMembership) if (r.employeeId) userOf.set(r.employeeId, r.userId);
    const seenUsers = new Set<string>();
    const out: Eligible[] = [];
    for (const m of order) {
      const userId = userOf.get(m.employeeId);
      if (!userId || seenUsers.has(userId)) continue;
      seenUsers.add(userId);
      out.push({ userId, employeeId: m.employeeId, name: m.name, legacyKey: m.key, since: m.since });
    }
    return out;
  }

  // ======================================================================== roster + cursor

  /**
   * The roster and cursor, seeded on first use and with newly eligible accounts appended. Must run
   * under the company's rotation lock.
   */
  private async load(tx: DbExecutor, companyId: string, actor: { id: string; name: string }): Promise<Loaded> {
    const eligibleList = await this.eligible(tx, companyId);
    const eligible = new Map(eligibleList.map((e) => [e.userId, e]));
    let [state] = await tx
      .select()
      .from(hiringRotationState)
      .where(eq(hiringRotationState.companyId, companyId))
      .limit(1);
    const now = new Date();
    if (!state) {
      const legacy = await this.lastAudited(tx, companyId);
      const rows = eligibleList.map((e, i) => ({
        id: `rot_${crypto.randomUUID()}`,
        companyId,
        userId: e.userId,
        employeeId: e.employeeId,
        position: i + 1,
        joinedVia: 'seed_legacy',
        joinedAt: now,
        updatedAt: now,
      }));
      if (rows.length > 0) await tx.insert(hiringRotationMembers).values(rows);
      const lastMember = legacy ? rows.find((r) => r.employeeId === legacy.employeeId) : undefined;
      // The legacy pointer's member left the order: start where the old code would have — after
      // the place its key held — by taking the last member whose legacy key sorts before it.
      let lastPosition: number | null = lastMember?.position ?? null;
      if (legacy && !lastMember && legacy.key) {
        const before = eligibleList.filter((e) => e.legacyKey <= (legacy.key as string));
        lastPosition = before.length > 0 ? before.length : 0;
      }
      [state] = await tx
        .insert(hiringRotationState)
        .values({
          companyId,
          lastUserId: lastMember?.userId ?? null,
          lastEmployeeId: legacy?.employeeId ?? null,
          lastPosition,
          lastLeadId: legacy?.leadId ?? null,
          lastAssignedAt: legacy?.at ?? null,
          seededAt: now,
          seededFrom: legacy ? `legacy_rotation:last_auto_assign=${legacy.employeeId}` : 'legacy_rotation:no_previous_turn',
          version: 1,
          updatedAt: now,
        })
        .returning();
      await tx.insert(auditLogs).values({
        id: `aud_${crypto.randomUUID()}`,
        companyId,
        actorType: 'system',
        actorId: actor.id,
        actorName: actor.name,
        action: 'rotation_seeded',
        entityType: 'hiring_rotation',
        entityId: companyId,
        entityLabel: 'HR rotation',
        summary: `HR rotation stored: ${eligibleList.map((e) => e.name).join(', ') || 'no eligible recruiter'}${legacy ? `; last turn ${legacy.name}` : ''}`,
        changes: rows.map((r) => ({ field: `position_${r.position}`, old: null, new: r.userId })),
        reason: null,
        at: now,
      });
    }
    let members = await tx
      .select()
      .from(hiringRotationMembers)
      .where(eq(hiringRotationMembers.companyId, companyId))
      .orderBy(asc(hiringRotationMembers.position), asc(hiringRotationMembers.id));
    const known = new Map(members.map((m) => [m.userId, m]));
    let max = members.reduce((n, m) => Math.max(n, m.position), 0);
    const joined: Eligible[] = [];
    for (const e of eligibleList) {
      const existing = known.get(e.userId);
      if (!existing) {
        max += 1;
        await tx.insert(hiringRotationMembers).values({
          id: `rot_${crypto.randomUUID()}`,
          companyId,
          userId: e.userId,
          employeeId: e.employeeId,
          position: max,
          joinedVia: 'auto_join',
          joinedAt: now,
          updatedAt: now,
        });
        joined.push(e);
      } else if (existing.employeeId !== e.employeeId) {
        // The account was relinked to another recruiter employee: the turn follows the account.
        await tx
          .update(hiringRotationMembers)
          .set({ employeeId: e.employeeId, updatedAt: now })
          .where(eq(hiringRotationMembers.id, existing.id));
      }
    }
    if (joined.length > 0) {
      for (const e of joined) {
        await tx.insert(auditLogs).values({
          id: `aud_${crypto.randomUUID()}`,
          companyId,
          actorType: 'system',
          actorId: actor.id,
          actorName: actor.name,
          action: 'rotation_joined',
          entityType: 'hiring_rotation',
          entityId: companyId,
          entityLabel: 'HR rotation',
          summary: `${e.name} joined the HR rotation at the end`,
          changes: [{ field: 'member', old: null, new: e.userId }],
          reason: null,
          at: now,
        });
      }
    }
    if (joined.length > 0 || members.some((m) => eligible.get(m.userId) && eligible.get(m.userId)?.employeeId !== m.employeeId)) {
      members = await tx
        .select()
        .from(hiringRotationMembers)
        .where(eq(hiringRotationMembers.companyId, companyId))
        .orderBy(asc(hiringRotationMembers.position), asc(hiringRotationMembers.id));
    }
    return { members, state: state as HiringRotationStateRow, eligible };
  }

  /** The next member to take a turn: after the cursor's place, wrapping, skipping the unavailable. */
  private pick(loaded: Loaded): HiringRotationMemberRow | null {
    const available = loaded.members.filter((m) => !m.excluded && loaded.eligible.has(m.userId));
    if (available.length === 0) return null;
    const after = loaded.state.lastPosition;
    if (after === null || after === undefined) return available[0] ?? null;
    return available.find((m) => m.position > after) ?? available[0] ?? null;
  }

  private nameOf(loaded: Loaded, m: HiringRotationMemberRow): string {
    return loaded.eligible.get(m.userId)?.name ?? m.employeeId;
  }

  /**
   * Takes the next turn for a lead just created in `tx`, and records it there. Returns the
   * recruiter, or null (the lead stays unassigned) when nobody is eligible.
   */
  async assignNext(
    tx: DbExecutor,
    companyId: string,
    lead: { id: string; label: string },
    actor: { id: string; name: string; type: 'system' | 'user' },
    channel: 'online_application' | 'manual',
  ): Promise<{ employeeId: string; name: string } | null> {
    await this.lock(tx, companyId);
    const loaded = await this.load(tx, companyId, actor);
    const next = this.pick(loaded);
    if (!next) return null;
    const name = this.nameOf(loaded, next);
    const legacyKey = loaded.eligible.get(next.userId)?.legacyKey ?? null;
    const last = await this.lastAudited(tx, companyId);
    // Strictly after the previous turn, so "the latest entry" is never a tie.
    const now = new Date();
    const at = last && last.at.getTime() >= now.getTime() ? new Date(last.at.getTime() + 1) : now;
    const available = loaded.members.filter((m) => !m.excluded && loaded.eligible.has(m.userId));
    const turn = available.findIndex((m) => m.userId === next.userId) + 1;
    await tx
      .update(hiringRotationState)
      .set({
        lastUserId: next.userId,
        lastEmployeeId: next.employeeId,
        lastPosition: next.position,
        lastLeadId: lead.id,
        lastAssignedAt: at,
        version: sql`${hiringRotationState.version} + 1`,
        updatedAt: at,
      })
      .where(eq(hiringRotationState.companyId, companyId));
    await tx.insert(auditLogs).values({
      id: `aud_${crypto.randomUUID()}`,
      companyId,
      actorType: actor.type,
      actorId: actor.id,
      actorName: actor.name,
      action: AUTO_ASSIGN_ACTION,
      entityType: 'lead',
      entityId: lead.id,
      entityLabel: lead.label,
      summary: `Recruiter ${name} assigned automatically (turn ${turn} of ${available.length})`,
      changes: [
        { field: 'recruiterEmployeeId', old: null, new: next.employeeId },
        { field: 'recruiter', old: null, new: name },
        // The pre-0048 code's place key, so a rollback continues at the right turn.
        { field: 'rotationKey', old: last?.key ?? null, new: legacyKey },
        { field: 'recruiterUserId', old: loaded.state.lastUserId ?? null, new: next.userId },
        { field: 'rotationPosition', old: loaded.state.lastPosition === null ? null : String(loaded.state.lastPosition), new: String(next.position) },
        { field: 'channel', old: null, new: channel },
      ],
      reason: null,
      at,
    });
    return { employeeId: next.employeeId, name };
  }

  /** Runs `fn` with the roster loaded under the lock, in its own transaction. */
  private async withRoster<T>(principal: Principal, fn: (tx: DbExecutor, loaded: Loaded) => Promise<T>): Promise<T> {
    return this.database.db.transaction(async (tx) => {
      await this.lock(tx, principal.companyId);
      const loaded = await this.load(tx, principal.companyId, {
        id: principal.userId,
        name: principal.userName ?? principal.userId,
      });
      return fn(tx, loaded);
    });
  }

  /** The rotation as the Leads line and older screens read it: order, last turn, next. */
  async describe(principal: Principal): Promise<LeadRotation> {
    return this.withRoster(principal, async (_tx, loaded) => {
      const available = loaded.members.filter((m) => !m.excluded && loaded.eligible.has(m.userId));
      const strip = (m: HiringRotationMemberRow): LeadRotationMember => ({
        employeeId: m.employeeId,
        name: this.nameOf(loaded, m),
        since: loaded.eligible.get(m.userId)?.since ?? m.joinedAt.toISOString(),
      });
      const next = this.pick(loaded);
      const lastMember = loaded.members.find((m) => m.userId === loaded.state.lastUserId);
      return {
        recruiters: available.map(strip),
        next: next ? strip(next) : null,
        last:
          loaded.state.lastEmployeeId && loaded.state.lastAssignedAt
            ? {
                employeeId: loaded.state.lastEmployeeId,
                name: lastMember ? this.nameOf(loaded, lastMember) : loaded.state.lastEmployeeId,
                at: loaded.state.lastAssignedAt.toISOString(),
              }
            : null,
      };
    });
  }

  /** Who would take the next turn right now (informational: the allocation decides). */
  async preview(principal: Principal): Promise<{ employeeId: string; name: string } | null> {
    return this.withRoster(principal, async (_tx, loaded) => {
      const next = this.pick(loaded);
      return next ? { employeeId: next.employeeId, name: this.nameOf(loaded, next) } : null;
    });
  }

  /** Recruiting settings › HR rotation. */
  async settings(principal: Principal): Promise<RotationSettings> {
    return this.withRoster(principal, async (tx, loaded) => {
      const ineligibleWhy = await this.reasons(tx, principal.companyId, loaded);
      const members: RotationMember[] = loaded.members.map((m) => ({
        userId: m.userId,
        employeeId: m.employeeId,
        name: loaded.eligible.get(m.userId)?.name ?? ineligibleWhy.get(m.userId)?.name ?? m.employeeId,
        position: m.position,
        excluded: m.excluded,
        excludedReason: m.excludeReason,
        eligible: loaded.eligible.has(m.userId),
        ineligibleReason: loaded.eligible.has(m.userId) ? null : (ineligibleWhy.get(m.userId)?.why ?? 'No longer meets the rule'),
        joinedAt: m.joinedAt.toISOString(),
        joinedVia: m.joinedVia,
      }));
      const next = this.pick(loaded);
      const lastMember = loaded.members.find((m) => m.userId === loaded.state.lastUserId);
      const [unassigned] = await tx
        .select({ value: count() })
        .from(hiringLeads)
        .where(
          and(
            eq(hiringLeads.companyId, principal.companyId),
            eq(hiringLeads.isTest, false),
            isNull(hiringLeads.recruiterEmployeeId),
            ne(hiringLeads.status, 'dead'),
            ne(hiringLeads.status, 'converted'),
          ),
        );
      return {
        members,
        next: next ? { userId: next.userId, employeeId: next.employeeId, name: this.nameOf(loaded, next) } : null,
        last: {
          userId: loaded.state.lastUserId,
          employeeId: loaded.state.lastEmployeeId,
          name: lastMember ? members.find((m) => m.userId === lastMember.userId)?.name ?? null : null,
          at: loaded.state.lastAssignedAt?.toISOString() ?? null,
        },
        unassignedWarning: next === null,
        unassignedLeads: unassigned?.value ?? 0,
        canManage: principal.permissions.has(ROTATION_ADMIN_PERMISSION),
        rule: ROTATION_RULE,
      };
    });
  }

  /** Why each ineligible member is not taking turns, and their name, for the settings page. */
  private async reasons(tx: DbExecutor, companyId: string, loaded: Loaded) {
    const out = new Map<string, { name: string; why: string }>();
    const missing = loaded.members.filter((m) => !loaded.eligible.has(m.userId));
    for (const m of missing) {
      const [emp] = await tx
        .select({ first: employees.firstName, last: employees.lastName, status: employees.status, position: employees.position })
        .from(employees)
        .where(and(eq(employees.companyId, companyId), eq(employees.id, m.employeeId)))
        .limit(1);
      const [acct] = await tx
        .select({ status: memberships.status, active: users.isActive })
        .from(memberships)
        .innerJoin(users, eq(users.id, memberships.userId))
        .where(and(eq(memberships.companyId, companyId), eq(memberships.userId, m.userId)))
        .limit(1);
      const why = !acct
        ? 'No account in this company'
        : !acct.active
          ? 'Account disabled'
          : acct.status !== 'active'
            ? `Membership ${acct.status}`
            : !emp
              ? 'Employee record not found'
              : emp.status === 'terminated'
                ? 'Employee terminated'
                : !RECRUITER_POSITION.test(emp.position)
                  ? `Position is ${emp.position}`
                  : 'Account no longer linked to the employee';
      out.set(m.userId, { name: emp ? `${emp.first} ${emp.last}`.trim() : m.employeeId, why });
    }
    return out;
  }

  private assertAdmin(principal: Principal) {
    if (!principal.permissions.has(ROTATION_ADMIN_PERMISSION)) {
      throw new AppError({ status: 403, title: 'Forbidden', detail: 'Only an administrator can change the HR rotation.' });
    }
  }

  /** Reorders the roster (administrators). The cursor keeps pointing at the same person's new place. */
  async reorder(principal: Principal, userIds: string[]): Promise<RotationSettings> {
    this.assertAdmin(principal);
    await this.withRoster(principal, async (tx, loaded) => {
      const current = loaded.members.map((m) => m.userId);
      const same = current.length === userIds.length && new Set(userIds).size === userIds.length && userIds.every((u) => current.includes(u));
      if (!same) {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          detail: 'The rotation changed while you were editing it. Reload and try again.',
        });
      }
      const now = new Date();
      // Two passes so the positions never collide mid-update.
      for (const [i, userId] of userIds.entries()) {
        await tx
          .update(hiringRotationMembers)
          .set({ position: 10_000 + i + 1, updatedAt: now })
          .where(and(eq(hiringRotationMembers.companyId, principal.companyId), eq(hiringRotationMembers.userId, userId)));
      }
      for (const [i, userId] of userIds.entries()) {
        await tx
          .update(hiringRotationMembers)
          .set({ position: i + 1, updatedAt: now })
          .where(and(eq(hiringRotationMembers.companyId, principal.companyId), eq(hiringRotationMembers.userId, userId)));
      }
      const lastIndex = loaded.state.lastUserId ? userIds.indexOf(loaded.state.lastUserId) : -1;
      await tx
        .update(hiringRotationState)
        .set({
          lastPosition: lastIndex >= 0 ? lastIndex + 1 : loaded.state.lastPosition,
          version: sql`${hiringRotationState.version} + 1`,
          updatedAt: now,
        })
        .where(eq(hiringRotationState.companyId, principal.companyId));
      const names = (ids: string[]) => ids.map((u) => loaded.eligible.get(u)?.name ?? u).join(', ');
      await tx.insert(auditLogs).values({
        id: `aud_${crypto.randomUUID()}`,
        companyId: principal.companyId,
        actorType: 'user',
        actorId: principal.userId,
        actorName: principal.userName ?? principal.userId,
        action: 'rotation_reordered',
        entityType: 'hiring_rotation',
        entityId: principal.companyId,
        entityLabel: 'HR rotation',
        summary: `HR rotation order set to ${names(userIds)}`,
        changes: [{ field: 'order', old: names(current), new: names(userIds) }],
        reason: null,
        at: now,
      });
    });
    return this.settings(principal);
  }

  /** Excludes or restores one member (administrators). Excluded members keep their place. */
  async setExcluded(principal: Principal, userId: string, input: RotationExcludeRequest): Promise<RotationSettings> {
    this.assertAdmin(principal);
    await this.withRoster(principal, async (tx, loaded) => {
      const member = loaded.members.find((m) => m.userId === userId);
      if (!member) throw new AppError({ status: 404, title: 'Not Found', detail: 'That account is not in the rotation' });
      if (member.excluded === input.excluded) return;
      const now = new Date();
      await tx
        .update(hiringRotationMembers)
        .set({
          excluded: input.excluded,
          excludedAt: input.excluded ? now : null,
          excludedBy: input.excluded ? (principal.userName ?? principal.userId) : null,
          excludeReason: input.excluded ? input.reason : null,
          updatedAt: now,
        })
        .where(eq(hiringRotationMembers.id, member.id));
      await tx
        .update(hiringRotationState)
        .set({ version: sql`${hiringRotationState.version} + 1`, updatedAt: now })
        .where(eq(hiringRotationState.companyId, principal.companyId));
      const name = loaded.eligible.get(userId)?.name ?? member.employeeId;
      await tx.insert(auditLogs).values({
        id: `aud_${crypto.randomUUID()}`,
        companyId: principal.companyId,
        actorType: 'user',
        actorId: principal.userId,
        actorName: principal.userName ?? principal.userId,
        action: input.excluded ? 'rotation_excluded' : 'rotation_included',
        entityType: 'hiring_rotation',
        entityId: principal.companyId,
        entityLabel: 'HR rotation',
        summary: input.excluded ? `${name} excluded from the HR rotation` : `${name} back in the HR rotation`,
        changes: [{ field: 'excluded', old: String(member.excluded), new: String(input.excluded) }],
        reason: input.reason,
        at: now,
      });
    });
    return this.settings(principal);
  }

  /**
   * The employee the signed-in account is, if any: the account's membership link first (set in
   * Administration › Users), then an employee record that names the user. Same company only.
   */
  async ownEmployee(
    principal: Principal,
  ): Promise<{ employeeId: string; name: string; isRecruiter: boolean } | null> {
    const db = this.database.db;
    const pick = { id: employees.id, first: employees.firstName, last: employees.lastName, position: employees.position, status: employees.status };
    const [viaMembership] = await db
      .select(pick)
      .from(memberships)
      .innerJoin(
        employees,
        and(eq(employees.id, memberships.employeeId), eq(employees.companyId, principal.companyId)),
      )
      .where(and(eq(memberships.companyId, principal.companyId), eq(memberships.userId, principal.userId)))
      .limit(1);
    const [viaUser] = viaMembership
      ? [viaMembership]
      : await db
          .select(pick)
          .from(employees)
          .where(and(eq(employees.companyId, principal.companyId), eq(employees.userId, principal.userId)))
          .orderBy(asc(employees.id))
          .limit(1);
    if (!viaUser) return null;
    return {
      employeeId: viaUser.id,
      name: `${viaUser.first} ${viaUser.last}`.trim(),
      isRecruiter: viaUser.status !== 'terminated' && RECRUITER_POSITION.test(viaUser.position),
    };
  }
}
