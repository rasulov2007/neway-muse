import { usePrincipal as useAdminPrincipal } from '@/features/admin/useAdmin';

/**
 * The signed-in principal's permissions.
 *
 * Phase 3 Administration replaced what used to be here: a role-to-permission table hardcoded in
 * the browser, mirroring `docs/RBAC.md` by hand. That table was right on the day it was written
 * and wrong the moment an administrator edited a role — the UI would keep hiding a button the
 * server would have allowed, or showing one it was about to refuse.
 *
 * The set now comes from `GET /admin/me`, which resolves it from the same `role_permissions` rows
 * the server checks on every request. It is still only a courtesy: hiding a control is a
 * convenience, and every protected action is checked again on the server, where it counts.
 *
 * While the request is in flight the set is empty, so a control appears once its permission is
 * known rather than flashing in and being withdrawn.
 */

export interface Principal {
  userId: string;
  name: string;
  role: string;
  permissions: ReadonlySet<string>;
}

export function usePrincipal(): Principal {
  const query = useAdminPrincipal();
  const data = query.data;
  return {
    userId: data?.userId ?? '',
    name: data?.name ?? '',
    role: data?.roles[0] ?? '',
    permissions: new Set(data?.permissions ?? []),
  };
}

/** Convenience for a single check at a call site. */
export function useHasPermission(permission: string): boolean {
  return usePrincipal().permissions.has(permission);
}
