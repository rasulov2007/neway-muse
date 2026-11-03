/**
 * The restricted view of a driver's profile (owner, 2026-10-26): "On the driver profile only
 * Contact information, Assignment and equipment and CDL information should show; from Documents
 * only the CDL; nothing else visible — not the pay plan, nothing else."
 *
 * The owner's clarification the same day: the FULL profile is for Accounting and the
 * Administrator only. The gate is `drivers.view_pay`, which in production only those two roles
 * hold. Everybody else who may open a driver (`drivers.view`) — dispatchers, dispatch leads,
 * updaters, maintenance, Safety, HR, Fleet — gets the restricted view.
 */
export const DRIVER_PROFILE_FULL_PERMISSION = 'drivers.view_pay';

/** The driver documents the restricted profile shows: the CDL, front and back. */
export const DISPATCH_DRIVER_DOCUMENT_CODES: ReadonlySet<string> = new Set(['cdl', 'cdl_back']);

export function isRestrictedDriverProfileViewer(permissions: readonly string[]): boolean {
  return permissions.includes('drivers.view') && !permissions.includes(DRIVER_PROFILE_FULL_PERMISSION);
}

/**
 * Who may read a driver's CDL document (front and back) through the restricted profile: anybody
 * who may open the driver. Everything else in the driver file keeps its own rules.
 */
export function readsDriverCdlDocuments(permissions: readonly string[]): boolean {
  return permissions.includes('drivers.view');
}
