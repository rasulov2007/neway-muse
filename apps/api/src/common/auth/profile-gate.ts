import { and, eq } from 'drizzle-orm';
import { SELF_PROFILE_SETTING, SETTING_DEFAULTS, profileGateApplies, type ProfileStatus } from '@neway/shared';
import type { DatabaseService } from '../../database/database.service';
import { settings } from '../../database/schema/admin';
import { employees } from '../../database/schema/people';

/**
 * Complete your profile (owner, 2026-10-26): whether a membership is held on the profile page.
 *
 * Held when the company setting is on (default), the account is not an administrator, owner or
 * platform admin, it has no linked employee record (memberships.employee_id, or employees.user_id
 * in the same company), and the person has not submitted the form. Read on every request by the
 * principal middleware; the guard then refuses every route not marked @AllowBeforeProfile.
 */
export interface ProfileGateFacts {
  companyId: string;
  userId: string;
  roles: readonly string[];
  isOwner: boolean;
  isPlatformAdmin: boolean;
  employeeId: string | null;
  completedAt: Date | null;
  /** A driver login (memberships.driver_id, 0081): the driver app has no employee profile to complete. */
  driverId?: string | null;
}

type Db = DatabaseService['db'];

export async function selfProfileEnabled(db: Db, companyId: string): Promise<boolean> {
  const [row] = await db
    .select({ value: settings.value })
    .from(settings)
    .where(and(eq(settings.companyId, companyId), eq(settings.key, SELF_PROFILE_SETTING)))
    .limit(1);
  const value = row ? row.value : SETTING_DEFAULTS[SELF_PROFILE_SETTING];
  return value !== false;
}

/** The employee record this account owns in this company, by either link. */
export async function linkedEmployeeId(db: Db, facts: Pick<ProfileGateFacts, 'companyId' | 'userId' | 'employeeId'>): Promise<string | null> {
  if (facts.employeeId) return facts.employeeId;
  const [row] = await db
    .select({ id: employees.id })
    .from(employees)
    .where(and(eq(employees.companyId, facts.companyId), eq(employees.userId, facts.userId)))
    .limit(1);
  return row?.id ?? null;
}

export async function profileStatusFor(db: Db, facts: ProfileGateFacts, enabled?: boolean): Promise<ProfileStatus> {
  const exempt = facts.isOwner || facts.isPlatformAdmin || facts.roles.includes('administrator') || Boolean(facts.driverId);
  const on = enabled ?? (await selfProfileEnabled(db, facts.companyId));
  if (exempt || !on) return 'exempt';
  if (facts.completedAt) return 'complete';
  // Cheap answer first: only an account with no membership link costs the extra lookup.
  if (facts.employeeId) return 'complete';
  const linked = await linkedEmployeeId(db, facts);
  return profileGateApplies({
    enabled: on,
    roles: facts.roles,
    isOwner: facts.isOwner,
    isPlatformAdmin: facts.isPlatformAdmin,
    hasEmployee: linked !== null,
    completedAt: facts.completedAt,
  })
    ? 'pending'
    : 'complete';
}
