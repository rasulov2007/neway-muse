import { SYSTEM_ROLES, WORKSPACE_COLLECTIONS, WORKSPACE_EXTRA_KEY_POLICIES, canReadWorkspaceKey, canWriteWorkspaceKey, workspaceKey, workspaceKeyPolicy } from '@neway/shared';
import { policyAdmits, type RouteEntry } from '../../src/common/auth/route-policy';

/**
 * The Role × Endpoint matrix, built from code: every route's declared policy (route metadata)
 * against every built-in role's grants (SYSTEM_ROLES). "Policy" access is what the global guard
 * admits; a handler or service may narrow further (direct reports, owner records, masking), which
 * the `narrowing` column names.
 */
export const ROLES = SYSTEM_ROLES.map((r) => r.code);
const GRANTS = new Map(SYSTEM_ROLES.map((r) => [r.code, new Set(r.permissions)]));

export function rolesAdmitted(route: RouteEntry): string[] {
  return ROLES.filter((role) => policyAdmits(route.policy, GRANTS.get(role)!));
}

/** Who passed before 2026-10-25: a decorator counted only on a controller that listed PermissionGuard. */
export function rolesAdmittedBefore(route: RouteEntry): string[] {
  if (route.policy.kind === 'public') return ROLES;
  if (!route.guards.includes('PermissionGuard')) return ROLES;
  if (route.policy.kind !== 'permission') return ROLES;
  return ROLES.filter((role) => policyAdmits(route.policy, GRANTS.get(role)!));
}

export function policyText(route: RouteEntry): string {
  const p = route.policy;
  if (p.kind === 'public') return 'public';
  if (p.kind === 'signed-in') return `signed-in: ${p.reason}`;
  if (p.kind === 'none') return 'NONE (403)';
  return [p.all.length ? `all(${p.all.join(' + ')})` : '', p.any.length ? `any(${p.any.join(' | ')})` : ''].filter(Boolean).join(' and ');
}

/** Where a handler or service narrows what the policy admits (documented, not computed). */
export const NARROWING: Array<[RegExp, string]> = [
  [/^\/hr\/(attendance|pto|performance|onboarding)/, 'HR (.manage) reaches the company; others reach only direct reports (employees.manager_employee_id)'],
  [/^\/employees/, 'pay type / rate masked without employees.view_financial'],
  [/^\/(drivers)(\/|$)/, 'driver PII masked per drivers.view_contact / view_licence / view_pay'],
  [/^\/state/, 'per-key read/write codes (workspace/access.ts); load money and maintenance costs stripped'],
  [/^\/files\/:id(\/link)?$/, 'owner record decides (file-access.ts); sensitive files need Safety/HR codes'],
  [/^\/compliance\/documents\/:id\/file$|\/(consent|driver-application|dot-application\/link\/files|documents\/:documentId\/file|reports\/:reportId\/file)/, 'signed link only (GET /files/sign); personnel records need compliance_sensitive.view / safety_testing.view / recruiting.manage (W-9: + driver_tax_forms.view)'],
  [/^\/compliance\/documents/, 'unit permission or compliance.view per document (handler)'],
  [/^\/platform\//, 'PlatformAdminGuard: users.is_platform_admin'],
];

export function narrowing(route: RouteEntry): string {
  return NARROWING.find(([re]) => re.test(route.path))?.[1] ?? '';
}

/** Rows the owner should confirm: open-to-everyone reasons, pickers, judgement calls. */
export const UNSURE: Array<[string, RegExp, string]> = [
  ['GET', /^\/(drivers|trucks|trailers)(\/:idOrNumber|\/:idOrUnit)?$/, 'picker lists opened to every operational role (PII masked)'],
  ['GET', /^\/analytics\/accessorials$/, 'accessorial split (billed / to driver / to dispatcher per type) open to every analytics.view holder - a pay report?'],
  ['GET', /^\/drivers\/:idOrNumber\/payment$/, 'payment details (masked bank numbers) still open to drivers.view as well as accounting.view'],
  ['POST', /^\/files(\/raw)?$/, 'upload allowed to any role with an attach control'],
  ['GET', /^\/employees\/dispatchers$/, 'dispatcher picker opened to dispatch / loads / boards'],
  ['POST', /^\/company\/packet$/, 'broker packet (W-9/COI/MC/NOA) for every company_profile.view holder (dispatchers)'],
  ['PATCH', /^\/safety\/accidents-v2\/tasks\/:taskId$/, 'task assignee may update own task without accidents.edit (service)'],
  ['POST', /^\/safety\/accidents-v2\/tasks\/:taskId\/updates$/, 'task assignee may update own task without accidents.edit (service)'],
  ['POST', /^\/employees\/:id\/compensation$/, 'compensation write: employees.view_financial + (employees.manage | accounting.edit)'],
];

export function unsure(route: RouteEntry): string {
  return UNSURE.find(([m, re]) => m === route.method && re.test(route.path))?.[2] ?? '';
}

const csvCell = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);

export function moduleOf(path: string): string {
  return path.split('/')[1] ?? '';
}

/** One CSV row per route: current vs proposed per role (Y = admitted by the route policy). */
export function routeMatrixCsv(routes: RouteEntry[]): string {
  const header = ['module', 'method', 'path', 'handler', 'policy_before', 'policy_now', ...ROLES.flatMap((r) => [`${r}:before`, `${r}:now`]), 'narrowing', 'unsure'];
  const lines = [header.join(',')];
  for (const route of routes) {
    const before = new Set(rolesAdmittedBefore(route));
    const now = new Set(rolesAdmitted(route));
    const beforeText = route.policy.kind === 'permission' && !route.guards.includes('PermissionGuard') ? `NOT ENFORCED (${policyText(route)})` : route.guards.includes('PermissionGuard') || route.policy.kind === 'public' ? policyText(route) : 'signed-in only (no check)';
    lines.push(
      [
        moduleOf(route.path), route.method, route.path, `${route.controller}.${route.handler}`, beforeText, policyText(route),
        ...ROLES.flatMap((r) => [before.has(r) ? 'Y' : '-', now.has(r) ? 'Y' : '-']),
        narrowing(route), unsure(route),
      ].map(csvCell).join(','),
    );
  }
  return lines.join('\n') + '\n';
}

/** The /state keys, role by role (R = read, W = write, - = refused). */
export function stateKeyCsv(): string {
  const keys = [...WORKSPACE_COLLECTIONS.map((c) => workspaceKey(c)), ...Object.keys(WORKSPACE_EXTRA_KEY_POLICIES)];
  const lines = [['key', 'read_any', 'write_any', 'strips', ...ROLES, 'unsure'].join(',')];
  for (const key of keys) {
    const p = workspaceKeyPolicy(key)!;
    const cells = ROLES.map((r) => {
      const g = [...GRANTS.get(r)!];
      return `${canReadWorkspaceKey(g, key) ? 'R' : '-'}${canWriteWorkspaceKey(g, key) ? 'W' : ''}`;
    });
    const strips = p.stripsCosts ? 'maintenance costs' : '';
    lines.push([key, p.read.join(' | '), p.write.join(' | ') || '(nobody)', strips, ...cells, p.unsure ? 'yes' : ''].map(csvCell).join(','));
  }
  return lines.join('\n') + '\n';
}

/** The fixture the CI suite compares against: route → roles the policy admits. */
export function admissionFixture(routes: RouteEntry[]): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const route of routes) out[`${route.method} ${route.path} ${route.controller}.${route.handler}`] = rolesAdmitted(route);
  return out;
}
