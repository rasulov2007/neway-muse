import { Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import { DatabaseService } from '../../database/database.service';
import { membershipRoles, memberships, rolePermissions, roles } from '../../database/schema/admin';

/**
 * Who holds a permission in a company: the office accounts (never a driver login) whose active
 * roles grant the code. Used to target a department's notifications at the people who may open
 * the conversation, not at everyone.
 */
@Injectable()
export class MessageAudienceService {
  constructor(private readonly database: DatabaseService) {}

  /** Users holding every one of `codes` (an empty list = nobody). */
  async usersHoldingAll(companyId: string, codes: readonly string[]): Promise<string[]> {
    if (codes.length === 0) return [];
    let result: string[] | null = null;
    for (const code of codes) {
      const holders = new Set<string>(await this.usersHolding(companyId, [code]));
      result = result === null ? [...holders] : result.filter((u: string) => holders.has(u));
    }
    return result ?? [];
  }

  /** Users holding any one of `codes`. */
  async usersHolding(companyId: string, codes: readonly string[]): Promise<string[]> {
    if (codes.length === 0) return [];
    const rows = await this.database.db
      .selectDistinct({ userId: memberships.userId })
      .from(memberships)
      .innerJoin(membershipRoles, eq(membershipRoles.membershipId, memberships.id))
      .innerJoin(roles, and(eq(roles.id, membershipRoles.roleId), eq(roles.status, 'active')))
      .innerJoin(rolePermissions, eq(rolePermissions.roleId, roles.id))
      .where(
        and(
          eq(memberships.companyId, companyId),
          eq(memberships.status, 'active'),
          isNull(memberships.driverId),
          inArray(rolePermissions.permissionCode, [...codes]),
        ),
      );
    return rows.map((r) => r.userId);
  }

  /** True when this user (an office account of the company) holds every code. */
  async userHoldsAll(companyId: string, userId: string, codes: readonly string[]): Promise<boolean> {
    const holders = await this.usersHoldingAll(companyId, codes);
    return holders.includes(userId);
  }
}
