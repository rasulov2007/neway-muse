import { Injectable } from '@nestjs/common';
import { and, asc, count, eq, ilike, inArray, ne, or, sql } from 'drizzle-orm';
import { ACCOUNT_STATUSES, ADMIN_CRITICAL_PERMISSIONS, profileGateApplies } from '@neway/shared';
import { selfProfileEnabled } from '../../common/auth/profile-gate';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import {
  memberships,
  membershipRoles,
  rolePermissions,
  roles,
  users,
} from '../../database/schema/admin';
import { employees } from '../../database/schema/people';
import { AuditService } from '../people/audit.service';
import { AuthService } from '../auth/auth.service';
import { generateTemporaryPassword, hashPassword } from '../auth/password.util';

/**
 * What creating an account (or reissuing a credential) hands back.
 *
 * `temporaryPassword` appears in this one response and nowhere else: the database keeps only a
 * scrypt hash, so once the administrator dismisses the dialog nothing in the system can say what
 * it was. The credential opens the login screen and nothing else until it is replaced.
 */
export interface CreatedAccount {
  account: AccountRecord;
  /** Null when an existing person was added to this company: they keep their own password. */
  temporaryPassword: string | null;
  /** True when the email already signed in elsewhere and was added to this company. */
  addedExisting?: boolean;
}

export interface AccountRecord {
  membershipId: string;
  userId: string;
  name: string;
  email: string;
  phone: string | null;
  status: string;
  isOwner: boolean;
  mfaEnabled: boolean;
  /** Whether this person can sign in at all. The password itself is never read back. */
  hasPassword: boolean;
  employeeId: string | null;
  employeeName: string | null;
  employeeNumber: string | null;
  department: string | null;
  roles: { id: string; code: string; name: string }[];
  /** Complete your profile (2026-10-26). */
  profileStatus: 'complete' | 'pending' | 'exempt';
  profileCompletedAt: string | null;
  invitedAt: string | null;
  acceptedAt: string | null;
  lastLoginAt: string | null;
  createdAt: string;
}

/**
 * Accounts.
 *
 * A user is a person who can sign in; a membership is that person's access to one company. Both
 * are kept apart from the employee record, so an administrator with no employment file and a driver
 * with no login are both ordinary cases rather than exceptions.
 *
 * The rule this service exists to enforce is the lockout guard: a company must always retain at
 * least one enabled account that can administer it. Every path that could remove the last one —
 * suspending, disabling, or stripping its roles — is refused with the reason.
 */
@Injectable()
export class UsersService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  private get db() {
    return this.database.db;
  }

  private async rolesFor(membershipIds: string[]) {
    if (membershipIds.length === 0) return new Map<string, AccountRecord['roles']>();
    const rows = await this.db
      .select({
        membershipId: membershipRoles.membershipId,
        id: roles.id,
        code: roles.code,
        name: roles.name,
      })
      .from(membershipRoles)
      .innerJoin(roles, eq(membershipRoles.roleId, roles.id))
      .where(inArray(membershipRoles.membershipId, membershipIds));

    const byMembership = new Map<string, AccountRecord['roles']>();
    for (const row of rows) {
      const list = byMembership.get(row.membershipId) ?? [];
      list.push({ id: row.id, code: row.code, name: row.name });
      byMembership.set(row.membershipId, list);
    }
    return byMembership;
  }

  async list(
    principal: Principal,
    query: {
      page: number;
      pageSize: number;
      search?: string;
      status?: string;
      roleId?: string;
      department?: string;
      profile?: 'pending';
    },
  ): Promise<{ data: AccountRecord[]; total: number; page: number; pageSize: number }> {
    const parts = [eq(memberships.companyId, principal.companyId)];
    const gateOn = await selfProfileEnabled(this.db, principal.companyId);
    if (query.profile === 'pending') {
      // Who still has to complete their own profile: the same rule the gate applies, in SQL.
      parts.push(gateOn ? UsersService.profilePending() : sql`false`);
    }
    if (query.status) parts.push(eq(memberships.status, query.status));
    // Archived accounts leave the list unless asked for by name (owner, 2026-10-05).
    else parts.push(ne(memberships.status, 'archived'));
    if (query.department) parts.push(eq(employees.department, query.department));
    if (query.search) {
      const term = `%${query.search}%`;
      const match = or(
        ilike(users.firstName, term),
        // "DAVID MCKAY": the whole name, spaces collapsed (owner, 2026-10-26).
        sql`(${users.firstName} || ' ' || ${users.lastName}) ilike ${`%${query.search.trim().replace(/\s+/g, ' ')}%`}`,
        ilike(users.lastName, term),
        ilike(users.email, term),
        ilike(memberships.userId, term),
        ilike(employees.employeeNumber, term),
      );
      if (match) parts.push(match);
    }
    if (query.roleId) {
      parts.push(
        sql`exists (select 1 from ${membershipRoles} mr where mr.membership_id = ${memberships.id} and mr.role_id = ${query.roleId})`,
      );
    }
    const where = and(...parts);

    const [counted] = await this.db
      .select({ value: count() })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .leftJoin(employees, eq(memberships.employeeId, employees.id))
      .where(where);

    const rows = await this.db
      .select({
        membership: memberships,
        user: users,
        employeeName: sql<string | null>`${employees.firstName} || ' ' || ${employees.lastName}`,
        employeeNumber: employees.employeeNumber,
        department: employees.department,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .leftJoin(employees, eq(memberships.employeeId, employees.id))
      .where(where)
      .orderBy(asc(users.lastName), asc(users.firstName))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);

    const roleMap = await this.rolesFor(rows.map((r) => r.membership.id));
    const withRecord = await this.usersWithEmployee(principal.companyId, rows.map((r) => r.user.id));

    return {
      data: rows.map((row) =>
        this.toRecord(row, roleMap.get(row.membership.id) ?? [], { gateOn, withRecord }),
      ),
      total: counted?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  private toRecord(
    row: {
      membership: typeof memberships.$inferSelect;
      user: typeof users.$inferSelect;
      employeeName: string | null;
      employeeNumber: string | null;
      department: string | null;
    },
    assigned: AccountRecord['roles'],
    gate: { gateOn: boolean; withRecord: Set<string> },
  ): AccountRecord {
    const exempt =
      !gate.gateOn ||
      row.membership.isOwner ||
      row.user.isPlatformAdmin ||
      assigned.some((r) => r.code === 'administrator');
    const profileStatus: AccountRecord['profileStatus'] = exempt
      ? 'exempt'
      : profileGateApplies({
            enabled: true,
            roles: assigned.map((r) => r.code),
            isOwner: row.membership.isOwner,
            isPlatformAdmin: row.user.isPlatformAdmin,
            hasEmployee: Boolean(row.membership.employeeId) || gate.withRecord.has(row.user.id),
            completedAt: row.membership.profileCompletedAt,
          })
        ? 'pending'
        : 'complete';
    return {
      profileStatus,
      profileCompletedAt: row.membership.profileCompletedAt?.toISOString() ?? null,
      membershipId: row.membership.id,
      userId: row.user.id,
      name: `${row.user.firstName} ${row.user.lastName}`.trim(),
      email: row.user.email,
      phone: row.user.phone,
      status: row.membership.status,
      isOwner: row.membership.isOwner,
      mfaEnabled: row.user.mfaEnabled,
      hasPassword: Boolean(row.user.passwordHash),
      employeeId: row.membership.employeeId,
      employeeName: row.employeeName,
      employeeNumber: row.employeeNumber,
      department: row.department,
      roles: assigned,
      invitedAt: row.membership.invitedAt?.toISOString() ?? null,
      acceptedAt: row.membership.acceptedAt?.toISOString() ?? null,
      lastLoginAt: row.user.lastLoginAt?.toISOString() ?? null,
      createdAt: row.membership.createdAt.toISOString(),
    };
  }

  async get(principal: Principal, membershipId: string): Promise<AccountRecord> {
    const [row] = await this.db
      .select({
        membership: memberships,
        user: users,
        employeeName: sql<string | null>`${employees.firstName} || ' ' || ${employees.lastName}`,
        employeeNumber: employees.employeeNumber,
        department: employees.department,
      })
      .from(memberships)
      .innerJoin(users, eq(memberships.userId, users.id))
      .leftJoin(employees, eq(memberships.employeeId, employees.id))
      .where(and(eq(memberships.companyId, principal.companyId), eq(memberships.id, membershipId)))
      .limit(1);
    if (!row) {
      throw new AppError({ status: 404, title: 'Not Found', detail: `No account ${membershipId}` });
    }
    const roleMap = await this.rolesFor([row.membership.id]);
    return this.toRecord(row, roleMap.get(row.membership.id) ?? [], {
      gateOn: await selfProfileEnabled(this.db, principal.companyId),
      withRecord: await this.usersWithEmployee(principal.companyId, [row.user.id]),
    });
  }

  /** Users who own an employee record in this company through `employees.user_id`. */
  private async usersWithEmployee(companyId: string, userIds: string[]): Promise<Set<string>> {
    if (userIds.length === 0) return new Set();
    const rows = await this.db
      .select({ userId: employees.userId })
      .from(employees)
      .where(and(eq(employees.companyId, companyId), inArray(employees.userId, userIds)));
    return new Set(rows.map((r) => r.userId).filter((u): u is string => u !== null));
  }

  /** SQL twin of `profileGateApplies` for the "has not completed" filter (gate on). */
  private static profilePending() {
    return sql`(${memberships.employeeId} is null
      and ${memberships.profileCompletedAt} is null
      and ${memberships.isOwner} = false
      and ${users.isPlatformAdmin} = false
      and not exists (select 1 from ${employees} e where e.company_id = ${memberships.companyId} and e.user_id = ${memberships.userId})
      and not exists (select 1 from ${membershipRoles} mr join ${roles} r on r.id = mr.role_id
                      where mr.membership_id = ${memberships.id} and r.code = 'administrator'))`;
  }

  /** Every permission this account actually holds, from every role assigned to it. */
  async effectivePermissions(principal: Principal, membershipId: string): Promise<string[]> {
    await this.get(principal, membershipId);
    const rows = await this.db
      .selectDistinct({ code: rolePermissions.permissionCode })
      .from(membershipRoles)
      .innerJoin(rolePermissions, eq(membershipRoles.roleId, rolePermissions.roleId))
      .where(eq(membershipRoles.membershipId, membershipId));
    return rows.map((r) => r.code).sort();
  }

  async create(
    principal: Principal,
    input: {
      firstName: string;
      lastName: string;
      email: string;
      phone: string | null;
      employeeId: string | null;
      roleIds: string[];
      invite: boolean;
    },
  ): Promise<CreatedAccount> {
    const email = input.email.trim().toLowerCase();

    const [existingUser] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    if (existingUser) {
      const [alreadyHere] = await this.db
        .select({ id: memberships.id })
        .from(memberships)
        .where(
          and(
            eq(memberships.companyId, principal.companyId),
            eq(memberships.userId, existingUser.id),
          ),
        )
        .limit(1);
      if (alreadyHere) {
        throw new AppError({ status: 409, title: 'Conflict', detail: `${email} already has an account in this company` });
      }
      // One person, one login (owner, 2026-10-13): somebody who already signs in to another
      // company is added to this one with the same email and password, and switches company in
      // the top bar.
      return this.addExisting(principal, existingUser.id, email, input);
    }

    if (input.employeeId) {
      const [employee] = await this.db
        .select({ id: employees.id })
        .from(employees)
        .where(
          and(eq(employees.companyId, principal.companyId), eq(employees.id, input.employeeId)),
        )
        .limit(1);
      if (!employee) {
        throw new AppError({
          status: 422,
          title: 'Unprocessable Entity',
          detail: 'That employee is not on this workforce',
        });
      }
      const [taken] = await this.db
        .select({ id: memberships.id })
        .from(memberships)
        .where(eq(memberships.employeeId, input.employeeId))
        .limit(1);
      if (taken) {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          detail: 'That employee already has an account. One person, one login.',
        });
      }
    }

    const userId = `usr_${crypto.randomUUID()}`;
    const membershipId = `mbr_${crypto.randomUUID()}`;
    const now = new Date();

    // The credential is created with the account, in the same transaction: an account that cannot
    // be signed into is not an account, and the previous behaviour (no password, no invitation
    // token, no email) meant every new user had to be rescued by hand.
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);

    await this.db.transaction(async (tx) => {
      await tx.insert(users).values({
        id: userId,
        email,
        firstName: input.firstName.trim(),
        lastName: input.lastName.trim(),
        phone: input.phone,
        passwordHash,
        mustChangePassword: true,
        isActive: true,
      });
      await tx.insert(memberships).values({
        id: membershipId,
        companyId: principal.companyId,
        userId,
        employeeId: input.employeeId,
        // An account with no invitation sent is `invited` and cannot sign in either way; the
        // status describes the record, not a promise that an email left the building.
        status: 'invited',
        invitedByUserId: principal.userId,
        invitedAt: input.invite ? now : null,
        invitationExpiresAt: input.invite ? new Date(now.getTime() + 7 * 24 * 3600 * 1000) : null,
      });
      if (input.roleIds.length > 0) {
        await tx.insert(membershipRoles).values(
          input.roleIds.map((roleId) => ({
            membershipId,
            roleId,
            assignedByName: principal.userName ?? principal.userId,
          })),
        );
      }
    });

    await this.audit.write(principal, {
      action: 'create',
      entityType: 'user',
      entityId: membershipId,
      entityLabel: `${input.firstName} ${input.lastName}`,
      summary:
        `Account created for ${email} with a temporary password` +
        `${input.invite ? ', invitation recorded' : ''}`,
    });

    return { account: await this.get(principal, membershipId), temporaryPassword };
  }

  private async addExisting(
    principal: Principal,
    userId: string,
    email: string,
    input: { firstName: string; lastName: string; employeeId: string | null; roleIds: string[] },
  ): Promise<CreatedAccount> {
    if (input.employeeId) {
      const [taken] = await this.db.select({ id: memberships.id }).from(memberships).where(eq(memberships.employeeId, input.employeeId)).limit(1);
      if (taken) throw new AppError({ status: 409, title: 'Conflict', detail: 'That employee already has an account. One person, one login.' });
      const [employee] = await this.db.select({ id: employees.id }).from(employees).where(and(eq(employees.companyId, principal.companyId), eq(employees.id, input.employeeId))).limit(1);
      if (!employee) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'That employee is not on this workforce' });
    }
    const membershipId = `mbr_${crypto.randomUUID()}`;
    const now = new Date();
    await this.db.transaction(async (tx) => {
      await tx.insert(memberships).values({
        id: membershipId,
        companyId: principal.companyId,
        userId,
        employeeId: input.employeeId,
        status: 'active',
        invitedByUserId: principal.userId,
        invitedAt: now,
        acceptedAt: now,
      });
      if (input.roleIds.length > 0) {
        await tx.insert(membershipRoles).values(input.roleIds.map((roleId) => ({ membershipId, roleId, assignedByName: principal.userName ?? principal.userId })));
      }
    });
    await this.audit.write(principal, {
      action: 'create',
      entityType: 'user',
      entityId: membershipId,
      entityLabel: `${input.firstName} ${input.lastName}`,
      summary: `${email} already signs in to another company: added to this company with the same login`,
    });
    return { account: await this.get(principal, membershipId), temporaryPassword: null, addedExisting: true };
  }

  /**
   * Issues a fresh temporary password for an account that already exists.
   *
   * The path back in for the people this system left stranded: an account seeded without a
   * credential, or someone who has forgotten theirs. Every existing session for that user ends,
   * and the new credential must be replaced at first use like any other.
   */
  async issueTemporaryPassword(
    principal: Principal,
    membershipId: string,
  ): Promise<CreatedAccount> {
    const record = await this.get(principal, membershipId);
    const temporaryPassword = generateTemporaryPassword();
    await this.auth.setPassword(record.userId, temporaryPassword, { temporary: true });
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'user',
      entityId: membershipId,
      entityLabel: record.name,
      summary: `Temporary password issued for ${record.email}; existing sessions were ended`,
    });
    return { account: await this.get(principal, membershipId), temporaryPassword };
  }

  /**
   * Gives an account a password so the person can sign in.
   *
   * The password is written as a scrypt hash and never read back — not here, not by the Users
   * screen, not in the audit entry, which records only that a credential was replaced. Every
   * existing session for that user ends, because a changed password must not leave old browsers
   * signed in.
   */
  async setPassword(
    principal: Principal,
    membershipId: string,
    password: string,
  ): Promise<AccountRecord> {
    const record = await this.get(principal, membershipId);
    await this.auth.setPassword(record.userId, password, { temporary: true });
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'user',
      entityId: membershipId,
      entityLabel: record.name,
      summary:
        `Password set for ${record.email}; it must be changed at first sign-in ` +
        `and existing sessions were ended`,
    });
    return this.get(principal, membershipId);
  }

  /**
   * Changes the account's sign-in email (owner, 2026-10-12). The email is the login across the
   * platform, so it must be free, and an account that also belongs to another company is changed
   * only by that person, never from one company's admin page.
   */
  async changeEmail(principal: Principal, membershipId: string, email: string): Promise<AccountRecord> {
    const record = await this.get(principal, membershipId);
    const next = email.trim().toLowerCase();
    if (record.email.toLowerCase() === next) return record;
    const [taken] = await this.db.select({ id: users.id }).from(users).where(and(sql`lower(${users.email}) = ${next}`, ne(users.id, record.userId))).limit(1);
    if (taken) throw new AppError({ status: 409, title: 'Conflict', detail: 'Another account already signs in with that email.' });
    const [other] = await this.db.select({ id: memberships.id }).from(memberships).where(and(eq(memberships.userId, record.userId), ne(memberships.companyId, principal.companyId))).limit(1);
    if (other) throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'This person also signs in to another company; they change their email themselves.' });
    await this.db.update(users).set({ email: next, updatedAt: new Date() }).where(eq(users.id, record.userId));
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'user',
      entityId: membershipId,
      entityLabel: record.name,
      summary: `Sign-in email changed from ${record.email} to ${next}`,
      changes: [{ field: 'email', old: record.email, new: next }],
    });
    return this.get(principal, membershipId);
  }

  async setStatus(
    principal: Principal,
    membershipId: string,
    status: string,
    reason: string | null,
  ): Promise<AccountRecord> {
    if (!ACCOUNT_STATUSES.includes(status as (typeof ACCOUNT_STATUSES)[number])) {
      throw new AppError({ status: 422, title: 'Unprocessable Entity', detail: 'Unknown status' });
    }
    const before = await this.get(principal, membershipId);
    if (before.status === status) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: `Already ${status}`,
      });
    }

    // The lockout guard. Losing the last account that can administer the company is not something
    // to warn about after the fact.
    if (status !== 'active') {
      await this.assertNotLastAdministrator(principal, membershipId, 'disable this account');
    }

    await this.db
      .update(memberships)
      .set({
        status,
        acceptedAt: status === 'active' && !before.acceptedAt ? new Date() : undefined,
        updatedAt: new Date(),
      })
      .where(eq(memberships.id, membershipId));

    await this.audit.write(principal, {
      action: 'status_change',
      entityType: 'user',
      entityId: membershipId,
      entityLabel: before.name,
      summary: `Account: ${before.status} → ${status}`,
      changes: [{ field: 'status', old: before.status, new: status }],
      reason,
    });
    return this.get(principal, membershipId);
  }

  /**
   * Links the account to its workforce record, or unlinks it (owner, 2026-10-07: a recruiter's
   * "My leads" needs to know which employee the account is). One account per employee; the
   * employee must be this company's and still on the workforce.
   */
  async setEmployee(
    principal: Principal,
    membershipId: string,
    employeeId: string | null,
  ): Promise<AccountRecord> {
    const before = await this.get(principal, membershipId);
    if ((before.employeeId ?? null) === employeeId) return before;
    let label: string | null = null;
    if (employeeId) {
      const [employee] = await this.db
        .select({ id: employees.id, first: employees.firstName, last: employees.lastName, status: employees.status })
        .from(employees)
        .where(and(eq(employees.companyId, principal.companyId), eq(employees.id, employeeId)))
        .limit(1);
      if (!employee || employee.status === 'terminated' || employee.status === 'archived') {
        throw new AppError({
          status: 422,
          title: 'Unprocessable Entity',
          detail: 'That employee is not on this workforce',
        });
      }
      const [taken] = await this.db
        .select({ id: memberships.id })
        .from(memberships)
        .where(and(eq(memberships.employeeId, employeeId), ne(memberships.id, membershipId)))
        .limit(1);
      if (taken) {
        throw new AppError({
          status: 409,
          title: 'Conflict',
          detail: 'That employee already has an account. One person, one login.',
        });
      }
      label = `${employee.first} ${employee.last}`.trim();
    }
    await this.db
      .update(memberships)
      .set({ employeeId, updatedAt: new Date() })
      .where(and(eq(memberships.companyId, principal.companyId), eq(memberships.id, membershipId)));
    await this.audit.write(principal, {
      action: 'update',
      entityType: 'user',
      entityId: membershipId,
      entityLabel: before.name,
      summary: label ? `Linked to employee ${label}` : 'Unlinked from its employee record',
      changes: [
        { field: 'employeeId', old: before.employeeId, new: employeeId },
        { field: 'employee', old: before.employeeName, new: label },
      ],
    });
    return this.get(principal, membershipId);
  }

  async setRoles(
    principal: Principal,
    membershipId: string,
    roleIds: string[],
  ): Promise<AccountRecord> {
    const before = await this.get(principal, membershipId);

    const valid = await this.db
      .select({ id: roles.id })
      .from(roles)
      .where(
        and(
          inArray(roles.id, roleIds.length > 0 ? roleIds : ['__none__']),
          or(eq(roles.companyId, principal.companyId), sql`${roles.companyId} is null`),
          eq(roles.status, 'active'),
        ),
      );
    if (valid.length !== roleIds.length) {
      throw new AppError({
        status: 422,
        title: 'Unprocessable Entity',
        detail: 'One of those roles does not exist in this company, or has been archived',
      });
    }

    // Write, then check, inside one transaction: if the change would leave nobody able to
    // administer the company, the throw rolls the whole thing back and no other request ever sees
    // the account without its roles. (An earlier version checked *after* committing and restored
    // the roles in a second transaction; a request resolving its principal in that gap saw an
    // administrator with no permissions at all.)
    await this.db.transaction(async (tx) => {
      await tx.delete(membershipRoles).where(eq(membershipRoles.membershipId, membershipId));
      if (roleIds.length > 0) {
        await tx.insert(membershipRoles).values(
          roleIds.map((roleId) => ({
            membershipId,
            roleId,
            assignedByName: principal.userName ?? principal.userId,
          })),
        );
      }
      await this.assertNotLastAdministrator(principal, null, 'remove the last administrator', tx);
    });

    await this.audit.write(principal, {
      action: 'assign',
      entityType: 'user',
      entityId: membershipId,
      entityLabel: before.name,
      summary: `Roles: ${before.roles.map((r) => r.name).join(', ') || 'none'} → ${valid.length > 0 ? roleIds.length : 'none'} assigned`,
      changes: [
        {
          field: 'roles',
          old: before.roles.map((r) => r.code).join(', ') || null,
          new: roleIds.join(', ') || null,
        },
      ],
    });
    return this.get(principal, membershipId);
  }

  /**
   * Refuses a change that would leave the company with nobody able to administer it.
   *
   * "Able to administer" means an enabled account holding every one of
   * `ADMIN_CRITICAL_PERMISSIONS` — being able to manage accounts but not roles is not enough to
   * recover from a mistake.
   */
  private async assertNotLastAdministrator(
    principal: Principal,
    excludingMembershipId: string | null,
    attempt: string,
    executor: Pick<typeof this.db, 'select'> = this.db,
  ): Promise<void> {
    const parts = [
      eq(memberships.companyId, principal.companyId),
      eq(memberships.status, 'active'),
    ];
    if (excludingMembershipId) parts.push(ne(memberships.id, excludingMembershipId));

    const [row] = await executor
      .select({ value: count() })
      .from(memberships)
      .where(
        and(
          ...parts,
          ...ADMIN_CRITICAL_PERMISSIONS.map(
            (permission) =>
              sql`exists (
                select 1 from ${membershipRoles} mr
                join ${rolePermissions} rp on rp.role_id = mr.role_id
                where mr.membership_id = ${memberships.id} and rp.permission_code = ${permission}
              )`,
          ),
        ),
      );

    if ((row?.value ?? 0) === 0) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `That would ${attempt} and leave nobody able to manage accounts and roles. Give another active account an administrator role first.`,
      });
    }
  }

  async summary(principal: Principal) {
    const rows = await this.db
      .select({ status: memberships.status, value: count() })
      .from(memberships)
      .where(eq(memberships.companyId, principal.companyId))
      .groupBy(memberships.status);
    const at = (status: string) => rows.find((r) => r.status === status)?.value ?? 0;
    // Archived accounts are not part of the company's accounts any more (owner, 2026-10-22): the
    // total is everything else, and the archived ones are counted on their own.
    return {
      total: rows.filter((r) => r.status !== 'archived').reduce((sum, r) => sum + r.value, 0),
      active: at('active'),
      invited: at('invited'),
      suspended: at('suspended'),
      disabled: at('disabled'),
      archived: at('archived'),
    };
  }

  /** Employees who could be given an account: on the workforce, and without one already. */
  async linkableEmployees(principal: Principal) {
    return this.db
      .select({
        id: employees.id,
        name: sql<string>`${employees.firstName} || ' ' || ${employees.lastName}`,
        employeeNumber: employees.employeeNumber,
        position: employees.position,
        email: employees.workEmail,
      })
      .from(employees)
      .where(
        and(
          eq(employees.companyId, principal.companyId),
          sql`${employees.status} not in ('terminated','archived')`,
          sql`not exists (select 1 from ${memberships} m where m.employee_id = ${employees.id})`,
        ),
      )
      .orderBy(asc(employees.lastName))
      .limit(500);
  }
}
