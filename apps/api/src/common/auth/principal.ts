/** Permission strings the dashboard module checks (docs/RBAC.md, docs/DASHBOARD.md §10). */
export const DASHBOARD_PERMISSIONS = {
  view: 'dashboard.view',
  viewFinancial: 'dashboard.view_financial',
  drilldown: 'dashboard.drilldown',
} as const;

export type DashboardPermission =
  (typeof DASHBOARD_PERMISSIONS)[keyof typeof DASHBOARD_PERMISSIONS];

/** The authenticated identity a request runs as; the only source of `companyId` (§11). */
export interface Principal {
  userId: string;
  /** Display name of the acting user, recorded on every audit entry they cause. */
  userName?: string;
  companyId: string;
  /** IANA timezone of the principal's company, used for every period resolution. */
  companyTimezone: string;
  /** First day of the company reporting week, 0 = Sunday ... 6 = Saturday. */
  weekStart: number;
  roles: string[];
  permissions: Set<string>;
  /** The membership this principal acts through, when it came from a real account. */
  membershipId?: string;
  /** True only when a bearer session proved who this is. Nothing else sets it. */
  signedIn?: boolean;
  /**
   * The credential behind this session is a temporary one. Every route except the one that
   * replaces it is refused while this is true (see `AuthenticatedGuard`).
   */
  mustChangePassword?: boolean;
  /**
   * The person still has to complete their own employee profile (owner, 2026-10-26). Every route
   * except those marked @AllowBeforeProfile is refused while this is true (see `AuthenticatedGuard`).
   */
  profileRequired?: boolean;
  /**
   * This request was proved by a signed document link, not a session (signed-download.ts). It may
   * open only routes marked @SignedDownload, and nothing else.
   */
  viaSignedLink?: boolean;
  /**
   * The roster driver this membership signs in as (memberships.driver_id, 0081), set only by the
   * principal middleware from the database. A driver principal holds the driver-app permissions
   * and nothing else; `/driver/*` still re-resolves the driver per request (DriverContextService).
   */
  driverId?: string;
  /** The auth session behind this request (bearer sessions only): device registration ties to it. */
  sessionId?: string;
}

/** True when the principal holds `permission`. */
export function hasPermission(principal: Principal, permission: string): boolean {
  return principal.permissions.has(permission);
}
