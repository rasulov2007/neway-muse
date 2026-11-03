import { randomUUID } from 'node:crypto';
import { Injectable } from '@nestjs/common';
import { and, asc, eq, inArray, sql } from 'drizzle-orm';
import type {
  CreatePlatformCompany,
  DeactivatePlatformCompany,
  PlatformCompany,
  PlatformCredential,
  RenamePlatformCompany,
} from '@neway/shared';
import type { Principal } from '../../common/auth/principal';
import { AppError } from '../../common/errors/app-error';
import { DatabaseService } from '../../database/database.service';
import { departments, memberships, membershipRoles, users } from '../../database/schema/admin';
import { companies } from '../../database/schema/roster';
import { AuditService } from '../people/audit.service';
import { AuthService } from '../auth/auth.service';
import { generateTemporaryPassword, hashPassword } from '../auth/password.util';

/** The built-in administrator role every new company's first account gets. */
const ADMINISTRATOR_ROLE_ID = 'rol_administrator';

/**
 * Customer companies, as the platform administrator sees them (owner, 2026-10-01).
 *
 * Does what `scripts/create-company.ts` did by hand, from a screen: a new company is an empty
 * workspace (no demo or test data) with one owner administrator holding a temporary password. Each
 * action writes its audit line into the company it touched, naming the platform administrator who
 * did it. Nothing is deleted; deactivating hides a company and refuses its sign-ins, reversibly.
 */
@Injectable()
export class PlatformService {
  constructor(
    private readonly database: DatabaseService,
    private readonly audit: AuditService,
    private readonly auth: AuthService,
  ) {}

  private get db() {
    return this.database.db;
  }

  async list(): Promise<PlatformCompany[]> {
    const rows = await this.db.select().from(companies).orderBy(asc(companies.createdAt));
    return this.describe(rows);
  }

  async get(companyId: string): Promise<PlatformCompany> {
    const rows = await this.db.select().from(companies).where(eq(companies.id, companyId));
    if (rows.length === 0) {
      throw new AppError({ status: 404, title: 'Not Found', detail: 'No such company' });
    }
    return (await this.describe(rows))[0]!;
  }

  private async describe(rows: (typeof companies.$inferSelect)[]): Promise<PlatformCompany[]> {
    const ids = rows.map((r) => r.id);
    if (ids.length === 0) return [];
    const counts = await this.db
      .select({ companyId: memberships.companyId, n: sql<number>`count(*)::int` })
      .from(memberships)
      .where(and(inArray(memberships.companyId, ids), inArray(memberships.status, ['active', 'invited'])))
      .groupBy(memberships.companyId);
    const owners = await this.db
      .select({
        companyId: memberships.companyId,
        membershipId: memberships.id,
        firstName: users.firstName,
        lastName: users.lastName,
        email: users.email,
        lastLoginAt: users.lastLoginAt,
      })
      .from(memberships)
      .innerJoin(users, eq(users.id, memberships.userId))
      .where(and(inArray(memberships.companyId, ids), eq(memberships.isOwner, true)))
      .orderBy(asc(memberships.createdAt));
    return rows.map((c) => {
      const owner = owners.find((o) => o.companyId === c.id);
      return {
        id: c.id,
        name: c.name,
        timezone: c.timezone,
        status: c.deactivatedAt ? 'deactivated' : 'active',
        deactivatedAt: c.deactivatedAt?.toISOString() ?? null,
        deactivatedReason: c.deactivatedReason,
        userCount: counts.find((n) => n.companyId === c.id)?.n ?? 0,
        admin: owner
          ? {
              membershipId: owner.membershipId,
              name: `${owner.firstName} ${owner.lastName}`.trim(),
              email: owner.email,
              lastLoginAt: owner.lastLoginAt?.toISOString() ?? null,
            }
          : null,
        createdAt: c.createdAt.toISOString(),
        version: c.updatedAt.toISOString(),
      };
    });
  }

  /** A readable, unused id: "Harbor Line Transport" -> co_aj_transport (co_aj_transport_2 if taken). */
  private async newCompanyId(name: string): Promise<string> {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '_')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32);
    const base = slug ? `co_${slug}` : `co_${randomUUID().slice(0, 8)}`;
    for (let i = 1; i < 100; i += 1) {
      const id = i === 1 ? base : `${base}_${i}`;
      const [taken] = await this.db.select({ id: companies.id }).from(companies).where(eq(companies.id, id));
      if (!taken) return id;
    }
    return `co_${randomUUID().slice(0, 12)}`;
  }

  async create(principal: Principal, input: CreatePlatformCompany): Promise<PlatformCredential> {
    const email = input.adminEmail.toLowerCase();
    const [taken] = await this.db
      .select({ id: users.id })
      .from(users)
      .where(sql`lower(${users.email}) = ${email}`)
      .limit(1);
    if (taken) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `${email} already has an account. Use another email for this company's administrator.`,
      });
    }
    const [sameName] = await this.db
      .select({ id: companies.id })
      .from(companies)
      .where(sql`lower(${companies.name}) = ${input.name.toLowerCase()}`)
      .limit(1);
    if (sameName) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: `A company called ${input.name} already exists.`,
      });
    }

    const companyId = await this.newCompanyId(input.name);
    const userId = `usr_${randomUUID()}`;
    const membershipId = `mbr_${randomUUID()}`;
    const temporaryPassword = generateTemporaryPassword();
    const passwordHash = await hashPassword(temporaryPassword);
    const lastName = input.adminLastName.trim() || 'Admin';

    await this.db.transaction(async (tx) => {
      await tx.insert(companies).values({
        id: companyId,
        name: input.name,
        timezone: 'America/New_York',
        weekStart: 'monday',
      });
      // Every company has a Driver Relations department (owner, 2026-10-06; migration 0043 gave
      // one to each company already on file).
      await tx
        .insert(departments)
        .values({
          id: `dep_driver_relations_${companyId}`,
          companyId,
          code: 'driver_relations',
          name: 'Driver Relations',
          description: 'Every request drivers send from the NORTHWIND FREIGHT Driver Care page.',
          status: 'active',
          isSystem: true,
        })
        .onConflictDoNothing();
      await tx.insert(users).values({
        id: userId,
        email,
        firstName: input.adminFirstName,
        lastName,
        passwordHash,
        mustChangePassword: true,
        isActive: true,
      });
      await tx.insert(memberships).values({
        id: membershipId,
        companyId,
        userId,
        status: 'active',
        isOwner: true,
        invitedByUserId: principal.userId,
        acceptedAt: new Date(),
      });
      await tx.insert(membershipRoles).values({
        membershipId,
        roleId: ADMINISTRATOR_ROLE_ID,
        assignedByName: principal.userName ?? principal.userId,
      });
    });

    await this.audit.write(this.in(principal, companyId), {
      action: 'create',
      entityType: 'company',
      entityId: companyId,
      entityLabel: input.name,
      summary: `Company ${input.name} created by the platform administrator, with administrator ${email} (temporary password)`,
    });
    return { company: await this.get(companyId), email, temporaryPassword };
  }

  async rename(principal: Principal, companyId: string, input: RenamePlatformCompany): Promise<PlatformCompany> {
    const before = await this.get(companyId);
    if (before.name === input.name) return before;
    await this.writeIfCurrent(companyId, input.version, { name: input.name });
    await this.audit.write(this.in(principal, companyId), {
      action: 'update',
      entityType: 'company',
      entityId: companyId,
      entityLabel: input.name,
      changes: [{ field: 'name', old: before.name, new: input.name }],
      summary: `Company renamed from ${before.name} to ${input.name} by the platform administrator`,
    });
    return this.get(companyId);
  }

  async deactivate(
    principal: Principal,
    companyId: string,
    input: DeactivatePlatformCompany,
  ): Promise<PlatformCompany> {
    if (companyId === principal.companyId) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'You are signed in through this company. Deactivating it would lock you out.',
      });
    }
    const before = await this.get(companyId);
    if (before.status === 'deactivated') return before;
    await this.writeIfCurrent(companyId, input.version, {
      deactivatedAt: new Date(),
      deactivatedReason: input.reason,
      deactivatedBy: principal.userName ?? principal.userId,
    });
    await this.audit.write(this.in(principal, companyId), {
      action: 'deactivate',
      entityType: 'company',
      entityId: companyId,
      entityLabel: before.name,
      reason: input.reason,
      changes: [{ field: 'status', old: 'active', new: 'deactivated' }],
      summary: `Company ${before.name} deactivated by the platform administrator; its people cannot sign in`,
    });
    return this.get(companyId);
  }

  async reactivate(principal: Principal, companyId: string, version: string): Promise<PlatformCompany> {
    const before = await this.get(companyId);
    if (before.status === 'active') return before;
    await this.writeIfCurrent(companyId, version, {
      deactivatedAt: null,
      deactivatedReason: null,
      deactivatedBy: null,
    });
    await this.audit.write(this.in(principal, companyId), {
      action: 'reactivate',
      entityType: 'company',
      entityId: companyId,
      entityLabel: before.name,
      changes: [{ field: 'status', old: 'deactivated', new: 'active' }],
      summary: `Company ${before.name} reactivated by the platform administrator`,
    });
    return this.get(companyId);
  }

  /** A fresh temporary password for the company's owner administrator; their sessions end. */
  async issueAdminPassword(principal: Principal, companyId: string): Promise<PlatformCredential> {
    const company = await this.get(companyId);
    if (!company.admin) {
      throw new AppError({ status: 409, title: 'Conflict', detail: 'This company has no owner administrator.' });
    }
    const [owner] = await this.db
      .select({ userId: memberships.userId })
      .from(memberships)
      .where(eq(memberships.id, company.admin.membershipId));
    const temporaryPassword = generateTemporaryPassword();
    await this.auth.setPassword(owner!.userId, temporaryPassword, { temporary: true });
    await this.audit.write(this.in(principal, companyId), {
      action: 'update',
      entityType: 'user',
      entityId: company.admin.membershipId,
      entityLabel: company.admin.name,
      summary: `Temporary password issued for ${company.admin.email} by the platform administrator; existing sessions were ended`,
    });
    return { company: await this.get(companyId), email: company.admin.email, temporaryPassword };
  }

  /** Version check: the update lands only if nobody changed the company since the screen read it. */
  private async writeIfCurrent(
    companyId: string,
    version: string,
    values: Partial<typeof companies.$inferInsert>,
  ): Promise<void> {
    const seen = new Date(version);
    if (Number.isNaN(seen.getTime())) {
      throw new AppError({ status: 400, title: 'Bad Request', detail: 'Invalid version' });
    }
    const updated = await this.db
      .update(companies)
      .set({ ...values, updatedAt: new Date() })
      .where(and(eq(companies.id, companyId), sql`date_trunc('milliseconds', ${companies.updatedAt}) = ${seen.toISOString()}::timestamptz`))
      .returning({ id: companies.id });
    if (updated.length === 0) {
      throw new AppError({
        status: 409,
        title: 'Conflict',
        detail: 'Someone changed this company a moment ago. Reload and try again.',
      });
    }
  }

  /** The principal, scoped to the company the action touched, so the audit line lands there. */
  private in(principal: Principal, companyId: string): Principal {
    return { ...principal, companyId };
  }
}
